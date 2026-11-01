const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// 版本文件名由本程序生成，只允许 <时间戳>.md 或 restored-<数字>-<时间戳>.md 形态。
const VERSION_FILE_RE = /^(?:restored-\d+-)?\d{8}-\d{6}(?:-\d{3})?\.md$/;

// ---------- 版本说明 ----------
//
// 说明描述的是"某一份内容是怎么来的"，挂在**内容**上，不挂在"保存动作"上。
//
// 难点在于快照机制是反着存的：保存时落盘的快照是**旧内容**，这次保存写进去的新内容
// 此刻没有任何快照条目，要等下一次保存（或回滚）才会被存成快照。如果把这次保存的
// 说明直接挂到这次生成的快照上，那条快照装的却是改动之前的内容——用户在历史里看到
// "加了示例"，点开却是没加示例的那一版，回滚过去更是南辕北辙。
//
// 所以说明分两段存在 index.json 里：
//   current: { note, sha256 }   当前正文的说明。sha256 记下写入时正文的哈希，
//                               用来判断"磁盘上的正文还是不是那一份"
//   notes:   { <快照文件名>: note }
// saveVersion 把旧正文存成快照时，若旧正文的哈希与 current.sha256 一致，就把 current
// 的说明原样转给这条新快照，然后清掉 current。于是任何一行的说明都描述那一行自己的
// 内容：快照行的说明 = 产生那份内容的那次保存填的说明；"当前内容"行同理。
// 回滚也自洽：回滚前的当前内容连同它的说明一起变成快照，回滚写入的内容是新的
// 当前内容，没有说明（用户可以事后补）。
//
// 哈希对不上（外部编辑器改过、自动字段被别处改写）就丢弃 current：那句说明描述的
// 已经不是这份内容了，宁可不显示也不能张冠李戴。
//
// 旧索引只有 pinned 字段，notes / current 缺省时一律按"没有说明"处理。
const MAX_VERSION_NOTE = 200;

function contentHash(content) {
  return crypto.createHash('sha256').update(Buffer.from(String(content), 'utf8')).digest('hex');
}

// 只做清洗、不做校验：换行和制表符折成空格（说明在列表里按单行显示，
// 保留换行只会让列表行高参差，导入的数据里也可能夹带 \r），其余控制字符直接去掉，
// 连续空白合并，首尾去空白。
function cleanVersionNote(raw) {
  return String(raw)
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// IPC 入口用：类型不对、清洗后超长都抛错码，不静默截断——用户写的字被吞一截
// 却显示保存成功，比直接告诉他太长更糟。上限按码点数，和界面上的 maxlength 对齐
// （maxlength 按 UTF-16 码元数，基本平面以外的字符在界面上会先被拦，不会反过来）。
function normalizeVersionNote(raw, appError) {
  if (raw == null) return '';
  if (typeof raw !== 'string') throw appError('E_VERSION_NOTE_INVALID', typeof raw);
  const note = cleanVersionNote(raw);
  if ([...note].length > MAX_VERSION_NOTE) throw appError('E_VERSION_NOTE_TOO_LONG', String(MAX_VERSION_NOTE));
  return note;
}

// 导入备份时用：外来索引不可信，只留认得的字段。说明超长时截断而不是整条拒绝——
// 这时没有用户在场修改，丢掉整条说明比截断更亏。
// keepFile(file) 决定某个快照名是否保留（调用方据此只留这次真的导入了的快照）。
// 键先过 VERSION_FILE_RE 白名单，"__proto__" 这类键到不了赋值那一步。
function sanitizeVersionIndex(raw, keepFile = () => true) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pinned = {};
  const notes = {};
  for (const [file, value] of Object.entries(src.pinned && typeof src.pinned === 'object' ? src.pinned : {})) {
    if (value === true && VERSION_FILE_RE.test(file) && keepFile(file)) pinned[file] = true;
  }
  for (const [file, value] of Object.entries(src.notes && typeof src.notes === 'object' ? src.notes : {})) {
    if (typeof value !== 'string' || !VERSION_FILE_RE.test(file) || !keepFile(file)) continue;
    const note = [...cleanVersionNote(value)].slice(0, MAX_VERSION_NOTE).join('');
    if (note) notes[file] = note;
  }
  const out = { pinned };
  if (Object.keys(notes).length) out.notes = notes;
  const cur = src.current;
  if (cur && typeof cur === 'object' && typeof cur.note === 'string' && typeof cur.sha256 === 'string' && /^[0-9a-f]{64}$/.test(cur.sha256)) {
    const note = [...cleanVersionNote(cur.note)].slice(0, MAX_VERSION_NOTE).join('');
    if (note) out.current = { note, sha256: cur.sha256 };
  }
  return out;
}

function timestampName(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`;
}

function createVersionStore(options) {
  const {
    versionsDir,
    maxUnpinned,
    appError,
    ensureDir,
    writeFileAtomic,
    now = () => new Date(),
    logError = (...args) => console.error(...args)
  } = options || {};

  function versionDirFor(relPath) {
    const rel = String(relPath == null ? '' : relPath).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) throw appError('E_PATH_EMPTY');
    if (rel.includes('\0')) throw appError('E_PATH_BAD_CHAR');
    const resolved = path.resolve(versionsDir, rel);
    // 跨盘符时 path.relative 返回绝对路径，必须和 .. 一起拦截。
    const relV = path.relative(versionsDir, resolved);
    if (relV.startsWith('..') || path.isAbsolute(relV)) throw appError('E_PATH_ESCAPE', relPath);
    return resolved;
  }

  function versionFilePath(relPath, file) {
    const name = String(file == null ? '' : file);
    if (!VERSION_FILE_RE.test(name)) throw appError('E_BAD_VERSION_FILE', name);
    return path.join(versionDirFor(relPath), name);
  }

  // 区分不存在和损坏：损坏的索引改名留档，避免星标被静默清空后无从恢复。
  async function readIndexJson(idxPath, fallback) {
    let raw;
    try {
      raw = await fsp.readFile(idxPath, 'utf8');
    } catch {
      return { ...fallback };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      throw new Error('not an object');
    } catch (e) {
      const bak = idxPath + '.corrupt-' + timestampName(now());
      try { await fsp.rename(idxPath, bak); } catch {}
      logError('[index] 索引损坏，已改名留档:', bak, e.message);
      return { ...fallback };
    }
  }

  async function readVersionIndex(relPath) {
    return readIndexJson(path.join(versionDirFor(relPath), 'index.json'), { pinned: {} });
  }

  async function writeVersionIndex(relPath, index) {
    const dir = versionDirFor(relPath);
    await ensureDir(dir);
    await writeFileAtomic(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
  }

  function notesOf(index) {
    return index.notes && typeof index.notes === 'object' && !Array.isArray(index.notes) ? index.notes : {};
  }

  // current 只在哈希对得上时才算数，见文件头。
  function currentNoteFor(index, content) {
    const cur = index.current;
    if (!cur || typeof cur !== 'object' || typeof cur.note !== 'string' || !cur.note) return '';
    if (content == null || cur.sha256 !== contentHash(content)) return '';
    return cur.note;
  }

  async function pruneVersions(relPath) {
    const dir = versionDirFor(relPath);
    let files;
    try {
      files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md'));
    } catch {
      return;
    }
    if (files.length <= maxUnpinned) return;
    const index = await readVersionIndex(relPath);
    const pinned = index.pinned || {};
    // 星标版本不计入上限，也永不自动删除。
    const unpinned = files.filter(f => !pinned[f]).sort();
    const excess = unpinned.length - maxUnpinned;
    if (excess <= 0) return;
    const removed = [];
    for (const f of unpinned.slice(0, excess)) {
      try { await fsp.unlink(path.join(dir, f)); removed.push(f); } catch {}
    }
    // 快照删了，说明跟着删。不删的话索引里会越积越多认不出主人的说明；
    // 将来同名快照（同一毫秒的时间戳）再出现时，还会把旧说明错安到新快照上。
    const notes = notesOf(index);
    if (!removed.some(f => Object.prototype.hasOwnProperty.call(notes, f))) return;
    for (const f of removed) delete notes[f];
    index.notes = notes;
    try { await writeVersionIndex(relPath, index); } catch (e) {
      // 残留的说明在列表里不可见（列表只按现存快照取说明），不值得让这次保存失败。
      logError('[versions] 裁剪后清理版本说明失败:', relPath, e.message);
    }
  }

  // 撞名时向后挪一毫秒，保持文件名格式和时间排序。
  async function saveVersion(relPath, content) {
    const dir = versionDirFor(relPath);
    await ensureDir(dir);
    let d = now();
    let name = timestampName(d) + '.md';
    for (let i = 0; i < 1000 && fs.existsSync(path.join(dir, name)); i++) {
      d = new Date(d.getTime() + 1);
      name = timestampName(d) + '.md';
    }
    await writeFileAtomic(path.join(dir, name), content);
    await handOverCurrentNote(relPath, name, content);
    await pruneVersions(relPath);
  }

  // 刚存成快照的这份旧正文，就是 current 说明描述的那份内容时，把说明转给快照。
  // 无论转没转，current 都清掉：正文马上要被覆盖，它不再是"当前内容"了。
  //
  // 失败只记日志不抛：快照已经落盘，正文还没写，这时抛出去会让整次保存失败——
  // 为了一句说明挡住用户的正文，代价倒过来了。
  async function handOverCurrentNote(relPath, snapshotName, content) {
    let index;
    try {
      index = await readVersionIndex(relPath);
      if (!index.current) return;
      const note = currentNoteFor(index, content);
      if (note) index.notes = { ...notesOf(index), [snapshotName]: note };
      delete index.current;
      await writeVersionIndex(relPath, index);
    } catch (e) {
      logError('[versions] 版本说明没能转到快照上:', relPath, snapshotName, e && e.message);
    }
  }

  // 正文写盘之后调用，content 是实际写进去的内容（含 bump 过的自动字段）。
  //   note 非空：这次保存填了说明，挂到当前内容上
  //   note 为空：这次没填说明。carryFrom 是"这次没有产生快照时，写入前的那份正文"，
  //     即内容没变、只 bump 了自动字段的那种保存：说明继续跟着当前内容走，换绑到
  //     新哈希上。产生了快照时调用方传 null——说明已经由 saveVersion 转给快照；
  //     就算那次转交写盘失败、current 还残留着，也不能把它换绑到新内容上，
  //     那等于把旧内容的说明安到新内容头上。
  // 没有说明也没有可换绑的 current 时不写盘：新文件不该因为一次保存就多出一个
  // 只装着空 pinned 的版本目录。
  async function recordCurrentNote(relPath, content, note, carryFrom) {
    const index = await readVersionIndex(relPath);
    if (note) {
      index.current = { note, sha256: contentHash(content) };
    } else {
      if (!index.current) return;
      // carryFrom 为 null 时 currentNoteFor 返回空串，current 被清掉
      const kept = currentNoteFor(index, carryFrom);
      if (kept) index.current = { note: kept, sha256: contentHash(content) };
      else delete index.current;
    }
    await writeVersionIndex(relPath, index);
  }

  async function getCurrentNote(relPath, content) {
    return currentNoteFor(await readVersionIndex(relPath), content);
  }

  // 事后编辑说明。file 为 null 表示"当前内容"那一行，此时必须带上当前正文，
  // 哈希按它算；否则 file 必须是现存的快照，名字过白名单。
  async function setVersionNote(relPath, file, rawNote, currentContent) {
    const note = normalizeVersionNote(rawNote, appError);
    if (file == null) {
      if (typeof currentContent !== 'string') throw appError('E_VERSION_NOT_FOUND', String(relPath));
      const index = await readVersionIndex(relPath);
      if (note) index.current = { note, sha256: contentHash(currentContent) };
      else if (!index.current) return note;
      else delete index.current;
      await writeVersionIndex(relPath, index);
      return note;
    }
    const full = versionFilePath(relPath, file);
    // 被裁剪掉的快照不许再挂说明：否则索引里留下一条没有主人的说明，
    // 将来同名快照出现时会被错安上去。
    if (!fs.existsSync(full)) throw appError('E_VERSION_NOT_FOUND', String(file));
    const index = await readVersionIndex(relPath);
    const notes = notesOf(index);
    if (note) notes[file] = note; else delete notes[file];
    index.notes = notes;
    await writeVersionIndex(relPath, index);
    return note;
  }

  async function listVersions(relPath) {
    const dir = versionDirFor(relPath);
    let files;
    try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md')); } catch { return []; }
    const index = await readVersionIndex(relPath);
    const notes = notesOf(index);
    return files.map(f => {
      const timestamp = f.replace(/\.md$/, '');
      const note = typeof notes[f] === 'string' ? notes[f] : '';
      return { file: f, timestamp, pinned: !!(index.pinned && index.pinned[f]), note };
    }).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async function readVersion(relPath, file) {
    return fsp.readFile(versionFilePath(relPath, file), 'utf8');
  }

  async function pinVersion(relPath, file, pinned) {
    versionFilePath(relPath, file);
    const index = await readVersionIndex(relPath);
    index.pinned = index.pinned || {};
    if (pinned) index.pinned[file] = true; else delete index.pinned[file];
    await writeVersionIndex(relPath, index);
    return true;
  }

  return {
    versionDirFor,
    versionFilePath,
    timestampName,
    readIndexJson,
    saveVersion,
    pruneVersions,
    listVersions,
    readVersion,
    pinVersion,
    recordCurrentNote,
    getCurrentNote,
    setVersionNote
  };
}

module.exports = {
  createVersionStore,
  timestampName,
  VERSION_FILE_RE,
  MAX_VERSION_NOTE,
  contentHash,
  cleanVersionNote,
  normalizeVersionNote,
  sanitizeVersionIndex
};
