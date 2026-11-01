const fsp = require('fs/promises');
const path = require('path');

let seq = 0;

// 回退用：主进程会注入真正的 appError（码编进 message，见 CLAUDE.md），
// 单测不注入时也得抛出同一种形状，断言才能按码判断。
const fallbackError = (code, detail) => new Error(code + '|' + detail);

// 白名单里的条目是"相对项目目录的固定路径"，用 / 分段。
// allowed.has(name) 已经把形状锁死了，这里再拆一遍是第二道闸：将来有人往
// 白名单里手滑加了 '../x' 或 'C:\\x'，也不会因此变成任意路径写入。
// 冒号一并拒绝——Windows 上 'a.md:stream' 会写进 NTFS 备用数据流。
function splitRel(name) {
  if (!name || /[\\:\0]/.test(name) || name.startsWith('/')) return null;
  const segs = name.split('/');
  if (segs.some(s => !s || s === '.' || s === '..')) return null;
  return segs;
}

async function lstatOrNull(file) {
  try { return await fsp.lstat(file); }
  catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}

// 从项目目录往下逐级 lstat。必须是 lstat 而不是 stat：stat 会跟着链接走，
// 一个指向别处的 .github（symlink 或 Windows 的 junction，libuv 把两者都报成
// isSymbolicLink）在 stat 眼里就是个普通目录，写进去就落到了用户没选过的地方。
// 返回 'missing' / 'file' / 'unsafe'。中间某级不存在时后面自然也不存在，直接 missing。
async function inspect(targetDir, segs) {
  let cur = targetDir;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    const st = await lstatOrNull(cur);
    if (!st) return 'missing';
    if (st.isSymbolicLink()) return 'unsafe';
    const last = i === segs.length - 1;
    if (last ? !st.isFile() : !st.isDirectory()) return 'unsafe';
  }
  return 'file';
}

async function plan(targetDir, files, allowed, options = {}) {
  const appError = options.appError || fallbackError;
  const items = [];
  const seen = new Set();
  for (const item of Array.isArray(files) ? files : []) {
    const name = item && typeof item.name === 'string' ? item.name : '';
    const segs = allowed.has(name) ? splitRel(name) : null;
    if (!segs || seen.has(name)) continue;
    seen.add(name);
    items.push({ name, segs, content: String(item.content || ''), fullPath: path.join(targetDir, ...segs) });
  }
  const existing = [];
  const unsafe = [];
  for (const item of items) {
    const kind = await inspect(targetDir, item.segs);
    if (kind === 'file') existing.push(item.name);
    else if (kind === 'unsafe') unsafe.push(item.name);
  }
  // 有任何一项不安全就整次拒绝，一个文件都不写：此时还没问过用户要不要覆盖，
  // 部分写入再报错，用户看到的是一个半成品目录和一条失败提示，分不清哪些落了盘。
  if (unsafe.length) throw appError('E_RULE_EXPORT_UNSAFE', unsafe.join(', '));
  return { targetDir, items, existing };
}

// 写盘前就地再查一遍并补建缺的目录，不复用 plan 的结论：plan 和 write 之间
// 隔着一个"要不要覆盖"的对话框，用户可以停在那儿任意久，目录在这期间被换成
// 链接的话，只靠 plan 的结果就会写穿出去。
// 建目录逐级 mkdir（不用 recursive），每建一级立刻 lstat 确认它是真目录。
async function prepare(targetDir, segs) {
  let cur = targetDir;
  for (const seg of segs.slice(0, -1)) {
    cur = path.join(cur, seg);
    let st = await lstatOrNull(cur);
    if (!st) {
      try { await fsp.mkdir(cur); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
      st = await lstatOrNull(cur);
    }
    if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new Error('unsafe path: ' + cur);
  }
  const st = await lstatOrNull(path.join(cur, segs[segs.length - 1]));
  if (!st) return 'missing';
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('unsafe path: ' + segs.join('/'));
  return 'file';
}

async function writeAtomic(file, content) {
  const tmp = path.join(path.dirname(file), `.pfm-rule-${process.pid}-${seq++}-${path.basename(file)}.part`);
  try {
    // wx：临时名可以被猜到，有人预先在这个名字上放一个链接时，
    // 默认的 w 会跟着链接写到别处；wx 遇到已存在（含悬空链接）直接失败。
    await fsp.writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
    await fsp.rename(tmp, file);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch {}
    throw e;
  }
}

async function write(exportPlan, mode, onError) {
  const existing = new Set(exportPlan.existing);
  const written = [];
  const skipped = [];
  const failed = [];
  for (const item of exportPlan.items) {
    if (existing.has(item.name) && mode !== 'overwrite') {
      skipped.push(item.name);
      continue;
    }
    try {
      const now = await prepare(exportPlan.targetDir, item.segs);
      // 只覆盖用户在对话框里看到过的文件。plan 时还不存在、问完之后才冒出来的，
      // 用户没被问过，按"保留已有文件"处理——否则 mode 默认的 overwrite
      // （没有已有文件时根本不弹框）会把它静默盖掉。
      if (now === 'file' && !existing.has(item.name)) {
        skipped.push(item.name);
        continue;
      }
      await writeAtomic(item.fullPath, item.content);
      written.push(item.name);
    } catch (e) {
      failed.push(item.name);
      if (onError) onError(item.name, e);
    }
  }
  return { written, skipped, failed };
}

module.exports = { plan, write };
