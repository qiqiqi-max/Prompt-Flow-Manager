// Prompt Flow Manager - Electron 主进程
// 负责窗口、文件系统操作、版本管理、回收站、配置、导出
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
// 统计读文件次数。搜索是唯一随库规模线性变差的操作，压测时用它量化 I/O。
let fileReadCount = 0;
function countedReadFile(fullPath) {
  fileReadCount++;
  return fsp.readFile(fullPath, 'utf8');
}

// ---------- 正文缓存 ----------
// 搜索要遍历整库读正文。用户在搜索框里连打几个字，库没变却要重读所有文件。
// 这里按 (mtime, size) 做缓存：每次仍然 stat（很便宜），只重读真正变过的文件。
// 所以外部编辑器改的文件也能被发现，不会读到旧内容。
// 已知边界：同一个 mtime 刻度内把文件改成同样大小会命中旧缓存，概率极低且两个
// 维度同时相等才会发生，代价只是搜索结果延迟一次刷新。
// 连 frontmatter 的解析结果一起缓存：getMetaList 每次都要对全库解析一遍，
// 在 1000 条规模下这部分和 stat 一样构成主要耗时。
// 搜索用的派生字段（去掉 frontmatter 的正文 + 其小写形式）同样缓存：
// 否则用户每敲一个字符，searchAll 就要对全库重做一次 stripFrontmatter 正则和
// toLowerCase 大字符串分配——1000 条规模下这是搜索剩余耗时的绝大部分，
// 而它们只随文件内容变化，和查询词无关，完全可以复用。
const contentCache = new Map(); // fullPath -> { mtimeMs, size, content, meta, bodyRaw, bodyLower }
let cacheHits = 0;
let cacheMisses = 0;

const EMPTY_ENTRY = { content: '', meta: {}, bodyRaw: '', bodyLower: '' };

async function readParsedCached(fullPath) {
  let st;
  try { st = await fsp.stat(fullPath); } catch { return EMPTY_ENTRY; }
  const hit = contentCache.get(fullPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    cacheHits++;
    return hit;
  }
  cacheMisses++;
  let content = '';
  try { content = await countedReadFile(fullPath); } catch { return EMPTY_ENTRY; }
  const bodyRaw = stripFrontmatter(content);
  const entry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    content,
    meta: parseFrontmatter(content).meta,
    bodyRaw,
    bodyLower: bodyRaw.toLowerCase()
  };
  contentCache.set(fullPath, entry);
  return entry;
}

// 文件被删除/移动后清掉对应缓存，避免 Map 无限增长
function dropFromCache(fullPath) {
  contentCache.delete(fullPath);
}
// stdout/stderr 的读取端一旦消失（从终端启动后关掉终端、被管道到提前退出的命令、
// 用 PowerShell 的 | Select-String 截流等），下一次 console.log 就会抛 EPIPE。
// 主进程里的未捕获异常会让 Electron 弹"A JavaScript error occurred in the main process"，
// 也就是说一条日志能把整个应用打挂。这里把流上的写错误吞掉，日志丢了无所谓，应用不能崩。
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') stream.on('error', () => {});
}

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
// 顶层目录名 → 绝对路径。遍历这三个目录的地方（listTree / getMetaList /
// listTreeAndMeta）都从这里取，避免三处各写一遍三元表达式。
const TOP_DIRS = { prompts: PROMPTS_DIR, workflows: WORKFLOWS_DIR, templates: TEMPLATES_DIR };
const VERSIONS_DIR = path.join(DATA_ROOT, '.versions');
const TRASH_DIR = path.join(DATA_ROOT, '.trash');
// 配置默认放 userData（不污染提示词目录）；设了 PFM_DATA_DIR 时跟着走，
// 否则测试改语言/主题会写进用户真实配置。
const CONFIG_PATH = path.join(process.env.PFM_DATA_DIR ? DATA_ROOT : app.getPath('userData'), 'config.json');

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

// ---------- 抛给渲染进程的错误 ----------
// 渲染进程要把错误翻译成用户语言，所以必须能机器识别。
// Electron 的 IPC 只把 Error.message 传过去（自定义属性会丢），
// 因此错误码只能编进 message：`<CODE>|<细节>`。
// 渲染侧用 describeError() 解析，未知码就原样显示。
function appError(code, detail) {
  return new Error(detail == null || detail === '' ? code : code + '|' + detail);
}

// ---------- 路径安全 ----------
// 标准化根目录，避免因盘符大小写/分隔符差异导致 startsWith 误判。
const DATA_ROOT_NORM = path.normalize(DATA_ROOT);
function safeJoin(relPath) {
  if (relPath == null) throw appError('E_PATH_EMPTY');
  const rel = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.includes('\0')) throw appError('E_PATH_BAD_CHAR');
  const resolved = path.resolve(DATA_ROOT_NORM, rel);
  const rel2 = path.relative(DATA_ROOT_NORM, resolved);
  // 相对路径以 .. 开头说明逃逸出了根目录
  if (rel2.startsWith('..')) throw appError('E_PATH_ESCAPE', relPath);
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
  if (!rel) throw appError('E_PATH_EMPTY');
  if (rel.includes('\0')) throw appError('E_PATH_BAD_CHAR');
  const resolved = path.resolve(VERSIONS_DIR, rel);
  if (path.relative(VERSIONS_DIR, resolved).startsWith('..')) throw appError('E_PATH_ESCAPE', relPath);
  return resolved;
}

// 版本文件名由本程序生成，只允许 <时间戳>.md 或 restored-<数字>-<时间戳>.md 形态，
// 防止 file 参数被拿来穿越目录。
const VERSION_FILE_RE = /^(?:restored-\d+-)?\d{8}-\d{6}(?:-\d{3})?\.md$/;
function versionFilePath(relPath, file) {
  const name = String(file == null ? '' : file);
  if (!VERSION_FILE_RE.test(name)) throw appError('E_BAD_VERSION_FILE', name);
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

// 配置写入必须串行。渲染进程有五个各自独立的 debounce 在写 config
// （tabs 500ms / recent 500ms / lockedFiles 400ms / sidebarWidth 400ms / expandedPaths 600ms），
// 一次"打开文件 + 拖宽侧边栏 + 展开目录"就会让它们在相近时刻落地。
// updateConfig 是 read-modify-write：若并发执行，各自读到同一份旧快照再全量写回，
// 后写的会把前写的字段整个覆盖掉，表现是偶发的"设置没保存上"，很难复现。
// 这里把所有 patch 排成一条 promise 链，每个 patch 都读到前一个的结果。
let configWriteChain = Promise.resolve();
function queueConfigWrite(fn) {
  const run = configWriteChain.then(fn, fn);
  // 链条本身不能因为某次失败而断掉，否则后续写入全被拒绝
  configWriteChain = run.then(() => {}, () => {});
  return run;
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

// 一次遍历同时产出文件树和元数据列表。
// 为什么合并：渲染进程每次 refreshTree 都要这两份数据，而 listTree 和 getMetaList
// 走的是同一套目录递归——分开调用等于把整库 readdir 两遍（新建/删除/重命名/移动/
// 保存后都会触发）。这里合成一次遍历、一次 IPC 往返。
// 语义必须与原来的两个函数逐字一致：目录为空则不出现在树里（children.length 判断），
// stage 只对 prompts 顶层的二级目录有意义。
async function listTreeAndMeta() {
  const meta = [];
  // 每个目录内的条目并发处理。串行 await 的代价实测很显著：1000 个文件
  // 逐个 stat 约 180ms，并发降到 25ms 量级——缓存命中时 stat 就是主要开销
  // （读文件次数为 0，字符串处理只占个位数毫秒）。
  // 顺序必须保持稳定：用 map 收集结果再按原序拼装，不要在回调里 push。
  const walk = async (dir, baseRel, top) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return []; // 目录不存在或不可读：当作空目录，不阻塞整棵树
    }
    const slots = await Promise.all(entries.map(async (e) => {
      if (e.name.startsWith('.')) return null;
      const rel = `${baseRel}/${e.name}`;
      if (e.isDirectory()) {
        const children = await walk(path.join(dir, e.name), rel, top);
        // 空目录不进树（与旧 buildSubTree 行为一致）
        if (!children.length) return null;
        return { node: { type: 'dir', name: e.name, rel, children } };
      }
      if (!e.name.toLowerCase().endsWith('.md')) return null;
      const entry = await readParsedCached(path.join(dir, e.name));
      let stage = null;
      if (top === 'prompts') {
        const segs = rel.split('/');
        stage = segs.length > 2 ? segs[1] : null;
      }
      return {
        node: { type: 'file', name: e.name, rel },
        metaItem: { rel, name: e.name, meta: entry.meta, stage, top }
      };
    }));
    const nodes = [];
    for (const slot of slots) {
      if (!slot) continue;
      nodes.push(slot.node);
      if (slot.metaItem) meta.push(slot.metaItem);
    }
    return nodes;
  };
  const tree = [];
  for (const top of ['prompts', 'workflows', 'templates']) {
    tree.push({ type: 'dir', name: top, rel: top, children: await walk(TOP_DIRS[top], top, top) });
  }
  return { tree, meta };
}

// ---------- 元数据列表（用于筛选） ----------
// includeContent=true 时把已经读到的正文一并带出来。
// 搜索需要正文，如果不带出去，searchAll 就得把每个文件再读一遍（2N 次 I/O）。
// 默认不带：get-meta-list 的结果要经 IPC 序列化给渲染进程，正文会白白拷一份。
async function getMetaList(includeContent = false) {
  const out = [];
  for (const top of ['prompts', 'workflows', 'templates']) {
    const rootDir = TOP_DIRS[top];
    // 目录内并发。缓存命中时每个文件仍要 stat 一次做失效判断，
    // 串行 await 让整库 stat 排成一条链——1000 文件实测约 180ms，
    // 并发后降到 25ms 量级。字符串处理只占个位数毫秒，不是瓶颈。
    // 结果按原序拼装，保持输出顺序稳定。
    const walk = async (dir, baseRel) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      const slots = await Promise.all(entries.map(async (e) => {
        if (e.name.startsWith('.')) return null;
        const rel = `${baseRel}/${e.name}`;
        if (e.isDirectory()) return { subdir: path.join(dir, e.name), rel };
        if (!e.name.toLowerCase().endsWith('.md')) return null;
        const entry = await readParsedCached(path.join(dir, e.name));
        let stage = null;
        if (top === 'prompts') {
          const segs = rel.split('/');
          stage = segs.length > 2 ? segs[1] : null;
        }
        const item = { rel, name: e.name, meta: entry.meta, stage, top };
        // 搜索走 includeContent=true，直接把缓存里的派生字段带过去（不再重算）。
        // 这些字段只在进程内使用，不经 IPC 发给渲染进程。
        if (includeContent) {
          item.content = entry.content;
          item.bodyRaw = entry.bodyRaw;
          item.bodyLower = entry.bodyLower;
        }
        return { item };
      }));
      // 子目录递归留在串行段：并发已经在每一层内部生效，
      // 再叠一层并发会把打开的文件句柄数放大到不可控。
      for (const slot of slots) {
        if (!slot) continue;
        if (slot.item) out.push(slot.item);
        else if (slot.subdir) await walk(slot.subdir, slot.rel);
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
  // 复用 getMetaList 已经读到的正文，不再逐个重读（原先是 2N 次 I/O）
  const meta = await getMetaList(true);
  const results = [];
  for (const item of meta) {
    const nameHit = (item.meta.title || item.name).toLowerCase().includes(q);
    const tagHit = Array.isArray(item.meta.tags) && item.meta.tags.some(t => String(t).toLowerCase().includes(q));
    // bodyRaw / bodyLower 来自 contentCache（见 readParsedCached），
    // 不在这里重算——每敲一个字符重做全库的正则+toLowerCase 是搜索的主要开销。
    const bodyRaw = item.bodyRaw || '';
    const bodyIdx = (item.bodyLower || '').indexOf(q);
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

// 渲染进程 refreshTree 用这一个替代原先的 list-tree + get-meta-list 两次调用。
// 另两个 handler 保留：自检脚本与其他调用点仍在单独使用它们。
ipcMain.handle('list-tree-and-meta', async () => {
  await ensureDirs();
  return listTreeAndMeta();
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
  dropFromCache(full);
  return { content: toWrite, meta: parseFrontmatter(toWrite).meta };
});

async function createFileAt(rel, content) {
  const full = safeJoin(rel);
  if (fs.existsSync(full)) throw appError('E_FILE_EXISTS', rel);
  await ensureDir(path.dirname(full));
  const toWrite = bumpAutoFields(content, null);
  await fsp.writeFile(full, toWrite, 'utf8');
  dropFromCache(full);
  return { content: toWrite, meta: parseFrontmatter(toWrite).meta };
}

ipcMain.handle('create-file', (e, rel, content) => createFileAt(rel, content));

ipcMain.handle('rename', async (e, oldRel, newRel) => {
  const oldFull = safeJoin(oldRel);
  const newFull = safeJoin(newRel);
  if (fs.existsSync(newFull)) throw appError('E_TARGET_EXISTS', newRel);
  await ensureDir(path.dirname(newFull));
  await fsp.rename(oldFull, newFull);
  dropFromCache(oldFull);
  dropFromCache(newFull);
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
  if (await isLocked(rel)) throw appError('E_LOCKED', rel);
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
  dropFromCache(full);
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
  if (!item) throw appError('E_TRASH_ITEM_MISSING');
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
    dropFromCache(safeJoin(alt));
    finalRel = alt;
  } else {
    await fsp.rename(storePath, targetFull);
    dropFromCache(targetFull);
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
  dropFromCache(full);
  return { content: toWrite, meta: parseFrontmatter(toWrite).meta };
});

ipcMain.handle('get-meta-list', async () => {
  await ensureDirs();
  return getMetaList();
});

ipcMain.handle('search', async (e, query) => searchAll(query));

ipcMain.handle('get-config', async () => loadConfig());

// 经 queueConfigWrite 串行化：并发调用会排队，每次都基于最新的磁盘状态做合并。
function updateConfig(patch) {
  return queueConfigWrite(async () => {
    const cur = await loadConfig();
    const next = { ...cur, ...(patch || {}) };
    await saveConfig(next);
    return next;
  });
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
  if (!type || typeof type !== 'string') throw appError('E_TYPE_INVALID');
  const t = String(type).trim();
  if (!t) throw appError('E_TYPE_EMPTY');
  const cfg = await loadConfig();
  const list = Array.isArray(cfg.projectTypes) ? [...cfg.projectTypes] : [...DEFAULT_PROJECT_TYPES];
  if (list.includes(t)) throw appError('E_TYPE_EXISTS', t);
  list.push(t);
  return await updateConfig({ projectTypes: list });
});

ipcMain.handle('remove-project-type', async (e, type) => {
  const cfg = await loadConfig();
  const list = Array.isArray(cfg.projectTypes) ? [...cfg.projectTypes] : [...DEFAULT_PROJECT_TYPES];
  if (list.length <= 1) throw appError('E_TYPE_MIN_ONE');
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

// ---------- 搜索压测（PFM_SELFTEST_BENCH=<条数>） ----------
// 搜索会遍历整个库，是唯一随规模线性变差的操作。这里生成指定条数的提示词，
// 量化耗时与读文件次数，避免"感觉快了"这种没有依据的结论。
// 必须配 PFM_DATA_DIR，否则会往真实库里灌垃圾数据。
async function runSearchBench(count) {
  const stage = 'testing';
  const dir = path.join(PROMPTS_DIR, stage);
  await ensureDir(dir);
  for (let i = 0; i < count; i++) {
    const body = 'lorem ipsum '.repeat(40) + (i === count - 1 ? ' NEEDLE_AT_END ' : '') + 'dolor sit amet';
    await fsp.writeFile(path.join(dir, `bench-${i}.md`),
      `---\ntitle: Bench ${i}\nstage: ${stage}\ntags: [bench]\n---\n${body}`, 'utf8');
  }
  const time = async (label, fn) => {
    fileReadCount = 0;
    cacheHits = 0;
    cacheMisses = 0;
    const t0 = Date.now();
    const r = await fn();
    const ms = Date.now() - t0;
    console.log(`[bench] ${label}: ${ms}ms, 读文件 ${fileReadCount} 次, 缓存命中 ${cacheHits}/${cacheHits + cacheMisses}, 结果 ${Array.isArray(r) ? r.length : '-'} 条`);
    return { ms, reads: fileReadCount };
  };
  console.log(`[bench] 库规模: ${count} 条提示词`);
  await time('getMetaList', () => getMetaList());
  await time('search 命中正文末尾', () => searchAll('NEEDLE_AT_END'));
  await time('search 命中标签', () => searchAll('bench'));
  await time('search 无命中', () => searchAll('zzz_nothing_matches_zzz'));
}

// ---------- 自检用的系统对话框桩 ----------
// 导出/导入四个流程都要弹系统对话框，正常跑不了自动化测试。
// 这里在自检模式下把 dialog 换成"按队列返回预设结果"的桩，队列放在
// PFM_SELFTEST_DIALOGS 指向的 JSON 文件里（每次取走一项，写回剩余项）。
// 两个开关都不设时这段完全不生效，生产行为不受影响。
function installSelfTestDialogStubs() {
  const queuePath = process.env.PFM_SELFTEST_DIALOGS;
  const takeNext = (fallback) => {
    try {
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      const item = queue.shift();
      fs.writeFileSync(queuePath, JSON.stringify(queue), 'utf8');
      if (item) console.log('[selftest] 对话框桩返回: ' + JSON.stringify(item));
      return item || fallback;
    } catch (e) {
      console.error('[selftest] 读取对话框队列失败:', e.message);
      return fallback;
    }
  };
  dialog.showSaveDialog = async () => takeNext({ canceled: true });
  dialog.showOpenDialog = async () => takeNext({ canceled: true, filePaths: [] });
  console.log('[selftest] 已启用对话框桩，队列文件: ' + queuePath);
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

      // 8b. 正文缓存的失效验证：改完内容立刻搜，必须搜到新的、搜不到旧的。
      // 这是加缓存后最容易出的回归。
      const cur = await api.readFile(renamed);
      await api.saveFile(renamed, cur.content.replace('第一版正文', '缓存失效验证文本'));
      const newHits = await api.search('缓存失效验证文本');
      check('保存后立刻能搜到新内容（缓存已失效）', newHits.some(h => h.rel === renamed), '命中 ' + newHits.length + ' 条');
      const oldHits = await api.search('第一版正文');
      check('保存后搜不到旧内容（没有读到缓存旧值）', !oldHits.some(h => h.rel === renamed), '命中 ' + oldHits.length + ' 条');
      // 恢复内容，后面的导出/导入断言依赖它
      await api.saveFile(renamed, cur.content);
      check('内容已还原', (await api.readFile(renamed)).content.includes('第一版正文'));
      const metas = await api.getMetaList();
      check('元数据列表包含该文件', metas.some(m => m.rel === renamed));
      const tree = await api.listTree();
      check('文件树包含 prompts/workflows/templates 三个根', tree.length === 3);

      // 9. 越权防护 + 错误码本地化
      // 主进程抛的是 E_XXX|detail，渲染进程要能翻成当前语言；翻不出来才回退原文。
      const codeCheck = async (name, fn, expectCode) => {
        try { await fn(); check(name, false, '本应抛错'); }
        catch (e) {
          const shown = describeError(e);
          const stillRaw = new RegExp('\\b' + expectCode + '\\b').test(shown);
          check(name, !stillRaw, stillRaw ? '未翻译，仍是: ' + shown : shown);
        }
      };
      await codeCheck('E_PATH_ESCAPE 已本地化', () => api.readFile('../../../../Windows/win.ini'), 'E_PATH_ESCAPE');
      await codeCheck('E_LOCKED 已本地化', async () => {
        await api.setConfig({ lockedFiles: [renamed] });
        try { await api.trash(renamed); } finally { await api.setConfig({ lockedFiles: [] }); }
      }, 'E_LOCKED');
      await codeCheck('E_FILE_EXISTS 已本地化', () => api.createFile(renamed, 'x'), 'E_FILE_EXISTS');
      await codeCheck('E_BAD_VERSION_FILE 已本地化', () => api.readVersion(renamed, 'not-a-version.md'), 'E_BAD_VERSION_FILE');

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

      // 11. 导出 / 导入往返（依赖对话框桩，见 installSelfTestDialogStubs）
      // 这四个流程原先只能人工点，现在把 dialog 换成桩后可以全自动验证。
      if (window.__pfmDialogStubs) {
        const paths = window.__pfmDialogStubs;
        const single = await api.exportSingle(renamed);
        check('导出单个提示词返回成功', single.ok === true, JSON.stringify(single));
        const zip = await api.exportZip();
        check('导出 ZIP 返回成功', zip.ok === true, JSON.stringify(zip));

        const imp1 = await api.importSingle();
        check('导入单个 .md 成功', imp1.ok === true && !!imp1.rel, JSON.stringify(imp1));
        const impRead = await api.readFile(imp1.rel);
        check('导入的内容可读且正确', impRead.content.includes('第一版正文'));
        check('导入重名时自动改名而非覆盖', imp1.rel !== renamed, imp1.rel);

        const imp2 = await api.importZip();
        check('导入 ZIP 报告了真实导入数量', imp2.ok === true && imp2.imported > 0,
          JSON.stringify({ ok: imp2.ok, imported: imp2.imported, failed: imp2.failed }));
        check('导入 ZIP 无失败条目', Array.isArray(imp2.failed) && imp2.failed.length === 0,
          JSON.stringify(imp2.failed));

        const cancel = await api.exportZip();
        check('用户取消导出时返回 ok:false', cancel.ok === false, JSON.stringify(cancel));
      }

      // 清理
      const leftovers = (await api.getMetaList()).filter(mm => mm.rel !== renamed && mm.top === 'prompts');
      for (const mm of leftovers) { try { await api.trash(mm.rel); } catch (_) {} }
      await api.trash(renamed);
      await api.emptyTrash();
      check('清空回收站后为空', (await api.listTrash()).items.length === 0);
    } catch (e) {
      check('功能自检执行中断', false, e && e.message ? e.message : String(e));
    }
    return out;
  })()`;

  // 在页面里模拟真实点击。只依赖 DOM 与真实事件，不走任何测试专用后门。
  const uiScript = `(async () => {
    const out = [];
    const check = (name, ok, detail) => out.push([name, !!ok, detail || '']);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const menu = () => document.getElementById('ctx-menu');
    // 弹层"可见"的判定：没有 hidden、有尺寸、且矩形落在视口内。
    // 只判 hidden 是不够的——曾经 CSS 缺 left/top，弹层显示了但在视口外。
    const menuVisible = () => {
      const el = menu();
      if (!el || el.classList.contains('hidden')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 &&
        r.top >= 0 && r.left >= 0 &&
        r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1;
    };
    // 用真实事件序列点击：mousedown → mouseup → click，
    // 因为"关闭弹层"的监听挂在 mousedown 上，只 dispatch click 测不出真实行为。
    const realClick = async (el) => {
      for (const type of ['mousedown', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      await sleep(250);
    };
    const typeAndConfirm = async (value) => {
      const inp = document.getElementById('ctx-input');
      if (!inp) return false;
      inp.value = value;
      await realClick(document.getElementById('ctx-ok'));
      return true;
    };
    const pressEsc = async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const inp = document.getElementById('ctx-input');
      if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(250);
    };

    try {
      const before = (await window.promptFlowApi.getMetaList()).length;

      // ---- 空状态「新建提示词」完整走通三个弹层 ----
      await realClick(document.getElementById('empty-new-prompt'));
      check('点「新建提示词」后弹出阶段选择且在视口内', menuVisible(),
        menu() ? 'hidden=' + menu().classList.contains('hidden') + ' rect=' + JSON.stringify(menu().getBoundingClientRect()) : 'no menu');
      check('弹层里的输入框自动获得焦点', document.activeElement && document.activeElement.id === 'ctx-input',
        document.activeElement ? document.activeElement.id : 'none');
      if (!menuVisible()) return out; // 后面全都依赖这一步

      await typeAndConfirm('测试');
      check('确定后弹出名称输入', menuVisible());
      const newName = 'UI点击自检-' + Date.now();
      await typeAndConfirm(newName);
      check('再确定后弹出工程类型选择', menuVisible());
      await typeAndConfirm('其他');
      await sleep(700);

      const after = await window.promptFlowApi.getMetaList();
      const created = after.find(x => x.rel === 'prompts/testing/' + newName + '.md');
      check('整条新建流程真的落盘了文件', !!created && after.length === before + 1,
        '库内文件 ' + before + ' → ' + after.length + '，期望新增 ' + newName);
      check('新建后进入编辑模式', !!document.getElementById('editor-wrap') &&
        !document.getElementById('editor-wrap').classList.contains('hidden'));

      // ---- 工具栏按钮同样能弹出 ----
      await pressEsc();
      await realClick(document.getElementById('btn-new-folder'));
      check('点「＋目录」能弹出输入框', menuVisible());
      await pressEsc();
      check('Esc 能关掉弹层', !menuVisible());

      // ---- 点弹层外部要能关闭（防止把 mousedown 改错方向）----
      await realClick(document.getElementById('btn-new-workflow'));
      check('点「＋工作流」能弹出输入框', menuVisible());
      await realClick(document.body);
      check('点弹层外部能关闭', !menuVisible());

      // ---- 导入方式选择 ----
      await realClick(document.getElementById('btn-import'));
      check('点「导入」能弹出方式选择', menuVisible());
      await realClick(document.body);

      // ---- 主题切换 ----
      const themeBefore = document.body.className;
      await realClick(document.getElementById('btn-theme'));
      check('切换主题会改变 body class', document.body.className !== themeBefore,
        themeBefore + ' → ' + document.body.className);
      await realClick(document.getElementById('btn-theme'));

      // ---- 抽屉 ----
      await realClick(document.getElementById('btn-trash'));
      check('回收站抽屉能打开', !document.getElementById('trash-drawer').classList.contains('hidden'));
      await realClick(document.getElementById('btn-trash-close'));
      await realClick(document.getElementById('btn-settings'));
      check('设置抽屉能打开', !document.getElementById('settings-drawer').classList.contains('hidden'));
      await realClick(document.getElementById('btn-settings-close'));

      // ---- 文件树键盘导航 ----
      // 注意：导航只在文件行之间进行（.tree-row.file），当前项的类名是 active
      const fileRows = Array.from(document.querySelectorAll('#tree .tree-row.file'));
      if (fileRows.length > 1) {
        const tree = document.getElementById('tree');
        await realClick(fileRows[0]);
        await sleep(300);
        const firstRel = (document.querySelector('#tree .tree-row.file.active') || {}).__rel ||
          (document.querySelector('#tree .tree-row.file.active') || {}).dataset?.rel || state.currentRel;
        tree.focus();
        tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await sleep(400);
        const secondRel = state.currentRel;
        check('文件树方向键能切到下一个文件', !!firstRel && !!secondRel && firstRel !== secondRel,
          String(firstRel) + ' → ' + String(secondRel));
        tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        await sleep(400);
        check('方向键能切回上一个文件', state.currentRel === firstRel,
          String(state.currentRel) + ' 应为 ' + String(firstRel));
      } else {
        check('文件树里有多于一个文件行可供导航', false, '只有 ' + fileRows.length + ' 个文件行');
      }

      // ---- 右键菜单 ----
      const fileRow = document.querySelector('#tree .tree-row.file') || document.querySelector('#tree .tree-row');
      if (fileRow) {
        fileRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
        await sleep(250);
        const items = menu() ? menu().querySelectorAll('.ctx-item').length : 0;
        check('右键菜单能弹出且有菜单项（' + items + ' 项）', menuVisible() && items > 0);
        await realClick(document.body);
      }
    } catch (e) {
      check('UI 点击自检执行中断', false, e && e.message ? e.message : String(e));
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
            // 告诉页面对话框桩是否可用（可用时才跑导出/导入往返）
            await targetWin.webContents.executeJavaScript(
              'window.__pfmDialogStubs = ' + JSON.stringify(process.env.PFM_SELFTEST_DIALOGS || null) + ';', true);
            const fnResults = await targetWin.webContents.executeJavaScript(functionalScript, true);
            for (const [name, ok, detail] of fnResults) {
              if (ok) console.log('[selftest:fn] PASS ' + name);
              else fail('[fn] ' + name + (detail ? ' → ' + detail : ''));
            }
          }
        }
        // PFM_SELFTEST_READONLY=1：对当前库做只读体检。
        // 把每个文件都读出来、解析 frontmatter、渲染 Markdown、解析流程图、跑搜索，
        // 全程不写文件，所以可以安全地对着真实数据跑（用来回答"我的库能正常用吗"）。
        if (process.env.PFM_SELFTEST_READONLY === '1') {
          const ro = await targetWin.webContents.executeJavaScript(`(async () => {
            const api = window.promptFlowApi;
            const out = { files: [], errors: [], searches: [], flows: [] };
            const metas = await api.getMetaList();
            for (const item of metas) {
              try {
                const { content, meta } = await api.readFile(item.rel);
                const html = renderMarkdown(content.replace(/^---[\\s\\S]*?---\\r?\\n?/, ''));
                const rec = {
                  rel: item.rel,
                  bytes: content.length,
                  title: meta.title || null,
                  version: meta.version == null ? null : meta.version,
                  htmlLen: html.length
                };
                if (item.top === 'workflows') {
                  const steps = parseWorkflowFlow(content);
                  rec.flowSteps = steps.length;
                  // 真正把流程图渲染一遍并数节点数，只在游离元素里做，不动界面
                  const probe = document.createElement('div');
                  probe.innerHTML = renderFlowDiagram(steps, meta.title || item.rel);
                  const nodes = probe.querySelectorAll('[data-flow-node], .flow-node').length;
                  const brokenLinks = [];
                  for (const s of steps) {
                    if (!s.prompt) { brokenLinks.push(s.id + ' 缺 prompt'); continue; }
                    const target = s.prompt.startsWith('prompts/') ? s.prompt : 'prompts/' + s.prompt;
                    if (!metas.some(mm => mm.rel === target)) brokenLinks.push(s.id + ' → ' + s.prompt + '（文件不存在）');
                  }
                  out.flows.push({ rel: item.rel, steps: steps.length,
                    missing: steps.filter(s => !s.prompt).length, nodes, brokenLinks });
                }
                out.files.push(rec);
              } catch (e) {
                out.errors.push(item.rel + ' → ' + (e && e.message ? e.message : String(e)));
              }
            }
            for (const q of ['需求', 'prompt', '代码', 'zzz_no_match_zzz']) {
              try { out.searches.push({ q, hits: (await api.search(q)).length }); }
              catch (e) { out.errors.push('search(' + q + ') → ' + e.message); }
            }
            return out;
          })()`, true);
          console.log('[readonly] 库内文件 ' + ro.files.length + ' 个');
          for (const f of ro.files) {
            console.log('[readonly]   ' + f.rel + '  ' + f.bytes + ' 字节, title=' + f.title +
              ', version=' + f.version + ', 渲染 HTML ' + f.htmlLen + ' 字符' +
              (f.flowSteps == null ? '' : ', 流程步骤 ' + f.flowSteps));
          }
          for (const s of ro.searches) console.log('[readonly] 搜索 "' + s.q + '" → ' + s.hits + ' 条');
          const emptyRender = ro.files.filter(f => f.htmlLen === 0);
          const noTitle = ro.files.filter(f => !f.title);
          const badFlow = ro.flows.filter(f => f.steps === 0 || f.missing > 0);
          if (ro.errors.length) fail('只读体检有报错: ' + ro.errors.join(' | '));
          else console.log('[readonly] PASS 所有文件都能读取并解析，无异常');
          if (emptyRender.length) fail('这些文件渲染结果为空: ' + emptyRender.map(f => f.rel).join(', '));
          else console.log('[readonly] PASS 所有文件的 Markdown 都渲染出内容');
          if (noTitle.length) console.log('[readonly] 注意：这些文件的 frontmatter 缺 title: ' + noTitle.map(f => f.rel).join(', '));
          else console.log('[readonly] PASS 所有文件都有 title');
          if (badFlow.length) fail('这些工作流的 flow 解析异常: ' + JSON.stringify(badFlow));
          else console.log('[readonly] PASS 工作流的流程图步骤都解析正常（' + ro.flows.length + ' 个工作流）');
          for (const f of ro.flows) {
            console.log('[readonly]   ' + f.rel + ': ' + f.steps + ' 步 → 流程图 ' + f.nodes + ' 个节点');
          }
          const noNodes = ro.flows.filter(f => f.nodes === 0);
          if (noNodes.length) fail('这些工作流渲染不出流程图节点: ' + noNodes.map(f => f.rel).join(', '));
          else if (ro.flows.length) console.log('[readonly] PASS 流程图都能渲染出节点');
          const broken = ro.flows.filter(f => f.brokenLinks && f.brokenLinks.length);
          if (broken.length) fail('流程图里有指向不存在文件的节点: ' + JSON.stringify(broken.map(f => ({ rel: f.rel, links: f.brokenLinks }))));
          else if (ro.flows.length) console.log('[readonly] PASS 流程图每个节点都指向存在的提示词');
        }

        // PFM_SELFTEST_LANG=en 时切到英文再检查，用于核对 i18n 覆盖。
        // 走真实的 setLang() 路径，所以必须配 PFM_DATA_DIR 隔离配置文件。
        if (process.env.PFM_SELFTEST_LANG) {
          if (!process.env.PFM_DATA_DIR) {
            fail('语言自检必须设置 PFM_DATA_DIR，拒绝改写用户真实配置');
          } else {
            const lang = process.env.PFM_SELFTEST_LANG === 'en' ? 'en' : 'zh';
            const res = await targetWin.webContents.executeJavaScript(`(async () => {
              await setLang('${lang}');
              await new Promise(r => setTimeout(r, 400));
              // 只检查"界面外壳"的文案。以下容器渲染的是用户数据
              // （提示词标题、标签、正文、工程类型…），里面出现中文是正常的，
              // 把它们算进来会让检查变成误报。
              const userDataContainers = [
                'tree', 'tabs-bar', 'breadcrumb', 'meta-bar', 'preview', 'editor',
                'recent-list', 'search-results', 'types-list',
                'version-list', 'version-detail', 'version-diff', 'trash-list',
                'filter-stage', 'filter-type', 'tag-datalist'
              ];
              const clone = document.body.cloneNode(true);
              for (const id of userDataContainers) {
                const el = clone.querySelector('#' + id);
                if (el) el.remove();
              }
              document.body.appendChild(clone);
              clone.style.position = 'absolute';
              clone.style.left = '-99999px';
              const text = clone.innerText || '';
              clone.remove();
              const chunks = text.match(/[\\u4e00-\\u9fa5]+/g) || [];
              return { lang: '${lang}', chunks: [...new Set(chunks)].slice(0, 20), total: chunks.length };
            })()`, true);
            if (lang === 'en') {
              const ok = res.total === 0;
              if (ok) console.log('[selftest] PASS 切换到英文后界面外壳无残留中文');
              else fail('切换到英文后界面外壳仍有中文（' + res.total + ' 处）: ' + res.chunks.join(' | '));
            } else {
              console.log('[selftest] 语言已切到 ' + res.lang);
            }
          }
        }
        // PFM_SELFTEST_UI=1：真的用鼠标点一遍界面。
        // 为什么必须有这层：功能自检是直接调 IPC 的，绕过了所有 UI；
        // 结果"点新建提示词没反应"这种全量阻塞的 bug 一路没被发现——
        // 打开弹层的那次 click 冒泡到 document 后把弹层自己关掉了。
        // 会新建文件，所以必须配 PFM_DATA_DIR。
        if (process.env.PFM_SELFTEST_UI === '1') {
          if (!process.env.PFM_DATA_DIR) {
            fail('UI 点击自检必须设置 PFM_DATA_DIR，拒绝在真实库上点');
          } else {
            const uiResults = await targetWin.webContents.executeJavaScript(uiScript, true);
            for (const [name, ok, detail] of uiResults) {
              if (ok) console.log('[selftest:ui] PASS ' + name);
              else fail('[ui] ' + name + (detail ? ' → ' + detail : ''));
            }
          }
        }
        // PFM_SELFTEST_OPEN=<相对路径> 时先打开该文件，让截图能拍到正文/流程图。
        // 会写入"最近打开"（和用户点一下的效果一样），所以配合 PFM_DATA_DIR 用。
        if (process.env.PFM_SELFTEST_OPEN) {
          const rel = process.env.PFM_SELFTEST_OPEN;
          const info = await targetWin.webContents.executeJavaScript(
            '(async () => { await openFile(' + JSON.stringify(rel) + '); await new Promise(r => setTimeout(r, 500));' +
            ' return { rel: state.currentRel, previewLen: ($("preview") || {}).innerHTML ? $("preview").innerHTML.length : 0,' +
            ' flowNodes: document.querySelectorAll("#preview .flow-node, #preview [data-flow-node]").length }; })()', true);
          if (info.rel === rel && info.previewLen > 0) {
            console.log('[selftest] PASS 打开 ' + rel + '（预览 ' + info.previewLen + ' 字符，流程图节点 ' + info.flowNodes + ' 个）');
          } else {
            fail('打开 ' + rel + ' 后预览为空: ' + JSON.stringify(info));
          }
        }
        // PFM_SELFTEST_SHOT=<路径> 时顺手存一张真实渲染截图，便于人工核对界面
        if (process.env.PFM_SELFTEST_SHOT) {
          // 窗口被遮挡或还没绘制完时 capturePage 会返回空图，重试几次。
          let png = null;
          for (let i = 0; i < 5; i++) {
            const image = await targetWin.webContents.capturePage();
            png = image.toPNG();
            if (png && png.length > 0) break;
            await new Promise(r => setTimeout(r, 400));
          }
          if (png && png.length > 0) {
            fs.writeFileSync(process.env.PFM_SELFTEST_SHOT, png);
            console.log('[selftest] 截图已保存: ' + process.env.PFM_SELFTEST_SHOT + '（' + png.length + ' 字节）');
          } else {
            fail('截图为空：窗口可能未绘制');
          }
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

// ---------- 导航守卫 ----------
// 提示词正文是 Markdown，渲染时明确放行了 target 属性（见 renderMarkdown），
// 所以正文里的 [文档](https://…) 是可点的。默认行为是在**当前窗口内**导航过去，
// 于是工具栏、文件树、未保存的编辑全部消失，且没有后退按钮——整个应用被一条
// 链接劫持。导入的第三方 .md 同理。
// 这里把两条路都堵上：新窗口请求交给系统浏览器，窗口内导航直接拒绝。
// 只允许 file:// 通过，因为界面本身是 loadFile 加载的（reload 也走这条）。
function attachNavigationGuard(targetWin) {
  const openExternally = (url) => {
    // 只把 http/https 交给系统浏览器。file:/// 之类的本地协议不转发，
    // 否则一条 file:///C:/… 链接就能让应用去打开任意本地文件/程序。
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(e => console.error('打开外部链接失败:', e.message));
    } else {
      console.log('[nav] 已拦截非 http(s) 链接: ' + url);
    }
  };
  targetWin.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  targetWin.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return; // 界面自身/reload
    e.preventDefault();
    openExternally(url);
  });
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
  attachNavigationGuard(win);
  const selfTest = process.env.PFM_SELFTEST === '1' ? attachSelfTest(win) : null;
  win.loadFile(path.join(CODE_ROOT, 'src', 'index.html'));
  if (selfTest) selfTest.run();

  // resize / move 会以每秒几十次的频率触发。不防抖会疯狂读写 config.json。
  // 走 updateConfig 而不是自己 loadConfig→saveConfig：后者是一次独立的
  // read-modify-write，会和渲染进程那五个 debounce（tabs/recent/locked/
  // sidebarWidth/expandedPaths）互相覆盖字段。updateConfig 内部有写队列。
  let boundsTimer = null;
  const flushBounds = async () => {
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    try {
      await updateConfig({ windowBounds: bounds });
    } catch (e) {
      console.error('保存窗口位置失败:', e);
    }
  };
  const scheduleSaveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(flushBounds, 500);
  };
  win.on('resize', scheduleSaveBounds);
  win.on('move', scheduleSaveBounds);
  // 关窗前把待写入的尺寸落盘，否则最后一次调整会丢。
  // 这里必须同步写：close 之后进程随即退出，await 不保证能跑完。
  // 为了不和写队列打架，先把队列里已排队的写等干净再动手——但同步上下文
  // 等不了 promise，所以退而求其次：读当前磁盘内容做 merge，只覆盖
  // windowBounds 一个字段，其余字段原样保留。最坏情况是丢掉一次
  // 正在飞行中的 debounce 写入，而不是整份配置被覆盖。
  win.on('close', () => {
    if (boundsTimer) { clearTimeout(boundsTimer); boundsTimer = null; }
    if (win && !win.isDestroyed()) {
      try {
        const bounds = win.getBounds();
        const cur = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
        cur.windowBounds = bounds;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2), 'utf8');
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

// ---------- 单实例 ----------
// 两个实例操作同一份数据目录时，config.json 是全量读改写，
// windowBounds / lockedFiles / tabs 会互相覆盖；.versions 的裁剪也可能打架。
// 所以第二个实例直接退出，把已有窗口唤到前台。
//
// 自检模式不参与：测试会拉起多个 Electron，各自 PFM_DATA_DIR 指向不同的临时目录，
// 本来就该允许共存。在这里加锁会让第二个测试进程静默退出，表现为莫名超时。
const SINGLE_INSTANCE = process.env.PFM_SELFTEST !== '1' && !process.env.PFM_SELFTEST_BENCH;
if (SINGLE_INSTANCE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (SINGLE_INSTANCE) {
    app.on('second-instance', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
  }
  bootstrap();
}

function bootstrap() {
app.whenReady().then(async () => {
  if (process.env.PFM_SELFTEST_BENCH) {
    if (!process.env.PFM_DATA_DIR) {
      console.error('[bench] 必须设置 PFM_DATA_DIR，拒绝往真实库里写压测数据');
      app.exit(1);
      return;
    }
    await ensureDirs();
    await runSearchBench(parseInt(process.env.PFM_SELFTEST_BENCH, 10) || 100);
    app.exit(0);
    return;
  }
  if (process.env.PFM_SELFTEST === '1' && process.env.PFM_SELFTEST_DIALOGS) {
    installSelfTestDialogStubs();
  }
  ensureSeedData();
  await ensureDirs();
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
