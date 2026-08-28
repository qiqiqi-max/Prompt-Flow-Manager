// Prompt Flow Manager - Electron 主进程
// 负责窗口、文件系统操作、版本管理、回收站、配置、导出
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const archiver = require('archiver'); // 仅用于压缩导出
const { readZipMarkdownEntries, sanitizeTitle, uniqueRel } = require('./lib/zip-import');

// 某些 Windows 环境 GPU 驱动/运行库缺失，禁用 GPU 硬件加速避免 GPU 进程崩溃。
// 软件渲染对提示词管理器这种轻量界面性能完全足够。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-direct-composition');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// 沙箱在某些缺少运行库的环境会导致渲染进程 DLL 缺失，关闭以保证启动。
app.commandLine.appendSwitch('no-sandbox');

// 两个根目录必须严格区分，混用会导致打包版白屏：
// - CODE_ROOT：随包分发的只读代码资源（preload.js / src/）。打包后位于 asar 内部，
//   必须用 __dirname 定位，绝不能指向 userData（那里没有这些文件）。
// - DATA_ROOT：用户数据（prompts / workflows / templates / .versions / .trash）。
//   打包后 asar 只读，所以落到可写的 userData；开发模式就用项目目录，方便直接看文件。
const CODE_ROOT = __dirname;
// PFM_DATA_DIR 仅供自动化测试使用：把数据目录指到临时位置，
// 这样功能自检可以随便增删文件而不碰用户真实的提示词库。
const DATA_ROOT = process.env.PFM_DATA_DIR
  ? path.resolve(process.env.PFM_DATA_DIR)
  : (app.isPackaged ? app.getPath('userData') : __dirname);
const PROMPTS_DIR = path.join(DATA_ROOT, 'prompts');
const WORKFLOWS_DIR = path.join(DATA_ROOT, 'workflows');
const TEMPLATES_DIR = path.join(DATA_ROOT, 'templates');
const VERSIONS_DIR = path.join(DATA_ROOT, '.versions');
const TRASH_DIR = path.join(DATA_ROOT, '.trash');
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

// 打包后首次运行：从 asar 内拷出种子资源到 Data 目录
function ensureSeedData() {
  // 只写 stdout，不再往数据目录追加 debug.log（那会无限增长）。
  const log = (msg) => console.log('[ensureSeedData] ' + msg);
  if (!app.isPackaged) return;
  try {
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    const seedRoot = CODE_ROOT;
    for (const dir of ['prompts', 'workflows', 'templates']) {
      const dest = path.join(DATA_ROOT, dir);
      const src = path.join(seedRoot, dir);
      const destExists = fs.existsSync(dest);
      const destHasContent = destExists && fs.readdirSync(dest).length > 0;
      const srcExists = fs.existsSync(src);
      log(dir + ': src=' + src + ' exists=' + srcExists + ', destExists=' + destExists + ', destHasContent=' + destHasContent);
      if (destHasContent) { log('  skip ' + dir + ' (has content)'); continue; }
      if (srcExists) {
        log('  copying ' + dir);
        copyDirSync(src, dest);
        log('  done ' + dir + ', files=' + fs.readdirSync(dest).length);
      } else {
        log('  seed MISSING for ' + dir);
      }
    }
    log('FINISHED');
  } catch (e) {
    log('ERROR: ' + e.message + '\n' + e.stack);
  }
}
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

const STAGES = ['project-init', 'code-generation', 'code-review', 'testing', 'deployment'];
const STAGE_LABELS = {
  'project-init': '项目初始化',
  'code-generation': '代码生成',
  'code-review': '代码审查',
  'testing': '测试',
  'deployment': '部署'
};
const DEFAULT_PROJECT_TYPES = ['前端项目', '后端项目', '数据分析', '脚本工具', '其他'];
const MAX_UNPINNED_VERSIONS = 30;

let win = null;

// ---------- 路径安全 ----------
// 标准化根目录，避免因盘符大小写/分隔符差异导致 startsWith 误判。
const DATA_ROOT_NORM = path.normalize(DATA_ROOT);
function safeJoin(relPath) {
  if (relPath == null) throw new Error('路径为空');
  const rel = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.includes('\0')) throw new Error('路径含非法字符');
  const resolved = path.resolve(DATA_ROOT_NORM, rel);
  const rel2 = path.relative(DATA_ROOT_NORM, resolved);
  // 相对路径以 .. 开头说明逃逸出了根目录
  if (rel2.startsWith('..')) throw new Error('路径越权: ' + relPath);
  return resolved;
}

// ---------- frontmatter 解析（主进程权威） ----------
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const yaml = m[1];
  const body = m[2];
  const meta = {};
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if (val === 'true') {
      val = true;
    } else if (val === 'false') {
      val = false;
    } else if (/^-?\d+$/.test(val)) {
      val = parseInt(val, 10);
    } else {
      val = val.replace(/^["']|["']$/g, '');
    }
    meta[key] = val;
  }
  return { meta, body };
}

// 原地更新自动字段（version/updatedAt/createdAt），保留其余 frontmatter 与正文原样。
// 这样 workflow 的 flow 多行数组等结构不会被破坏。
function bumpAutoFields(content, prevContent) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const prevMeta = prevContent != null ? parseFrontmatter(prevContent).meta : {};
  const curMeta = m ? parseFrontmatter(content).meta : {};
  const prevVer = (curMeta.version != null ? Number(curMeta.version) : null) || (prevMeta.version != null ? Number(prevMeta.version) : null) || 0;
  const newVersion = prevVer + 1;
  const now = new Date().toISOString().replace(/\.\d+Z$/, '');
  const createdAt = curMeta.createdAt || prevMeta.createdAt || now;

  if (!m) {
    const fm = ['---', `version: ${newVersion}`, `updatedAt: ${now}`, `createdAt: ${createdAt}`, '---', ''].join('\n');
    return fm + content;
  }
  let yaml = m[1];
  const body = m[2];
  const setField = (text, key, val) => {
    const re = new RegExp('^(' + key + '):\\s*.*$', 'm');
    if (re.test(text)) return text.replace(re, `$1: ${val}`);
    return text.replace(/\s*$/, '') + '\n' + `${key}: ${val}`;
  };
  yaml = setField(yaml, 'version', newVersion);
  yaml = setField(yaml, 'updatedAt', now);
  yaml = setField(yaml, 'createdAt', createdAt);
  return `---\n${yaml}\n---\n${body}`;
}

function stripFrontmatter(content) {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return m ? m[1] : content;
}

// ---------- 版本管理 ----------
// 版本目录同样要做越权校验：relPath 来自渲染进程，不能直接拼进 path.join。
function versionDirFor(relPath) {
  const rel = String(relPath == null ? '' : relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) throw new Error('路径为空');
  if (rel.includes('\0')) throw new Error('路径含非法字符');
  const resolved = path.resolve(VERSIONS_DIR, rel);
  if (path.relative(VERSIONS_DIR, resolved).startsWith('..')) throw new Error('路径越权: ' + relPath);
  return resolved;
}

// 版本文件名由本程序生成，只允许 <时间戳>.md 或 restored-<数字>-<时间戳>.md 形态，
// 防止 file 参数被拿来穿越目录。
const VERSION_FILE_RE = /^(?:restored-\d+-)?\d{8}-\d{6}(?:-\d{3})?\.md$/;
function versionFilePath(relPath, file) {
  const name = String(file == null ? '' : file);
  if (!VERSION_FILE_RE.test(name)) throw new Error('非法的版本文件名: ' + name);
  return path.join(versionDirFor(relPath), name);
}

// 带毫秒：同一秒内连续保存不会覆盖同名快照。
// 仍保持"字典序 == 时间序"，因为各字段都是定宽零填充的。
function timestampName() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function saveVersion(relPath, content) {
  const dir = versionDirFor(relPath);
  await ensureDir(dir);
  const name = timestampName() + '.md';
  await fsp.writeFile(path.join(dir, name), content, 'utf8');
  await pruneVersions(relPath);
}

async function readVersionIndex(relPath) {
  const idxPath = path.join(versionDirFor(relPath), 'index.json');
  try {
    return JSON.parse(await fsp.readFile(idxPath, 'utf8'));
  } catch {
    return { pinned: {} };
  }
}

async function writeVersionIndex(relPath, index) {
  const dir = versionDirFor(relPath);
  await ensureDir(dir);
  await fsp.writeFile(path.join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
}

async function pruneVersions(relPath) {
  const dir = versionDirFor(relPath);
  let files;
  try {
    files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md'));
  } catch {
    return;
  }
  if (files.length <= MAX_UNPINNED_VERSIONS) return; // 未星标数必然也未超限，快速返回
  const index = await readVersionIndex(relPath);
  const pinned = index.pinned || {};
  // 星标版本不计入上限、永不自动删除，所以配额只按未星标数量计算。
  const unpinned = files.filter(f => !pinned[f]).sort(); // 时间戳字典序 = 时间序
  const excess = unpinned.length - MAX_UNPINNED_VERSIONS;
  if (excess <= 0) return;
  for (const f of unpinned.slice(0, excess)) { // slice(0, n) = 最旧的 n 个
    try { await fsp.unlink(path.join(dir, f)); } catch {}
  }
}

// ---------- 回收站 ----------
async function readTrashIndex() {
  try {
    return JSON.parse(await fsp.readFile(path.join(TRASH_DIR, 'index.json'), 'utf8'));
  } catch {
    return { items: [] };
  }
}
async function writeTrashIndex(index) {
  await ensureDir(TRASH_DIR);
  await fsp.writeFile(path.join(TRASH_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
}

// ---------- 配置 ----------
async function loadConfig() {
  const defaults = {
    theme: 'light',
    windowBounds: { width: 1200, height: 780 },
    projectTypes: DEFAULT_PROJECT_TYPES,
    lockedFiles: []
  };
  try {
    const cfg = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
    return { ...defaults, ...cfg, windowBounds: { ...defaults.windowBounds, ...(cfg.windowBounds || {}) } };
  } catch {
    return defaults;
  }
}
async function saveConfig(cfg) {
  try { await fsp.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) { console.error(e); }
}

// ---------- 目录树 ----------
async function buildSubTree(dir, baseRel) {
  const nodes = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return nodes; // 目录不存在或不可读：当作空目录，不阻塞整棵树
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = baseRel ? `${baseRel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const children = await buildSubTree(path.join(dir, e.name), rel);
      if (children.length) nodes.push({ type: 'dir', name: e.name, rel, children });
    } else if (e.name.toLowerCase().endsWith('.md')) {
      nodes.push({ type: 'file', name: e.name, rel });
    }
  }
  return nodes;
}

async function listTree() {
  return [
    { type: 'dir', name: 'prompts', rel: 'prompts', children: await buildSubTree(PROMPTS_DIR, 'prompts') },
    { type: 'dir', name: 'workflows', rel: 'workflows', children: await buildSubTree(WORKFLOWS_DIR, 'workflows') },
    { type: 'dir', name: 'templates', rel: 'templates', children: await buildSubTree(TEMPLATES_DIR, 'templates') }
  ];
}

// ---------- 元数据列表（用于筛选） ----------
async function getMetaList() {
  const out = [];
  for (const top of ['prompts', 'workflows', 'templates']) {
    const rootDir = top === 'prompts' ? PROMPTS_DIR : top === 'workflows' ? WORKFLOWS_DIR : TEMPLATES_DIR;
    const walk = async (dir, baseRel) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const rel = `${baseRel}/${e.name}`;
        if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
        else if (e.name.toLowerCase().endsWith('.md')) {
          let content = '';
          try { content = await fsp.readFile(path.join(dir, e.name), 'utf8'); } catch {}
          const { meta } = parseFrontmatter(content);
          let stage = null;
          if (top === 'prompts') {
            const segs = rel.split('/');
            stage = segs.length > 2 ? segs[1] : null;
          }
          out.push({ rel, name: e.name, meta, stage, top });
        }
      }
    };
    await walk(rootDir, top);
  }
  return out;
}

// ---------- 全文搜索 ----------
async function searchAll(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const meta = await getMetaList();
  const results = [];
  for (const item of meta) {
    let content = '';
    try { content = await fsp.readFile(safeJoin(item.rel), 'utf8'); } catch {}
    const nameHit = (item.meta.title || item.name).toLowerCase().includes(q);
    const tagHit = Array.isArray(item.meta.tags) && item.meta.tags.some(t => String(t).toLowerCase().includes(q));
    const bodyRaw = stripFrontmatter(content);
    const body = bodyRaw.toLowerCase();
    const bodyIdx = body.indexOf(q);
    let rank = 0, snippet = '';
    if (nameHit) rank = 3;
    else if (tagHit) rank = 2;
    else if (bodyIdx >= 0) {
      rank = 1;
      const start = Math.max(0, bodyIdx - 30);
      snippet = '…' + bodyRaw.slice(start, bodyIdx + 80) + '…';
    } else continue;
    results.push({ rel: item.rel, name: item.meta.title || item.name, stage: item.stage, projectType: item.meta.projectType, rank, snippet });
  }
  results.sort((a, b) => b.rank - a.rank);
  return results.slice(0, 60);
}

// ---------- IPC ----------
ipcMain.handle('get-root', () => DATA_ROOT);
ipcMain.handle('log', (e, msg) => { console.log('[renderer]', String(msg)); });

ipcMain.handle('list-tree', async () => {
  await ensureDirs();
  return listTree();
});

ipcMain.handle('read-file', async (e, rel) => {
  const full = safeJoin(rel);
  const content = await fsp.readFile(full, 'utf8');
  const { meta } = parseFrontmatter(content);
  return { content, meta };
});

ipcMain.handle('save-file', async (e, rel, content) => {
  const full = safeJoin(rel);
  let prev = null;
  try { prev = await fsp.readFile(full, 'utf8'); } catch {}
  if (prev != null && prev !== content) await saveVersion(rel, prev);
  const toWrite = bumpAutoFields(content, prev);
  await ensureDir(path.dirname(full));
  await fsp.writeFile(full, toWrite, 'utf8');
  return { content: toWrite, meta: parseFrontmatter(toWrite).meta };
});

async function createFileAt(rel, content) {
  const full = safeJoin(rel);
  if (fs.existsSync(full)) throw new Error('文件已存在: ' + rel);
  await ensureDir(path.dirname(full));
  const toWrite = bumpAutoFields(content, null);
  await fsp.writeFile(full, toWrite, 'utf8');
  return { content: toWrite, meta: parseFrontmatter(toWrite).meta };
}

ipcMain.handle('create-file', (e, rel, content) => createFileAt(rel, content));

ipcMain.handle('rename', async (e, oldRel, newRel) => {
  const oldFull = safeJoin(oldRel);
  const newFull = safeJoin(newRel);
  if (fs.existsSync(newFull)) throw new Error('目标已存在: ' + newRel);
  await ensureDir(path.dirname(newFull));
  await fsp.rename(oldFull, newFull);
  // 版本目录跟随
  const oldV = versionDirFor(oldRel);
  const newV = versionDirFor(newRel);
  if (fs.existsSync(oldV)) {
    await ensureDir(path.dirname(newV));
    await fsp.rename(oldV, newV);
  }
  // 锁定标记跟随改名，避免"改名 → 删除"绕过锁
  const cfg = await loadConfig();
  if (Array.isArray(cfg.lockedFiles) && cfg.lockedFiles.includes(oldRel)) {
    const next = cfg.lockedFiles.filter(r => r !== oldRel);
    if (!next.includes(newRel)) next.push(newRel);
    await updateConfig({ lockedFiles: next });
  }
  return true;
});

async function isLocked(rel) {
  const cfg = await loadConfig();
  return Array.isArray(cfg.lockedFiles) && cfg.lockedFiles.includes(rel);
}

ipcMain.handle('trash', async (e, rel) => {
  const full = safeJoin(rel);
  if (await isLocked(rel)) throw new Error('文件已锁定，无法删除: ' + rel);
  if (!fs.existsSync(full)) return true;
  await ensureDir(TRASH_DIR);
  const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const ext = path.extname(rel);
  let storeName = id + ext;
  // 回收站内极少可能重名（id 含随机数），但保险起见仍做检查
  while (fs.existsSync(path.join(TRASH_DIR, storeName))) {
    storeName = `${id}-${Math.floor(Math.random() * 1e6)}${ext}`;
  }
  const storePath = path.join(TRASH_DIR, storeName);
  await fsp.rename(full, storePath);
  const index = await readTrashIndex();
  // 版本目录一并移入回收站（若存在），恢复时一起还原
  let versionStore = null;
  const vDir = versionDirFor(rel);
  if (fs.existsSync(vDir)) {
    const vStoreName = `${id}-versions`;
    let vStorePath = path.join(TRASH_DIR, vStoreName);
    while (fs.existsSync(vStorePath)) {
      vStorePath = path.join(TRASH_DIR, `${id}-${Math.floor(Math.random() * 1e6)}-versions`);
    }
    await fsp.rename(vDir, vStorePath);
    versionStore = path.basename(vStorePath);
  }
  index.items.unshift({ id, originalRel: rel, name: path.basename(rel), trashedAt: new Date().toISOString(), store: storeName, versionStore });
  await writeTrashIndex(index);
  // 清掉锁列表里的残留条目
  const cfg = await loadConfig();
  if (Array.isArray(cfg.lockedFiles) && cfg.lockedFiles.includes(rel)) {
    await updateConfig({ lockedFiles: cfg.lockedFiles.filter(r => r !== rel) });
  }
  return true;
});

ipcMain.handle('list-trash', async () => readTrashIndex());

ipcMain.handle('restore', async (e, id) => {
  const index = await readTrashIndex();
  const item = index.items.find(i => i.id === id);
  if (!item) throw new Error('回收站项不存在');
  const storePath = path.join(TRASH_DIR, item.store);
  const targetFull = safeJoin(item.originalRel);
  await ensureDir(path.dirname(targetFull));
  let finalRel = item.originalRel;
  if (fs.existsSync(targetFull)) {
    // 原位置已有同名，加后缀
    const ext = path.extname(item.originalRel);
    const base = item.originalRel.slice(0, -ext.length);
    let n = 1;
    let alt = item.originalRel;
    while (fs.existsSync(safeJoin(alt))) {
      alt = `${base}-restored${n}${ext}`;
      n++;
    }
    await fsp.rename(storePath, safeJoin(alt));
    finalRel = alt;
  } else {
    await fsp.rename(storePath, targetFull);
  }
  // 还原版本目录（若存在）。若目标版本目录已存在（同名文件被删后又重建过），
  // 不覆盖，而是并到新名字下保留两份历史。
  if (item.versionStore) {
    const vStorePath = path.join(TRASH_DIR, item.versionStore);
    try {
      if (fs.existsSync(vStorePath)) {
        const targetV = versionDirFor(finalRel);
        if (fs.existsSync(targetV)) {
          // 已有版本目录：把回收站里的版本文件并进去（加 -restored 前缀避免覆盖）
          const files = await fsp.readdir(vStorePath);
          for (const f of files) {
            const src = path.join(vStorePath, f);
            let dstName = f;
            while (fs.existsSync(path.join(targetV, dstName))) {
              dstName = 'restored-' + Math.floor(Math.random() * 1e6) + '-' + f;
            }
            await fsp.rename(src, path.join(targetV, dstName));
          }
          try { await fsp.rmdir(vStorePath); } catch {}
        } else {
          await ensureDir(path.dirname(targetV));
          await fsp.rename(vStorePath, targetV);
        }
      }
    } catch (e) { console.error('还原版本目录失败:', e); }
  }
  index.items = index.items.filter(i => i.id !== id);
  await writeTrashIndex(index);
  return true;
});

ipcMain.handle('empty-trash', async () => {
  const index = await readTrashIndex();
  for (const item of index.items) {
    try { await fsp.unlink(path.join(TRASH_DIR, item.store)); } catch {}
    if (item.versionStore) {
      try { await fsp.rm(path.join(TRASH_DIR, item.versionStore), { recursive: true, force: true }); } catch {}
    }
  }
  await writeTrashIndex({ items: [] });
  return true;
});

ipcMain.handle('list-versions', async (e, rel) => {
  const dir = versionDirFor(rel);
  let files;
  try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md')); } catch { return []; }
  const index = await readVersionIndex(rel);
  const list = files.map(f => {
    const ts = f.replace(/\.md$/, '');
    return { file: f, timestamp: ts, pinned: !!(index.pinned && index.pinned[f]) };
  }).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return list;
});

ipcMain.handle('read-version', async (e, rel, file) => {
  return fsp.readFile(versionFilePath(rel, file), 'utf8');
});

ipcMain.handle('pin-version', async (e, rel, file, pinned) => {
  const index = await readVersionIndex(rel);
  index.pinned = index.pinned || {};
  if (pinned) index.pinned[file] = true; else delete index.pinned[file];
  await writeVersionIndex(rel, index);
  return true;
});

ipcMain.handle('rollback-version', async (e, rel, file) => {
  const full = safeJoin(rel);
  const versionFull = versionFilePath(rel, file);
  const versionContent = await fsp.readFile(versionFull, 'utf8');
  let prev = null;
  try { prev = await fsp.readFile(full, 'utf8'); } catch {}
  // 当前内容先存为新版本（不丢失）
  if (prev != null && prev !== versionContent) await saveVersion(rel, prev);
  // 回滚写入（作为新一次保存，bump 自动字段）
  const toWrite = bumpAutoFields(versionContent, prev);
  await fsp.writeFile(full, toWrite, 'utf8');
  return { content: toWrite, meta: parseFrontmatter(toWrite).meta };
});

ipcMain.handle('get-meta-list', async () => {
  await ensureDirs();
  return getMetaList();
});

ipcMain.handle('search', async (e, query) => searchAll(query));

ipcMain.handle('get-config', async () => loadConfig());

async function updateConfig(patch) {
  const cur = await loadConfig();
  const next = { ...cur, ...(patch || {}) };
  await saveConfig(next);
  return next;
}

ipcMain.handle('set-config', (e, cfg) => updateConfig(cfg));

ipcMain.handle('confirm', async (e, message) => {
  const res = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['取消', '确定'],
    defaultId: 1,
    cancelId: 0,
    message: '确认',
    detail: message
  });
  return res.response === 1;
});

ipcMain.handle('export-zip', async () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const res = await dialog.showSaveDialog(win, {
    title: '导出备份',
    defaultPath: `prompt-backup-${stamp}.zip`,
    filters: [{ name: 'ZIP', extensions: ['zip'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(res.filePath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    archive.directory(PROMPTS_DIR, 'prompts', {});
    archive.directory(WORKFLOWS_DIR, 'workflows', {});
    archive.directory(TEMPLATES_DIR, 'templates', {});
    archive.finalize();
  });
  return { ok: true, path: res.filePath };
});

ipcMain.handle('export-single', async (e, rel) => {
  const full = safeJoin(rel);
  const meta = parseFrontmatter(await fsp.readFile(full, 'utf8')).meta;
  const fileName = (meta.title || path.basename(rel, '.md')) + '.md';
  const res = await dialog.showSaveDialog(win, {
    title: '导出提示词',
    defaultPath: fileName,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  await fsp.writeFile(res.filePath, await fsp.readFile(full, 'utf8'), 'utf8');
  return { ok: true, path: res.filePath };
});

// ---------- 导入辅助 ----------
// 依据 frontmatter 决定落库位置，返回实际写入的相对路径。
async function importMarkdown(fileName, content) {
  const { meta } = parseFrontmatter(content);
  const title = sanitizeTitle(meta.title || path.basename(fileName, '.md'));
  const stage = (meta.stage && STAGES.includes(meta.stage)) ? meta.stage : 'project-init';
  const rel = uniqueRel(`prompts/${stage}/${title}.md`, (r) => fs.existsSync(safeJoin(r)));
  await createFileAt(rel, content);
  return rel;
}

ipcMain.handle('import-single', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '导入提示词',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false };
  const srcPath = res.filePaths[0];
  const content = await fsp.readFile(srcPath, 'utf8');
  const rel = await importMarkdown(path.basename(srcPath), content);
  return { ok: true, rel };
});

ipcMain.handle('import-zip', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '导入备份包',
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false };
  const zipPath = res.filePaths[0];
  const { entries, skipped } = await readZipMarkdownEntries(zipPath);
  const imported = [];
  const failedList = skipped.map(s => ({ name: s.name, error: s.reason }));
  for (const entry of entries) {
    try {
      imported.push(await importMarkdown(entry.name, entry.content));
    } catch (err) {
      failedList.push({ name: entry.name, error: err.message });
    }
  }
  // 不静默成功：调用方能看到真实导入数量与失败明细
  return { ok: true, imported: imported.length, rels: imported, failed: failedList };
});

ipcMain.handle('get-stages', () => ({ stages: STAGES, labels: STAGE_LABELS }));

ipcMain.handle('add-project-type', async (e, type) => {
  if (!type || typeof type !== 'string') throw new Error('类型名称无效');
  const t = String(type).trim();
  if (!t) throw new Error('类型名称不能为空');
  const cfg = await loadConfig();
  const list = Array.isArray(cfg.projectTypes) ? [...cfg.projectTypes] : [...DEFAULT_PROJECT_TYPES];
  if (list.includes(t)) throw new Error('类型已存在');
  list.push(t);
  return await updateConfig({ projectTypes: list });
});

ipcMain.handle('remove-project-type', async (e, type) => {
  const cfg = await loadConfig();
  const list = Array.isArray(cfg.projectTypes) ? [...cfg.projectTypes] : [...DEFAULT_PROJECT_TYPES];
  if (list.length <= 1) throw new Error('至少保留一个类型');
  const idx = list.indexOf(type);
  if (idx === -1) return await updateConfig({});
  list.splice(idx, 1);
  return await updateConfig({ projectTypes: list });
});

// ---------- 启动 ----------
async function ensureDirs() {
  for (const d of [PROMPTS_DIR, WORKFLOWS_DIR, TEMPLATES_DIR, VERSIONS_DIR, TRASH_DIR]) {
    await ensureDir(d);
  }
  // 确保阶段子目录存在
  for (const s of STAGES) await ensureDir(path.join(PROMPTS_DIR, s));
}

// ---------- 自检（PFM_SELFTEST=1） ----------
// 存在的理由：这个应用出过两类"进程能起来但界面是白的"的故障
//   1) renderer.js 顶层与其他脚本重名，整段脚本不执行；
//   2) 打包后 preload / index.html 路径指向了数据目录。
// 这两种问题只有真正把页面加载起来才暴露得出来，纯静态检查测不到，
// 所以提供一个无人工干预的自检入口供 CI / 冒烟测试调用。
function attachSelfTest(targetWin) {
  const consoleErrors = [];
  targetWin.webContents.on('console-message', (e, level, message) => {
    if (level >= 2) consoleErrors.push(message); // 2=warning 以上，3=error
  });
  const loaded = new Promise((resolve, reject) => {
    targetWin.webContents.once('did-finish-load', () => resolve());
    targetWin.webContents.once('did-fail-load', (e, code, desc, url) =>
      reject(new Error(`页面加载失败 code=${code} desc=${desc} url=${url}`)));
  });

  const probeScript = `(async () => {
    // 轮询等渲染进程完成首次 IPC 拉取
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (document.querySelectorAll('#tree .tree-row, #tree [data-rel], #tree > *').length > 0) break;
      await new Promise(r => setTimeout(r, 100));
    }
    return {
      bridgeReady: typeof window.promptFlowApi === 'object' && window.promptFlowApi !== null,
      nodeLeak: typeof window.require !== 'undefined' || typeof window.module !== 'undefined',
      markedReady: !!(window.marked && typeof window.marked.marked === 'function'),
      purifyReady: !!(window.DOMPurify && typeof window.DOMPurify.sanitize === 'function'),
      dmpReady: typeof window.diff_match_patch === 'function',
      i18nReady: typeof I18N === 'object' && !!I18N.zh,
      treeNodes: document.querySelectorAll('#tree > *').length,
      title: document.title
    };
  })()`;

  // 在页面里跑，直接调 contextBridge 暴露的 API → 真实经过 IPC 与主进程逻辑。
  const functionalScript = `(async () => {
    const api = window.promptFlowApi;
    const out = [];
    const check = (name, ok, detail) => out.push([name, !!ok, detail || '']);
    const expectThrow = async (name, fn) => {
      try { await fn(); check(name, false, '本应抛错但成功了'); }
      catch (e) { check(name, true); }
    };
    const rel = 'prompts/testing/自检临时.md';
    try {
      // 1. 新建
      await api.createFile(rel, '---\\ntitle: 自检临时\\nstage: testing\\n---\\n第一版正文');
      let read = await api.readFile(rel);
      check('新建提示词并自动写入 frontmatter', read.meta.version === 1 && !!read.meta.createdAt, JSON.stringify(read.meta));

      // 2. 保存 → 产生版本快照 + version 自增
      await api.saveFile(rel, read.content.replace('第一版正文', '第二版正文'));
      read = await api.readFile(rel);
      check('保存后 version 自增', read.meta.version === 2, 'version=' + read.meta.version);
      check('保存后正文已更新', read.content.includes('第二版正文'));

      let versions = await api.listVersions(rel);
      check('保存产生了 1 条历史版本', versions.length === 1, '共 ' + versions.length + ' 条');
      const oldVersion = await api.readVersion(rel, versions[0].file);
      check('历史版本存的是修改前的内容', oldVersion.includes('第一版正文'));

      // 3. 星标
      await api.pinVersion(rel, versions[0].file, true);
      versions = await api.listVersions(rel);
      check('版本可星标', versions[0].pinned === true);

      // 4. 回滚
      await api.rollbackVersion(rel, versions[0].file);
      read = await api.readFile(rel);
      check('回滚后正文回到旧版', read.content.includes('第一版正文'));
      versions = await api.listVersions(rel);
      check('回滚前的内容也被存成新版本（不丢）', versions.length === 2, '共 ' + versions.length + ' 条');

      // 5. 锁定：主进程必须拦住删除
      await api.setConfig({ lockedFiles: [rel] });
      await expectThrow('已锁定的文件删不掉（主进程强制）', () => api.trash(rel));

      // 6. 锁定状态下改名，锁要跟着走
      const renamed = 'prompts/testing/自检改名.md';
      await api.rename(rel, renamed);
      const cfg = await api.getConfig();
      check('改名后锁跟随文件', Array.isArray(cfg.lockedFiles) && cfg.lockedFiles.includes(renamed), JSON.stringify(cfg.lockedFiles));
      await expectThrow('改名后依然删不掉（无法绕过锁）', () => api.trash(renamed));
      const renamedVersions = await api.listVersions(renamed);
      check('改名后版本历史跟随', renamedVersions.length === 2, '共 ' + renamedVersions.length + ' 条');

      // 7. 解锁 → 删除 → 回收站 → 恢复
      await api.setConfig({ lockedFiles: [] });
      await api.trash(renamed);
      let trash = await api.listTrash();
      const item = trash.items.find(i => i.originalRel === renamed);
      check('删除进入回收站', !!item);
      await api.restore(item.id);
      const restored = await api.readFile(renamed);
      check('从回收站恢复成功', restored.content.includes('第一版正文'));
      check('恢复后版本历史也回来了', (await api.listVersions(renamed)).length === 2);

      // 8. 搜索与元数据
      const hits = await api.search('第一版正文');
      check('全文搜索命中正文', hits.some(h => h.rel === renamed), '命中 ' + hits.length + ' 条');
      const metas = await api.getMetaList();
      check('元数据列表包含该文件', metas.some(m => m.rel === renamed));
      const tree = await api.listTree();
      check('文件树包含 prompts/workflows/templates 三个根', tree.length === 3);

      // 9. 越权防护
      await expectThrow('拒绝读取库外文件（路径穿越）', () => api.readFile('../../../../Windows/win.ini'));
      await expectThrow('拒绝写入库外文件', () => api.saveFile('../../../evil.md', 'x'));
      await expectThrow('拒绝非法的版本文件名', () => api.readVersion(renamed, '../../../../Windows/win.ini'));

      // 10. 工程类型增删
      const before = (await api.getConfig()).projectTypes.length;
      await api.addProjectType('自检类型');
      check('可新增工程类型', (await api.getConfig()).projectTypes.includes('自检类型'));
      await api.removeProjectType('自检类型');
      check('可移除工程类型', (await api.getConfig()).projectTypes.length === before);
      await expectThrow('重复类型名被拒绝', async () => {
        await api.addProjectType('重复项');
        await api.addProjectType('重复项');
      });

      // 清理
      await api.trash(renamed);
      await api.emptyTrash();
      check('清空回收站后为空', (await api.listTrash()).items.length === 0);
    } catch (e) {
      check('功能自检执行中断', false, e && e.message ? e.message : String(e));
    }
    return out;
  })()`;

  return {
    run: async () => {
      const fail = (msg) => { console.error('[selftest] FAIL ' + msg); process.exitCode = 1; };
      try {
        await loaded;
        const r = await targetWin.webContents.executeJavaScript(probeScript, true);
        const checks = [
          ['contextBridge 已注入 window.promptFlowApi', r.bridgeReady],
          ['渲染进程无 Node 能力泄漏（require/module 不可见）', !r.nodeLeak],
          ['marked 已加载', r.markedReady],
          ['DOMPurify 已加载', r.purifyReady],
          ['diff-match-patch 已加载', r.dmpReady],
          ['I18N 全局可用', r.i18nReady],
          ['文件树已渲染出节点（' + r.treeNodes + ' 个）', r.treeNodes > 0]
        ];
        for (const [name, ok] of checks) {
          if (ok) console.log('[selftest] PASS ' + name);
          else fail(name);
        }
        if (consoleErrors.length) fail('渲染进程报错: ' + consoleErrors.join(' | '));
        // 功能自检：真正走一遍 IPC（新建→保存→版本→回滚→锁定→删除→恢复→搜索）。
        // 必须配合 PFM_DATA_DIR 指向临时目录，否则会动到真实提示词库。
        if (process.env.PFM_SELFTEST_FUNCTIONAL === '1') {
          if (!process.env.PFM_DATA_DIR) {
            fail('功能自检必须设置 PFM_DATA_DIR，拒绝在真实数据目录上跑');
          } else {
            const fnResults = await targetWin.webContents.executeJavaScript(functionalScript, true);
            for (const [name, ok, detail] of fnResults) {
              if (ok) console.log('[selftest:fn] PASS ' + name);
              else fail('[fn] ' + name + (detail ? ' → ' + detail : ''));
            }
          }
        }
        // PFM_SELFTEST_SHOT=<路径> 时顺手存一张真实渲染截图，便于人工核对界面
        if (process.env.PFM_SELFTEST_SHOT) {
          const image = await targetWin.webContents.capturePage();
          fs.writeFileSync(process.env.PFM_SELFTEST_SHOT, image.toPNG());
          console.log('[selftest] 截图已保存: ' + process.env.PFM_SELFTEST_SHOT);
        }
      } catch (e) {
        fail(e.message);
      } finally {
        console.log('[selftest] ' + (process.exitCode ? '有失败项' : '全部通过'));
        app.exit(process.exitCode || 0);
      }
    }
  };
}

async function createWindow() {
  const config = await loadConfig();
  win = new BrowserWindow({
    width: config.windowBounds.width,
    height: config.windowBounds.height,
    x: config.windowBounds.x,
    y: config.windowBounds.y,
    minWidth: 800,
    minHeight: 500,
    title: 'Prompt Flow Manager',
    backgroundColor: config.theme === 'dark' ? '#1e1e1e' : '#ffffff',
    webPreferences: {
      preload: path.join(CODE_ROOT, 'preload.js'),
      // 渲染进程不给 Node 能力：导入的 .md 属外部内容，若 DOMPurify 被绕过，
      // nodeIntegration 会让一次 XSS 直接升级成任意代码执行。
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox 维持关闭：部分缺运行库的 Windows 环境开启后渲染进程会因缺 DLL 起不来
      // （与文件开头的 --no-sandbox 开关配套）。进程隔离由 contextIsolation 承担。
      sandbox: false,
      webgl: false
    }
  });
  const selfTest = process.env.PFM_SELFTEST === '1' ? attachSelfTest(win) : null;
  win.loadFile(path.join(CODE_ROOT, 'src', 'index.html'));
  if (selfTest) selfTest.run();

  // resize / move 会以每秒几十次的频率触发。不防抖会疯狂读写 config.json，
  // 且多个 loadConfig→saveConfig 交错时会互相覆盖甚至写坏文件。
  let boundsTimer = null;
  let boundsWriting = false;
  const flushBounds = async () => {
    if (boundsWriting || !win || win.isDestroyed()) return;
    boundsWriting = true;
    try {
      const cfg = await loadConfig();
      cfg.windowBounds = win.getBounds();
      await saveConfig(cfg);
    } catch (e) {
      console.error('保存窗口位置失败:', e);
    } finally {
      boundsWriting = false;
    }
  };
  const scheduleSaveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(flushBounds, 500);
  };
  win.on('resize', scheduleSaveBounds);
  win.on('move', scheduleSaveBounds);
  // 关窗前把待写入的尺寸落盘，否则最后一次调整会丢
  win.on('close', () => {
    if (boundsTimer) { clearTimeout(boundsTimer); boundsTimer = null; }
    if (win && !win.isDestroyed()) {
      try {
        const cfg = { windowBounds: win.getBounds() };
        const cur = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...cur, ...cfg }, null, 2), 'utf8');
      } catch (e) { console.error('关窗保存尺寸失败:', e); }
    }
  });

  buildMenu();
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (action) => win && win.webContents.send('menu-action', action);
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建提示词', accelerator: 'CmdOrCtrl+N', click: () => send('new-prompt') },
        { label: '新建工作流', click: () => send('new-workflow') },
        { type: 'separator' },
        { label: '导出备份(ZIP)', accelerator: 'CmdOrCtrl+E', click: () => send('export') },
        { label: '清空回收站', click: () => send('empty-trash') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '切换主题', accelerator: 'CmdOrCtrl+T', click: () => send('toggle-theme') },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  ensureSeedData();
  await ensureDirs();
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
