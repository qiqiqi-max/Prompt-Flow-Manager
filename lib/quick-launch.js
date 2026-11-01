// lib/quick-launch.js
// 全局快捷键呼出的快速搜索面板：快捷键字符串校验、注册状态机、设置变更的
// 提交/回滚顺序、面板居中。
//
// 刻意不 require('electron')：globalShortcut、配置读写、appError 全部由主进程传进来，
// 所以整套判定能用裸 node 单测（tests/quick-launch-logic.test.js）。窗口本身
// （BrowserWindow、webPreferences、导航拦截）留在 electron-main.js，那部分只有
// Electron 测得到（tests/quick-launch.test.js）。
//
// 默认组合键选 Ctrl+Alt+Space，理由按排除法：
//   - Alt+Space 是 Windows 的窗口系统菜单，抢了它所有程序的"还原/移动/最小化"菜单就没了；
//   - Ctrl+Space / Shift+Space 是中文输入法的中英切换 / 全半角切换，本项目的用户
//     大多开着中文输入法，抢了等于让他打不了字；
//   - Ctrl+Alt+<字母> 在德语、波兰语等键盘布局下就是 AltGr+<字母>，会吃掉 @ € ł 这类字符；
//   - Ctrl+Shift+<字母> 是各家编辑器的高频命令（VS Code 的 Ctrl+Shift+P/F/E…）。
// 落在 Space 上还顺了"启动器"的肌肉记忆（PowerToys Run 的 Alt+Space、Spotlight 的
// Cmd+Space）。已知会撞的是 JetBrains IDE 的"类名补全"，所以功能默认关闭，设置里可改。
const DEFAULT_ACCELERATOR = 'Ctrl+Alt+Space';

// 修饰键的别名 → 规范名。规范名也是 Electron accelerator 认的写法，可以直接交给
// globalShortcut.register。CommandOrControl 归到 Ctrl：打包目标只有 Windows，
// 在这里分平台只会让同一份配置在两边显示成两个样子。
const MODIFIER_ALIASES = {
  ctrl: 'Ctrl', control: 'Ctrl', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
  super: 'Super', win: 'Super', meta: 'Super', cmd: 'Super', command: 'Super'
};
// 规范化后的修饰键顺序。用户写 Alt+Ctrl+Space 和 Ctrl+Alt+Space 是同一个键，
// 存盘时统一成一种，否则"改成同一个组合"会被当成变更，白白注销重注册一次。
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'];
const MAX_LEN = 64;

// 主键白名单：字母、数字、F1-F24、Space。
// 不收 Enter / Tab / Esc / Backspace / Delete / 方向键：全局抢走它们，
// 用户在任何程序里都会发现某个组合"按了没反应"，而且很难联想到是这个应用干的。
function normalizeKey(raw) {
  const s = raw.toLowerCase();
  if (/^[a-z]$/.test(s)) return s.toUpperCase();
  if (/^[0-9]$/.test(s)) return s;
  if (s === 'space') return 'Space';
  const f = s.match(/^f([1-9]|1[0-9]|2[0-4])$/);
  if (f) return 'F' + f[1];
  return null;
}

// 系统已经占着、注册"成功"了也只会两边打架的组合。Alt+F4 / Ctrl+F4 是关窗口 / 关标签。
// Alt+Space 和 Ctrl+Space 下面的"至少两个修饰键"规则已经挡掉了，单列出来是为了
// 给用户一个更准确的理由（reason 不同，测试分得清）。
const RESERVED = new Set(['Alt+Space', 'Ctrl+Space', 'Shift+Space', 'Alt+F4', 'Ctrl+F4']);

// 校验并规范化一个快捷键字符串。
// 返回 { ok: true, accelerator } 或 { ok: false, reason }。
// reason 只给测试和日志看，界面上统一走 E_SHORTCUT_INVALID 一条文案。
function normalizeAccelerator(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' };
  const s = input.trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (s.length > MAX_LEN) return { ok: false, reason: 'too-long' };
  const parts = s.split('+').map(p => p.trim());
  // 'Ctrl+' 和 'Ctrl++K' 都会切出空段。不允许把 '+' 本身当主键：
  // 它在大多数布局上要配 Shift 才打得出来，写进 accelerator 只会产生歧义。
  if (parts.some(p => !p)) return { ok: false, reason: 'syntax' };
  const mods = new Set();
  let key = null;
  for (let i = 0; i < parts.length; i++) {
    const lower = parts[i].toLowerCase();
    const mod = Object.prototype.hasOwnProperty.call(MODIFIER_ALIASES, lower) ? MODIFIER_ALIASES[lower] : null;
    if (mod) {
      // 主键之后再出现修饰键（K+Ctrl）当语法错：Electron 要求主键在最后
      if (key) return { ok: false, reason: 'syntax' };
      // Ctrl+Control+K：两个别名指向同一个键
      if (mods.has(mod)) return { ok: false, reason: 'duplicate-modifier' };
      mods.add(mod);
      continue;
    }
    if (key) return { ok: false, reason: 'syntax' };   // 两个主键
    key = normalizeKey(parts[i]);
    if (!key) return { ok: false, reason: 'unknown-key' };
  }
  if (!key) return { ok: false, reason: 'no-key' };
  const ordered = MODIFIER_ORDER.filter(m => mods.has(m));
  const accelerator = ordered.concat(key).join('+');
  if (RESERVED.has(accelerator)) return { ok: false, reason: 'reserved' };
  // 修饰键要求：
  //   F13-F24 键盘上一般没有实体键（宏键盘才有），单按也不会和任何人打架；
  //   其余主键至少要两个修饰键，或者一个非 Shift 修饰键 + F1-F12。
  //   单个 Ctrl/Alt + 字母就是 Ctrl+C / Alt+F（菜单访问键），全局抢走等于
  //   让所有程序的复制粘贴、菜单都失灵；只有 Shift 等于抢走一个大写字母。
  const isHighF = /^F(1[3-9]|2[0-4])$/.test(key);
  const isF = /^F\d+$/.test(key);
  const strong = ordered.filter(m => m !== 'Shift').length;
  if (!isHighF) {
    if (strong === 0) return { ok: false, reason: 'needs-modifier' };
    if (!isF && ordered.length < 2) return { ok: false, reason: 'needs-modifier' };
  }
  return { ok: true, accelerator };
}

// 从配置里读出"该不该注册、注册哪个"。
// enabled 只认严格的 true：config.json 可以被手改，'false' 这种字符串按 truthy
// 算的话就成了"关不掉"。快捷键缺省时用默认值；有值但校验不过时**不**回落默认值——
// 用户写的是 Ctrl+Q，静默换成 Ctrl+Alt+Space 等于替他抢了一个他没要的键。
function resolveSettings(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const enabled = c.quickLaunchEnabled === true;
  const raw = c.quickLaunchShortcut == null || c.quickLaunchShortcut === ''
    ? DEFAULT_ACCELERATOR : c.quickLaunchShortcut;
  const norm = normalizeAccelerator(raw);
  return {
    enabled,
    accelerator: norm.ok ? norm.accelerator : null,
    raw: typeof raw === 'string' ? raw : String(raw),
    invalid: !norm.ok
  };
}

// 注册状态机。同一时刻最多注册一个快捷键。
//
// 换键时**先注册新的、成功了再注销旧的**：反过来的话新键被占用时旧键已经没了，
// 用户只是想换个键，结果两个都没有。
//
// "注册成功"要两个信号都对：register 的返回值和 isRegistered。不同 Electron 版本、
// 不同平台在"被别的程序占用"时有的返回 false、有的返回 undefined 但实际没注册上，
// 只信一个就会出现"设置里显示已生效、按了没反应"——这正是这个功能最不能有的失效。
function createShortcutController({ globalShortcut, onTrigger }) {
  let current = null;

  function tryRegister(acc) {
    let ret;
    try {
      ret = globalShortcut.register(acc, () => onTrigger());
    } catch (e) {
      return { ok: false, thrown: e && e.message ? e.message : String(e) };
    }
    let reg = false;
    try { reg = globalShortcut.isRegistered(acc); } catch { reg = false; }
    if (ret === false || !reg) {
      // 返回了 true 但 isRegistered 说没有：残留的半注册也要清掉，不然下次 register
      // 同一个键会因为"已经注册过"直接失败。
      try { if (reg) globalShortcut.unregister(acc); } catch {}
      return { ok: false };
    }
    return { ok: true };
  }

  function release(acc) {
    try { globalShortcut.unregister(acc); } catch {}
  }

  // 让注册状态变成 { enabled, accelerator } 描述的样子。
  // 返回 { registered, accelerator, error }，error 只可能是 null 或 'E_SHORTCUT_TAKEN'。
  // 失败时**不动**当前已注册的键：调用方自己决定要不要回滚（见 applySettingsChange）。
  function apply({ enabled, accelerator }) {
    if (!enabled || !accelerator) {
      if (current) release(current);
      current = null;
      return { registered: false, accelerator: accelerator || null, error: null };
    }
    if (current === accelerator) return { registered: true, accelerator, error: null };
    const r = tryRegister(accelerator);
    if (!r.ok) return { registered: false, accelerator, error: 'E_SHORTCUT_TAKEN', thrown: r.thrown || null };
    if (current) release(current);
    current = accelerator;
    return { registered: true, accelerator, error: null };
  }

  function unregisterAll() {
    try { globalShortcut.unregisterAll(); } catch {}
    current = null;
  }

  return { apply, unregisterAll, current: () => current };
}

// 设置面板改开关 / 改组合键。顺序是这个功能里最容易写反的地方：
//
//   1. 先注册，成功了才落盘。反过来的话，键被别的程序占着也照样写进 config.json，
//      之后每次启动都会失败一次、提示一次，而用户在设置里看到的是"已开启"。
//   2. 落盘失败要把注册回滚到改之前。否则这一次会话里新键生效、磁盘上还是旧键，
//      重启后行为悄悄变回去——和"设置保存失败但界面照样生效"是同一类偏差，
//      主进程为那一类专门有 E_CONFIG_WRITE。
//
// 回滚目标取 controller.current()（此刻真正注册着的），不取配置里的值：
// 启动时注册失败的话，配置说开着、实际没注册，按配置回滚会凭空注册一个键。
async function applySettingsChange({ controller, loadConfig, updateConfig, appError }, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const cur = resolveSettings(await loadConfig());
  let accelerator = cur.accelerator;
  let rawToSave = null;
  if (p.shortcut != null) {
    const norm = normalizeAccelerator(p.shortcut);
    if (!norm.ok) throw appError('E_SHORTCUT_INVALID', String(p.shortcut).slice(0, MAX_LEN));
    accelerator = norm.accelerator;
    rawToSave = norm.accelerator;
  }
  const enabled = p.enabled == null ? cur.enabled : p.enabled === true;
  if (enabled && !accelerator) throw appError('E_SHORTCUT_INVALID', cur.raw.slice(0, MAX_LEN));

  const before = controller.current();
  const res = controller.apply({ enabled, accelerator });
  if (enabled && !res.registered) throw appError('E_SHORTCUT_TAKEN', accelerator);

  const toSave = { quickLaunchEnabled: enabled };
  if (rawToSave) toSave.quickLaunchShortcut = rawToSave;
  try {
    await updateConfig(toSave);
  } catch (e) {
    // 回到改之前的注册状态。旧键刚被我们自己注销，重注册理论上不会失败；
    // 真失败了（这一瞬间被别的程序抢走）也不能留着新键——磁盘上不是它。
    const back = controller.apply({ enabled: before != null, accelerator: before });
    if (before != null && !back.registered) controller.apply({ enabled: false, accelerator: null });
    throw e;
  }
  return statusOf(controller, await loadConfig());
}

// 给设置面板看的状态。registered 必须以"此刻真正注册着的键 == 配置里的键"为准：
// 只看 controller.current() 非空的话，换键失败后旧键还在，面板会把新键显示成已生效。
function statusOf(controller, cfg) {
  const s = resolveSettings(cfg);
  const live = controller.current();
  const registered = s.enabled && !!s.accelerator && live === s.accelerator;
  let error = null;
  if (s.enabled && !registered) error = s.invalid ? 'E_SHORTCUT_INVALID' : 'E_SHORTCUT_TAKEN';
  return {
    enabled: s.enabled,
    shortcut: s.accelerator || s.raw,
    registered,
    error
  };
}

// 自检用的 globalShortcut 替身：和真实 API 同形，但只在内存里记账。
//
// 为什么自检不能注册真实快捷键：测试会在开发机上并行拉起好几个 Electron，
// 真注册的话第一个进程抢到键，后面的全部"被占用"；而且测试跑着的时候开发者
// 按 Ctrl+Alt+Space 会呼出一个测试进程的面板。
// taken 列出"假装已被别的程序占用"的键，用来走注册失败那条路径。
function createFakeGlobalShortcut({ taken = [] } = {}) {
  const takenSet = new Set(taken.map(t => {
    const n = normalizeAccelerator(t);
    return n.ok ? n.accelerator : String(t);
  }));
  const handlers = new Map();
  const calls = { register: 0, unregister: 0, unregisterAll: 0 };
  return {
    register(acc, cb) {
      calls.register++;
      if (takenSet.has(acc) || handlers.has(acc)) return false;
      handlers.set(acc, cb);
      return true;
    },
    unregister(acc) { calls.unregister++; handlers.delete(acc); },
    unregisterAll() { calls.unregisterAll++; handlers.clear(); },
    isRegistered(acc) { return handlers.has(acc); },
    // 以下只给自检用：模拟用户按下某个组合键
    press(acc) {
      const cb = handlers.get(acc);
      if (!cb) return false;
      cb();
      return true;
    },
    registeredKeys: () => [...handlers.keys()],
    calls
  };
}

// 面板在工作区里居中。workArea 不一定从 (0,0) 开始：副屏在主屏左边时 x 是负数，
// 任务栏在顶部时 y 不是 0。直接拿 width/2 算会把面板放到主屏上去。
// 尺寸超过工作区时夹到工作区（小屏 + 高缩放下 640 逻辑像素可能放不下）。
function centerBounds(workArea, size) {
  const a = workArea || { x: 0, y: 0, width: 800, height: 600 };
  const w = Math.min(Math.round(size.width), a.width);
  const h = Math.min(Math.round(size.height), a.height);
  return {
    x: Math.round(a.x + (a.width - w) / 2),
    y: Math.round(a.y + (a.height - h) / 2),
    width: w,
    height: h
  };
}

module.exports = {
  DEFAULT_ACCELERATOR,
  normalizeAccelerator,
  resolveSettings,
  createShortcutController,
  applySettingsChange,
  statusOf,
  createFakeGlobalShortcut,
  centerBounds
};
