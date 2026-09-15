// lib/logger.js
// 主进程的滚动文件日志。
//
// 为什么不 require('electron')：
// 目录解析（DATA_ROOT 在开发模式 = 项目目录、打包后 = userData、测试时 = PFM_DATA_DIR）
// 是 electron-main.js 已经做过一次的判断，这里再抄一遍就有了第二个真值来源——
// 历史上正是"两个根目录各写一遍三元表达式"导致打包版白屏（见 electron-main.js:123-133）。
// 所以目录由调用方通过 init({ dir }) 传进来。副作用是这个模块能用裸 node 跑单测，
// 不必拉起 Electron。
//
// 为什么日志放 logs/ 子目录而不是数据根目录顶层：
// tests/smoke.test.js:758 有一条防回归断言，盯的就是"往 DATA_ROOT 顶层 append debug.log"
// 这个形状（旧实现每次列目录树都同步追加一行，文件无上限增长）。
// 独立子目录 + 大小滚动 + 文件数上限，三条一起才算真正解决那个问题。
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- 可调常量 ----------

// 单个日志文件的字节上限。
// 取 2 MiB 的依据：主进程的日志量是"每次启动几十行 + 出错时的栈"这个量级
// （bootstrap / heal / 对话框桩 / IPC 错误），不是每次按键都写。2 MiB 能装下
// 几百次启动的记录，够回溯到几周前；同时 2 MiB 还能一次读进内存做 tail，
// 也小到可以直接贴进 issue。
// 注意：这个值不能大到让 tail 变慢——诊断导出会读 active 文件尾部。
const MAX_BYTES = 2 * 1024 * 1024;

// 保留的文件总数（含正在写的 app.log）。
// 4 个归档 + 1 个活动 = 最坏 10 MiB。相对提示词库可以忽略，
// 又足以覆盖"用户过几天才来报 bug"的场景。
const MAX_FILES = 5;

// 单个字段进文件前的字符上限。
// 目的不是省空间，是把"有人不小心把整篇提示词正文传进来"的后果限制成一行摘要，
// 而不是把用户内容整篇落进日志（日志不受 safeJoinWritable 保护，也不进回收站）。
const MAX_FIELD_CHARS = 200;

// tail() 最多回读的字节数。日志文件可能有 2 MiB，诊断包只需要末尾一小段。
const TAIL_MAX_BYTES = 64 * 1024;

// 每 N 次写入重新 stat 一次活动文件，把内存里的字节计数和磁盘对齐。
// 需要它的原因见文件末尾"并发"一节：另一个进程写了同一个文件时，
// 本进程的计数会偏小，滚动就会迟到。
const RESTAT_EVERY = 32;

const ACTIVE_NAME = 'app.log';
const ARCHIVE_NAME = (n) => 'app-' + n + '.log';

// 文件内的行格式。导出成常量是为了让测试和以后的 grep 有一个稳定锚点，
// 而不是各处硬编码正则。
// 形如：2026-09-15T12:34:56.789Z INFO [heal] 数据目录检查通过，无需修复
const LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (INFO|WARN|ERROR) /;

// 明显是凭据的字段，进文件前打掉。
// 提示词正文里出现 api_key=... 不算罕见（用户拿它存过调用示例），
// 而日志文件是纯文本、不加密、还会被贴进 issue。
const SECRET_RE = /((?:api[-_]?key|secret|token|password|passwd|pwd|authorization|bearer)\s*[:=]\s*)("?)([^\s"',;]{4,})\2/gi;

// ---------- 模块状态 ----------
// 单例。主进程只有一个，做成实例反而要求调用方到处传引用。
const state = {
  dir: null,
  active: null,
  enabled: false,        // false = 只镜像到 console，不落盘
  maxBytes: MAX_BYTES,
  maxFiles: MAX_FILES,
  mirror: true,
  curSize: 0,
  writesSinceStat: 0,
  // 落盘失败的累计次数与最近一次的错误码。
  // 为什么必须留计数：吞掉异常是对的（磁盘满、被杀软锁住都不该让应用死），
  // 但"完全不吭声地吞"等于日志功能可以静默失效几个月没人知道。
  // 这里的计数由 diagnostics 报出去，诊断包里能看到"日志写了 0 行、失败 813 次"。
  failures: 0,
  lastFailure: null,     // { at, op, code }
  warnedOnce: false,     // 第一次失败往 stderr 吼一声，之后闭嘴避免刷屏
  written: 0             // 成功落盘的行数
};

// ---------- 脱敏 ----------

// 把绝对路径里的用户名段落打掉。
// C:\Users\张三\AppData\Roaming\... 里的用户名是 PII，而诊断包是要贴给别人看的。
// 顺序有讲究：先换更长的 DATA_ROOT / CODE_ROOT，再换 home——
// 反过来的话 home 前缀会先命中，DATA_ROOT 就再也匹配不上了。
function maskRoots(s) {
  let out = s;
  const subs = [];
  if (state.dataRoot) subs.push([state.dataRoot, '<data>']);
  if (state.codeRoot) subs.push([state.codeRoot, '<code>']);
  let home = null;
  try { home = os.homedir(); } catch { home = null; }
  if (home) subs.push([home, '~']);
  // 长前缀优先
  subs.sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of subs) {
    if (!from) continue;
    // 大小写不敏感 + 两种分隔符都认：Windows 上同一个目录可以写成
    // 'D:\a\b'、'D:/a/b'、'd:\A\B'，逐字 split 只能命中其中一种。
    const re = new RegExp(escapeRe(from).replace(/\\\\|\//g, '[\\\\/]'), 'gi');
    out = out.replace(re, to);
  }
  return out;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 单个字段的脱敏。四件事，缺一件都能让日志变成泄漏面：
//   1. 换行/回车/制表符转义 —— 一条记录必须只占一行。
//      不只是为了好看：正文里带 "\n2026-01-01T00:00:00.000Z INFO 一切正常" 的用户内容
//      会在日志里伪造出一条合法记录，把 grep 出来的结论带偏。
//   2. 长度截断 —— 把"整篇正文被误传进来"限制成一行摘要。
//   3. 凭据打码。
//   4. 根目录/家目录换成占位符。
// 注意：这只作用于**落盘**的那一份。镜像到 console 的是原样参数，
// 因为 tests/ 里有一批断言逐字匹配 stdout（见 tests/heal.test.js:186 的 /\[heal\]/、
// tests/functional-smoke.js:114-126 的 mustHave 清单），改了 stdout 形状会把它们全打红。
function redact(value) {
  let s;
  if (value == null) s = String(value);
  else if (typeof value === 'string') s = value;
  else if (value instanceof Error) s = (value.stack || value.message || String(value));
  else if (typeof value === 'object') {
    try { s = JSON.stringify(value); } catch { s = '[unserializable]'; }
    if (s === undefined) s = '[undefined]';
  } else s = String(value);

  s = s.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  s = s.replace(SECRET_RE, (m, k, q, v) => k + q + '***(' + v.length + ')' + q);
  s = maskRoots(s);
  if (s.length > MAX_FIELD_CHARS) {
    s = s.slice(0, MAX_FIELD_CHARS) + '…(+' + (s.length - MAX_FIELD_CHARS) + ')';
  }
  return s;
}

// ---------- 滚动 ----------

// app.log → app-1.log，app-1.log → app-2.log，…，最旧的删掉。
// 从后往前重命名：正序做的话第一步就把 app-1.log 覆盖掉了。
// 每一步单独 try：其中一个文件被杀软/资源监视器占住时，剩下的照样挪，
// 最坏结果是某一档留了旧内容，而不是整个滚动失败、活动文件无上限长大。
function rotate() {
  const archives = Math.max(0, state.maxFiles - 1);
  if (archives === 0) {
    // 只允许一个文件：直接截断，不留归档
    try { fs.writeFileSync(state.active, ''); state.curSize = 0; } catch (e) { noteFailure('truncate', e); }
    return;
  }
  const oldest = path.join(state.dir, ARCHIVE_NAME(archives));
  try { fs.rmSync(oldest, { force: true }); } catch (e) { noteFailure('rm-oldest', e); }
  for (let i = archives - 1; i >= 1; i--) {
    const from = path.join(state.dir, ARCHIVE_NAME(i));
    const to = path.join(state.dir, ARCHIVE_NAME(i + 1));
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch (e) { noteFailure('shift', e); }
  }
  try {
    if (fs.existsSync(state.active)) fs.renameSync(state.active, path.join(state.dir, ARCHIVE_NAME(1)));
    state.curSize = 0;
  } catch (e) {
    // 活动文件挪不走（被别的进程句柄占着）：别让计数停在超限值上死循环判滚动，
    // 重新 stat 一次，按磁盘真实大小继续追加。文件会略微超过上限，可以接受。
    noteFailure('rotate-active', e);
    resyncSize();
  }
}

function noteFailure(op, e) {
  state.failures++;
  state.lastFailure = {
    at: new Date().toISOString(),
    op,
    code: (e && (e.code || e.name)) ? String(e.code || e.name) : 'UNKNOWN'
  };
  if (!state.warnedOnce) {
    state.warnedOnce = true;
    // 只吼第一次。日志写不进去往往是持续性的（目录只读、磁盘满），
    // 每行都吼会把 stdout 淹掉，反而盖住真正的错误——而 stdout 是测试的断言面。
    try {
      console.error('[logger] 日志落盘失败，已降级为只输出到控制台（' + op + ': '
        + state.lastFailure.code + '）。后续同类失败不再重复提示，计数见诊断报告。');
    } catch { /* stdout 自己也坏了（EPIPE），没什么可做的 */ }
  }
}

function resyncSize() {
  try {
    state.curSize = fs.statSync(state.active).size;
  } catch {
    state.curSize = 0; // 不存在就当 0，下一次 append 会把它创建出来
  }
  state.writesSinceStat = 0;
}

// ---------- 写入 ----------

// 同步 appendFileSync，不是带缓冲的异步 writer。
//
// 权衡结论：选同步。理由按重要性排序：
//   1. 日志最值钱的时刻恰好是进程非正常结束的前几行——主进程崩溃、
//      app.exit()、用户从任务管理器杀进程。缓冲写在这三种情况下丢的正是那几行，
//      于是"日志功能"在唯一真正需要它的场合失效。要补救就得在 before-quit /
//      uncaughtException 里加 flush 握手，而本项目已经有一套关窗落盘握手了
//      （tests/close-flush.test.js），再加一套只会多一个能出错的地方。
//   2. 量级根本不需要异步。这里记的是启动链路、自愈结果、IPC 报错，
//      一次启动几十行；不是 listTree 那种每次刷新都触发的热路径——
//      旧的 debug.log 实现就是挂在目录遍历上才把文件写爆的（tests/smoke.test.js:758）。
//      单次 appendFileSync 写几百字节在 Windows 上是零点几毫秒量级。
//   3. 顺序天然正确。异步 writer 要么自己排队、要么日志顺序和实际发生顺序不一致，
//      而排队就又回到了第 1 条的丢尾问题。
// 代价：调用方如果在循环里打上万行，主进程会被同步 IO 卡住。
// 所以约定：**逐文件、逐按键的事件不许进日志**，只记"每次启动一次"级别的事件。
// 违反这条的写法应该在 code review 里被拦下，而不是靠这里加缓冲来兜。
function appendLine(level, msg) {
  if (!state.enabled) return;
  const line = new Date().toISOString() + ' ' + level + ' ' + msg + '\n';
  const bytes = Buffer.byteLength(line, 'utf8');
  if (state.writesSinceStat >= RESTAT_EVERY) resyncSize();
  // curSize > 0 的判断不能省：空文件时就算单行超过上限也不该先滚一次，
  // 否则会留下一串 0 字节归档，把真正的历史挤掉。
  if (state.curSize > 0 && state.curSize + bytes > state.maxBytes) rotate();
  try {
    fs.appendFileSync(state.active, line, 'utf8');
    state.curSize += bytes;
    state.writesSinceStat++;
    state.written++;
  } catch (e) {
    noteFailure('append', e);
  }
}

// 镜像到 console 的是**原样参数**，不是脱敏后的字符串。
// 这不是偷懒：现有测试逐字匹配 stdout（tests/heal.test.js:186、
// tests/functional-smoke.js:111-127、tests/ui-smoke.js:70-85），
// 而且 console.error(err) 对 Error 的展开格式和 String(err) 不一样。
// 脱敏只对落盘那份负责；"不要把正文传进日志"这条规则仍然由调用点保证。
function mirror(level, args) {
  if (!state.mirror) return;
  try {
    if (level === 'ERROR') console.error(...args);
    else if (level === 'WARN') console.warn(...args);
    else console.log(...args);
  } catch { /* stdout 的读取端消失时 console 会抛 EPIPE，见 electron-main.js:83-88 */ }
}

function emit(level, args) {
  mirror(level, args);
  // 落盘部分整体再兜一层：redact 里有正则和 JSON.stringify，
  // 传进来一个 getter 会抛的畸形对象也不能把调用方带下去。
  try {
    appendLine(level, args.map(redact).join(' '));
  } catch (e) {
    noteFailure('emit', e);
  }
}

// ---------- 公开 API ----------

// 初始化。**不抛异常**：这是启动链路上的第一步，它自己绝不能成为启动失败的原因。
// 建目录失败就把 enabled 置成 false，退化成纯 console 输出，应用照常起来。
//
// dataRoot / codeRoot 只用于脱敏时把路径前缀换成 <data> / <code>，可以不传。
// 幂等：重复调用只是重新解析目录，不会清空计数。
function init(opts) {
  const o = opts || {};
  if (!o.dir) {
    // 没给目录就只镜像。返回而不是抛：调用方在 bootstrap 里，抛了就白屏。
    state.enabled = false;
    return status();
  }
  state.dir = path.resolve(String(o.dir));
  state.active = path.join(state.dir, ACTIVE_NAME);
  state.maxBytes = Number.isFinite(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : MAX_BYTES;
  state.maxFiles = Number.isInteger(o.maxFiles) && o.maxFiles > 0 ? o.maxFiles : MAX_FILES;
  state.mirror = o.mirror !== false;
  state.dataRoot = o.dataRoot ? path.resolve(String(o.dataRoot)) : null;
  state.codeRoot = o.codeRoot ? path.resolve(String(o.codeRoot)) : null;
  try {
    fs.mkdirSync(state.dir, { recursive: true });
    state.enabled = true;
    resyncSize();
  } catch (e) {
    state.enabled = false;
    noteFailure('init', e);
  }
  return status();
}

const info = (...args) => emit('INFO', args);
const warn = (...args) => emit('WARN', args);
const error = (...args) => emit('ERROR', args);

// 读活动文件尾部。给诊断包用。
// 只回读 TAIL_MAX_BYTES：日志可能有 2 MiB，而且从中间截断的第一行是残行，丢掉。
function tail(lines) {
  const want = Number.isInteger(lines) && lines > 0 ? lines : 200;
  if (!state.active) return [];
  let fd = null;
  try {
    const st = fs.statSync(state.active);
    const len = Math.min(st.size, TAIL_MAX_BYTES);
    const start = st.size - len;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(state.active, 'r');
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    // 从中间开始读必然切断第一行，也可能切断一个多字节字符
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    const all = text.split('\n').filter(s => s.length > 0);
    return all.slice(-want);
  } catch {
    return []; // 读不到就返回空，诊断导出不该因为读不到日志而失败
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 关不掉也没别的办法 */ } }
  }
}

// 当前状态。诊断包会把它整块放进去，所以字段里不能有用户内容。
function status() {
  return {
    enabled: state.enabled,
    dir: state.dir ? maskRoots(state.dir) : null,
    maxBytes: state.maxBytes,
    maxFiles: state.maxFiles,
    written: state.written,
    failures: state.failures,
    lastFailure: state.lastFailure ? { ...state.lastFailure } : null
  };
}

// 现存日志文件清单（名字 + 字节数）。滚动测试和诊断都要用。
function files() {
  if (!state.dir) return [];
  let names;
  try { names = fs.readdirSync(state.dir); } catch { return []; }
  return names
    .filter(n => n === ACTIVE_NAME || /^app-\d+\.log$/.test(n))
    .sort()
    .map(n => {
      let size = -1;
      try { size = fs.statSync(path.join(state.dir, n)).size; } catch { /* 刚被滚掉 */ }
      return { name: n, size };
    });
}

// 同步写没有缓冲，所以没有"关闭时要 flush"这回事。
// 保留这个空函数只是为了让调用方不必区分实现：将来若真换成异步 writer，
// before-quit 里的调用点已经在了。
function close() { /* 同步写：无缓冲可刷 */ }

// 仅供测试重置模块状态。生产代码不要调用。
function _resetForTest() {
  state.dir = null;
  state.active = null;
  state.enabled = false;
  state.curSize = 0;
  state.writesSinceStat = 0;
  state.failures = 0;
  state.lastFailure = null;
  state.warnedOnce = false;
  state.written = 0;
  state.dataRoot = null;
  state.codeRoot = null;
  state.mirror = true;
}

// ---------- 并发：两个实例指向同一个数据目录 ----------
// 正常情况下不会发生：electron-main.js:3316 有单实例锁，第二个实例直接退出；
// 自检模式关掉了锁，但每个测试进程的 PFM_DATA_DIR 各不相同，看不见彼此的 logs/。
// 万一真的同时写（比如有人手工设了相同的 PFM_DATA_DIR）：
//   - 追加本身不会互相截断。O_APPEND 下单次几百字节的写在实践中不会交错出半行。
//   - 会错的是滚动。两个进程各自在内存里记 curSize，都可能判定该滚了，
//     于是出现"连续滚两次"（某一档归档很短）或 renameSync 撞上 ENOENT。
//     rotate() 里每步都单独 try + 失败只计数，所以最坏是归档分档不均，不会丢活动文件、
//     也不会让写入停掉。RESTAT_EVERY 定期重新 stat 把计数拉回磁盘真实值。
// 结论：不做跨进程加锁。加锁的代价（锁文件、陈旧锁的清理、又一类启动失败原因）
// 远大于收益，而收益只是让一个本来就不该出现的场景里的归档分档更整齐。

module.exports = {
  init, info, warn, error, tail, status, files, close, redact,
  LINE_RE, MAX_BYTES, MAX_FILES, MAX_FIELD_CHARS, ACTIVE_NAME, ARCHIVE_NAME,
  _resetForTest
};
