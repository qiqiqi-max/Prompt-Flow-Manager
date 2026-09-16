// Prompt Flow Manager - Electron 主进程
// 负责窗口、文件系统操作、版本管理、回收站、配置、导出
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');
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
// 缓存上限。原先没有：dropFromCache 只在删除/移动/保存时清对应条目，
// 从没被删过、只是不再被访问的文件会永久留在 Map 里，而每条都存了正文 +
// 一份全小写副本（约 2 倍文件大小）。长会话里反复浏览/搜索一个大库，常驻内存
// 只增不减。这里按 LRU 封顶：命中时把条目挪到队尾，插入后从队首淘汰最久未用的。
// Map 保持插入顺序，所以队首就是最久未 touch 的条目。
// 上限取 5000：远高于注释里 1000 条的性能基准，正常库一次搜索遍历不会触发淘汰
// （否则会拉低命中率）；真超了也只是退化成重读，正确性不受影响。
// 用 let 是为了让自检能临时调小，不必造几千个文件来验证淘汰。
let CONTENT_CACHE_MAX = 5000;

const EMPTY_ENTRY = { content: '', meta: {}, bodyRaw: '', bodyLower: '' };

async function readParsedCached(fullPath) {
  let st;
  try { st = await fsp.stat(fullPath); } catch { return EMPTY_ENTRY; }
  const hit = contentCache.get(fullPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    cacheHits++;
    // 命中即 touch：删了重插挪到队尾，这样淘汰时队首永远是最久未访问的那条。
    contentCache.delete(fullPath);
    contentCache.set(fullPath, hit);
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
  // 先 delete 再 set：过期条目重读后要挪到队尾，否则同 key 的 set 只更新值不改
  // 顺序，这条刚刷新却还排在队首，下一次淘汰就会把它当成最旧的删掉。
  contentCache.delete(fullPath);
  contentCache.set(fullPath, entry);
  // 超限则从队首（最久未用）逐个淘汰
  while (contentCache.size > CONTENT_CACHE_MAX) {
    const oldest = contentCache.keys().next().value;
    if (oldest === undefined) break;
    contentCache.delete(oldest);
  }
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
// 原生菜单的文案也要跟随语言。i18n.js 结尾有 module.exports，可以直接在主进程 require，
// 不必再维护第二份翻译表（之前菜单是硬编码中文，切到英文后整个菜单栏还是中文）。
const I18N_TABLE = require('./src/i18n.js');
// frontmatter 解析同样两边共用（src/frontmatter.js 结尾也有 module.exports）。
const FRONTMATTER = require('./src/frontmatter.js');
// 滚动文件日志 + 诊断包。两个模块都刻意不 require('electron')：
// 目录、版本号、两个根目录全部由这里传进去，DATA_ROOT / CODE_ROOT 的判断
// 只允许存在下面那一份（见 123-133 行的说明）。
// 必须在 EPIPE 兜底（86-88 行）之后 require：logger 会往 console 镜像，
// 而那段兜底负责保证 console 抛不出未捕获异常。
const logger = require('./lib/logger');
const diagnostics = require('./lib/diagnostics');
// 当前菜单语言。buildMenu 只在启动和语言变化时调用（见 syncMenuLang），
// 所以文案取值统一读这个变量，不用每个调用点都把 lang 传一遍。
let menuLang = null;
function mt(key) {
  const tbl = I18N_TABLE[menuLang === 'en' ? 'en' : 'zh'] || I18N_TABLE.zh;
  if (tbl[key] != null) return tbl[key];
  if (I18N_TABLE.zh[key] != null) return I18N_TABLE.zh[key];
  // 查不到就回退成键名本身，界面上会露出 dlgExportZip 这样的字符串。
  // 这个回退很容易骗过检查：键名里没有中文，所以"英文界面下没有残留中文"
  // 那条断言照样是绿的（写这段时就真的这样漏过去一次——四个对话框标题全是
  // 键名，测试全绿）。所以这里必须吼一声，让自检的 FAIL 匹配能抓到。
  console.error('[i18n] 主进程用了不存在的键: ' + key);
  return key;
}

// 某些 Windows 环境 GPU 驱动/运行库缺失，禁用 GPU 硬件加速避免 GPU 进程崩溃。
// 软件渲染对提示词管理器这种轻量界面性能完全足够。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-direct-composition');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// 沙箱默认开启，只在这台机器上被证明起不来之后才降级。
//
// 原先这里无条件 appendSwitch('no-sandbox')，理由是"某些缺运行库的环境开了会缺 DLL"。
// 那个理由是真的，但代价是**所有**用户都失去渲染进程的 OS 级隔离，
// 为的是照顾一小部分环境。contextIsolation 只隔离 JS 作用域，
// DOMPurify 被绕过之后的原生层利用要靠沙箱挡，而导入的 .md 属外部内容。
//
// 判断逻辑全在 lib/sandbox-state.js（跨启动的标记 + 两次不确认才降级 + 七天后重试），
// 那边的文件头写了为什么"探测"只能跨启动做。这里只负责把结论翻译成命令行开关。
//
// 顺序上不能挪：appendSwitch 必须在 app ready 之前，等窗口失败了再改已经来不及。
// 而 webPreferences.sandbox 单独开是没用的 —— 进程级的 --no-sandbox 会盖掉它，
// 所以这两处必须同时改（这也是本次改动的核心：它们是一个开关的两半）。
const sandboxState = require('./lib/sandbox-state');
// 状态文件跟 config.json 同目录。这里不能用 CONFIG_PATH：它在下面 40 行才定义，
// 而 appendSwitch 必须在此刻完成，所以把同一个三元表达式在此处求值一次。
// 两份表达式的漂移风险由 tests/smoke.test.js 的断言盯着。
const SANDBOX_STATE_DIR = process.env.PFM_DATA_DIR
  ? path.resolve(process.env.PFM_DATA_DIR)
  : app.getPath('userData');
const sandboxDecision = sandboxState.decide({
  state: sandboxState.read(SANDBOX_STATE_DIR),
  env: process.env
});
if (!sandboxDecision.sandbox) app.commandLine.appendSwitch('no-sandbox');

// 本次进程**当前生效**的模式。和 sandboxDecision.sandbox 的区别只有一种情况：
// 沙箱开着但渲染进程当场起不来，那时就地降级重建窗口（见 attachSandboxProbe），
// 这个变量跟着变 false，而 sandboxDecision 保留启动时的判定不动。
//
// 实测（本机缺 VC++ 运行库，正是这套机制要照顾的环境）：
//   sandbox:true  + 不带 --no-sandbox → 渲染进程 crash，exitCode -1073741515
//                                       （0xC0000135 STATUS_DLL_NOT_FOUND）
//   sandbox:false + 不带 --no-sandbox → 正常渲染
// 后一条是就地降级成立的依据：关掉窗口级开关就够了，不需要那个只能在
// app ready 之前设的进程级开关，所以不必重启。
let sandboxActive = sandboxDecision.sandbox;

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
// 日志放独立子目录，不放数据根目录顶层：tests/smoke.test.js 有一条防回归断言
// 盯的就是"往 DATA_ROOT 顶层 append debug.log"这个形状（旧实现每次列目录树
// 都同步追加一行，文件无上限增长）。独立子目录 + 大小滚动 + 文件数上限，
// 三条一起才算真正解决那个问题。
const LOGS_DIR = path.join(DATA_ROOT, 'logs');
// 配置默认放 userData（不污染提示词目录）；设了 PFM_DATA_DIR 时跟着走，
// 否则测试改语言/主题会写进用户真实配置。
const CONFIG_PATH = path.join(process.env.PFM_DATA_DIR ? DATA_ROOT : app.getPath('userData'), 'config.json');

// 打包后首次运行：从 asar 内拷出种子资源到 Data 目录。
//
// 关于"拷到一半失败"：原先的跳过判断是"目标目录非空就跳过"，而 copyDirSync
// 每个文件都没有单独保护。一个文件被占用/不可读就中途抛出，留下半个目录——
// 而半个目录也算"非空"，于是**之后每次启动都跳过，缺口永远补不回来**。
// 这里改成显式的进行中标记：拷之前放标记，成功后删掉。
//   有标记 = 上次拷到一半就挂了 → 允许重拷（此时用户还没用过这个目录）
//   无标记 + 目标非空 = 已完成的种子，或用户自己的内容 → 一定跳过
// 不能只看标记不看内容：老版本升上来的用户没有标记但有真实数据，
// 那样会把种子覆盖回去，清掉用户对同名文件（如 需求分析.md）的修改。
function seedFlagPath(dir) {
  return path.join(DATA_ROOT, '.seeding-' + dir);
}
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
      const flag = seedFlagPath(dir);
      const destExists = fs.existsSync(dest);
      const destHasContent = destExists && fs.readdirSync(dest).length > 0;
      const interrupted = fs.existsSync(flag);
      const srcExists = fs.existsSync(src);
      log(dir + ': src exists=' + srcExists + ', destHasContent=' + destHasContent + ', interrupted=' + interrupted);
      if (destHasContent && !interrupted) { log('  skip ' + dir + ' (已有内容)'); continue; }
      if (!srcExists) { log('  seed MISSING for ' + dir); continue; }
      if (interrupted) log('  上次拷贝未完成，重试 ' + dir);
      try {
        fs.writeFileSync(flag, new Date().toISOString(), 'utf8');
      } catch (e) {
        log('  无法写进行中标记，跳过 ' + dir + '：' + e.message);
        continue;
      }
      const failed = copyDirSync(src, dest);
      if (failed.length) {
        // 有文件没拷成：保留标记，下次启动继续补。至少不会永久缺内容。
        log('  ' + dir + ' 部分失败(' + failed.length + ' 个)，保留标记下次重试: ' + failed.slice(0, 3).join(', '));
      } else {
        try { fs.unlinkSync(flag); } catch {}
        log('  done ' + dir + ', files=' + fs.readdirSync(dest).length);
      }
    }
    log('FINISHED');
  } catch (e) {
    log('ERROR: ' + e.message + '\n' + e.stack);
  }
}
// 返回拷贝失败的文件列表，而不是让第一个失败就掀翻整次拷贝。
// 单个文件读不到（被杀软锁住、权限问题）不该导致其余几十个提示词都拷不过来。
function copyDirSync(src, dest, failed = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    try {
      if (ent.isDirectory()) copyDirSync(s, d, failed);
      else fs.copyFileSync(s, d);
    } catch (e) {
      failed.push(ent.name + ': ' + e.message);
    }
  }
  return failed;
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
  // 相对路径以 .. 开头说明逃逸出了根目录。
  // 还必须判 isAbsolute：Windows 上跨盘符时 path.relative 返回的是绝对路径而不是
  // 一串 ..（实测 path.relative('D:\\a', 'C:\\Windows') === 'C:\\Windows'），
  // 于是 startsWith('..') 为假，整个包含性检查被绕过。打包后 DATA_ROOT 在 C 盘，
  // 'D:/x.txt'、'E:/x.txt'、'C:x.txt'（盘符相对）全都能放行。
  // 可达路径不需要 XSS：工作流 frontmatter 的 flow[].prompt 会被渲染成流程节点的
  // data-prompt，用户点一下就走 read-file，正文直接显示在预览区。
  // trashStorePath 早就是这么判的，这里和 versionDirFor 漏了同一条。
  if (rel2.startsWith('..') || path.isAbsolute(rel2)) throw appError('E_PATH_ESCAPE', relPath);
  return resolved;
}

// 写入专用校验。safeJoin 只保证"没逃出 DATA_ROOT"，但打包后 DATA_ROOT 就是
// userData，而 config.json 正躺在那儿——于是 save-file('config.json', ...) 能用
// 记笔记的 API 覆盖应用自己的配置（bumpAutoFields 还会给它加上 --- frontmatter，
// 之后 loadConfig 解析失败回落默认值，主题/标签页/锁定/项目类型全丢）。
// .trash/index.json 和 .versions/** 同理。
// 写入只应该发生在三个内容目录里的 .md（外加建目录用的 .gitkeep 占位），
// 这里按顶层目录 + 扩展名双白名单卡死。
const WRITABLE_TOPS = new Set(['prompts', 'workflows', 'templates']);
function safeJoinWritable(relPath) {
  const resolved = safeJoin(relPath);
  const rel = path.relative(DATA_ROOT_NORM, resolved).replace(/\\/g, '/');
  const segs = rel.split('/');
  // 必须落在 prompts/ workflows/ templates/ 之下，且不能就是顶层目录本身
  if (segs.length < 2 || !WRITABLE_TOPS.has(segs[0])) throw appError('E_WRITE_FORBIDDEN', relPath);
  // 任何一段以 . 开头都拒绝（.versions/.trash/.git 都在这条上），唯一例外是
  // newFolder 用来占位的 .gitkeep 文件名本身。
  const base = segs[segs.length - 1];
  for (const s of segs.slice(0, -1)) {
    if (s.startsWith('.')) throw appError('E_WRITE_FORBIDDEN', relPath);
  }
  const isMd = base.toLowerCase().endsWith('.md') && base !== '.md';
  if (!isMd && base !== '.gitkeep') throw appError('E_WRITE_FORBIDDEN', relPath);
  return resolved;
}

// 回收站内部文件名的校验。
// 为什么必须有：empty-trash 会对 path.join(TRASH_DIR, item.store) 调
// fsp.rm(recursive: true, force: true)，而 item.store 来自 .trash/index.json——
// 一个普通 JSON 文件。它被同步盘冲突、外部编辑器、或上次崩溃写坏之后，
// store 变成 "../OUTSIDE" 就会静默递归删掉 .trash 之外的目录（实测能删到
// DATA_ROOT 之外）。force:true 连"不存在"都不报错，所以出事没有任何痕迹。
// store 名全部由本程序生成（trash handler 里的 `${id}${ext}` 和 `${id}-versions`），
// 一定是单层名字，因此这里直接要求"不含分隔符且解析后仍在 .trash 内"。
const TRASH_DIR_NORM = path.normalize(TRASH_DIR);
function trashStorePath(storeName) {
  const name = String(storeName == null ? '' : storeName);
  if (!name) throw appError('E_TRASH_BAD_STORE', String(storeName));
  if (name.includes('\0')) throw appError('E_TRASH_BAD_STORE', name);
  // 单层名字：出现任何分隔符或 .. 都说明索引被改过
  if (/[\\/]/.test(name) || name === '.' || name === '..') throw appError('E_TRASH_BAD_STORE', name);
  const resolved = path.resolve(TRASH_DIR_NORM, name);
  // 双保险：即使上面漏了某种形态，解析结果也必须落在 .trash 里面
  const rel = path.relative(TRASH_DIR_NORM, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw appError('E_TRASH_BAD_STORE', name);
  return resolved;
}

// ---------- frontmatter 解析 ----------
// 实现在 src/frontmatter.js，渲染进程用 <script> 加载同一份文件。
// 原先两边各有一份逐字复制的实现，改动其中一份不会同步到另一份，
// 症状是界面显示的 meta 和磁盘里的不一致，且不报错。
const parseFrontmatter = (content) => FRONTMATTER.parse(content);

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

const stripFrontmatter = (content) => FRONTMATTER.strip(content);

// ---------- 版本管理 ----------
// 版本目录同样要做越权校验：relPath 来自渲染进程，不能直接拼进 path.join。
function versionDirFor(relPath) {
  const rel = String(relPath == null ? '' : relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) throw appError('E_PATH_EMPTY');
  if (rel.includes('\0')) throw appError('E_PATH_BAD_CHAR');
  const resolved = path.resolve(VERSIONS_DIR, rel);
  // isAbsolute 的理由同 safeJoin：跨盘符时 path.relative 返回绝对路径，不是 ..
  const relV = path.relative(VERSIONS_DIR, resolved);
  if (relV.startsWith('..') || path.isAbsolute(relV)) throw appError('E_PATH_ESCAPE', relPath);
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
// 接受一个 Date 是为了让 saveVersion 能在名字被占时往后挪一毫秒重算
// （毫秒精度仍可能撞名，见那里的说明）。
function timestampName(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

// ---------- 原子写 ----------
// 普通 writeFile 是"先把目标截断到 0 字节，再写入"。中途断电/进程被杀，
// 留下的就是空文件或半截文件。对 index.json 这类清单尤其致命：
// readTrashIndex / readVersionIndex 的 catch 会把解析失败当成"空清单"静默返回，
// 于是一次中断的写入 = 整个回收站列表（或所有星标）凭空消失，而被删的文件还躺在
// .trash 里，UI 再也看不到。config.json 同理（主题/标签页/锁定/项目类型全丢）。
// 写临时文件再 rename：rename 在同一卷上是原子的，读者只会看到旧的或新的完整内容。
let atomicSeq = 0;
async function writeFileAtomic(fullPath, data) {
  const dir = path.dirname(fullPath);
  await ensureDir(dir);
  // 临时名要满足三个条件：
  //   1. 以 . 开头——目录树遍历会跳过点开头的项，写入过程中不会闪现在文件树里；
  //   2. 不以 .md 结尾——pruneVersions 和 list-versions 都按 .md 过滤目录内容，
  //      临时文件若带 .md 会被算进版本配额，甚至被当成最旧快照删掉；
  //   3. 带 pid + 计数器——同目录并发写不会用到同一个临时名。
  const tmp = path.join(dir, `.tmp-${process.pid}-${atomicSeq++}-${path.basename(fullPath)}.part`);
  try {
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, fullPath);
  } catch (e) {
    // 失败时清掉临时文件，别在数据目录里留垃圾（清理本身失败就忽略）
    try { await fsp.unlink(tmp); } catch {}
    throw e;
  }
}

// 独占创建：只用于"这个文件必须还不存在"的新建路径。
//
// 为什么不能沿用 writeFileAtomic：它结尾是 rename，而 rename 会无条件覆盖目标。
// 新建路径原先是"先 fs.existsSync 判重，再 writeFileAtomic"，两步之间有窗口，
// 且两步都不阻止覆盖——并发新建同名文件时两路都通过判重、两路都 rename，
// 后一次把前一次的正文整个盖掉，而两路都返回成功。
// 'wx' 把判重和创建合成一个内核级原子操作：文件已存在就直接 EEXIST，
// 谁抢到名字由内核裁决，不存在"检查完再被人插队"。
//
// 写一半失败就把自己刚创建的文件删掉，让结果回到"要么完整、要么不存在"。
// 残留的风险只剩"open 成功后进程被硬杀"留下 0 字节文件——这是个新文件，
// 不会毁掉任何已有内容，比原先的静默覆盖轻得多。
async function writeFileExclusive(fullPath, data, relForError) {
  await ensureDir(path.dirname(fullPath));
  let fh;
  try {
    fh = await fsp.open(fullPath, 'wx');
  } catch (e) {
    if (e && e.code === 'EEXIST') throw appError('E_FILE_EXISTS', relForError);
    throw e;
  }
  try {
    await fh.writeFile(data, 'utf8');
  } catch (e) {
    try { await fh.close(); } catch {}
    try { await fsp.unlink(fullPath); } catch {}
    throw e;
  }
  await fh.close();
}

// 快照名撞了就往后挪一毫秒重算，而不是覆盖或直接失败。
//
// 为什么需要：文件名精度只到毫秒，而快照名不能随便换格式——list-versions、
// pruneVersions 的"字典序 == 时间序"、VERSION_FILE_RE 都依赖这个形态。
// 同一毫秒内落两个快照时，两次 writeFileAtomic 会 rename 到同一个目标名：
// 实测（并发保存探针）在 Windows 上其中一次直接抛裸 EPERM，整个保存失败，
// 用户看到的是"保存失败"而正文其实已经写了一半。
// 挪毫秒而不是加随机后缀，是为了让名字仍然能被 VERSION_FILE_RE 认出来。
async function saveVersion(relPath, content) {
  const dir = versionDirFor(relPath);
  await ensureDir(dir);
  let d = new Date();
  let name = timestampName(d) + '.md';
  // 上限防死循环：正常撞一两次就够，连撞 1000 次说明目录有别的问题
  for (let i = 0; i < 1000 && fs.existsSync(path.join(dir, name)); i++) {
    d = new Date(d.getTime() + 1);
    name = timestampName(d) + '.md';
  }
  await writeFileAtomic(path.join(dir, name), content);
  await pruneVersions(relPath);
}

// 读索引 JSON，区分"文件不存在"和"文件损坏"两种情况。
// 之前两个索引都是 catch{ return 空 }，于是一次中断的写入（旧代码是原地
// writeFile，open(w) 先截断）会让整份索引静默变空：回收站列表清空但文件还在
// .trash 里、所有星标丢失，用户以为数据没了。现在写入是原子的，正常不该再出现
// 损坏；万一真损坏（磁盘错误、外部编辑），把坏文件改名留档而不是当空处理，
// 至少证据还在、可人工恢复。
async function readIndexJson(idxPath, fallback) {
  let raw;
  try {
    raw = await fsp.readFile(idxPath, 'utf8');
  } catch {
    return { ...fallback }; // 不存在：正常初始状态
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    throw new Error('not an object');
  } catch (e) {
    const bak = idxPath + '.corrupt-' + timestampName();
    try { await fsp.rename(idxPath, bak); } catch {}
    console.error('[index] 索引损坏，已改名留档:', bak, e.message);
    return { ...fallback };
  }
}

async function readVersionIndex(relPath) {
  const idxPath = path.join(versionDirFor(relPath), 'index.json');
  return readIndexJson(idxPath, { pinned: {} });
}

async function writeVersionIndex(relPath, index) {
  const dir = versionDirFor(relPath);
  await ensureDir(dir);
  await writeFileAtomic(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
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
  const idx = await readIndexJson(path.join(TRASH_DIR, 'index.json'), { items: [] });
  if (!Array.isArray(idx.items)) idx.items = [];
  return idx;
}
async function writeTrashIndex(index) {
  await ensureDir(TRASH_DIR);
  await writeFileAtomic(path.join(TRASH_DIR, 'index.json'), JSON.stringify(index, null, 2));
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
// 返回是否真的写成功。原先这里把错误吞掉只 console.error，
// 于是 set-config 照样 resolve、渲染进程以为存上了，实际磁盘没变。
async function saveConfig(cfg) {
  try {
    await writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return true;
  } catch (e) {
    console.error('保存配置失败:', e.message);
    return false;
  }
}

// ---------- 串行化 read-modify-write ----------
// 凡是"读出整份 JSON → 改一个字段 → 整份写回"的操作都必须串行。并发执行时
// 两边各自读到同一份旧快照，后写的把前写的整个覆盖掉——症状是偶发丢改动，极难复现。
//
// 三处都是这个形态，共用一套按 key 的 promise 链：
//   config      渲染进程有五个独立 debounce 在写（tabs 500ms / recent 500ms /
//               lockedFiles 400ms / sidebarWidth 400ms / expandedPaths 600ms），
//               一次"打开文件 + 拖宽侧边栏 + 展开目录"就会让它们在相近时刻落地。
//   trash       连续删两个文件时，第二条 unshift 基于旧快照，第一条记录直接消失，
//               而文件已经躺在 .trash 里成了孤儿（磁盘占着，UI 看不到，也删不掉）。
//   version:<rel> 快速连点星标会丢 pin 状态。按 rel 分链，不同文件互不阻塞。
const writeChains = new Map();
function queueWrite(key, fn) {
  const prev = writeChains.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  // 链条本身不能因为某次失败而断掉，否则后续写入全被拒绝
  const guard = run.then(() => {}, () => {});
  writeChains.set(key, guard);
  // 链尾自清理，避免 version:<rel> 这类动态 key 让 Map 无限增长
  guard.then(() => { if (writeChains.get(key) === guard) writeChains.delete(key); });
  return run;
}
function queueConfigWrite(fn) {
  return queueWrite('config', fn);
}

// 一次占多个 key。rename 要同时动源和目标两个文件（各自还有版本目录），
// 只占一个 key 的话另一侧仍可能被并发的 save-file 插进来。
//
// 多 key 必须按固定顺序获取，否则会死锁：A 占了 ver:x 等 ver:y、B 占了 ver:y 等
// ver:x，两边都不会释放。这里先排序再逐个嵌套，所有多 key 调用方的获取顺序就一致了，
// 环也就构造不出来。
//
// 全局约定的获取顺序（跨 key 类别）：ver:*（组内按字典序） → trash → config。
// 当前所有调用方都符合：save-file/pin/rollback 只占 ver:<rel>；trash 和 restore
// 占 ver:<rel> 后再占 trash（trash 内部还会再占 config）；empty-trash 只占 trash；
// set-config/项目类型只占 config；rename 占两个 ver:* 后再占 config。
// 没有任何一处反向获取，所以无环。新增写操作时若要占多个 key，必须沿用这个顺序。
// 排序不能用裸字典序：'config' < 'trash' < 'ver:'，正好和真实获取顺序相反。
// 只有 ver:* 一类多 key 时（rename）碰不出问题，一旦有人同时占 ver:* 和 trash，
// 字典序就会把 trash 排到前面，和 trash handler 内部"ver → trash → config"的
// 嵌套顺序对着来，环就出现了。所以先按类别 rank 排，再在类别内按字典序。
function lockRank(key) {
  if (key === 'config') return 2;
  if (key === 'trash') return 1;
  return 0; // ver:<rel>
}
function queueWriteMulti(keys, fn) {
  const uniq = Array.from(new Set(keys)).sort(
    (a, b) => (lockRank(a) - lockRank(b)) || (a < b ? -1 : a > b ? 1 : 0)
  );
  const acquire = (i) => (i >= uniq.length ? fn() : queueWrite(uniq[i], () => acquire(i + 1)));
  return acquire(0);
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

// 读"写之前的旧正文"。ENOENT 是正常情况（文件还不存在），返回 null；
// 其他任何错误都必须抛出去，绝不能当成"文件不存在"。
//
// 原先两处调用点都是裸 try/catch {}，分不清 ENOENT 和 EBUSY/EACCES/EMFILE/EIO。
// 代价不是"少存一次快照"这么轻：prev 停在 null 之后
//   1) saveVersion 被跳过——旧正文没有留下任何备份；
//   2) 紧接着 writeFileAtomic 把那个刚刚读不到的文件整个覆盖掉。
// 快照机制存在的意义正是兜住"磁盘上的内容和编辑器里的不一致"，
// 而这条路径恰好在最需要它的时候把它跳过了：保存照常返回成功，
// 磁盘上原来的正文永久消失，历史面板里也找不到对应快照。
// （附带一条：如果这次要写的正文本身没有 frontmatter，
//  bumpAutoFields(content, null) 还会把 version 归 1、createdAt 重算；
//  正文带 frontmatter 时以其中的值为准，不会重置。）
//
// 触发既不需要并发也不需要崩溃：杀软扫描、同步盘（OneDrive/坚果云）占用、
// 并发搜索时 fd 耗尽，任意一次瞬时锁就够，Windows 上尤其常见。
// 宁可让这次保存失败并弹出真实原因，也不能静默吃掉用户的正文。
async function readPrevContent(full) {
  try {
    return await fsp.readFile(full, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw appError('E_PREV_READ', (e && e.code ? e.code : 'UNKNOWN') + ' ' + full);
  }
}

// 排进 ver:<rel> 链。这个 handler 是 read-modify-write：读磁盘上的 prev →
// 存快照 → bumpAutoFields 拿 prev 算出新 version → 写回。并发时几路都读到同一份
// prev，算出同一个 version，后写的把前面的整个盖掉。
//
// 实测（并发保存探针）：连发 5 次保存，version 只从 1 涨到 2，丢了 4 次自增；
// 5 条快照只落了 3 条。触发路径不需要用户手快——Ctrl+S 和"保存"按钮都没有
// 防重入，按住 Ctrl+S 就能连发；exitEditMode 保存后切文件也会再走一次。
//
// 用和 pin-version 相同的 key：saveVersion 里的 pruneVersions 要读版本索引判断
// 星标，pin-version 要写这份索引，两者必须互斥，否则刚点的星标可能被裁掉。
// 按 rel 分链，不同文件之间不互相阻塞。
ipcMain.handle('save-file', async (e, rel, content) => queueWrite('ver:' + String(rel), async () => {
  const full = safeJoinWritable(rel);
  if (typeof content !== 'string') throw appError('E_CONTENT_NOT_STRING', typeof content);
  const prev = await readPrevContent(full);
  if (prev != null && prev !== content) await saveVersion(rel, prev);
  const toWrite = bumpAutoFields(content, prev);
  await ensureDir(path.dirname(full));
  await writeFileAtomic(full, toWrite);
  dropFromCache(full);
  return { content: toWrite, meta: parseFrontmatter(toWrite).meta };
}));

async function createFileAt(rel, content) {
  const full = safeJoinWritable(rel);
  if (typeof content !== 'string') throw appError('E_CONTENT_NOT_STRING', typeof content);
  const toWrite = bumpAutoFields(content, null);
  // 判重交给独占创建，不再自己 existsSync：见 writeFileExclusive 的说明。
  // 文件已存在时照旧抛 E_FILE_EXISTS，对调用方语义不变。
  await writeFileExclusive(full, toWrite, rel);
  dropFromCache(full);
  return { content: toWrite, meta: parseFrontmatter(toWrite).meta };
}

ipcMain.handle('create-file', (e, rel, content) => createFileAt(rel, content));

// 整个 handler 排进两侧文件各自的写链。原先完全没排队，而它由四步磁盘操作组成
// （判重 → 移正文 → 移版本目录 → 改锁列表），任意一步和并发的 save-file 交叉都会
// 留下半完成状态：
//   - 判重到 rename 之间有窗口，此刻另一路在 newRel 上保存，fsp.rename 直接把刚
//     存进去的正文覆盖掉（rename 不看目标存不存在），而两边都返回成功。
//   - 正文移走后、版本目录还没移时，另一路对 oldRel 保存会把 oldRel 重新创建出来，
//     结果同一份内容在新旧两个路径各有一份，版本历史却只跟着其中一个。
// 占两个 key 而不是一个：只占源的话，并发写目标的那条路照样插得进来。
// 顺序由 queueWriteMulti 统一排序，不会和别处形成环。
ipcMain.handle('rename', async (e, oldRel, newRel) => queueWriteMulti(
  ['ver:' + String(oldRel), 'ver:' + String(newRel)],
  async () => {
  // 两侧都过写入白名单：源要被移走（等于删），目标要被写入，
  // 任一侧落在 .versions/.trash/config.json 上都不行。
  const oldFull = safeJoinWritable(oldRel);
  const newFull = safeJoinWritable(newRel);
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
  // 锁定标记跟随改名，避免"改名 → 删除"绕过锁。
  //
  // 读改写整个塞进 queueConfigWrite：原先是在队列外 loadConfig，再拿这份快照去
  // updateConfig。渲染进程有五个 debounce 在并发写 config（tabs/recent/locked/
  // sidebarWidth/expandedPaths），只要在这两步之间插进来一次 lockedFiles 写入，
  // 就会被这里的旧快照整个覆盖——症状是刚锁的文件莫名解锁。
  //
  // updateConfig 现在会因写盘失败抛错，但这里必须吞掉：文件已经 rename 完了，
  // 抛出去渲染进程会显示"重命名失败"，而树刷新后文件明明已经改名。锁列表是
  // 事后记账，权威的失败信号走用户主动触发的 set-config。
  try {
    await queueConfigWrite(async () => {
      const cur = await loadConfig();
      if (!Array.isArray(cur.lockedFiles) || !cur.lockedFiles.includes(oldRel)) return;
      const next = cur.lockedFiles.filter(r => r !== oldRel);
      if (!next.includes(newRel)) next.push(newRel);
      const ok = await saveConfig({ ...cur, lockedFiles: next });
      if (!ok) throw appError('E_CONFIG_WRITE', CONFIG_PATH);
    });
  } catch (err) {
    console.error('锁定标记跟随改名失败（文件已改名）:', oldRel, '->', newRel, err.message);
  }
  return true;
}));

// 锁状态必须在 config 队列内读。原先是队列外裸 loadConfig()：渲染进程的
// lockedFiles 是 400ms 防抖写盘，"点锁定 → 立刻按删除"这个连招里，
// 锁还在防抖窗口里没落盘，或者正落盘落到一半（写队列里排着但还没执行），
// 这里读到的就是没有该文件的旧快照，于是锁形同虚设，文件照样进回收站。
// 排进队列后读到的是"此刻队列里所有已排队写入都完成后"的状态。
//
// 在 trash handler（持有 trash key）里再占 config 是允许的：
// 全局顺序是 ver:* → trash → config，config 永远最后占，构造不出环。
async function isLocked(rel) {
  return queueConfigWrite(async () => {
    const cfg = await loadConfig();
    return Array.isArray(cfg.lockedFiles) && cfg.lockedFiles.includes(rel);
  });
}

// 整个 handler 排进 trash 链：中间的 readTrashIndex → unshift → writeTrashIndex
// 是 read-modify-write，并发时后写的会覆盖掉前一条记录，而文件已经移进 .trash
// 成了索引里查不到的孤儿。
//
// 除了 trash 还要占 ver:<rel>：这个 handler 会把正文和版本目录搬走，而 save-file
// 只占 ver:<rel>，两边原先在同一个文件上完全不互斥。删除进行中发起的保存
// （Ctrl+S、切文件时的自动保存都会）会读到删除前的 prev、写回同一个路径，
// 然后被这里的 fsp.rename 一起卷进 .trash：保存返回成功，内容却不在树里了。
// 顺序由 queueWriteMulti 统一排（ver:* → trash），内部再占 config 也不成环。
ipcMain.handle('trash', async (e, rel) => queueWriteMulti(['ver:' + String(rel), 'trash'], async () => {
  // 删除同样是改动库内容：不加白名单就能把 config.json 移进回收站
  const full = safeJoinWritable(rel);
  if (await isLocked(rel)) throw appError('E_LOCKED', rel);
  if (!fs.existsSync(full)) return true;
  // 目录整棵搬进回收站后，empty-trash 用 unlink 删不掉（EPERM），却会无条件清空
  // 索引，结果整棵树永久留在 .trash 里、UI 再也看不到。回收站的语义只覆盖单个
  // .md 文件，这里直接拒绝目录。
  let st;
  try { st = await fsp.stat(full); } catch { return true; }
  if (st.isDirectory()) throw appError('E_TRASH_DIR_UNSUPPORTED', rel);
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
  // 索引写失败必须把文件搬回原处。原先是直接把异常抛出去：正文已经躺在 .trash 里，
  // 索引里却没有对应条目，于是文件树看不到、回收站列不出、empty-trash 也不会碰它，
  // 等于永久丢失，而用户看到的只是一句"删除失败"——照字面理解文件应该还在。
  try {
    await writeTrashIndex(index);
  } catch (err) {
    let back = true;
    try {
      await fsp.rename(storePath, full);
      dropFromCache(full);
    } catch (e2) {
      back = false;
      console.error('删除回滚失败，正文留在回收站但索引没有条目:', storePath, e2.message);
    }
    if (versionStore) {
      try { await fsp.rename(trashStorePath(versionStore), vDir); } catch (e2) {
        console.error('删除回滚：版本目录没能搬回:', versionStore, e2.message);
      }
    }
    throw appError(back ? 'E_TRASH_INDEX_WRITE' : 'E_TRASH_ORPHANED', rel);
  }
  // 清掉锁列表里的残留条目。和 rename 同理：读改写整个进配置队列，
  // 失败只记日志——文件已经在回收站里了，抛出去会显示"删除失败"但东西确实删了。
  try {
    await queueConfigWrite(async () => {
      const cur = await loadConfig();
      if (!Array.isArray(cur.lockedFiles) || !cur.lockedFiles.includes(rel)) return;
      const ok = await saveConfig({ ...cur, lockedFiles: cur.lockedFiles.filter(r => r !== rel) });
      if (!ok) throw appError('E_CONFIG_WRITE', CONFIG_PATH);
    });
  } catch (err) {
    console.error('清理锁定标记失败（文件已移入回收站）:', rel, err.message);
  }
  return true;
}));

ipcMain.handle('list-trash', async () => readTrashIndex());

// 启动自愈的报告。渲染进程本身不显示它（自愈是静默的，正常情况下没什么可说），
// 但必须有个把手能读到：否则"修了什么"只存在于 console 里，用户报障时拿不出来，
// 自检也没法断言修复真的发生过。第 9 项的诊断信息导出会直接用这份数据。
ipcMain.handle('get-heal-report', async () => lastHealReport);

// ---------- 诊断信息 ----------
// 采集所需的全部上下文都从这里传给 lib/diagnostics.js。那个模块刻意不 require
// ('electron')，也不自己解析目录：DATA_ROOT / CODE_ROOT 的判断只允许存在一份
// （见 130-140 行）。抄第二份的代价这个项目付过——打包版白屏。
//
// dirs 复用 TOP_DIRS，不在这里重新拼三个 path.join：那三个目录的定义已经有一处
// 真值来源了，遍历它们的地方（listTree / getMetaList / listTreeAndMeta）都从
// TOP_DIRS 取，诊断也照这个走，将来加第四个顶层目录才不会漏。
function diagnosticsContext() {
  return {
    appVersion: app.getVersion(),
    versions: process.versions,
    isPackaged: app.isPackaged,
    dataRoot: DATA_ROOT,
    codeRoot: CODE_ROOT,
    dirs: TOP_DIRS,
    healReport: lastHealReport,
    configPath: CONFIG_PATH,
    // 沙箱是否真的开着，以及为什么。这一项必须在诊断包里：降级是自动发生的，
    // 用户界面上看不出任何差别，不报出来就没人知道自己在不安全模式下跑了几个月。
    //
    // enabled 必须取 sandboxActive（此刻真正生效的模式），不能取
    // sandboxDecision.sandbox（启动时的判定）。两者只在一种情况下不同，而那种情况
    // 恰好是最需要如实上报的一种：沙箱开着但渲染进程起不来，就地降级重建了窗口。
    // 报启动判定的话，诊断包会说"沙箱开着"，而实际上用户正跑在无沙箱窗口上——
    // 这正是本次改动要消灭的那种假安全读数，只是换了个地方出现。
    // reason 同理跟着 sandboxRuntime 走：降级后它是 render-process-gone:xxx。
    //
    // confirmed 是"渲染进程这次真的起来了吗"（少了它，一个在加载完成前导出的
    // 诊断包会让人误以为沙箱验证通过）。
    //
    // strikes / degradedAt / lastConfirmedAt 现读磁盘，不用启动时那份快照：
    // 那三项是跨启动累积的历史，而启动快照是 confirm() 之前的状态，
    // 拿它报 lastConfirmedAt 会报出上一次启动的时间，看着像"本次没确认过"。
    // 诊断本来就是冷路径（同一个函数里已经在数文件、读日志尾部），多一次读不算事。
    sandbox: (() => {
      const st = sandboxState.read(SANDBOX_STATE_DIR);
      return {
        enabled: sandboxActive,
        reason: sandboxRuntime.reason || sandboxDecision.reason,
        confirmed: sandboxRuntime.confirmed,
        degradedThisRun: sandboxRuntime.degradedThisRun,
        strikes: st.strikes,
        degradedAt: st.degradedAt,
        lastConfirmedAt: st.lastConfirmedAt
      };
    })()
  };
}

// 只读采集，给"关于/诊断"面板直接显示用。
// collect() 里做同步 IO（数文件、读日志尾部），所以这是冷路径，别挂在任何
// 每次刷新都会走的地方。
ipcMain.handle('get-diagnostics', async () => diagnostics.collect(diagnosticsContext()));

// 恢复也要动库里的文件（正文搬回 originalRel、还原版本目录），所以除了 trash
// 还得占 ver:<originalRel>。否则并发的 save-file 能插在"判断目标是否存在"和
// fsp.rename 之间：那次保存返回成功，随后被 rename 无声覆盖（rename 不看目标
// 存不存在）。
//
// 锁 key 只能从索引里问出来，所以先在锁外读一遍。这一遍纯粹用来挑 key，
// 没有任何校验依赖它：条目在拿到锁之前被并发的 empty-trash 摘掉时，
// 锁内的 find 会返回 undefined，照旧抛 E_TRASH_ITEM_MISSING。
async function restoreLockKeys(id) {
  try {
    const idx = await readTrashIndex();
    const it = idx.items.find(i => i.id === id);
    if (it && it.originalRel != null) return ['ver:' + String(it.originalRel), 'trash'];
  } catch {}
  return ['trash'];
}

// 同样排进 trash 链：restore 也是 read-modify-write（读索引 → 移回文件 → 删条目）。
ipcMain.handle('restore', async (e, id) => queueWriteMulti(await restoreLockKeys(id), async () => {
  const index = await readTrashIndex();
  const item = index.items.find(i => i.id === id);
  if (!item) throw appError('E_TRASH_ITEM_MISSING');
  // 抛错而不是自动摘条目：store 名越界说明索引被写坏了，
  // 静默删条目会连带丢掉 .trash 里那份还能人工找回的文件。
  const storePath = trashStorePath(item.store);
  // store 文件不在了（被手动清理/外部删除）：直接把条目摘掉，否则 rename 会抛错，
  // 后面删条目的代码永远执行不到，回收站里留下一条每次点都失败的幽灵记录。
  if (!fs.existsSync(storePath)) {
    index.items = index.items.filter(i => i.id !== id);
    await writeTrashIndex(index);
    throw appError('E_TRASH_STORE_MISSING', item.originalRel);
  }
  // 还原是往库里写文件，所以走 safeJoinWritable 而不是 safeJoin：后者只拦
  // "跳出 DATA_ROOT"，库内的 .versions/.trash/config.json 照样允许写。
  // originalRel 来自 .trash/index.json，索引写坏之后 "config.json" 或
  // ".versions/x/1.md" 这种值会被原地覆盖，而删除入口（trash）一直是按
  // safeJoinWritable 卡的，还原口比删除口宽本身就不对称。
  // 老索引里若真有越界条目，这里会抛 E_WRITE_FORBIDDEN 并把条目留在回收站，
  // 比静默覆盖掉配置文件好。
  const targetFull = safeJoinWritable(item.originalRel);
  await ensureDir(path.dirname(targetFull));
  let finalRel = item.originalRel;
  if (fs.existsSync(targetFull)) {
    // 原位置已有同名，加后缀。
    // 注意不能写 slice(0, -ext.length)：无扩展名时 ext 是 ''，-0 === 0，
    // slice(0, 0) 得到空串，alt 就变成 "-restored1" 被还原到数据根目录下。
    // .gitkeep（renderer 新建目录时会创建）和被删的目录都会走到这条路径。
    const ext = path.extname(item.originalRel);
    const base = ext ? item.originalRel.slice(0, -ext.length) : item.originalRel;
    let n = 1;
    let alt = item.originalRel;
    while (fs.existsSync(safeJoinWritable(alt))) {
      alt = `${base}-restored${n}${ext}`;
      n++;
    }
    await fsp.rename(storePath, safeJoinWritable(alt));
    dropFromCache(safeJoinWritable(alt));
    finalRel = alt;
  } else {
    await fsp.rename(storePath, targetFull);
    dropFromCache(targetFull);
  }
  // 还原版本目录（若存在）。若目标版本目录已存在（同名文件被删后又重建过），
  // 不覆盖，而是并到新名字下保留两份历史。
  if (item.versionStore) {
    try {
      const vStorePath = trashStorePath(item.versionStore);
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
}));

ipcMain.handle('empty-trash', async () => queueWrite('trash', async () => {
  const index = await readTrashIndex();
  // 用 rm(recursive) 而不是 unlink：早期版本允许把目录搬进回收站，
  // unlink 删目录会 EPERM 失败。
  //
  // 一条删不掉不能拖垮整轮清空（否则后面的 writeTrashIndex 执行不到，已经删掉的
  // 条目还留在索引里，回收站里全是点不动的幽灵记录），但也不能像原先那样"记条日志
  // 然后无条件清空索引"：文件还在 .trash 占着磁盘，索引里的条目却没了，UI 再也
  // 看不到它、下一次清空也不会再碰它。所以删失败的条目原样留在索引里，
  // 并把失败抛给渲染进程——用户至少知道回收站没清干净，还能重试。
  const kept = [];
  const failedNames = [];
  for (const item of index.items) {
    // store 名越界/损坏说明索引被写坏了，.trash 里并没有这个名字对应的文件。
    // 留着条目会让回收站永远清不掉，所以摘掉它，只记日志。
    let storePath;
    try { storePath = trashStorePath(item.store); } catch (e) {
      console.error('清空回收站跳过损坏条目:', item.store, e.message);
      continue;
    }
    let ok = true;
    try { await fsp.rm(storePath, { recursive: true, force: true }); } catch (e) {
      ok = false;
      console.error('清空回收站条目失败:', item.store, e.message);
    }
    if (item.versionStore) {
      let vPath = null;
      try { vPath = trashStorePath(item.versionStore); } catch (e) {
        console.error('清空回收站跳过损坏的版本目录名:', item.versionStore, e.message);
      }
      if (vPath) {
        try { await fsp.rm(vPath, { recursive: true, force: true }); } catch (e) {
          ok = false;
          console.error('清空回收站版本目录失败:', item.versionStore, e.message);
        }
      }
    }
    if (!ok) {
      kept.push(item);
      failedNames.push(item.name || item.originalRel || item.id);
    }
  }
  await writeTrashIndex({ items: kept });
  if (kept.length) throw appError('E_TRASH_EMPTY_PARTIAL', failedNames.join(', '));
  return true;
}));

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

// 按文件排队（不同文件的星标互不影响，同一文件的连续点击必须串行）。
// 读索引 → 改 pinned → 写回同样是 read-modify-write：并发时后写的会把
// 前一次的星标整份覆盖掉。
ipcMain.handle('pin-version', async (e, rel, file, pinned) => queueWrite('ver:' + String(rel), async () => {
  // file 必须先过校验，否则非法名字会被写进索引长期留着
  versionFilePath(rel, file);
  const index = await readVersionIndex(rel);
  index.pinned = index.pinned || {};
  if (pinned) index.pinned[file] = true; else delete index.pinned[file];
  await writeVersionIndex(rel, index);
  return true;
}));

// 和 save-file 同链同理由：读 prev → 存快照 → 按 prev 算 version → 写回。
// 回滚和保存并发（点了回滚又按 Ctrl+S）时，不排队就会两边各写一次，
// 版本号只涨一次，其中一次的内容彻底消失。
ipcMain.handle('rollback-version', async (e, rel, file) => queueWrite('ver:' + String(rel), async () => {
  // 回滚是往库里写内容，走写入白名单（versionFilePath 另有自己的名字校验）
  const full = safeJoinWritable(rel);
  const versionFull = versionFilePath(rel, file);
  const versionContent = await fsp.readFile(versionFull, 'utf8');
  // 同 save-file：读失败必须抛，不能当作"文件不存在"。
  // 回滚这条路径上更要紧——它的全部意义就是"当前内容先存为新版本，不丢失"，
  // 而 prev 被静默吞成 null 时恰好跳过那次 saveVersion，把要保住的内容直接覆盖掉。
  const prev = await readPrevContent(full);
  // 当前内容先存为新版本（不丢失）
  if (prev != null && prev !== versionContent) await saveVersion(rel, prev);
  // 回滚写入（作为新一次保存，bump 自动字段）
  const toWrite = bumpAutoFields(versionContent, prev);
  // save-file 有这句，这里原先漏了：目录被外部删掉后回滚会 ENOENT 失败
  await ensureDir(path.dirname(full));
  await writeFileAtomic(full, toWrite);
  dropFromCache(full);
  return { content: toWrite, meta: parseFrontmatter(toWrite).meta };
}));

ipcMain.handle('get-meta-list', async () => {
  await ensureDirs();
  return getMetaList();
});

ipcMain.handle('search', async (e, query) => searchAll(query));

ipcMain.handle('get-config', async () => loadConfig());

// 经 queueConfigWrite 串行化：并发调用会排队，每次都基于最新的磁盘状态做合并。
//
// saveConfig 的返回值必须检查。它内部把写盘异常吞成 return false（磁盘满、
// config.json 被占用或只读、目录权限变了都会走到这），原先这里直接 await 完就
// 扔掉结果、照常 return next，于是 set-config 正常 resolve、渲染进程把内存里的
// state.config 当成已落盘。症状是改主题/语言/锁定当场生效，重启后全部回滚，
// 而且没有任何提示——用户只会觉得"这软件存不住设置"。
function updateConfig(patch) {
  return queueConfigWrite(async () => {
    const cur = await loadConfig();
    const next = { ...cur, ...(patch || {}) };
    const ok = await saveConfig(next);
    if (!ok) throw appError('E_CONFIG_WRITE', CONFIG_PATH);
    return next;
  });
}

ipcMain.handle('set-config', async (e, cfg) => {
  const next = await updateConfig(cfg);
  // 语言改了就重建原生菜单（buildMenu 只在启动时调一次，不管这里就永远停在旧语言）
  syncMenuLang(next.lang);
  return next;
});

// 渲染进程确认过"没有未保存改动"之后才走到这里。
// 菜单里不用 role:'reload'，因为那个 role 绕过渲染进程直接重载，草稿会无声丢失。
// 注意只能注册一次：ipcMain.handle 对同一通道重复注册会直接抛
// "Attempted to register a second handler"，那是在模块顶层执行的，整个应用起不来。
ipcMain.handle('reload-window', () => {
  if (win && !win.isDestroyed()) win.webContents.reload();
  return true;
});

// 按钮和标题都走 mt()：原先写死中文，英文界面下会弹出一个中英混排的框——
// 提示内容是渲染进程按当前语言传来的英文，按钮却是"取消 / 确定"。
// 主进程能直接读同一份 i18n 表（见文件开头的 I18N_TABLE），不必让渲染进程
// 把每个按钮文案都通过 IPC 传一遍。
ipcMain.handle('confirm', async (e, message) => {
  const res = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [mt('cancel_'), mt('ok')],
    defaultId: 1,
    cancelId: 0,
    message: mt('confirm'),
    detail: message
  });
  return res.response === 1;
});

// 三选一：保存 / 不保存 / 取消。
// confirm 只有两个按钮，表达不了"不保存但继续"这个选项——而切文件/切标签时
// 用户真正需要的就是它（见渲染进程的 leaveEditForSwitch）。
//
// 文案仍接受渲染进程传入（它有完整的 t() 上下文），但兜底值改成 mt() 而不是
// 写死中文：漏传时至少跟着界面语言走，不会突然冒出一个中文按钮。
// cancelId 指向"取消"，所以按 Esc 或点窗口关闭按钮都等于取消——
// 默认取最安全的那个分支，不会把草稿丢掉。
ipcMain.handle('confirm-unsaved', async (e, opts) => {
  const o = opts || {};
  const labels = [
    String(o.save || mt('saveChanges')),
    String(o.discard || mt('discardChanges')),
    String(o.cancel || mt('cancel'))
  ];
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: labels,
    defaultId: 0,
    cancelId: 2,
    // noLink 防止 Windows 把三个按钮渲染成命令链接样式，和应用里其他对话框不一致
    noLink: true,
    message: String(o.title || mt('unsavedTitle')),
    detail: String(o.detail || '')
  });
  return ['save', 'discard', 'cancel'][res.response] || 'cancel';
});

ipcMain.handle('export-zip', async () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const res = await dialog.showSaveDialog(win, {
    title: mt('dlgExportZip'),
    defaultPath: `prompt-backup-${stamp}.zip`,
    filters: [{ name: 'ZIP', extensions: ['zip'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  // 关键：必须监听输出流的 error。原先只挂了 archive 的 error，于是
  // 目标不可写（路径无权限/磁盘满/被占用）时 close 仍会触发 → resolve →
  // 返回 {ok:true}，用户被告知"备份成功"而磁盘上根本没有文件；
  // 目标是个目录时两个 error 都不触发，Promise 永不 settle，渲染进程的 await 永久挂起。
  // 备份是最不该骗人的功能，这里改成任一路失败都 reject，并清掉半截文件。
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const out = fs.createWriteStream(res.filePath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('error', (err) => done(reject, appError('E_EXPORT_WRITE', err.message)));
    out.on('close', () => done(resolve));
    archive.on('error', (err) => done(reject, appError('E_EXPORT_ARCHIVE', err.message)));
    archive.pipe(out);
    archive.directory(PROMPTS_DIR, 'prompts', {});
    archive.directory(WORKFLOWS_DIR, 'workflows', {});
    archive.directory(TEMPLATES_DIR, 'templates', {});
    archive.finalize().catch((err) => done(reject, appError('E_EXPORT_ARCHIVE', err.message)));
  }).catch(async (err) => {
    // 失败时别留下半截 zip 让用户误当成可用备份
    try { await fsp.unlink(res.filePath); } catch {}
    throw err;
  });
  return { ok: true, path: res.filePath };
});

ipcMain.handle('export-single', async (e, rel) => {
  const full = safeJoin(rel);
  const meta = parseFrontmatter(await fsp.readFile(full, 'utf8')).meta;
  const fileName = (meta.title || path.basename(rel, '.md')) + '.md';
  const res = await dialog.showSaveDialog(win, {
    title: mt('dlgExportSingle'),
    defaultPath: fileName,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  await fsp.writeFile(res.filePath, await fsp.readFile(full, 'utf8'), 'utf8');
  return { ok: true, path: res.filePath };
});

// 导出诊断信息。用户报障时把这个 JSON 贴出来，代替一来一回问"你的版本/系统/
// 数据目录在哪"。
//
// 必须由用户自己选保存位置：诊断包里含 DATA_ROOT 的真实路径（Windows 上带用户名），
// 那是故意不脱敏的——"路径指错"正是本项目最严重那次故障的根因，看不到真实路径
// 就白采集了。代价是这份文件不能自动上传、不能默默写到某个固定位置，
// 必须让用户看见它落在哪、由用户决定给谁看。
//
// writeFileAtomic 注入进去，而不是让 diagnostics 自己实现一份原子写：
// 临时名的形态（.tmp-<pid>-<seq>-*.part）和启动自愈的清理规则 TMP_PART_RE
// 是绑死的，出现第二份实现就会漂移，症状是自愈删掉别人正在写的临时文件、
// 或留下永远清不掉的垃圾。
ipcMain.handle('export-diagnostics', async () => {
  const res = await dialog.showSaveDialog(win, {
    title: mt('dlgExportDiagnostics'),
    defaultPath: diagnostics.defaultFileName(),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  const out = await diagnostics.exportTo(res.filePath, diagnosticsContext(), writeFileAtomic);
  logger.info('[diag] 已导出诊断信息，' + out.bytes + ' 字节');
  return { ok: true, path: res.filePath, bytes: out.bytes };
});

// ---------- 导入辅助 ----------
// 依据 frontmatter 决定落库位置，返回实际写入的相对路径。
async function importMarkdown(fileName, content) {
  const { meta } = parseFrontmatter(content);
  const title = sanitizeTitle(meta.title || path.basename(fileName, '.md'));
  const stage = (meta.stage && STAGES.includes(meta.stage)) ? meta.stage : 'project-init';
  const base = `prompts/${stage}/${title}.md`;
  // uniqueRel 只能按"此刻磁盘上有什么"挑名字，挑完到真正创建之间仍有窗口。
  // 而且这一段到 await 之前全是同步的：并发导入几个同名文件时，每一路都在
  // 别人落盘之前跑完 uniqueRel，于是全都挑中同一个名字。
  // createFileAt 现在是独占创建，撞上只会抛 E_FILE_EXISTS 而不会覆盖，
  // 所以这里重挑一次名字再试——导入的既有语义是"自动改名，不覆盖"。
  for (let attempt = 0; attempt < 50; attempt++) {
    const rel = uniqueRel(base, (r) => fs.existsSync(safeJoin(r)));
    try {
      await createFileAt(rel, content);
      return rel;
    } catch (e) {
      if (e && typeof e.message === 'string' && e.message.split('|')[0] === 'E_FILE_EXISTS') continue;
      throw e;
    }
  }
  throw appError('E_TOO_MANY_DUPES', base);
}

ipcMain.handle('import-single', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: mt('dlgImportSingle'),
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
    title: mt('dlgImportZip'),
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

// 项目类型的增删都是 read-modify-write，读必须和写在同一个队列里。
// 原先是队列外 loadConfig() 拿快照 → 改数组 → 交给 updateConfig 写，而 updateConfig
// 只把"合并 patch + 写盘"这一步排进队列。渲染进程有五个 debounce 在写 config
// （tabs / recent / lockedFiles / sidebarWidth / expandedPaths），读到写之间只要插进
// 一次，patch 里带的就是那份过期数组。两次增删之间也会互相覆盖：连着加两个类型，
// 后一次基于不含前一个的快照，落盘只剩后一个——UI 上两个都显示加成功了，重启就没了。
// 这里内联 loadConfig + saveConfig，不调 updateConfig：updateConfig 自己也走 config
// 队列，在队列回调里再调它会等自己所在链条的 guard，直接死锁。
function updateProjectTypes(mutate) {
  return queueConfigWrite(async () => {
    const cur = await loadConfig();
    const list = Array.isArray(cur.projectTypes) ? [...cur.projectTypes] : [...DEFAULT_PROJECT_TYPES];
    const next = mutate(list); // 抛错就是校验失败，链条的 guard 会兜住不影响后续写入
    const merged = next === null ? cur : { ...cur, projectTypes: next };
    const ok = await saveConfig(merged);
    if (!ok) throw appError('E_CONFIG_WRITE', CONFIG_PATH);
    return merged;
  });
}

ipcMain.handle('add-project-type', async (e, type) => {
  if (!type || typeof type !== 'string') throw appError('E_TYPE_INVALID');
  const t = String(type).trim();
  if (!t) throw appError('E_TYPE_EMPTY');
  return await updateProjectTypes((list) => {
    if (list.includes(t)) throw appError('E_TYPE_EXISTS', t);
    list.push(t);
    return list;
  });
});

ipcMain.handle('remove-project-type', async (e, type) => {
  return await updateProjectTypes((list) => {
    if (list.length <= 1) throw appError('E_TYPE_MIN_ONE');
    const idx = list.indexOf(type);
    if (idx === -1) return null; // 不存在：原样写回，保持原先"静默成功"的返回语义
    list.splice(idx, 1);
    return list;
  });
});

// ---------- 启动 ----------
async function ensureDirs() {
  for (const d of [PROMPTS_DIR, WORKFLOWS_DIR, TEMPLATES_DIR, VERSIONS_DIR, TRASH_DIR]) {
    await ensureDir(d);
  }
  // 确保阶段子目录存在
  for (const s of STAGES) await ensureDir(path.join(PROMPTS_DIR, s));
}

// ---------- 启动自愈 ----------
// 崩溃、断电、同步盘冲突、外部编辑之后，数据目录会留下几类"程序自己再也碰不到"
// 的残留。它们的共同点是**不报错**：界面看着正常，东西却已经找不回来了。
//
//   1. 回收站索引里有条目、.trash 里的文件没了 → 幽灵记录，每次点恢复都失败，
//      而且永远删不掉（restore 里虽然会顺手摘掉，但得先有人去点它）。
//   2. .trash 里有文件、索引里没有对应条目 → 反过来的情况，后果重得多：
//      文件树看不到（已从原位置移走）、回收站列不出、清空回收站也不会碰它，
//      等于永久丢失且占着磁盘。trash handler 的回滚失败分支就会留下这种残留
//      （E_TRASH_ORPHANED），日志里有一行，用户什么也看不到。
//   3. .tmp-<pid>-<seq>-*.part → writeFileAtomic 写到一半进程被杀留下的。
//      单个文件不大，但每次崩溃攒一个，且永远没人清。
//   4. store 名越界（"../OUTSIDE" 这种）→ 索引被写坏的证据。这类条目
//      empty-trash 会跳过、restore 会抛错，留着只是让回收站永远清不干净。
//
// 三条原则：
//   - **只做加法和摘引用，不删用户内容。** 唯一会被删掉的是 .part 临时文件
//     （按定义就是半截文件，没有任何完整内容）。孤立的正文一律"收养"成回收站
//     条目让它重新可见，而不是清理掉。
//   - **自愈失败绝不能拖垮启动。** 整段包在 try 里，最坏情况是什么都没修，
//     而不是应用起不来——那比原来的问题严重得多。
//   - **做过什么必须留痕。** 返回一份报告，写进日志，也供诊断导出使用。
let lastHealReport = null;

// .part 临时文件的判定必须严格按 writeFileAtomic 生成的形态来，
// 不能宽到 /\.part$/：用户自己的 .part 文件（下载工具的半成品之类）不该被删。
const TMP_PART_RE = /^\.tmp-\d+-\d+-.*\.part$/;
// 只清理"明显不是正在写"的：本进程刚生成的、以及 60 秒内动过的都跳过。
// 自检会同时拉起多个 Electron，但它们各自 PFM_DATA_DIR 不同，不会互相看见。
const TMP_PART_MIN_AGE_MS = 60 * 1000;

async function healDataDir() {
  const report = {
    ranAt: new Date().toISOString(),
    droppedGhostEntries: [],   // 索引里有、文件没了
    adoptedOrphanFiles: [],    // 文件在、索引里没有 → 收养成条目
    droppedBadStore: [],       // store 名越界
    orphanVersionDirs: [],     // 孤立的版本目录（只报告，不动）
    unrestorableEntries: [],   // originalRel 现在已不允许写入（只报告，不动）
    removedTempFiles: [],
    errors: []
  };

  // 和 IPC 用同一把 trash 锁。启动时还没有窗口、理论上没有并发，但自检会在
  // 页面加载完之后再触发一次，那时 IPC 是活的。
  await queueWrite('trash', async () => {
    // readTrashIndex 内部就带损坏处理：解析不出来会把坏文件改名留档并返回空清单。
    const index = await readTrashIndex();
    const before = index.items.length;
    const kept = [];
    const referenced = new Set();

    for (const item of index.items) {
      // store 名越界 = 索引被写坏。这类条目谁都处理不了，摘掉并大声记录。
      let storePath = null;
      try {
        storePath = trashStorePath(item.store);
      } catch (e) {
        report.droppedBadStore.push({ store: String(item.store), reason: e.message });
        continue;
      }
      if (!fs.existsSync(storePath)) {
        report.droppedGhostEntries.push({ id: item.id, name: item.name, store: item.store });
        continue;
      }
      referenced.add(path.basename(storePath));
      if (item.versionStore) {
        try { referenced.add(path.basename(trashStorePath(item.versionStore))); } catch {}
      }
      // 还原口按 safeJoinWritable 卡：老索引里若有 "config.json" 这种越界值，
      // 点恢复会抛 E_WRITE_FORBIDDEN。不动它（正文还在，可人工找回），只报告。
      try { safeJoinWritable(item.originalRel); } catch (e) {
        report.unrestorableEntries.push({ id: item.id, originalRel: String(item.originalRel), reason: e.message });
      }
      kept.push(item);
    }

    // 反向：.trash 里有正文、索引里没条目。收养成新条目让它重新可见。
    //
    // originalRel 是**恢复不出来的**——store 名只有 id + 扩展名，不含原路径。
    // 所以指到 prompts/recovered/ 下面：这个位置一定通得过 safeJoinWritable，
    // 用户点恢复就能拿回文件，再自己移到想要的地方。
    // 比"报告一句然后什么都不做"强，也比删掉安全。
    let entries = [];
    try {
      entries = await fsp.readdir(TRASH_DIR, { withFileTypes: true });
    } catch (e) {
      report.errors.push('读 .trash 失败: ' + e.message);
    }
    for (const e of entries) {
      const name = e.name;
      if (name === 'index.json') continue;
      if (name.startsWith('index.json.corrupt-')) continue; // 损坏留档，保留证据
      if (TMP_PART_RE.test(name)) continue;                  // 下面统一处理
      if (referenced.has(name)) continue;
      if (e.isDirectory()) {
        // 孤立的版本目录：里面是历史快照，不删也不收养（收养需要配一份正文）。
        report.orphanVersionDirs.push(name);
        continue;
      }
      if (!name.toLowerCase().endsWith('.md')) {
        report.errors.push('.trash 下有无法识别的孤立文件，未处理: ' + name);
        continue;
      }
      const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      let recoveredRel = 'prompts/recovered/' + name;
      let n = 1;
      while (fs.existsSync(path.join(DATA_ROOT, recoveredRel))) {
        recoveredRel = 'prompts/recovered/' + name.replace(/\.md$/i, '') + '-' + n + '.md';
        n++;
      }
      kept.push({
        id,
        originalRel: recoveredRel,
        name,
        trashedAt: new Date().toISOString(),
        store: name,
        versionStore: null,
        recovered: true
      });
      report.adoptedOrphanFiles.push({ store: name, originalRel: recoveredRel });
    }

    const changed = report.droppedGhostEntries.length || report.adoptedOrphanFiles.length
      || report.droppedBadStore.length || kept.length !== before;
    if (changed) {
      try {
        await writeTrashIndex({ ...index, items: kept });
      } catch (e) {
        // 写不回去就当什么都没修：索引还是旧的那份，下次启动再试。
        report.errors.push('回写回收站索引失败: ' + e.message);
      }
    }
  });

  // .part 清理只扫 writeFileAtomic 真正会写的那几个位置，**不能**从 DATA_ROOT
  // 递归下去：开发模式下 DATA_ROOT 就是仓库根目录，那样每次启动都要爬一遍
  // node_modules / .git / dist（本机 node_modules 就有十万级条目），
  // 白白把启动拖慢，而那些目录里根本不可能有本程序的临时文件。
  //
  // 写入点对照（grep writeFileAtomic 的调用方）：
  //   config.json        → DATA_ROOT 顶层，不需要递归
  //   .trash/index.json  → TRASH_DIR 一层
  //   版本快照和索引      → .versions/** 递归
  //   正文               → prompts / workflows / templates 递归
  const now = Date.now();
  let scanned = 0;

  const sweepFile = async (dir, name) => {
    if (!TMP_PART_RE.test(name)) return;
    // 名字里的 pid 是本进程 = 我们自己正在写，绝不能删。
    const m = name.match(/^\.tmp-(\d+)-/);
    if (m && Number(m[1]) === process.pid) return;
    const full = path.join(dir, name);
    let st;
    try { st = await fsp.stat(full); } catch { return; }
    if (now - st.mtimeMs < TMP_PART_MIN_AGE_MS) return; // 可能是别人正在写
    try {
      await fsp.unlink(full);
      report.removedTempFiles.push(path.relative(DATA_ROOT, full).replace(/\\/g, '/'));
    } catch (err) {
      report.errors.push('删临时文件失败 ' + name + ': ' + err.message);
    }
  };

  const walk = async (dir, recurse) => {
    if (scanned > 50000) return; // 上限防病态目录把启动拖住
    let list;
    try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      scanned++;
      if (e.isDirectory()) {
        if (recurse) await walk(path.join(dir, e.name), true);
        continue;
      }
      await sweepFile(dir, e.name);
    }
  };

  await walk(DATA_ROOT, false);
  for (const d of [TRASH_DIR, VERSIONS_DIR, PROMPTS_DIR, WORKFLOWS_DIR, TEMPLATES_DIR]) {
    await walk(d, true);
  }

  return report;
}

// 启动时跑一次，任何异常都吞掉：自愈是尽力而为，不能成为新的启动失败原因。
async function runStartupHeal() {
  try {
    const r = await healDataDir();
    lastHealReport = r;
    const counts = [
      ['幽灵条目', r.droppedGhostEntries.length],
      ['收养孤立正文', r.adoptedOrphanFiles.length],
      ['越界 store', r.droppedBadStore.length],
      ['残留临时文件', r.removedTempFiles.length]
    ].filter(([, n]) => n > 0);
    // 这一段从 console.* 换成 logger.*：字符串一个字都没动。
    // tests/heal.test.js:186 断言输出里出现 /\[heal\]/，而 195 行断言对照组的输出里
    // **没有** [heal]——logger 默认镜像到 console，所以 stdout 形状不变，
    // 同时这些行现在也会落进 logs/app.log，用户报障时拿得出来。
    if (counts.length) {
      logger.info('[heal] 已修复: ' + counts.map(([k, n]) => k + ' ' + n).join('，'));
      for (const g of r.droppedGhostEntries) logger.info('[heal] 摘掉幽灵条目（文件已不存在）: ' + g.store);
      for (const a of r.adoptedOrphanFiles) logger.info('[heal] 收养孤立正文 ' + a.store + ' → 可从回收站恢复到 ' + a.originalRel);
      for (const b of r.droppedBadStore) logger.error('[heal] 摘掉越界 store 条目: ' + b.store + '（' + b.reason + '）');
      for (const t of r.removedTempFiles) logger.info('[heal] 删除残留临时文件: ' + t);
    } else {
      logger.info('[heal] 数据目录检查通过，无需修复');
    }
    if (r.orphanVersionDirs.length) logger.info('[heal] 注意：.trash 下有孤立版本目录（未处理）: ' + r.orphanVersionDirs.join(', '));
    if (r.unrestorableEntries.length) logger.error('[heal] 注意：有条目的原路径已不允许写入，恢复会失败: ' + r.unrestorableEntries.map(x => x.originalRel).join(', '));
    for (const err of r.errors) logger.error('[heal] ' + err);
    return r;
  } catch (e) {
    logger.error('[heal] 自愈过程本身失败（已忽略，不影响启动）:', e && e.stack ? e.stack : e);
    lastHealReport = { ranAt: new Date().toISOString(), failed: String(e && e.message ? e.message : e) };
    return lastHealReport;
  }
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
//
// 队列按 kind 分流而不是一条流水线：文件对话框（save/open）和消息框
// （confirm / confirm-unsaved）的调用时机互不相干，混在一条队列里的话，
// 往中间插一个消息框应答就会把后面四个导出/导入的应答全错位一格。
// 不带 kind 的条目算文件对话框，保持既有队列不用改。
const selfTestDialogCalls = { file: 0, messageBox: 0 };
// 最近一次消息框的实际参数。原生对话框不在 DOM 里，渲染进程那段"切到英文后
// clone body 查残留中文"根本看不到它，所以主进程留一份给自检断言用——
// 否则"按钮写死中文"这类缺陷在自动化里是完全不可见的。
let selfTestLastMessageBox = null;
// 同理留一份文件对话框的标题（导出备份 / 导出提示词 / 导入提示词 / 导入备份包）。
let selfTestLastFileDialog = null;
function installSelfTestDialogStubs() {
  const queuePath = process.env.PFM_SELFTEST_DIALOGS;
  const takeNext = (kind, fallback) => {
    try {
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      const at = queue.findIndex(q => (q && q.kind ? q.kind : 'file') === kind);
      const item = at === -1 ? null : queue.splice(at, 1)[0];
      fs.writeFileSync(queuePath, JSON.stringify(queue), 'utf8');
      if (item) console.log('[selftest] 对话框桩返回(' + kind + '): ' + JSON.stringify(item));
      // 队列里没有对应条目说明测试没料到这次弹框。不能静默放行：
      // 走 fallback（取消）才不会让"多弹了一个框"看起来像成功。
      else console.error('[selftest] 对话框桩：' + kind + ' 队列已空，按取消处理');
      return item || fallback;
    } catch (e) {
      console.error('[selftest] 读取对话框队列失败:', e.message);
      return fallback;
    }
  };
  const recordFile = (args) => {
    const opts = (args.length > 1 ? args[1] : args[0]) || {};
    selfTestLastFileDialog = { title: opts.title == null ? '' : String(opts.title) };
  };
  dialog.showSaveDialog = async (...args) => {
    selfTestDialogCalls.file++;
    recordFile(args);
    return takeNext('file', { canceled: true });
  };
  dialog.showOpenDialog = async (...args) => {
    selfTestDialogCalls.file++;
    recordFile(args);
    return takeNext('file', { canceled: true, filePaths: [] });
  };
  // 消息框（确认 / 三选一的未保存提示）。回退值取调用方自己声明的 cancelId，
  // 这样"队列没料到的弹框"一律等于用户按了取消——对 confirm-unsaved 就是
  // 保住草稿、中止切换，是最安全的那个分支。
  dialog.showMessageBox = async (...args) => {
    const opts = (args.length > 1 ? args[1] : args[0]) || {};
    selfTestDialogCalls.messageBox++;
    selfTestLastMessageBox = {
      buttons: Array.isArray(opts.buttons) ? opts.buttons.slice() : [],
      message: opts.message == null ? '' : String(opts.message),
      detail: opts.detail == null ? '' : String(opts.detail)
    };
    return takeNext('message', { response: Number.isInteger(opts.cancelId) ? opts.cancelId : 0 });
  };
  console.log('[selftest] 已启用对话框桩，队列文件: ' + queuePath);
}

// ---------- 安全回归（跟着功能自检一起跑） ----------
// 这几条都要先把磁盘弄成"坏状态"才能测：伪造被改坏的 .trash/index.json、
// 把 config.json 占成目录让原子写必然失败。渲染进程没有 fs，构造不出前置条件，
// 所以放在主进程。全程只动 PFM_DATA_DIR 指向的临时目录。
async function runSecurityRegression(targetWin) {
  const out = [];
  const check = (name, ok, detail) => out.push([name, !!ok, detail == null ? '' : String(detail)]);
  // 从渲染进程发起 IPC：这样走的是和用户操作完全相同的链路，
  // 而不是在主进程里直接调 handler 内部函数（那样测不到 ipcMain 层）。
  const viaIpc = (expr) => targetWin.webContents.executeJavaScript(
    `(async () => { try { const r = await ${expr}; return { ok: true, value: r }; }
      catch (e) { return { ok: false, message: String(e && e.message || e) }; } })()`, true);

  // ---- 1. 回收站索引被改坏时不能删到 .trash 外面 ----
  // .trash/index.json 是普通 JSON 文件，同步盘冲突、外部编辑器、上次崩溃写坏
  // 都会让 store 变成 "../XXX"。empty-trash 对它调 rm(recursive, force)，
  // force 连"不存在"都不报错，删错了不留任何痕迹。
  const outsideDir = path.join(DATA_ROOT, 'SEC-MUST-SURVIVE');
  const outsideFile = path.join(outsideDir, 'keep.txt');
  try {
    await ensureDir(outsideDir);
    await fsp.writeFile(outsideFile, 'must survive', 'utf8');
    await ensureDir(TRASH_DIR);
    // 直接写坏索引，绕过所有正常入口
    await fsp.writeFile(path.join(TRASH_DIR, 'index.json'), JSON.stringify({
      items: [
        { id: 'sec-escape-1', originalRel: 'prompts/x.md', name: 'x.md',
          trashedAt: new Date().toISOString(), store: '../SEC-MUST-SURVIVE', versionStore: null },
        { id: 'sec-escape-2', originalRel: 'prompts/y.md', name: 'y.md',
          trashedAt: new Date().toISOString(), store: 'nested/../../SEC-MUST-SURVIVE', versionStore: null }
      ]
    }, null, 2), 'utf8');

    const emptied = await viaIpc('window.promptFlowApi.emptyTrash()');
    check('清空回收站在索引被改坏时仍返回成功', emptied.ok === true, emptied.message);
    check('越界的 store 没有删到 .trash 之外的目录', fs.existsSync(outsideDir));
    check('越界的 store 没有删到 .trash 之外的文件', fs.existsSync(outsideFile));

    // restore 走的是同一批 store 字段，同样要挡住
    await fsp.writeFile(path.join(TRASH_DIR, 'index.json'), JSON.stringify({
      items: [{ id: 'sec-escape-3', originalRel: 'prompts/z.md', name: 'z.md',
        trashedAt: new Date().toISOString(), store: '../SEC-MUST-SURVIVE', versionStore: null }]
    }, null, 2), 'utf8');
    const restored = await viaIpc(`window.promptFlowApi.restore('sec-escape-3')`);
    check('恢复越界条目会被拒绝而不是照做', restored.ok === false, JSON.stringify(restored));
    check('恢复失败后越界目录依然完好', fs.existsSync(outsideFile));
  } catch (e) {
    check('回收站越界防护用例执行完成', false, e && e.message);
  } finally {
    try { await fsp.writeFile(path.join(TRASH_DIR, 'index.json'), JSON.stringify({ items: [] }, null, 2), 'utf8'); } catch {}
    try { await fsp.rm(outsideDir, { recursive: true, force: true }); } catch {}
  }

  // ---- 2. 配置写盘失败必须传到渲染进程 ----
  // saveConfig 把写盘异常吞成 return false。原先 updateConfig 扔掉这个返回值，
  // set-config 照常 resolve，渲染进程把内存值当成已落盘——改完当场生效、重启全丢。
  // 这里把 config.json 换成目录：writeFileAtomic 最后那步 rename 必然 EPERM/EISDIR。
  let cfgBackup = null;
  try {
    try { cfgBackup = await fsp.readFile(CONFIG_PATH, 'utf8'); } catch { cfgBackup = null; }
    const before = await viaIpc('window.promptFlowApi.getConfig()');
    const themeBefore = before.ok ? before.value.theme : null;

    try { await fsp.unlink(CONFIG_PATH); } catch {}
    await fsp.mkdir(CONFIG_PATH, { recursive: true });
    const blocked = await viaIpc(`window.promptFlowApi.setConfig({ theme: 'sec-probe-theme' })`);
    check('配置写盘失败时 setConfig 抛错而不是假装成功', blocked.ok === false, JSON.stringify(blocked));
    check('失败信息带 E_CONFIG_WRITE 错误码',
      blocked.ok === false && /E_CONFIG_WRITE/.test(blocked.message || ''), blocked.message);

    // 复原后必须能正常写，且刚才那次失败的值没有残留在磁盘上
    await fsp.rm(CONFIG_PATH, { recursive: true, force: true });
    if (cfgBackup != null) await fsp.writeFile(CONFIG_PATH, cfgBackup, 'utf8');
    const after = await viaIpc(`window.promptFlowApi.setConfig({ theme: ${JSON.stringify(themeBefore || 'light')} })`);
    check('恢复可写后 setConfig 重新正常工作', after.ok === true, JSON.stringify(after));
    let onDisk = null;
    try { onDisk = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8')); } catch {}
    check('写盘失败的值没有留在 config.json 里',
      !onDisk || onDisk.theme !== 'sec-probe-theme', onDisk && onDisk.theme);
  } catch (e) {
    check('配置写失败用例执行完成', false, e && e.message);
  } finally {
    try {
      const st = fs.existsSync(CONFIG_PATH) ? await fsp.stat(CONFIG_PATH) : null;
      if (st && st.isDirectory()) await fsp.rm(CONFIG_PATH, { recursive: true, force: true });
      if (cfgBackup != null && !fs.existsSync(CONFIG_PATH)) await fsp.writeFile(CONFIG_PATH, cfgBackup, 'utf8');
    } catch {}
  }

  // ---- 3. 回收站里的文件只能还原回三个内容目录 ----
  // restore 原先用 safeJoin 决定写到哪，只挡住"跳出 DATA_ROOT"，
  // 挡不住 originalRel 指向 config.json 或 .versions/**。而删除入口用的是
  // safeJoinWritable，进得来的位置和出得去的位置标准不一致。
  try {
    await ensureDir(TRASH_DIR);
    const payload = path.join(TRASH_DIR, 'sec-payload.md');
    await fsp.writeFile(payload, 'payload', 'utf8');
    await fsp.writeFile(path.join(TRASH_DIR, 'index.json'), JSON.stringify({
      items: [{ id: 'sec-target', originalRel: 'config.json', name: 'config.json',
        trashedAt: new Date().toISOString(), store: 'sec-payload.md', versionStore: null }]
    }, null, 2), 'utf8');
    const res = await viaIpc(`window.promptFlowApi.restore('sec-target')`);
    check('还原到 config.json 被写入白名单拦住', res.ok === false, JSON.stringify(res));
    let cfgIntact = true;
    try {
      const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
      cfgIntact = raw !== 'payload';
    } catch { cfgIntact = true; }
    check('config.json 没被回收站里的文件覆盖', cfgIntact);
  } catch (e) {
    check('还原白名单用例执行完成', false, e && e.message);
  } finally {
    try { await fsp.writeFile(path.join(TRASH_DIR, 'index.json'), JSON.stringify({ items: [] }, null, 2), 'utf8'); } catch {}
    try { await fsp.unlink(path.join(TRASH_DIR, 'sec-payload.md')); } catch {}
  }

  // ---- 4. 并发保存不能丢自增、不能丢快照 ----
  // save-file 是 read-modify-write：读磁盘上的 prev → 存快照 → 用 prev 算新 version → 写回。
  // 原先它不排队，几路并发都读到同一份 prev，算出同一个 version，后写的整个盖掉前面的。
  // 实测连发 5 次：version 只从 1 涨到 2（丢 4 次自增），5 条快照只落 3 条，
  // 还有一次因为同毫秒快照撞名直接抛 EPERM 给用户。
  // 触发不需要手快：Ctrl+S 和保存按钮都没防重入，按住就连发；退出编辑态时也会再走一次。
  const J = (v) => JSON.stringify(v);
  const mkDoc = (body) => ['---', 'title: sec-concurrency', '---', body].join('\n');
  const relC = 'prompts/testing/sec-concurrency.md';
  const relS = 'prompts/testing/sec-timestamp.md';
  try {
    const created = await viaIpc(`window.promptFlowApi.createFile(${J(relC)}, ${J(mkDoc('base'))})`);
    if (!created.ok) {
      check('并发用例前置：创建文件', false, created.message);
    } else {
      const before = await viaIpc(`window.promptFlowApi.readFile(${J(relC)})`);
      const v0 = before.ok ? Number(before.value.meta.version) : null;

      // 同时发 N 个内容各不相同的保存，每个都该让 version +1
      const N = 5;
      const calls = [];
      for (let i = 0; i < N; i++) calls.push(`window.promptFlowApi.saveFile(${J(relC)}, ${J(mkDoc('body-' + i))})`);
      const settled = await targetWin.webContents.executeJavaScript(
        `(async () => { const rs = await Promise.allSettled([${calls.join(',')}]);
           return rs.map(r => r.status === 'fulfilled' ? 'ok' : String(r.reason && r.reason.message || r.reason)); })()`, true);
      check('并发保存全部成功（没有同毫秒撞名抛 EPERM）',
        settled.every(s => s === 'ok'), JSON.stringify(settled));

      const after = await viaIpc(`window.promptFlowApi.readFile(${J(relC)})`);
      const vN = after.ok ? Number(after.value.meta.version) : null;
      check(`并发 ${N} 次保存后 version 应为 ${v0 + N}`, vN === v0 + N,
        `实际 version=${vN}（起始 ${v0}，丢失 ${v0 + N - vN} 次自增）`);

      // 注意这条测的是 writeFileAtomic，不是队列：临时文件 + rename 保证任何时刻
      // 读到的都是某一次写入的完整内容。做反向对照时撤掉队列它依然是绿的（实测过），
      // 所以别把它算成并发覆盖——并发覆盖靠上面 version 和下面快照数那两条。
      const finalBody = after.ok ? String(after.value.content) : '';
      const hits = [];
      for (let i = 0; i < N; i++) if (finalBody.includes('body-' + i)) hits.push(i);
      check('原子写：磁盘正文是某一次保存的完整内容（不是半截或交错）', hits.length === 1,
        `命中 ${JSON.stringify(hits)}`);

      // N 次内容不同的保存，前 N-1 次的旧内容 + 初始内容 = N 条快照
      let snaps = [];
      try { snaps = (await fsp.readdir(versionDirFor(relC))).filter(f => f.endsWith('.md')); } catch {}
      check(`并发保存应产生 ${N} 条版本快照`, snaps.length === N,
        `实际 ${snaps.length} 条: ${JSON.stringify(snaps)}`);
    }

    // 快照撞名：saveVersion 必须往后挪毫秒，不能覆盖已存在的快照。
    //
    // 不能用"连发几次保存"来测：每次 IPC 往返实测约 12ms，永远撞不到同一毫秒，
    // 那样写出来的断言在修复被撤掉时依然是绿的（第一版就是这么写的，
    // 分离对照里证实了它测不到东西）。
    // 所以这里直接在主进程调 saveVersion，并预先把它接下来几毫秒会用到的名字
    // 全部占掉——这样它必然进入挪名分支，行为完全可判定：
    //   修复在  → 占位文件全部原样保留，快照落在一个新名字上
    //   修复不在 → 快照直接 rename 到占位名上，把它覆盖掉（Windows 上还可能抛 EPERM）
    const dirT = versionDirFor(relS);
    await ensureDir(dirT);
    // 占名窗口要同时满足两头：
    //   够宽——写这批占位文件本身要花时间，窗口必须宽到把这段耗时盖住，否则
    //         saveVersion 起手那一毫秒已经漂到窗口外面，根本不会撞名，
    //         断言就又变成"永远为真"；
    //   够窄——总数必须低于 MAX_UNPINNED_VERSIONS（30），否则 saveVersion 里的
    //         pruneVersions 会把最旧的占位文件裁掉，看起来像"被覆盖"。
    // 窗口起点是自适应的：写 25 个文件在 CI 机器上可能要三四十毫秒，比窗口本身还宽，
    // 固定从"现在"起算就会整段错过——CI 上真红过一次（窗口 ..666 .. ..690，
    // 而 saveVersion 要用 ..691）。所以每轮量一次实际耗时，下一轮把窗口整体后移到
    // "写完之后"再开始，这样不依赖机器快慢，也不用把窗口撑到触发 pruneVersions。
    const DECOY_MS = 25;
    let decoyNames = [];
    let wouldPick = null;
    let occupied = false;
    let offset = 0;
    for (let attempt = 0; attempt < 12 && !occupied; attempt++) {
      // 上一轮的占位文件必须清掉，否则累计超过 30 个会触发 pruneVersions
      for (const n of decoyNames) { try { fs.unlinkSync(path.join(dirT, n)); } catch {} }
      decoyNames = [];
      const t0 = Date.now();
      for (let i = 0; i < DECOY_MS; i++) decoyNames.push(timestampName(new Date(t0 + offset + i)) + '.md');
      for (const n of decoyNames) fs.writeFileSync(path.join(dirT, n), 'DECOY', 'utf8');
      wouldPick = timestampName(new Date()) + '.md';
      occupied = decoyNames.includes(wouldPick);
      if (!occupied) offset = (Date.now() - t0) + 2; // 下一轮从"写完"之后再开始占
    }

    // 前置断言：saveVersion 此刻会算出的名字必须已经被占掉，否则这个用例什么都没测到。
    check('撞名用例前置：目标快照名确实已被占用', occupied,
      `将要使用 ${wouldPick}，占名窗口 ${decoyNames[0]} .. ${decoyNames[decoyNames.length - 1]}`);

    await saveVersion(relS, 'SNAPSHOT-CONTENT');

    const survived = [];
    for (const n of decoyNames) {
      let raw = null;
      try { raw = await fsp.readFile(path.join(dirT, n), 'utf8'); } catch {}
      if (raw !== 'DECOY') survived.push(n + '=' + JSON.stringify(raw));
    }
    check('快照撞名时没有覆盖已存在的版本', survived.length === 0,
      `被改写/丢失的占位文件: ${JSON.stringify(survived)}`);

    const allT = (await fsp.readdir(dirT)).filter(f => f.endsWith('.md'));
    const fresh = allT.filter(f => !decoyNames.includes(f));
    check('快照撞名时改用新文件名落盘', fresh.length === 1, `新增文件: ${JSON.stringify(fresh)}`);
    if (fresh.length === 1) {
      const body = await fsp.readFile(path.join(dirT, fresh[0]), 'utf8');
      check('挪名后的快照内容正确', body === 'SNAPSHOT-CONTENT', JSON.stringify(body).slice(0, 80));
    }
  } catch (e) {
    check('并发保存用例执行完成', false, e && e.message);
  } finally {
    // 这几个文件是用例自己造的，留着会污染后续只读体检和搜索用例的计数
    for (const r of [relC, relS]) {
      try { await fsp.rm(path.join(DATA_ROOT, r), { force: true }); } catch {}
      try { await fsp.rm(versionDirFor(r), { recursive: true, force: true }); } catch {}
    }
  }

  // ---- 5. 项目类型增删不能互相覆盖（读必须在队列内） ----
  // add/remove-project-type 也是 read-modify-write。原先读在队列外：
  // loadConfig() 拿快照 → 改数组 → 交给 updateConfig，而 updateConfig 只把
  // "合并 patch + 写盘"排进队列。几路并发各自基于同一份旧快照算结果，
  // 后写的整个盖掉前面的，落盘只剩最后一个。每次调用都正常 resolve、
  // 界面上类型也都出现了，重启才发现少了——和丢锁定标记是同一个坑。
  const origCfg = await loadConfig();
  const origTypes = Array.isArray(origCfg.projectTypes) ? [...origCfg.projectTypes] : [...DEFAULT_PROJECT_TYPES];
  try {
    const baseTypes = ['sec-base-a', 'sec-base-b'];
    await viaIpc(`window.promptFlowApi.setConfig(${J({ projectTypes: baseTypes })})`);

    // 并发新增 5 个互不相同的类型，5 个都必须留在磁盘上
    const addNames = [];
    for (let i = 0; i < 5; i++) addNames.push('sec-add-' + i);
    const addCalls = addNames.map(n => `window.promptFlowApi.addProjectType(${J(n)})`);
    const addRes = await targetWin.webContents.executeJavaScript(
      `(async () => { const rs = await Promise.allSettled([${addCalls.join(',')}]);
         return rs.map(r => r.status === 'fulfilled' ? 'ok' : String(r.reason && r.reason.message || r.reason)); })()`, true);
    check('并发新增项目类型全部成功', addRes.every(s => s === 'ok'), JSON.stringify(addRes));

    const listAdd = (await loadConfig()).projectTypes || [];
    const missing = addNames.filter(n => !listAdd.includes(n));
    check('并发新增的 5 个项目类型都落盘了', missing.length === 0,
      `丢失 ${JSON.stringify(missing)}，磁盘上是 ${JSON.stringify(listAdd)}`);
    check('并发新增没有冲掉原有类型', baseTypes.every(n => listAdd.includes(n)), JSON.stringify(listAdd));

    // 删除阶段必须自己用 setConfig 铺前置，不能拿上面新增的结果当输入。
    // 第一版就是 addNames.slice(0, 4)，反向对照时发现它测不到东西：撤掉修复后
    // 新增阶段本来就丢了 4 个，删除的目标全都不在磁盘上，于是全走"不存在→静默成功"
    // 分支，"都消失了"自然为真。前置被上一步破坏，断言就变成永远为真。
    const delNames = [];
    for (let i = 0; i < 4; i++) delNames.push('sec-del-' + i);
    await viaIpc(`window.promptFlowApi.setConfig(${J({ projectTypes: [...baseTypes, ...delNames] })})`);
    const listPre = (await loadConfig()).projectTypes || [];
    check('并发删除用例前置：4 个待删类型都已在磁盘上',
      delNames.every(n => listPre.includes(n)), JSON.stringify(listPre));

    const delCalls = delNames.map(n => `window.promptFlowApi.removeProjectType(${J(n)})`);
    const delRes = await targetWin.webContents.executeJavaScript(
      `(async () => { const rs = await Promise.allSettled([${delCalls.join(',')}]);
         return rs.map(r => r.status === 'fulfilled' ? 'ok' : String(r.reason && r.reason.message || r.reason)); })()`, true);
    check('并发删除项目类型全部成功', delRes.every(s => s === 'ok'), JSON.stringify(delRes));

    const listDel = (await loadConfig()).projectTypes || [];
    const leftover = delNames.filter(n => listDel.includes(n));
    check('并发删除的 4 个项目类型都从磁盘上消失了', leftover.length === 0,
      `残留 ${JSON.stringify(leftover)}，磁盘上是 ${JSON.stringify(listDel)}`);
    check('并发删除没有连带删掉别的类型', baseTypes.every(n => listDel.includes(n)),
      JSON.stringify(listDel));

    // 上面的修复把两个 handler 改成了共用 mutate 回调，几条校验分支的语义必须保持不变
    const dup = await viaIpc(`window.promptFlowApi.addProjectType(${J(baseTypes[0])})`);
    check('新增重名类型仍然报 E_TYPE_EXISTS',
      dup.ok === false && /E_TYPE_EXISTS/.test(dup.message), JSON.stringify(dup));
    const blank = await viaIpc(`window.promptFlowApi.addProjectType("   ")`);
    check('新增空白类型仍然报 E_TYPE_EMPTY',
      blank.ok === false && /E_TYPE_EMPTY/.test(blank.message), JSON.stringify(blank));
    const noSuch = await viaIpc(`window.promptFlowApi.removeProjectType("sec-not-there")`);
    check('删除不存在的类型仍然静默成功', noSuch.ok === true, JSON.stringify(noSuch));

    await viaIpc(`window.promptFlowApi.setConfig(${J({ projectTypes: ['sec-only-one'] })})`);
    const lastOne = await viaIpc(`window.promptFlowApi.removeProjectType("sec-only-one")`);
    check('删到只剩一个时仍然报 E_TYPE_MIN_ONE',
      lastOne.ok === false && /E_TYPE_MIN_ONE/.test(lastOne.message), JSON.stringify(lastOne));
  } catch (e) {
    check('项目类型并发用例执行完成', false, e && e.message);
  } finally {
    // 后面还有只读体检在用这份 config，必须还原成用例开始前的样子
    try { await viaIpc(`window.promptFlowApi.setConfig(${J({ projectTypes: origTypes })})`); } catch {}
  }


  // ---- 6. contentCache 按 LRU 封顶，只读浏览也不会让它无限增长 ----
  // 原先只在文件被删/移/存时清对应条目：只读浏览过、从没变动的文件会永久留在
  // Map 里，每条还存了正文 + 一份全小写副本。长会话里反复浏览大库，常驻内存只增
  // 不减。这里把上限临时调小到 3，塞进 5 个文件，验证四件事：大小被压在上限内、
  // 最久未访问的被淘汰、命中会把条目挪回队尾（保护最近用的）、被淘汰的重读能重新入缓存。
  const savedCacheMax = CONTENT_CACHE_MAX;
  const cacheTestDir = path.join(DATA_ROOT, '.cache-lru-test');
  try {
    await fsp.mkdir(cacheTestDir, { recursive: true });
    CONTENT_CACHE_MAX = 3;
    const cf = [];
    for (let i = 0; i < 5; i++) {
      const fp = path.join(cacheTestDir, 'c' + i + '.md');
      await fsp.writeFile(fp, '# cache ' + i + '\nbody ' + i, 'utf8');
      cf.push(fp);
    }
    // 依次读入（都是 miss），c0..c4 顺序进队；上限 3，读到 c3、c4 时各淘汰一次队首
    for (const fp of cf) await readParsedCached(fp);
    check('LRU 淘汰后缓存大小压在上限内',
      contentCache.size === 3, 'size=' + contentCache.size + ', max=' + CONTENT_CACHE_MAX);
    check('最久未访问的文件被淘汰',
      !contentCache.has(cf[0]) && !contentCache.has(cf[1]),
      'c0在=' + contentCache.has(cf[0]) + ', c1在=' + contentCache.has(cf[1]));
    check('最近访问的三个文件留在缓存',
      contentCache.has(cf[2]) && contentCache.has(cf[3]) && contentCache.has(cf[4]),
      'c2=' + contentCache.has(cf[2]) + ', c3=' + contentCache.has(cf[3]) + ', c4=' + contentCache.has(cf[4]));

    // 队首此刻是 c2。命中 c2 应把它挪到队尾，于是下一个新文件进来时淘汰的是 c3 而非 c2。
    await readParsedCached(cf[2]);
    const c5path = path.join(cacheTestDir, 'c5.md');
    await fsp.writeFile(c5path, '# cache 5\nbody 5', 'utf8');
    await readParsedCached(c5path);
    check('命中会把条目挪回队尾，保护最近使用的项',
      contentCache.has(cf[2]) && !contentCache.has(cf[3]),
      'c2在=' + contentCache.has(cf[2]) + '（应在）, c3在=' + contentCache.has(cf[3]) + '（应被淘汰）');

    // 被淘汰的 c0 文件还在磁盘上，重读应重新入缓存并记一次 miss
    const missBefore = cacheMisses;
    await readParsedCached(cf[0]);
    check('被淘汰的文件重读会重新入缓存并计一次未命中',
      contentCache.has(cf[0]) && cacheMisses === missBefore + 1,
      'c0在=' + contentCache.has(cf[0]) + ', miss增量=' + (cacheMisses - missBefore));
  } catch (e) {
    check('contentCache LRU 用例执行完成', false, e && e.message);
  } finally {
    CONTENT_CACHE_MAX = savedCacheMax;
    for (let i = 0; i < 6; i++) contentCache.delete(path.join(cacheTestDir, 'c' + i + '.md'));
    try { await fsp.rm(cacheTestDir, { recursive: true, force: true }); } catch {}
  }

  // ---- 7. 新建/导入不能因为 check-then-write 静默覆盖 ----
  // createFileAt 原先是"fs.existsSync 判重 → writeFileAtomic"。两步之间有窗口，
  // 而 writeFileAtomic 结尾的 rename 会无条件覆盖目标，所以并发新建同名文件时
  // 几路都通过判重、几路都 rename，后一次把前一次的正文整个盖掉，且每一路都
  // 返回成功——用户看到"导入成功 5 条"，磁盘上其实只剩最后一条。
  // importMarkdown 更糟：它到第一个 await 之前全是同步的，几路必然都跑完
  // uniqueRel 才有人落盘，于是全都挑中同一个名字，不是窄窗口而是稳定复现。
  const exRel = 'prompts/project-init/sec-excl-dup.md';
  const imTitle = 'sec-imp-dup';
  const cleanupRels = [exRel];
  try {
    try { await fsp.rm(safeJoin(exRel), { force: true }); } catch {}

    // 5 路并发新建同一个 rel，各写不同正文
    const exRes = await Promise.allSettled(
      [0, 1, 2, 3, 4].map(i => createFileAt(exRel, '# excl ' + i + '\n\nEXCL-BODY-' + i))
    );
    const exOk = exRes.filter(r => r.status === 'fulfilled');
    const exFail = exRes.filter(r => r.status === 'rejected');
    // 这条才是真正能抓到缺陷的断言：修复前 5 路全部 fulfilled。
    check('并发新建同名文件只有一路成功',
      exOk.length === 1, '成功 ' + exOk.length + ' 路，失败 ' + exFail.length + ' 路');
    check('失败的各路都报 E_FILE_EXISTS',
      exFail.length === 4 && exFail.every(r =>
        String(r.reason && r.reason.message).split('|')[0] === 'E_FILE_EXISTS'),
      JSON.stringify(exFail.map(r => String(r.reason && r.reason.message))));

    // 注意：下面这条单独拿出来是抓不到缺陷的——rename 本身是原子的，
    // 修复前磁盘上也只会有某一路的完整正文。它的作用是守住"没有半截/混写正文"，
    // 真正的检测靠上面的成功路数。
    const exDisk = await fsp.readFile(safeJoin(exRel), 'utf8');
    const exMarkers = [0, 1, 2, 3, 4].filter(i => exDisk.includes('EXCL-BODY-' + i));
    check('磁盘上只有一路的完整正文，没有混写',
      exMarkers.length === 1, '匹配到标记 ' + JSON.stringify(exMarkers));

    // 5 路并发导入同一个标题：既有语义是"自动改名，不覆盖"，所以 5 路都该成功，
    // 但必须落到 5 个不同的文件上，5 份正文一份都不能丢。
    const imRes = await Promise.allSettled([0, 1, 2, 3, 4].map(i => importMarkdown(
      imTitle + '.md',
      '---\ntitle: ' + imTitle + '\nstage: project-init\n---\n\nIMP-BODY-' + i
    )));
    const imOk = imRes.filter(r => r.status === 'fulfilled').map(r => r.value);
    for (const r of imOk) cleanupRels.push(r);
    check('并发导入全部成功', imOk.length === 5,
      JSON.stringify(imRes.map(r => r.status === 'fulfilled' ? r.value
        : String(r.reason && r.reason.message))));

    const imUniq = [...new Set(imOk)];
    check('并发导入分配到的路径互不相同',
      imUniq.length === imOk.length, JSON.stringify(imOk));

    const imFound = new Set();
    for (const rel of imUniq) {
      let c = '';
      try { c = await fsp.readFile(safeJoin(rel), 'utf8'); } catch {}
      for (let i = 0; i < 5; i++) if (c.includes('IMP-BODY-' + i)) imFound.add(i);
    }
    check('并发导入的 5 份正文都完整落盘',
      imFound.size === 5, '只找到 ' + JSON.stringify([...imFound]) + '，落盘路径 ' + JSON.stringify(imUniq));
  } catch (e) {
    check('新建/导入独占创建用例执行完成', false, e && e.message);
  } finally {
    // 顺带把 uniqueRel 可能挑出的 -1..-9 变体一起清掉，别留给后面的用例
    for (let n = 1; n <= 9; n++) cleanupRels.push('prompts/project-init/' + imTitle + '-' + n + '.md');
    cleanupRels.push('prompts/project-init/' + imTitle + '.md');
    for (const rel of new Set(cleanupRels)) {
      const f = safeJoin(rel);
      try { await fsp.rm(f, { force: true }); } catch {}
      dropFromCache(f);
    }
  }



  // ---- 8. 路径校验不能被跨盘符绕过，窗口内导航只放行界面自身 ----
  // safeJoin 原先只判 path.relative(...).startsWith('..')。Windows 上跨盘符时
  // path.relative 返回的是绝对路径而不是一串 ..（实测
  // path.relative('D:\\a', 'C:\\Windows') === 'C:\\Windows'），startsWith('..')
  // 为假，于是整个包含性检查被绕过。versionDirFor 漏的是同一条。
  // 可达路径不需要 XSS：工作流 frontmatter 的 flow[].prompt 被渲染成流程节点的
  // data-prompt，用户点一下就走 read-file，库外文件的正文直接显示在预览区。
  try {
    // 另一个盘的盘符要按 DATA_ROOT 实际所在盘算，否则在 CI 上（临时目录在 C 盘）
    // 拿 C: 去测会走"同盘 .. 逃逸"分支，测不到跨盘符这条。
    const myDrive = String(path.parse(DATA_ROOT_NORM).root || 'C:\\').slice(0, 1).toUpperCase();
    const other = myDrive === 'C' ? 'D' : 'C';
    check('用例前置：构造的盘符与 DATA_ROOT 不同盘', other !== myDrive, `DATA_ROOT 在 ${myDrive}:，用 ${other}:`);

    const crossCases = [
      other + ':\\Windows\\win.ini',
      other + ':/Windows/win.ini',
      other + ':x.txt'           // 盘符相对形态
    ];
    const notBlocked = [];
    for (const c of crossCases) {
      let blocked = false;
      try { safeJoin(c); } catch (err) {
        blocked = String(err && err.message).split('|')[0] === 'E_PATH_ESCAPE';
      }
      if (!blocked) notBlocked.push(c);
    }
    check('safeJoin 拦住跨盘符绝对路径', notBlocked.length === 0, `放行了 ${JSON.stringify(notBlocked)}`);

    const notBlockedV = [];
    for (const c of crossCases) {
      let blocked = false;
      try { versionDirFor(c); } catch (err) {
        blocked = String(err && err.message).split('|')[0] === 'E_PATH_ESCAPE';
      }
      if (!blocked) notBlockedV.push(c);
    }
    check('versionDirFor 拦住跨盘符绝对路径', notBlockedV.length === 0, `放行了 ${JSON.stringify(notBlockedV)}`);

    // 走真实 IPC：这才是攻击者实际能碰到的入口（流程节点点击 → read-file）
    const ipcEsc = await viaIpc(`window.promptFlowApi.readFile(${J(other + ':\\\\Windows\\\\win.ini')})`);
    check('read-file 对跨盘符路径报 E_PATH_ESCAPE',
      ipcEsc.ok === false && /E_PATH_ESCAPE/.test(ipcEsc.message), JSON.stringify(ipcEsc));

    // 正常路径不能被误伤。自己造文件，不依赖种子数据：
    // PFM_DATA_DIR 指向的临时库里没有 templates/ 的随包内容，
    // 第一版直接读 templates/prompt-template.md，结果是 ENOENT 而不是校验通过，
    // 断言红得毫无意义（测的是文件在不在，不是路径校验放不放行）。
    const okRel = 'prompts/project-init/sec-crossdrive-ok.md';
    await viaIpc(`window.promptFlowApi.createFile(${J(okRel)}, ${J('---\ntitle: ok\n---\nBODY-OK')})`);
    const okRead = await viaIpc(`window.promptFlowApi.readFile(${J(okRel)})`);
    check('库内正常路径仍然可读', okRead.ok === true && /BODY-OK/.test(String(okRead.value && okRead.value.content)),
      JSON.stringify(okRead).slice(0, 160));
    try { await fsp.rm(safeJoin(okRel), { force: true }); } catch {}

    // ---- 导航守卫 ----
    // 原先是 url.startsWith('file://') 就放行。marked 默认不给链接加 target，
    // 所以正文里的相对链接（../../evil.html、//host/share/evil.html）不走
    // setWindowOpenHandler，正好落进这个放行分支；导航过去后 preload 会重新注入，
    // promptFlowApi 原样暴露给攻击者页面，而 CSP 只对 index.html 那一个文档生效。
    //
    // 这条前置断言很关键：SELF_URL 是用 pathToFileURL 拼的，必须和 Electron 实际
    // 加载的 URL 完全一致，否则 reload 会被自己的守卫拦掉。拿真实窗口的 URL 来验。
    const liveUrl = targetWin.webContents.getURL();
    check('用例前置：界面实际 URL 被 isSelfUrl 认可（reload 不会被误拦）',
      isSelfUrl(liveUrl), `实际 ${liveUrl}，SELF_URL ${SELF_URL}`);

    check('带 query/hash 的自身 URL 仍算自身（reload 容错）',
      isSelfUrl(SELF_URL + '?x=1') && isSelfUrl(SELF_URL + '#top'), 'query/hash 变体被拦了');

    // 审计里逐条验证过能通过 DOMPurify 的载荷形态
    const evilUrls = [
      'file:///C:/evil.html',
      pathToFileURL(path.join(CODE_ROOT, 'src', 'evil.html')).href, // 同目录旁路
      'file://attacker.example/share/evil.html',                     // UNC → 远端 SMB
      'file:///' + DATA_ROOT_NORM.replace(/\\/g, '/') + '/prompts/x.md'
    ];
    const leaked = evilUrls.filter(u => isSelfUrl(u));
    check('其余 file:// URL 一律不算自身', leaked.length === 0, `被当成自身: ${JSON.stringify(leaked)}`);

    // 上面几条只测 isSelfUrl 这个纯函数，测不到它有没有真的接到 will-navigate 上：
    // 把守卫改回 startsWith('file://') 时它们全是绿的（分离对照实测过）。
    // 所以这里真的让页面去导航一次，看拦没拦住——这才是攻击者实际走的那条路。
    const probePath = path.join(CODE_ROOT, 'src', 'evil-probe.html');
    try {
      fs.writeFileSync(probePath, '<html><body>PROBE</body></html>', 'utf8');
      const probeUrl = pathToFileURL(probePath).href;
      const urlBefore = targetWin.webContents.getURL();
      // 用正文里普通链接的等价形态发起窗口内导航（不是 window.open）
      await targetWin.webContents.executeJavaScript(
        `(() => { window.location.href = ${JSON.stringify(probeUrl)}; return 1; })()`, true);
      // 导航是异步的，给它足够时间真的发生
      await new Promise(r => setTimeout(r, 600));
      const urlAfter = targetWin.webContents.getURL();
      check('窗口内导航到其他 file:// 被真的拦住了（守卫已接线）',
        urlAfter === urlBefore,
        `导航前 ${urlBefore}，导航后 ${urlAfter}`);
      // 拦住之后界面必须还是活的，否则等于把应用弄坏了
      const stillAlive = await targetWin.webContents.executeJavaScript(
        `(() => typeof window.promptFlowApi === 'object' && !!document.getElementById('tree'))()`, true);
      check('拦下导航后页面依然正常（bridge 与 DOM 都在）', stillAlive === true, String(stillAlive));
    } finally {
      try { fs.unlinkSync(probePath); } catch {}
    }
  } catch (e) {
    check('路径与导航用例执行完成', false, e && e.message);
  }


  // ---- 9. 读旧正文失败时必须放弃保存，不能静默覆盖 ----
  // save-file / rollback-version 原先都是 try { prev = await readFile(...) } catch {}。
  // 只有 ENOENT 才该被吞掉（文件本来就不存在）；EBUSY/EACCES/EMFILE/EIO 落进同一个
  // 空 catch 之后，prev 停在 null，saveVersion 被跳过（旧正文没有留下快照），
  // 紧接着 writeFileAtomic 把这个刚刚读不到的文件整个盖掉。保存返回成功，正文没了。
  //
  // 用桩把 readFile 对这一个路径改成抛 EBUSY，是因为真去占用文件在 CI 上不可靠：
  // Linux 的 flock 是劝告锁，fs.readFile 照样读得到，构造不出前置条件。
  // 桩只拦目标路径，队列、快照、原子写全部走真实实现。
  const relPrev = 'prompts/testing/sec-prevread.md';
  const relPrevNew = 'prompts/testing/sec-prevread-new.md';
  const fullPrev = safeJoinWritable(relPrev);
  const mkPrevDoc = (body) => ['---', 'title: sec-prevread', '---', body].join('\n');
  const realReadFile = fsp.readFile;
  // 只对 fullPrev 抛指定错误码，其他读一律放行。返回命中计数器，
  // 前置断言要靠它确认桩真的被走到了（否则用例什么都没测到）。
  const stubReadFailure = (code, msg) => {
    const hits = { n: 0 };
    fsp.readFile = function (p, ...rest) {
      let same = false;
      try { same = path.resolve(String(p)) === path.resolve(fullPrev); } catch {}
      if (same) {
        hits.n++;
        const err = new Error(code + ': ' + msg + ', open ' + String(p));
        err.code = code;
        return Promise.reject(err);
      }
      return realReadFile.call(this, p, ...rest);
    };
    return hits;
  };
  try {
    const madePrev = await viaIpc('window.promptFlowApi.createFile(' + J(relPrev) + ', ' + J(mkPrevDoc('ORIGINAL-BODY')) + ')');
    check('读失败用例前置：创建文件', madePrev.ok === true, JSON.stringify(madePrev).slice(0, 160));

    // 再存一次，让 version 涨到 2 并留下一条快照，这样"快照数没变"才有对照价值
    await viaIpc('window.promptFlowApi.saveFile(' + J(relPrev) + ', ' + J(mkPrevDoc('ORIGINAL-BODY-v2')) + ')');
    const onDiskBefore = await realReadFile.call(fsp, fullPrev, 'utf8');
    let snapsBefore = [];
    try { snapsBefore = (await fsp.readdir(versionDirFor(relPrev))).filter(f => f.endsWith('.md')); } catch {}
    check('读失败用例前置：已有快照可作对照', snapsBefore.length >= 1, '快照 ' + snapsBefore.length + ' 条');

    const hitsSave = stubReadFailure('EBUSY', 'resource busy or locked');
    const saved = await viaIpc('window.promptFlowApi.saveFile(' + J(relPrev) + ', ' + J(mkPrevDoc('OVERWRITTEN-BODY')) + ')');
    fsp.readFile = realReadFile;

    check('读失败用例前置：桩真的被调用到了', hitsSave.n > 0, '命中 ' + hitsSave.n + ' 次');
    check('读旧正文失败时 save-file 报 E_PREV_READ 而不是返回成功',
      saved.ok === false && /E_PREV_READ/.test(String(saved.message)),
      JSON.stringify(saved).slice(0, 200));
    check('E_PREV_READ 带上真实系统错误码，用户能看出是被占用',
      /EBUSY/.test(String(saved.message)), String(saved.message).slice(0, 200));

    // 最关键的一条：磁盘上的旧正文必须还在
    const onDiskAfter = await realReadFile.call(fsp, fullPrev, 'utf8');
    check('读旧正文失败后磁盘正文没有被覆盖',
      onDiskAfter === onDiskBefore && !/OVERWRITTEN-BODY/.test(onDiskAfter),
      '盘上现在是 ' + JSON.stringify(onDiskAfter.slice(0, 120)));

    let snapsAfter = [];
    try { snapsAfter = (await fsp.readdir(versionDirFor(relPrev))).filter(f => f.endsWith('.md')); } catch {}
    check('保存被拒后不该留下半途的快照',
      snapsAfter.length === snapsBefore.length,
      '之前 ' + snapsBefore.length + ' 条，现在 ' + snapsAfter.length + ' 条');

    // 另一半同样重要：ENOENT 仍要当成"新文件"放行，不能把新建路径一起堵死
    const newSaved = await viaIpc('window.promptFlowApi.saveFile(' + J(relPrevNew) + ', ' + J(mkPrevDoc('BRAND-NEW')) + ')');
    check('文件不存在（ENOENT）时保存照旧成功，没有被误拦',
      newSaved.ok === true && /BRAND-NEW/.test(String(newSaved.value && newSaved.value.content)),
      JSON.stringify(newSaved).slice(0, 200));

    // rollback-version 走同一个 helper，一起验一遍
    const versions = await viaIpc('window.promptFlowApi.listVersions(' + J(relPrev) + ')');
    const vList = versions.ok && Array.isArray(versions.value) ? versions.value : [];
    const vFile = vList.length ? (typeof vList[0] === 'string' ? vList[0] : vList[0].file) : null;
    check('回滚用例前置：拿到一个可回滚的快照名',
      typeof vFile === 'string' && /\.md$/.test(vFile), JSON.stringify(versions).slice(0, 200));
    if (typeof vFile === 'string') {
      const hitsRoll = stubReadFailure('EACCES', 'permission denied');
      const rolled = await viaIpc('window.promptFlowApi.rollbackVersion(' + J(relPrev) + ', ' + J(vFile) + ')');
      fsp.readFile = realReadFile;
      check('读旧正文失败时 rollback-version 同样报 E_PREV_READ',
        rolled.ok === false && /E_PREV_READ/.test(String(rolled.message)) && hitsRoll.n > 0,
        JSON.stringify(rolled).slice(0, 200) + ' 桩命中 ' + hitsRoll.n);
      const afterRollback = await realReadFile.call(fsp, fullPrev, 'utf8');
      check('回滚被拒后磁盘正文没有被覆盖', afterRollback === onDiskBefore,
        '盘上现在是 ' + JSON.stringify(afterRollback.slice(0, 120)));
    }
  } catch (e) {
    check('读旧正文失败用例执行完成', false, e && e.message);
  } finally {
    fsp.readFile = realReadFile;
    for (const r of [relPrev, relPrevNew]) {
      try { await fsp.rm(path.join(DATA_ROOT, r), { force: true }); } catch {}
      try { await fsp.rm(versionDirFor(r), { recursive: true, force: true }); } catch {}
    }
  }

  // ---- 10. 回收站的写锁缺口与静默失败 ----
  // 三个独立问题，共用一批构造手法，所以放在同一节里：
  //   a) trash / restore 只占 trash 键，没占 ver:<rel>。这两个 handler 都在搬库里的
  //      正文和版本目录，而 save-file 只占 ver:<rel>——同一个文件上两边完全不互斥。
  //   b) empty-trash 删不掉某一条时只记日志，然后无条件把索引清空：文件还在 .trash
  //      里占着磁盘，索引条目却没了，UI 再也看不到它，下次清空也不会再碰它。
  //   c) trash 写索引失败时直接抛错，而正文已经躺在 .trash 里了：索引没有条目，
  //      文件树看不到、回收站列不出，等于永久丢失，而用户只看到一句"删除失败"。
  //
  // 并发那两条靠"把窗口撑宽"来做成可判定的：给关键那一次 fsp.rename 前面塞一段
  // 固定延时，再在延时中间发起 save-file。修复在 → save-file 被锁挡在外面，等
  // 前一个操作做完才跑，内容完好；修复不在 → save-file 必然落进窗口里，写完的正文
  // 被随后的 rename 搬走或覆盖，而两边都返回成功。延时只影响耗时，不改变任何语义。
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const realRename = fsp.rename;
  const realRm = fsp.rm;
  const realWriteFile = fsp.writeFile;
  // 只延迟指定的那一次 rename（按源/目标全路径精确匹配），其余 rename 原样放行。
  // 尤其不能误伤 writeFileAtomic 写 index.json 的 tmp→正式名那一次，
  // 否则测的就不是同一件事了。
  const stubRenameDelay = (matchFn, ms) => {
    const hits = { n: 0 };
    fsp.rename = async function (src, dst, ...rest) {
      let hit = false;
      try { hit = matchFn(path.resolve(String(src)), path.resolve(String(dst))); } catch {}
      if (hit) { hits.n++; await sleep(ms); }
      return realRename.call(this, src, dst, ...rest);
    };
    return hits;
  };
  const mkTrashDoc = (body) => ['---', 'title: sec-trashlock', '---', body].join('\n');

  // ---- 10a. 删除进行中的保存不能被一起卷进回收站 ----
  const relRace = 'prompts/testing/sec-trash-race.md';
  const fullRace = safeJoinWritable(relRace);
  try {
    const made = await viaIpc('window.promptFlowApi.createFile(' + J(relRace) + ', ' + J(mkTrashDoc('OLD-BODY')) + ')');
    check('删除并发用例前置：创建文件', made.ok === true, JSON.stringify(made).slice(0, 160));

    // 只拦"把这个文件搬进 .trash"那一次 rename
    const hits = stubRenameDelay(
      (src, dst) => src === path.resolve(fullRace) && path.dirname(dst) === path.resolve(TRASH_DIR_NORM),
      500
    );
    const both = await targetWin.webContents.executeJavaScript(
      '(async () => { const api = window.promptFlowApi;' +
      '  const settle = (p) => p.then(v => ({ ok: true, value: v }), e => ({ ok: false, message: String(e && e.message || e) }));' +
      '  const pTrash = settle(api.trash(' + J(relRace) + '));' +
      '  await new Promise(r => setTimeout(r, 80));' +
      '  const pSave = settle(api.saveFile(' + J(relRace) + ', ' + J(mkTrashDoc('SAVED-BODY')) + '));' +
      '  return { trash: await pTrash, save: await pSave }; })()', true);
    fsp.rename = realRename;

    check('删除并发用例前置：延时窗口真的生效了', hits.n > 0, '命中 ' + hits.n + ' 次');
    check('删除并发用例前置：删除本身成功', both.trash.ok === true, JSON.stringify(both.trash).slice(0, 160));
    // 保存报成功是这个 bug 之所以危险的原因：失败会被用户看见，成功不会。
    check('删除并发用例前置：保存也报成功', both.save.ok === true, JSON.stringify(both.save).slice(0, 160));

    // 核心断言：那次保存的正文必须仍然在库里，而不是被 rename 一起搬进 .trash。
    // 修复在 → save-file 排在 trash 后面执行，把文件重新建出来；
    // 修复不在 → save-file 写完的正文被 trash 的 rename 搬走，这里读不到任何东西。
    let onDisk = null;
    try { onDisk = await fsp.readFile(fullRace, 'utf8'); } catch {}
    check('删除进行中完成的保存没有被一起搬进回收站',
      onDisk != null && /SAVED-BODY/.test(onDisk),
      onDisk == null ? '文件已不在库里（正文只剩 .trash 里那份）' : JSON.stringify(onDisk.slice(0, 120)));

    // 另一头的对照：回收站里那份应该是删除时刻的旧正文。
    // 若它变成了 SAVED-BODY，说明保存插进了 rename 之前，两边确实交叉了。
    const idx = await readTrashIndex();
    const it = idx.items.find(i => i.originalRel === relRace);
    check('删除并发用例前置：回收站有对应条目', !!it, JSON.stringify(idx.items).slice(0, 160));
    if (it) {
      let stored = null;
      try { stored = await fsp.readFile(trashStorePath(it.store), 'utf8'); } catch {}
      check('回收站里存的是删除时刻的旧正文，不是并发保存的新正文',
        stored != null && /OLD-BODY/.test(stored) && !/SAVED-BODY/.test(stored),
        stored == null ? 'store 读不到' : JSON.stringify(stored.slice(0, 120)));
    }
  } catch (e) {
    check('删除并发用例执行完成', false, e && e.message);
  } finally {
    fsp.rename = realRename;
    try { await fsp.rm(fullRace, { force: true }); } catch {}
    try { await fsp.rm(versionDirFor(relRace), { recursive: true, force: true }); } catch {}
    try { await writeTrashIndex({ items: [] }); } catch {}
    try { for (const f of await fsp.readdir(TRASH_DIR)) if (f !== 'index.json') await fsp.rm(path.join(TRASH_DIR, f), { recursive: true, force: true }); } catch {}
  }

  // ---- 10b. 恢复进行中的保存不能被 rename 无声覆盖 ----
  // restore 先 existsSync 判断目标在不在，再 rename。判断和 rename 之间插进一次
  // save-file，那次保存会写出文件、返回成功，紧接着被 rename 覆盖掉（rename 不看
  // 目标存不存在）。占上 ver:<originalRel> 之后 save-file 只能排在后面。
  const relRestore = 'prompts/testing/sec-restore-race.md';
  const fullRestore = safeJoinWritable(relRestore);
  try {
    const made = await viaIpc('window.promptFlowApi.createFile(' + J(relRestore) + ', ' + J(mkTrashDoc('TRASHED-BODY')) + ')');
    check('恢复并发用例前置：创建文件', made.ok === true, JSON.stringify(made).slice(0, 160));
    const trashed = await viaIpc('window.promptFlowApi.trash(' + J(relRestore) + ')');
    check('恢复并发用例前置：文件已进回收站', trashed.ok === true, JSON.stringify(trashed).slice(0, 160));
    const idx0 = await readTrashIndex();
    const item0 = idx0.items.find(i => i.originalRel === relRestore);
    check('恢复并发用例前置：拿到回收站条目', !!item0, JSON.stringify(idx0.items).slice(0, 160));

    if (item0) {
      // 只拦"从 .trash 搬回原位置"那一次 rename
      const hits = stubRenameDelay(
        (src, dst) => dst === path.resolve(fullRestore) && path.dirname(src) === path.resolve(TRASH_DIR_NORM),
        500
      );
      const both = await targetWin.webContents.executeJavaScript(
        '(async () => { const api = window.promptFlowApi;' +
        '  const settle = (p) => p.then(v => ({ ok: true, value: v }), e => ({ ok: false, message: String(e && e.message || e) }));' +
        '  const pRestore = settle(api.restore(' + J(item0.id) + '));' +
        '  await new Promise(r => setTimeout(r, 80));' +
        '  const pSave = settle(api.saveFile(' + J(relRestore) + ', ' + J(mkTrashDoc('RESTORE-SAVED-BODY')) + '));' +
        '  return { restore: await pRestore, save: await pSave }; })()', true);
      fsp.rename = realRename;

      check('恢复并发用例前置：延时窗口真的生效了', hits.n > 0, '命中 ' + hits.n + ' 次');
      check('恢复并发用例前置：恢复本身成功', both.restore.ok === true, JSON.stringify(both.restore).slice(0, 160));
      check('恢复并发用例前置：保存也报成功', both.save.ok === true, JSON.stringify(both.save).slice(0, 160));

      // 核心断言：保存是后发的，它的正文必须是最终结果。
      // 修复不在 → 盘上留下的是 TRASHED-BODY，那次成功的保存被 rename 悄悄吃掉。
      let onDisk = null;
      try { onDisk = await fsp.readFile(fullRestore, 'utf8'); } catch {}
      check('恢复进行中完成的保存没有被 rename 覆盖',
        onDisk != null && /RESTORE-SAVED-BODY/.test(onDisk),
        onDisk == null ? '文件不存在' : JSON.stringify(onDisk.slice(0, 120)));
    }
  } catch (e) {
    check('恢复并发用例执行完成', false, e && e.message);
  } finally {
    fsp.rename = realRename;
    try { await fsp.rm(fullRestore, { force: true }); } catch {}
    try { await fsp.rm(versionDirFor(relRestore), { recursive: true, force: true }); } catch {}
    try { await writeTrashIndex({ items: [] }); } catch {}
    try { for (const f of await fsp.readdir(TRASH_DIR)) if (f !== 'index.json') await fsp.rm(path.join(TRASH_DIR, f), { recursive: true, force: true }); } catch {}
  }

  // ---- 10c. 清空回收站删不掉的条目必须留在索引里并报错 ----
  // 用桩让某一条的 rm 失败，是因为真构造一个"删不掉的文件"在 CI 上不可靠：
  // Linux 下把 .trash 设成只读会连 index.json 都写不了，测的就不是同一件事了。
  // 桩只拦那一个 store 路径，索引读写、其余条目全走真实实现。
  const relKeep = 'prompts/testing/sec-empty-keep.md';
  try {
    const made = await viaIpc('window.promptFlowApi.createFile(' + J(relKeep) + ', ' + J(mkTrashDoc('KEEP-BODY')) + ')');
    check('清空失败用例前置：创建文件', made.ok === true, JSON.stringify(made).slice(0, 160));
    const trashed = await viaIpc('window.promptFlowApi.trash(' + J(relKeep) + ')');
    check('清空失败用例前置：文件已进回收站', trashed.ok === true, JSON.stringify(trashed).slice(0, 160));
    const idx0 = await readTrashIndex();
    const item0 = idx0.items.find(i => i.originalRel === relKeep);
    check('清空失败用例前置：拿到回收站条目', !!item0, JSON.stringify(idx0.items).slice(0, 160));

    if (item0) {
      const storeFull = trashStorePath(item0.store);
      const hits = { n: 0 };
      fsp.rm = function (p, ...rest) {
        let same = false;
        try { same = path.resolve(String(p)) === path.resolve(storeFull); } catch {}
        if (same) {
          hits.n++;
          const err = new Error('EPERM: operation not permitted, rm ' + String(p));
          err.code = 'EPERM';
          return Promise.reject(err);
        }
        return realRm.call(this, p, ...rest);
      };
      const emptied = await viaIpc('window.promptFlowApi.emptyTrash()');
      fsp.rm = realRm;

      check('清空失败用例前置：桩真的被调用到了', hits.n > 0, '命中 ' + hits.n + ' 次');
      check('清空回收站删不掉条目时报错而不是返回成功',
        emptied.ok === false && /E_TRASH_EMPTY_PARTIAL/.test(String(emptied.message)),
        JSON.stringify(emptied).slice(0, 200));

      // 最关键的一条：文件还在 .trash 里，索引条目就必须留着，否则它彻底失去入口。
      const idx1 = await readTrashIndex();
      check('删不掉的条目留在索引里，回收站还能看到它',
        idx1.items.some(i => i.id === item0.id),
        '索引现在有 ' + idx1.items.length + ' 条: ' + JSON.stringify(idx1.items.map(i => i.originalRel)));
      check('删不掉的条目对应的文件确实还占着磁盘', fs.existsSync(storeFull), storeFull);

      // 另一半：rm 恢复正常后必须能真的清干净，不能因为上面那次失败卡住
      const again = await viaIpc('window.promptFlowApi.emptyTrash()');
      check('恢复可删后再清空一次能成功', again.ok === true, JSON.stringify(again).slice(0, 200));
      check('第二次清空后索引真的空了', (await readTrashIndex()).items.length === 0);
      check('第二次清空后文件也真的删掉了', !fs.existsSync(storeFull), storeFull);
    }
  } catch (e) {
    check('清空回收站失败用例执行完成', false, e && e.message);
  } finally {
    fsp.rm = realRm;
    try { await realRm.call(fsp, path.join(DATA_ROOT, relKeep), { force: true }); } catch {}
    try { await writeTrashIndex({ items: [] }); } catch {}
  }

  // ---- 10d. 删除时索引写失败必须把文件搬回原处 ----
  // 桩只拦 writeFileAtomic 给 .trash/index.json 用的那个临时文件，
  // 回滚要用的 rename 完全没被动过。
  const relRollback = 'prompts/testing/sec-trash-rollback.md';
  const fullRollback = safeJoinWritable(relRollback);
  try {
    const made = await viaIpc('window.promptFlowApi.createFile(' + J(relRollback) + ', ' + J(mkTrashDoc('ROLLBACK-BODY')) + ')');
    check('删除回滚用例前置：创建文件', made.ok === true, JSON.stringify(made).slice(0, 160));
    // 再存一次，让它有版本目录，这样"版本目录也搬回来了"才有对照价值
    await viaIpc('window.promptFlowApi.saveFile(' + J(relRollback) + ', ' + J(mkTrashDoc('ROLLBACK-BODY-v2')) + ')');
    const bodyBefore = await fsp.readFile(fullRollback, 'utf8');
    let snapsBefore = [];
    try { snapsBefore = (await fsp.readdir(versionDirFor(relRollback))).filter(f => f.endsWith('.md')); } catch {}
    check('删除回滚用例前置：已有版本目录可作对照', snapsBefore.length >= 1, '快照 ' + snapsBefore.length + ' 条');

    const hits = { n: 0 };
    fsp.writeFile = function (p, ...rest) {
      let hit = false;
      try {
        const rp = path.resolve(String(p));
        hit = path.dirname(rp) === path.resolve(TRASH_DIR_NORM) && /^\.tmp-.*-index\.json\.part$/.test(path.basename(rp));
      } catch {}
      if (hit) {
        hits.n++;
        const err = new Error('EACCES: permission denied, open ' + String(p));
        err.code = 'EACCES';
        return Promise.reject(err);
      }
      return realWriteFile.call(this, p, ...rest);
    };
    const res = await viaIpc('window.promptFlowApi.trash(' + J(relRollback) + ')');
    fsp.writeFile = realWriteFile;

    check('删除回滚用例前置：桩真的被调用到了', hits.n > 0, '命中 ' + hits.n + ' 次');
    check('索引写失败时删除报 E_TRASH_INDEX_WRITE 而不是裸系统错误',
      res.ok === false && /E_TRASH_INDEX_WRITE/.test(String(res.message)),
      JSON.stringify(res).slice(0, 200));

    // 核心断言：文件必须回到原处。修复不在 → 正文留在 .trash 里而索引没有条目，
    // 文件树、回收站、下次清空都碰不到它，等于永久丢失。
    let bodyAfter = null;
    try { bodyAfter = await fsp.readFile(fullRollback, 'utf8'); } catch {}
    check('索引写失败后正文回到原位置且内容未变',
      bodyAfter === bodyBefore,
      bodyAfter == null ? '文件不在原位置（只剩 .trash 里那份孤儿）' : JSON.stringify(bodyAfter.slice(0, 120)));

    let snapsAfter = [];
    try { snapsAfter = (await fsp.readdir(versionDirFor(relRollback))).filter(f => f.endsWith('.md')); } catch {}
    check('索引写失败后版本目录也搬回了原处',
      snapsAfter.length === snapsBefore.length,
      '之前 ' + snapsBefore.length + ' 条，现在 ' + snapsAfter.length + ' 条');

    check('索引里没有留下半条记录', !(await readTrashIndex()).items.some(i => i.originalRel === relRollback));
    let leftover = [];
    try { leftover = (await fsp.readdir(TRASH_DIR)).filter(f => f !== 'index.json' && !f.startsWith('.tmp-')); } catch {}
    check('.trash 里没有留下孤儿文件', leftover.length === 0, JSON.stringify(leftover));

    // 复原后照旧能正常删除，证明上面那次失败没把状态弄坏
    const ok2 = await viaIpc('window.promptFlowApi.trash(' + J(relRollback) + ')');
    check('恢复可写后删除重新正常工作', ok2.ok === true, JSON.stringify(ok2).slice(0, 200));
  } catch (e) {
    check('删除回滚用例执行完成', false, e && e.message);
  } finally {
    fsp.writeFile = realWriteFile;
    try { await fsp.rm(fullRollback, { force: true }); } catch {}
    try { await fsp.rm(versionDirFor(relRollback), { recursive: true, force: true }); } catch {}
    try { await writeTrashIndex({ items: [] }); } catch {}
    try { for (const f of await fsp.readdir(TRASH_DIR)) if (f !== 'index.json') await fsp.rm(path.join(TRASH_DIR, f), { recursive: true, force: true }); } catch {}
  }

  // ---- 10e. 多 key 获取顺序必须是 ver:* → trash → config ----
  // trash/restore 现在同时占 ver:<rel> 和 trash，而 trash handler 内部还会再占
  // config。queueWriteMulti 原先用裸 sort()，而字典序是 config < trash < ver:*，
  // 正好和真实获取顺序相反——一旦有第二处按 ver → trash 的方向拿锁（比如以后给
  // save-file 加一次回收站查重），两边就构成环，双方都不会释放。
  // 这一条测的是那个不变量本身：先占住 trash，再发一个 ['ver:probe','trash'] 的
  // 多 key 请求，然后看 ver:probe 有没有被它先占走。
  //   顺序正确（ver 先） → 探针排在后面，此刻跑不了
  //   顺序反了（trash 先）→ 多 key 请求还卡在 trash 上，ver:probe 是空的，探针立刻跑
  try {
    let releaseTrash;
    const gate = new Promise(r => { releaseTrash = r; });
    const holder = queueWrite('trash', () => gate);
    await sleep(30);

    let multiDone = false;
    const multi = queueWriteMulti(['ver:sec-lock-probe', 'trash'], async () => { multiDone = true; });
    await sleep(30);
    check('锁顺序用例前置：多 key 请求此刻确实被 trash 挡住', multiDone === false);

    let probeRan = false;
    const probe = queueWrite('ver:sec-lock-probe', async () => { probeRan = true; });
    await sleep(30);
    check('多 key 请求先占 ver:*，再等 trash（顺序没被字典序倒过来）',
      probeRan === false,
      probeRan ? 'ver:sec-lock-probe 还是空的，说明先去抢 trash 了' : '');

    releaseTrash();
    await holder;
    await multi;
    await probe;
    check('放开 trash 后多 key 请求和探针都能跑完（没有死锁）', multiDone === true && probeRan === true,
      'multi=' + multiDone + ' probe=' + probeRan);
  } catch (e) {
    check('锁顺序用例执行完成', false, e && e.message);
  }

  return out;
}

// ---------- 自检（PFM_SELFTEST=1） ----------
// 存在的理由：这个应用出过两类"进程能起来但界面是白的"的故障
//   1) renderer.js 顶层与其他脚本重名，整段脚本不执行；
//   2) 打包后 preload / index.html 路径指向了数据目录。
// 这两种问题只有真正把页面加载起来才暴露得出来，纯静态检查测不到，
// 所以提供一个无人工干预的自检入口供 CI / 冒烟测试调用。
// 自检脚本从 src/selftest/*.js 读，而不是写成主进程里的模板字符串。
// 为什么要拆出去：这三段一共 415 行真代码，写成 `...` 之后对所有静态检查
// 都是不透明的——实测在里面塞一个 `const const x = 1`，node --check、eslint、
// 冒烟测试三层全绿，而它一运行必炸。拆成真实 .js 文件后 eslint 才看得见。
//
// 用 CODE_ROOT 而不是 DATA_ROOT：这是代码资源，打包后在 asar 内（只读），
// 数据目录里没有这些文件。build.files 里的 src/**/* 已经覆盖了这个子目录。
//
// 同步读：自检是一次性启动流程，没有并发压力；而且读不到就该立刻炸掉，
// 不能让自检"少跑了一段"却仍然报全部通过。
function loadSelfTestScript(name) {
  const p = path.join(CODE_ROOT, 'src', 'selftest', name);
  const code = fs.readFileSync(p, 'utf8');
  // executeJavaScript 要的是一个表达式。文件本身就是 (async () => {...})()，
  // 但结尾可能带换行/BOM，去掉以免拼接后变成语句序列。
  return code.replace(/^\uFEFF/, '').trim();
}

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

  const probeScript = loadSelfTestScript('probe.js');

  // 在页面里跑，直接调 contextBridge 暴露的 API → 真实经过 IPC 与主进程逻辑。
  const functionalScript = loadSelfTestScript('functional.js');

  // 在页面里模拟真实点击。只依赖 DOM 与真实事件，不走任何测试专用后门。
  const uiScript = loadSelfTestScript('ui.js');

  return {
    run: async () => {
      const fail = (msg) => { console.error('[selftest] FAIL ' + msg); process.exitCode = 1; };
      // PFM_SELFTEST_CLOSE=flush|destroy：验证关窗时还挂在防抖窗口里的配置写入
      // 会被真的落盘（见 win.on('close') 与渲染进程的 __pfmFlushPending）。
      //
      // 成败不在这里判：进程退出之后由 tests/close-flush.test.js 读 config.json 定论。
      // "落盘"要等关窗流程整个走完才算数，在进程里自己断言等于自己发毕业证。
      //
      // destroy 是反向对照：win.destroy() 不触发 'close'，握手根本不会跑，那次改动
      // 就该跟着窗口一起没了。两组结果不同，才说明 flush 组测到的是握手本身，
      // 而不是"这个值反正总会被写进去"。
      //
      // 关键一步是把防抖的自然计时器挪到 10 分钟以后（下面临时改 setTimeout 的延时）。
      // 不这么做的话，flush 组即使握手完全失效，400ms 的计时器自己也可能把值写进去，
      // 于是测试照样绿——这就是个空断言。挪走之后，只有 flush() 能让这次写入完成。
      //
      // 这段不能放进下面的 try/finally：那里的 finally 会调 app.exit()，
      // 而 app.exit() 不走窗口关闭流程，会把正在进行的 flush 直接掐断。
      if (process.env.PFM_SELFTEST_CLOSE) {
        await loaded;
        if (!process.env.PFM_DATA_DIR) {
          fail('关窗落盘自检必须设置 PFM_DATA_DIR，拒绝在真实数据目录上跑');
          app.exit(1);
          return;
        }
        const mode = process.env.PFM_SELFTEST_CLOSE;
        const markWidth = 377;
        // 直接调防抖函数，不经过 toggleLockFile：后者现在会立刻 flush（锁定要尽快变成
        // 磁盘事实），那就没有"待写入"状态可测了。这里要的正是挂着还没落盘的状态。
        const sched = await targetWin.webContents.executeJavaScript(
          '(() => {'
          + ' const origST = window.setTimeout;'
          + ' window.setTimeout = function (fn, ms) { return origST.call(window, fn, 600000); };'
          + ' try {'
          + '   saveSidebarWidthDebounced(' + markWidth + ');'
          + '   saveTabsDebounced();'
          + ' } finally { window.setTimeout = origST; }'
          + ' return { hasFlush: typeof window.__pfmFlushPending === "function" };'
          + ' })()', true);
        if (!sched.hasFlush) fail('渲染进程没有暴露 __pfmFlushPending，关窗握手无从谈起');
        else console.log('[selftest:close] PASS 渲染进程暴露了 __pfmFlushPending');
        // 前置条件：此刻必须还没落盘。若这时磁盘上已经是新值，说明它是别的路径写进去的，
        // 后面无论看到什么都证明不了 flush 起了作用。
        let before = {};
        try { before = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
        if (before.sidebarWidth === markWidth) {
          fail('前置条件不成立：待写入的值在关窗之前就已经落盘了');
        } else {
          console.log('[selftest:close] PASS 关窗前该值还挂在防抖里（磁盘上是 '
            + JSON.stringify(before.sidebarWidth) + '）');
        }
        console.log('[selftest:close] 模式=' + mode);
        if (mode === 'destroy') targetWin.destroy();
        else targetWin.close();
        // 故意不调 app.exit()：让关窗流程自己走完（close → 异步收尾 → 真的关 →
        // window-all-closed → app.quit()），进程退出后由测试脚本读 config.json。
        return;
      }
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
            // 安全回归：这几条必须在主进程里跑，因为要先用 fs 把磁盘弄成坏状态
            // （伪造损坏的回收站索引、把 config.json 占成目录），再走真实 IPC 看行为。
            // 渲染进程没有 fs，构造不出这些前置条件。
            const secResults = await runSecurityRegression(targetWin);
            for (const [name, ok, detail] of secResults) {
              if (ok) console.log('[selftest:sec] PASS ' + name);
              else fail('[sec] ' + name + (detail ? ' → ' + detail : ''));
            }
          }
        }
        // PFM_SELFTEST_READONLY=1：对当前库做只读体检。
        // 把每个文件都读出来、解析 frontmatter、渲染 Markdown、解析流程图、跑搜索，
        // 全程不写文件，所以可以安全地对着真实数据跑（用来回答"我的库能正常用吗"）。
        if (process.env.PFM_SELFTEST_READONLY === '1') {
          const ro = await targetWin.webContents.executeJavaScript(loadSelfTestScript('readonly.js'), true);
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
            // split/join 而不是 replace：lang.js 里有两处 __LANG__（setLang 的实参
            // 和返回值里的回显），而 replace(字符串, ...) 只换第一处，
            // 第二处会原样留成字面量 '__LANG__'，让返回的 res.lang 变成假值。
            const res = await targetWin.webContents.executeJavaScript(
              loadSelfTestScript('lang.js').split('__LANG__').join(lang), true);
            // 占位符替换必须全部生效。lang.js 把替换后的 lang 回显在返回值里，
            // 所以只要这里 res.lang 还等于字面量 '__LANG__'，就说明漏替了一处。
            // 这条不能省：漏替的那处在 setLang() 之后，页面语言照样切对了，
            // "无残留中文"依旧全绿——缺陷只体现在这个回显值上。
            if (res.lang !== lang) {
              fail('lang.js 里的 __LANG__ 没被全部替换（回显 lang=' + res.lang + '，期望 ' + lang + '）');
            } else {
              console.log('[selftest] PASS lang.js 的 __LANG__ 占位符全部替换成 ' + lang);
            }
            if (lang === 'en') {
              const ok = res.total === 0;
              if (ok) console.log('[selftest] PASS 切换到英文后界面外壳无残留中文');
              else fail('切换到英文后界面外壳仍有中文（' + res.total + ' 处）: ' + res.chunks.join(' | '));
            } else {
              console.log('[selftest] 语言已切到 ' + res.lang);
            }
            // 原生对话框（系统弹的确认框 / 文件选择框）不在 DOM 里，上面那段
            // clone body 查中文的检查根本看不到它们。而主进程原先把按钮和标题
            // 写死成中文，英文用户看到的是"提示是英文、按钮是取消/确定"的混排框——
            // 这个缺陷在自动化里一直是完全不可见的。
            //
            // 这里真的走一遍 IPC 让对话框弹出来（桩会拦下并记下实际参数），
            // 再断言参数里没有中文。不能只静态查源码有没有 mt()：
            // 传错键、mt() 查不到键回退成中文，源码看着都是对的。
            if (lang === 'en' && process.env.PFM_SELFTEST_DIALOGS) {
              const cjk = /[\u4e00-\u9fa5]/;
              await targetWin.webContents.executeJavaScript(
                'window.promptFlowApi.confirm("probe")', true);
              const mb = selfTestLastMessageBox;
              if (!mb) {
                fail('英文界面下没能捕获到确认框的实际参数');
              } else {
                // 同样不能只查中文：键名里没有中文，弹成 'cancel_' 也会过。
                // 直接和表里的英文原文逐个比对。
                const wantButtons = [I18N_TABLE.en.cancel_, I18N_TABLE.en.ok];
                const wantMessage = I18N_TABLE.en.confirm;
                const sameButtons = mb.buttons.length === wantButtons.length
                  && mb.buttons.every((b, i) => b === wantButtons[i]);
                if (sameButtons && mb.message === wantMessage) {
                  console.log('[selftest] PASS 英文界面下原生确认框走了 i18n（按钮: ' + mb.buttons.join(' / ') + '）');
                } else {
                  fail('英文界面下原生确认框文案不等于表里的英文原文（中文残留或在弹键名）：'
                    + '按钮 ' + JSON.stringify(mb.buttons) + ' 应为 ' + JSON.stringify(wantButtons)
                    + '，标题 ' + JSON.stringify(mb.message) + ' 应为 ' + JSON.stringify(wantMessage));
                }
              }
              await targetWin.webContents.executeJavaScript(
                'window.promptFlowApi.exportZip()', true);
              const fd = selfTestLastFileDialog;
              // 只查"有没有中文"是不够的：mt() 查不到键时会回退成键名本身，
              // 而 'dlgExportZip' 这种键名里一个中文都没有，照样过。
              // 实测就是这么漏的——四个标题一度全在弹键名，断言还是绿的。
              // 所以这里直接和表里的英文原文比对。
              const wantTitle = I18N_TABLE.en.dlgExportZip;
              if (!fd) {
                fail('英文界面下没能捕获到文件对话框的实际参数');
              } else if (cjk.test(fd.title)) {
                fail('英文界面下文件对话框标题仍是中文: ' + fd.title);
              } else if (fd.title !== wantTitle) {
                fail('文件对话框标题不等于表里的英文原文（可能在弹键名）: 实际 ' + JSON.stringify(fd.title) + '，应为 ' + JSON.stringify(wantTitle));
              } else {
                console.log('[selftest] PASS 英文界面下文件对话框标题走了 i18n（' + fd.title + '）');
              }
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
// 界面自身的 file:// URL，只有它允许在窗口内导航。
// 原先是 url.startsWith('file://') 一律放行，这不够：marked 渲染出的相对链接
// （../../evil.html、//host/share/evil.html）默认不带 target，不走
// setWindowOpenHandler，正好落进那个放行分支。DOMPurify 拦得住显式写 file: 的
// 链接，但相对路径是合法 URL，它必须放行。
// 一旦导航过去，后果不是"界面被劫持"这么轻：preload 在每次文档加载时都会重新注入，
// promptFlowApi 原样暴露给新页面；而 CSP 是 index.html 里的 <meta>，只对那一个
// 文档生效，新页面没有任何 CSP。于是一次点击就能调 readFile/exportZip 把整个
// 提示词库读走再 fetch 外发。UNC 形式还能让内容直接来自远端 SMB。
const SELF_URL = pathToFileURL(path.join(CODE_ROOT, 'src', 'index.html')).href;
function isSelfUrl(url) {
  // 去掉 ?query / #hash 再比：reload 或将来加锚点都不该被误拦
  const bare = String(url == null ? '' : url).split('#')[0].split('?')[0];
  // Windows 上同一个文件的 URL 可能盘符大小写不同，统一小写比较
  return bare.toLowerCase() === SELF_URL.toLowerCase();
}

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
    if (isSelfUrl(url)) return; // 只有界面自身那一个 URL（含 reload）可以在窗口内导航
    e.preventDefault();
    openExternally(url);
  });
}

// 沙箱探测的运行时结论。诊断包要能回答"我这台机器现在到底开着沙箱吗、为什么"，
// 这是唯一能看出降级发生过的地方（用户不会去翻 sandbox-state.json）。
let sandboxRuntime = {
  requested: null,      // 本次启动请求的模式
  reason: null,         // decide() 给出的理由
  confirmed: false,     // 渲染进程真的加载完了
  degradedThisRun: false,
  rebuilding: false     // 正在就地重建窗口（window-all-closed 期间不许退出）
};

// 跨启动探测的窗口侧半边。
//
// 时序（必须在 loadFile 之前调用，标记要先按下去）：
//   1. 沙箱开着 → 在磁盘按 pending 标记
//   2. did-finish-load → confirm()，标记清掉，strikes 归零
//   3. 标记还在的时候渲染进程就没了（render-process-gone / did-fail-load）
//      → degrade() 落盘，然后**就地**把窗口用 sandbox:false 重建一个
//
// 为什么是就地重建而不是 app.relaunch()：起初这里写的是重启，理由是"进程级的
// --no-sandbox 只能在 app ready 之前设，这一进程改不动了"。前半句是对的，
// 后半句的推论是错的——实测 sandbox:false **不需要**那个进程级开关配合就能渲染
// （见文件开头 sandboxActive 处记录的两组实测退出码）。那个开关只是历史上
// 一并加上的，并非降级的必要条件。所以关掉窗口级开关重建窗口就够了，
// 用户看到窗口闪一下，不用经历一次完整重启。
//
// 附带效果：重启方案在自检模式下必须特例跳过（父进程会等一个已经换了 pid 的
// 目标，表现为莫名超时），于是自检环境永远走不到降级后的成功路径；
// 就地重建没有这个问题，自检和真实运行走同一条代码。
//
// 沙箱关着时整个探测不挂：那时没有要证明的事，挂上只会把普通的渲染进程崩溃
// 记成沙箱的账，反而让"七天后重试"永远重试不成功。
function attachSandboxProbe(targetWin) {
  if (!sandboxActive) {
    // 重建出来的窗口也会走到这里，所以两处状态都必须从旧值继承，不能重置：
    //   degradedThisRun —— 重置的话诊断包会显示"本来就是关着的"，本次降级无痕；
    //   reason —— 重置成 sandboxDecision.reason（启动判定，通常是 default-on）
    //     会把 render-process-gone:crashed 这个真正的原因盖掉。实测就是这样：
    //     重建后的日志打的是"原因: default-on"，而那次明明是崩溃降级来的。
    const degraded = sandboxRuntime.degradedThisRun;
    sandboxRuntime = {
      requested: sandboxState.MODE_OFF,
      reason: degraded ? sandboxRuntime.reason : sandboxDecision.reason,
      confirmed: false,
      degradedThisRun: degraded,
      rebuilding: false
    };
    logger.info('[sandbox] 本次以无沙箱模式' + (degraded ? '重建窗口' : '启动')
      + '，原因: ' + sandboxRuntime.reason);
    return;
  }

  sandboxRuntime = {
    requested: sandboxState.MODE_ON,
    reason: sandboxDecision.reason,
    confirmed: false,
    degradedThisRun: false,
    rebuilding: false
  };

  // decide() 可能已经改了状态（累加 strike、冷静期到了重试），先把那个落盘，
  // markAttempt 再在它之上加 pending。
  let cur = sandboxDecision.nextState;
  if (sandboxDecision.changed) {
    const res = sandboxState.write(SANDBOX_STATE_DIR, cur);
    if (!res.ok) logger.error('[sandbox] 写状态失败（本次结论记不住）: ' + res.error);
  }
  const marked = sandboxState.markAttempt(SANDBOX_STATE_DIR, cur);
  cur = marked.state;
  if (!marked.ok) {
    // 标记按不下去（目录只读）时不能继续假装在探测：pending 永远不会出现，
    // 于是"上次没确认"这个判断永远为假，降级路径就成了死代码。
    // 这种情况下沙箱照常开着（安全的那一侧），只是失去自动降级能力，记一行。
    logger.error('[sandbox] 无法写探测标记，本次不做降级判断: ' + marked.error);
    return;
  }
  logger.info('[sandbox] 尝试开启沙箱，原因: ' + sandboxDecision.reason);

  const wc = targetWin.webContents;

  wc.once('did-finish-load', () => {
    sandboxRuntime.confirmed = true;
    const res = sandboxState.confirm(SANDBOX_STATE_DIR, cur);
    cur = res.state;
    if (!res.ok) logger.error('[sandbox] 清探测标记失败（下次启动会误判一次未确认）: ' + res.error);
    else logger.info('[sandbox] 渲染进程已确认可用，沙箱保持开启');
  });

  // 渲染进程在确认之前就没了 —— 这正是缺运行库那类环境的症状。
  const fallback = (why) => {
    if (sandboxRuntime.confirmed || sandboxRuntime.rebuilding) return;
    sandboxRuntime.degradedThisRun = true;
    sandboxRuntime.rebuilding = true;
    const res = sandboxState.degrade(SANDBOX_STATE_DIR, cur, why);
    cur = res.state;
    if (!res.ok) {
      // 状态写不进去不影响本次恢复——sandboxActive 是内存里的变量，这一次照样能
      // 重建出可用窗口。代价只是下次启动还会再试一次沙箱、再失败、再重建一次。
      // 所以这里只记一行就继续；早先写成"放弃恢复"是错的，那会把一个能救回来的
      // 启动停在白窗口上。
      logger.error('[sandbox] 降级状态写盘失败（下次启动会重复一次探测）: ' + res.error);
    }
    logger.error('[sandbox] 渲染进程在沙箱下起不来（' + why + '），就地降级为无沙箱并重建窗口');
    sandboxActive = false;
    // 理由要在这里就记住。重建出来的窗口会再走一遍 attachSandboxProbe，
    // 那边的无沙箱分支原先无条件写 sandboxDecision.reason（还是 'default-on'），
    // 于是诊断包和日志都只会说"以无沙箱模式启动，原因 default-on"——降级发生过
    // 这件事被自己的恢复过程抹掉了。实测第一版日志就是这么打的。
    sandboxRuntime.reason = why;
    // 从事件回调里跳出来再动窗口：这会儿还在 render-process-gone 的派发过程中，
    // 同步 destroy 正在报告崩溃的那个 webContents 不是有保障的操作。
    setTimeout(() => { rebuildWindowWithoutSandbox().catch((e) => {
      logger.error('[sandbox] 重建窗口失败: ' + (e && e.stack ? e.stack : e));
      sandboxRuntime.rebuilding = false;
    }); }, 0);
  };

  // 两个信号都必须先过滤，否则会把不相干的失败记到沙箱账上——而降级是**持久**的，
  // 误判一次就把这台机器上的 OS 级隔离永久关掉，还顺带掩盖真正的故障。
  //
  // render-process-gone 的 clean-exit 是正常退出。绝大多数情况下这时 confirmed
  // 已经是 true，上面那个 guard 就挡住了；但用户在页面加载完之前就退出时不是，
  // 那次会被当成"沙箱起不来"。所以显式排掉。
  wc.on('render-process-gone', (e, details) => {
    const reason = details && details.reason ? details.reason : 'unknown';
    if (reason === 'clean-exit') return;
    fallback('render-process-gone:' + reason);
  });
  // did-fail-load 会为**任意** frame、任意 URL 触发。用 once 更糟：一个无关的
  // 子 frame 失败就把这一次机会用掉了。这里只认"主 frame 加载我们自己那个页面失败"，
  // 其余情况留给 attachSelfTest 和用户去看——比如 index.html 根本不在包里
  // （历史上那次打包白屏就是这个形状），那是打包问题，关掉沙箱一点用都没有。
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (!isSelfUrl(url)) return;
    fallback('did-fail-load:' + code + ':' + desc);
  });
}

// 就地降级：扔掉起不来的那个窗口，用 sandbox:false 重建一个。
//
// 用 destroy() 而不是 close()：close 会走 win.on('close') 那套异步落盘握手，
// 里头 flushRendererPending() 要等渲染进程回话，而渲染进程正是已经死掉的那个，
// 于是必然空等到 3 秒超时才继续。这时候也确实没有什么可落盘的——页面从来没
// 加载成功过，用户一个字都没输入。
async function rebuildWindowWithoutSandbox() {
  const old = win;
  win = null;                     // 先摘引用，避免 destroy 触发的回调里又读到它
  if (old && !old.isDestroyed()) old.destroy();
  await createWindow();           // 此刻 sandboxActive 已是 false
  sandboxRuntime.rebuilding = false;
  logger.info('[sandbox] 已用无沙箱模式重建窗口');
}

// 恢复窗口位置前必须校验。config.windowBounds 直接来自磁盘，而 set-config
// 又允许渲染进程写任意字段，所以这里可能是任何东西：
//   - 拔掉副屏后，上次存的 x/y 落在已不存在的显示器上 → 窗口开在屏幕外，
//     用户看不到也拖不回来，唯一的恢复手段是手删 config.json；
//   - width/height 为 0 / 负数 / NaN / 字符串 → 窗口尺寸异常甚至起不来。
// 规则：尺寸必须是有限正数并夹到最小值；位置必须整体落在某个显示器的可见区域内，
// 否则丢弃 x/y 让 Electron 自己居中。
const MIN_W = 800, MIN_H = 500;
function sanitizeWindowBounds(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  // 尺寸和位置的容错方式不同：
  // 尺寸是垃圾（0/负数/NaN/字符串）就整个回落默认值，再夹一次最小值兜底。
  // 只夹最小值不够——存进 0 会变成 800×500 这种用户没要求过的窗口，
  // 回落默认更接近"当作没存过"。
  const dim = (v, def, min) => {
    const n = num(v);
    return Math.max(min, n != null && n > 0 ? n : def);
  };
  const w = dim(b.width, 1200, MIN_W);
  const h = dim(b.height, 780, MIN_H);
  const out = { width: Math.round(w), height: Math.round(h) };
  const x = num(b.x), y = num(b.y);
  if (x == null || y == null) return out; // 没存过位置：交给 Electron 居中
  let displays = [];
  try { displays = screen.getAllDisplays(); } catch { return out; }
  // 标题栏必须有一块落在某个显示器的工作区内，用户才抓得住窗口
  const GRAB = 80; // 认为"抓得住"所需的最小可见宽度
  const visible = displays.some(d => {
    const a = d.workArea;
    return x + w - GRAB > a.x && x + GRAB < a.x + a.width &&
           y >= a.y - 8 && y + GRAB < a.y + a.height;
  });
  if (!visible) {
    console.log('[bounds] 上次的窗口位置不在任何显示器内，已改为居中:', JSON.stringify({ x, y }));
    return out;
  }
  out.x = Math.round(x);
  out.y = Math.round(y);
  return out;
}

async function createWindow() {
  const config = await loadConfig();
  const bounds = sanitizeWindowBounds(config.windowBounds);
  win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_W,
    minHeight: MIN_H,
    title: 'Prompt Flow Manager',
    backgroundColor: config.theme === 'dark' ? '#1e1e1e' : '#ffffff',
    webPreferences: {
      preload: path.join(CODE_ROOT, 'preload.js'),
      // 渲染进程不给 Node 能力：导入的 .md 属外部内容，若 DOMPurify 被绕过，
      // nodeIntegration 会让一次 XSS 直接升级成任意代码执行。
      contextIsolation: true,
      nodeIntegration: false,
      // 沙箱开不开由文件开头那个跨启动状态机决定（见 sandboxDecision 处的说明）。
      // 这里和进程级的 --no-sandbox 必须取同一个结论：只开这个而不管那个开关的话，
      // 命令行会盖掉它，看起来开了其实没开。
      //
      // 取 sandboxActive 而不是 sandboxDecision.sandbox：就地降级重建窗口时，
      // 内存里的 sandboxActive 已经翻成 false，而 sandboxDecision 保留启动判定。
      // 读后者的话重建出来的窗口又会开着沙箱，于是崩溃→重建→再崩溃，
      // 除了 rebuilding 那个 guard 拦着之外就是个死循环——白窗口照旧。
      sandbox: sandboxActive,
      webgl: false
    }
  });
  attachNavigationGuard(win);
  attachSandboxProbe(win);
  const selfTest = process.env.PFM_SELFTEST === '1' ? attachSelfTest(win) : null;
  win.loadFile(path.join(CODE_ROOT, 'src', 'index.html'));
  if (selfTest) selfTest.run();

  // resize / move 会以每秒几十次的频率触发。不防抖会疯狂读写 config.json。
  // 走 updateConfig 而不是自己 loadConfig→saveConfig：后者是一次独立的
  // read-modify-write，会和渲染进程那五个 debounce（tabs/recent/locked/
  // sidebarWidth/expandedPaths）互相覆盖字段。updateConfig 内部有写队列。
  let boundsTimer = null;
  // 最大化时 getBounds() 返回的是铺满屏幕的尺寸。直接存下来，下次启动会以
  // "非最大化但尺寸等于屏幕"的样子打开——看着像最大化，实际拖不动也还原不了。
  // 存 getNormalBounds()（还原后的尺寸）+ 一个 maximized 标记，恢复时再 maximize()。
  const currentBounds = () => {
    if (win.isMaximized()) return { ...win.getNormalBounds(), maximized: true };
    return { ...win.getBounds(), maximized: false };
  };
  const flushBounds = async () => {
    if (!win || win.isDestroyed()) return;
    try {
      await updateConfig({ windowBounds: currentBounds() });
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
  // 同步兜底：读当前磁盘内容做 merge，只覆盖 windowBounds 一个字段。
  // 不走写队列（同步上下文等不了 promise），所以最坏情况是丢掉一次正在飞行中的
  // debounce 写入。只在下面的异步路径没走通时用。
  const saveBoundsSync = () => {
    if (!win || win.isDestroyed()) return;
    try {
      const bounds = currentBounds();
      const cur = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
      cur.windowBounds = bounds;
      // 同步版的原子写：临时文件 + rename。异步 writeFileAtomic 在 close
      // 回调里等不到，但截断风险是一样的——这里崩在半路，config.json 就废了。
      const tmp = CONFIG_PATH + '.tmp-close';
      fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), 'utf8');
      fs.renameSync(tmp, CONFIG_PATH);
    } catch (e) { console.error('关窗保存尺寸失败:', e); }
  };

  // 让渲染进程把还在防抖窗口里的配置写入立刻落盘（见 renderer 的 __pfmFlushPending）。
  // typeof 判断不能省：页面还没加载完或加载失败时那个函数不存在，
  // 直接调会抛 ReferenceError，把整个关窗收尾带崩。
  const flushRendererPending = async () => {
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed() || wc.isCrashed()) return;
    await wc.executeJavaScript(
      '(typeof window.__pfmFlushPending === "function" ? window.__pfmFlushPending() : true)', true
    );
  };

  // 关窗前把待写入的东西落盘，否则最后一次改动会丢。
  //
  // 原先只能同步写 windowBounds——close 回调是同步的，等不了 promise。但渲染进程
  // 那五个配置 debounce（tabs 500 / recent 500 / locked 400 / sidebarWidth 400 /
  // expandedPaths 600）根本没有对外把手，改完立刻关窗那次就没了：拖宽侧边栏后
  // 马上关窗，重开还是旧宽度；展开几个目录再关窗，展开状态丢失。
  //
  // 所以第一次 close 先 preventDefault 把窗口留住，异步做两件事——催渲染进程
  // flush、把窗口尺寸走正常写队列存好——然后再真的关。close 会因此触发两次，
  // 用 closing 区分，第二次直接放行。
  //
  // 超时兜底是必须的：页面崩了或渲染主线程卡死时 executeJavaScript 的 promise
  // 永远不 settle，没有超时窗口就再也关不掉，比丢一次防抖写入严重得多。
  const CLOSE_FLUSH_TIMEOUT_MS = 3000;
  let closing = false;
  let boundsSavedAsync = false;
  win.on('close', (e) => {
    if (boundsTimer) { clearTimeout(boundsTimer); boundsTimer = null; }
    if (closing) {
      // 第二次进来：异步收尾已经结束（或超时放弃）。它没存下尺寸就走同步兜底。
      if (!boundsSavedAsync) saveBoundsSync();
      return;
    }
    closing = true;
    e.preventDefault();
    const finish = (async () => {
      try {
        await flushRendererPending();
      } catch (err) {
        console.error('关窗催渲染进程落盘失败:', err && err.message ? err.message : err);
      }
      try {
        // 走 updateConfig 而不是同步写：它在配置写队列里，不会和渲染进程刚 flush
        // 出来的那几次 set-config 互相覆盖字段。
        if (win && !win.isDestroyed()) {
          await updateConfig({ windowBounds: currentBounds() });
          boundsSavedAsync = true;
        }
      } catch (err) {
        console.error('关窗保存尺寸失败（退回同步写）:', err && err.message ? err.message : err);
      }
    })();
    const timeout = new Promise(r => setTimeout(r, CLOSE_FLUSH_TIMEOUT_MS));
    Promise.race([finish, timeout]).then(() => {
      // 退出流程里 preventDefault 已经把 quit 取消了，必须原路走回 app.quit()，
      // 否则 macOS 下按了 Cmd+Q 只关窗、应用不退。
      if (isQuitting) { app.quit(); return; }
      if (win && !win.isDestroyed()) win.close();
    });
  });

  // win 是模块级单例，销毁后必须置空。send() 只检查 `win &&`，
  // macOS 下关窗后应用还活着、菜单仍可点，Cmd+N 会打到已销毁对象上
  // 抛 "Object has been destroyed"。
  win.on('closed', () => { win = null; });

  // 上次是最大化状态：先按还原尺寸建窗，再最大化，这样"取消最大化"能回到合理尺寸
  if (config.windowBounds && config.windowBounds.maximized) win.maximize();

  // 用配置里的语言建菜单。不能直接 buildMenu()：menuLang 初始是 null，
  // 英文用户启动时会先看到一整套中文菜单，直到手动切一次语言才更新。
  syncMenuLang(config.lang);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  // 必须同时检查 isDestroyed：win 置空是在 'closed' 事件里，而 'close' 到 'closed'
  // 之间窗口已销毁但引用还在，此刻点菜单就会抛 "Object has been destroyed"。
  const send = (action) => {
    if (win && !win.isDestroyed()) win.webContents.send('menu-action', action);
  };
  const template = [
    {
      label: mt('menuFile'),
      submenu: [
        { label: mt('menuNewPrompt'), accelerator: 'CmdOrCtrl+N', click: () => send('new-prompt') },
        { label: mt('menuNewWorkflow'), click: () => send('new-workflow') },
        { type: 'separator' },
        { label: mt('menuExportZip'), accelerator: 'CmdOrCtrl+E', click: () => send('export') },
        { label: mt('menuEmptyTrash'), click: () => send('empty-trash') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: mt('menuEdit'),
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: mt('menuView'),
      submenu: [
        // 主题快捷键统一由渲染进程的 Ctrl+Shift+L 承担（index.html 的 tooltip 也这么写）。
        // 这里原先挂 CmdOrCtrl+T，等于同一功能两个键，而且和浏览器习惯的"新标签页"撞。
        { label: mt('menuToggleTheme'), click: () => send('toggle-theme') },
        // role:'reload' 直接重载，编辑中的草稿无声消失。改成先问渲染进程，
        // 由它检查脏状态（渲染侧 menu-action 处理里带确认），干净时才真的 reload。
        { label: mt('menuReload'), accelerator: 'CmdOrCtrl+R', click: () => send('request-reload') },
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

// 语言变了就重建菜单，否则切到 English 后原生菜单仍是中文。
function syncMenuLang(lang) {
  const next = lang === 'en' ? 'en' : 'zh';
  if (next === menuLang) return;
  menuLang = next;
  buildMenu();
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
  // activate 必须在 createWindow 之前注册：注册在后面时，一旦 createWindow 抛错
  // 就永远注册不上（macOS 下点 Dock 图标再也开不出窗口）。
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // 日志要在任何可能失败的启动步骤之前初始化，否则最需要记录的那一段
  // （ensureSeedData / ensureDirs 抛错）恰好没人记。init 自己不抛：建不出目录
  // 就退化成只往 console 镜像，应用照常起来。
  //
  // 放在 try 之外是故意的：init 失败不该走 showErrorBox + app.exit(1) 那条路，
  // 日志写不进去不是启动失败。
  logger.init({ dir: LOGS_DIR, dataRoot: DATA_ROOT, codeRoot: CODE_ROOT });
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
  // 启动链路里的异常必须自己兜住。这是个 async 回调，抛出去就是主进程的
  // unhandledRejection：没有窗口、没有对话框、也不退出，只剩一个僵死进程，
  // 用户得去任务管理器杀。数据目录只读（放在受管控目录、被同步盘锁住、
  // 磁盘满）时 ensureDirs 就会抛，而 ensureSeedData 自己把异常吞了，
  // 连日志都看不到根因。
  try {
    ensureSeedData();
    await ensureDirs();
    // 自愈必须在 createWindow 之前：窗口一出来渲染进程就会 list-trash / listTree，
    // 那时索引应该已经是修好的，否则用户先看到一屏幽灵条目再看到它们消失。
    await runStartupHeal();
    await createWindow();
  } catch (e) {
    logger.error('[bootstrap] 启动失败:', e && e.stack ? e.stack : e);
    // 至少让用户知道是哪里出了问题、数据目录在哪，而不是对着一个不存在的窗口。
    try {
      dialog.showErrorBox('Prompt Flow Manager 启动失败', [
        '无法初始化数据目录：',
        DATA_ROOT,
        '',
        '常见原因：目录只读、被同步盘/杀软占用、磁盘已满。',
        '',
        String(e && e.message ? e.message : e)
      ].join('\n'));
    } catch {}
    app.exit(1);
  }
});
}

// 菜单退出 / Cmd+Q 会先走 before-quit，再给每个窗口发 close。
// 而下面 win.on('close') 为了做异步收尾会 preventDefault 一次，那会把整个 quit
// 取消掉：只 win.close() 的话，macOS 下窗口关了应用还留着（window-all-closed
// 在 darwin 不退），用户按了 Cmd+Q 却退不掉。所以记下"这次是退出"，
// 收尾做完后原路走回 app.quit()。
let isQuitting = false;
app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  // 沙箱降级正在重建窗口时不许退出。这中间有一小段"零个窗口"的空隙
  // （destroy 旧窗口 → await createWindow 建新窗口），Windows 上这个事件
  // 会在那一瞬间触发并直接 app.quit()，表现为"开了一下就没了"。
  // 没有这个 guard，整条就地降级的路就是死的——而且只在真的降级时才暴露。
  if (sandboxRuntime.rebuilding) return;
  if (process.platform !== 'darwin') app.quit();
});
