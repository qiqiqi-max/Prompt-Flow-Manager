// lib/sandbox-state.js
// 渲染进程沙箱开关的跨启动状态机。
//
// 为什么需要一个状态机，而不是一句 `sandbox: true`：
//   沙箱失败的形态是"渲染进程根本起不来"——缺 VC++ 运行库的 Windows 上，
//   沙箱化的渲染进程加载 DLL 失败，窗口一片空白甚至整个应用直接没了。
//   这类失败**无法在开窗之前探测**：要知道渲染进程能不能起来，只能真的起一次。
//
//   所以"探测"只能是跨启动的：开窗前在磁盘上按一个"正在尝试"的标记，
//   渲染进程真的加载完了才把标记清掉。下次启动看到没清掉的标记，
//   就知道上一次连页面都没出来 —— 这时候降级。
//
//   注意这个状态机管的是**跨启动的记忆**，不是当次的恢复手段。当次崩了主进程
//   会就地重建一个无沙箱窗口（electron-main.js 的 rebuildWindowWithoutSandbox），
//   用户只看到窗口闪一下。这里落盘的意义是让下一次启动不必再撞一遍。
//
// 三条尺度上的判断，都写在这里而不是散在主进程：
//   1. 默认开启。沙箱是渲染进程唯一的 OS 级隔离，contextIsolation 只挡 JS 作用域，
//      挡不住 DOMPurify 被绕过之后的原生层利用。
//   2. 降级要有代价。一次没确认的启动**不**降级（kill -9、断电、任务管理器结束
//      进程都会留下同样的标记），连续两次才算。否则一次断电就把用户永久按在
//      不安全模式上，而且他自己完全看不出来。
//   3. 降级不是终身的。RETRY_AFTER_MS 之后重试一次沙箱：用户装上运行库、
//      换了机器、系统升级之后，不该还留在当年那次故障的结论里。
//
// 这个文件刻意不 require('electron')：目录由调用方传进来，
// 判断逻辑可以用裸 node 单测（同 lib/logger.js 的理由）。
const fs = require('fs');
const path = require('path');

// 状态文件名。和 config.json 放同一个目录（见 electron-main.js 里的 SANDBOX_STATE_DIR）：
// 那是个每机器一份的位置，而"这台机器上沙箱能不能用"正是每机器一份的事实。
// 跟着 config.json 走还顺带让 PFM_DATA_DIR 的测试隔离自动生效。
const STATE_FILE = 'sandbox-state.json';

// 连续多少次"启动了但渲染进程没确认"才降级。见文件头第 2 条。
const MAX_STRIKES = 2;

// 降级之后多久重试一次沙箱。见文件头第 3 条。
const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const MODE_ON = 'sandbox';
const MODE_OFF = 'no-sandbox';

function statePath(dir) {
  return path.join(String(dir), STATE_FILE);
}

function defaultState() {
  return {
    schema: 1,
    mode: MODE_ON,
    reason: 'default',
    pending: null,
    strikes: 0,
    lastConfirmedAt: null,
    degradedAt: null
  };
}

// 读状态。任何异常都退化成默认值：状态文件坏了不该让应用起不来，
// 而"坏了就当默认（沙箱开着）"是安全的那一侧。
function read(dir) {
  const base = defaultState();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
  } catch {
    return base;
  }
  if (!raw || typeof raw !== 'object') return base;
  const mode = raw.mode === MODE_OFF ? MODE_OFF : MODE_ON;
  const strikes = Number.isFinite(raw.strikes) && raw.strikes > 0 ? Math.floor(raw.strikes) : 0;
  // pending 只认带时间戳的对象。写坏成 true / 字符串时当作没有：
  // 宁可漏判一次降级，也不要凭一个形状不对的值把沙箱关掉。
  const pending = raw.pending && typeof raw.pending === 'object' && typeof raw.pending.at === 'string'
    ? { at: raw.pending.at, mode: raw.pending.mode === MODE_OFF ? MODE_OFF : MODE_ON }
    : null;
  return {
    schema: 1,
    mode,
    reason: typeof raw.reason === 'string' ? raw.reason : base.reason,
    pending,
    strikes: Math.min(strikes, MAX_STRIKES),
    lastConfirmedAt: typeof raw.lastConfirmedAt === 'string' ? raw.lastConfirmedAt : null,
    degradedAt: typeof raw.degradedAt === 'string' ? raw.degradedAt : null
  };
}

// 同步原子写：临时文件 + rename。
//
// 为什么不用主进程的 writeFileAtomic：这个模块的调用点全在同步上下文里
// （decide 要在 app ready 之前跑完，才赶得上 appendSwitch；确认和降级发生在
// render-process-gone / did-finish-load 这类窗口事件回调里，那里没人 await
// 返回值，异步写失败会变成没人接的 rejection）。截断风险照样要防，
// 所以自己写一份同步的。
//
// 临时名故意**不**取 .tmp-<pid>-<seq>-*.part 的形状：那个形状会被启动自愈
// 当成残留临时文件扫掉（electron-main.js 的 TMP_PART_RE）。这里每次覆盖同一个名字，
// 不会累积，形态上也一眼能看出属于谁。参照 CONFIG_PATH + '.tmp-close' 的先例。
function write(dir, state) {
  const full = statePath(dir);
  const tmp = full + '.tmp';
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, full);
    return { ok: true, error: null };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 本来就没建出来 */ }
    // 写不进去就只是"下次启动记不住这次结论"，不是启动失败。调用方负责记一行日志。
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// 纯函数：给定磁盘上的状态和环境变量，决定这一次启动开不开沙箱。
//
// 返回 { sandbox, reason, nextState, changed }。
//   sandbox    这次启动要不要开
//   reason     为什么（会进日志和诊断包，是排障时唯一能看出"为什么我没开沙箱"的地方）
//   nextState  调用方应当落盘的状态（已经把 strike 累加/降级写进去了）
//   changed    nextState 和入参是否不同，没变就不用写盘
//
// env 覆盖（PFM_SANDBOX=on|off）不写盘：它是临时手段，用于测试和给用户一个
// 不改代码的逃生口，不该污染自动判断的历史。
function decide(opts) {
  const o = opts || {};
  const state = o.state || defaultState();
  const env = o.env || {};
  const now = o.now == null ? Date.now() : o.now;
  const iso = new Date(now).toISOString();

  const forced = String(env.PFM_SANDBOX || '').toLowerCase();
  if (forced === 'on' || forced === '1') {
    return { sandbox: true, reason: 'env-forced-on', nextState: state, changed: false };
  }
  if (forced === 'off' || forced === '0') {
    return { sandbox: false, reason: 'env-forced-off', nextState: state, changed: false };
  }

  // 已经降级过：看看冷静期到了没有。
  if (state.mode === MODE_OFF) {
    const since = Date.parse(state.degradedAt || '');
    const expired = Number.isFinite(since) ? (now - since) >= RETRY_AFTER_MS : true;
    if (!expired) {
      return { sandbox: false, reason: state.reason || 'degraded', nextState: state, changed: false };
    }
    // 冷静期满，重试一次。strikes 归零，重新走一遍"两次不确认才降级"。
    return {
      sandbox: true,
      reason: 'retry-after-degrade',
      nextState: { ...state, mode: MODE_ON, reason: 'retry-after-degrade', strikes: 0, pending: null, degradedAt: null },
      changed: true
    };
  }

  // 上一次启动按了标记却没确认 —— 渲染进程没能加载完。
  if (state.pending) {
    const strikes = state.strikes + 1;
    if (strikes >= MAX_STRIKES) {
      return {
        sandbox: false,
        reason: 'renderer-unconfirmed',
        nextState: { ...state, mode: MODE_OFF, reason: 'renderer-unconfirmed', strikes, pending: null, degradedAt: iso },
        changed: true
      };
    }
    // 还没到降级线：继续开着沙箱再试一次，但把这次记下来。
    return {
      sandbox: true,
      reason: 'retry-after-unconfirmed',
      nextState: { ...state, reason: 'retry-after-unconfirmed', strikes, pending: null },
      changed: true
    };
  }

  return { sandbox: true, reason: state.reason === 'default' ? 'default-on' : state.reason, nextState: state, changed: false };
}

// 开窗之前按标记。只在沙箱开着时按：关着的时候没有要证明的事，
// 按了反而会把普通崩溃算成沙箱的账。
function markAttempt(dir, state, now) {
  const at = new Date(now == null ? Date.now() : now).toISOString();
  const next = { ...state, pending: { at, mode: MODE_ON } };
  const res = write(dir, next);
  return { state: next, ...res };
}

// 渲染进程真的加载完了。清标记、清 strike——这是"沙箱在这台机器上能用"的唯一凭据。
function confirm(dir, state, now) {
  const at = new Date(now == null ? Date.now() : now).toISOString();
  const next = { ...state, pending: null, strikes: 0, lastConfirmedAt: at };
  const res = write(dir, next);
  return { state: next, ...res };
}

// 当场判定沙箱不可用（渲染进程在确认之前就没了）。
//
// 落盘只负责**下一次**启动：下一进程 decide() 读到 mode=no-sandbox，直接以无沙箱
// 起，不再撞一遍。本次的恢复不靠这里——主进程就地重建一个无沙箱窗口即可
// （见 electron-main.js 的 rebuildWindowWithoutSandbox）。所以写盘失败不该中断
// 恢复，只是"这次结论记不住"，下次启动会重复一遍探测。
function degrade(dir, state, reason, now) {
  const at = new Date(now == null ? Date.now() : now).toISOString();
  const next = {
    ...state,
    mode: MODE_OFF,
    reason: String(reason || 'renderer-gone'),
    pending: null,
    strikes: MAX_STRIKES,
    degradedAt: at
  };
  const res = write(dir, next);
  return { state: next, ...res };
}

module.exports = {
  statePath, defaultState, read, write, decide, markAttempt, confirm, degrade,
  STATE_FILE, MAX_STRIKES, RETRY_AFTER_MS, MODE_ON, MODE_OFF
};
