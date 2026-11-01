// lib/quick-launch-selftest.js
// 快速搜索面板的端到端自检（PFM_SELFTEST_QUICK_LAUNCH）。测试专用，正常启动一行都不跑。
//
// 为什么单独一个文件、不并进 lib/selftest.js：这条自检要在主进程里模拟按快捷键、
// 读写剪贴板、比对两个窗口的 webPreferences、临时替换 search 的 IPC 处理器来制造乱序，
// 每一步都夹在页面操作中间，没法写成一段丢进页面执行的脚本。而 lib/selftest.js 的
// 注入契约（REQUIRED / init 解构 / 主进程传参三份清单）有专门的断言和变异脚本盯着，
// 往里加依赖等于改契约。这里走同一个思路：不 require electron，app / screen /
// clipboard / ipcMain / 窗口全部由主进程传进来（见 electron-main.js 的 runQuickLaunchSelfTest）。
//
// 两种模式：
//   full          默认。快捷键开着启动 → 最小化主窗口按快捷键 → 搜索 / 乱序 / 复制 /
//                 填空 / Esc / 失焦 → 设置面板开关和改键 → 切语言主题 → 退出时注销
//   startup-taken 启动时快捷键已被"别的程序"占用：要当面提示，不能静默失效；
//                 再走一次自检入口直接呼出（不经快捷键），并在沙箱关着时复验安全配置
//
// 期望值写死在 tests/quick-launch.test.js 种下的几个文件上（ql-plain / ql-fill / ql-snippet），
// 两边一起改。
const path = require('path');
const FRONTMATTER = require(path.join(__dirname, '..', 'src', 'frontmatter.js'));
const PLACEHOLDERS = require(path.join(__dirname, '..', 'src', 'placeholders.js'));
const INCLUDES = require(path.join(__dirname, '..', 'src', 'includes.js'));
const I18N = require(path.join(__dirname, '..', 'src', 'i18n.js'));

const PLAIN_REL = 'prompts/testing/ql-plain.md';
const FILL_REL = 'prompts/testing/ql-fill.md';
const DEFAULT_KEY = 'Ctrl+Alt+Space';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 5000, step = 40) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try { last = await fn(); } catch { last = null; }
    if (last) return last;
    await sleep(step);
  }
  return last;
}
const fillVars = (s, vars) => Object.keys(vars).reduce((acc, k) => acc.split('{' + k + '}').join(vars[k]), s);

// 两套 console-message 签名都认，理由见 lib/selftest.js 的 attachSelfTest
function collectConsole(wc, sink, label) {
  wc.on('console-message', (...args) => {
    const d = args[0];
    if (d && typeof d === 'object' && 'level' in d && typeof d.level === 'string') {
      if (d.level === 'warning' || d.level === 'error') sink.push(label + ': ' + d.message);
      return;
    }
    const [, level, message] = args;
    if (typeof level === 'number' && level >= 2) sink.push(label + ': ' + message);
  });
}

async function run(ctx) {
  const { app, screen, clipboard, ipcMain, fs, DATA_ROOT, CONFIG_PATH,
    mainWin, backend, showQuickPanel, getQuickPanel, searchAll } = ctx;
  let failed = 0;
  const check = (name, ok, detail) => {
    if (ok) console.log('[quick-launch] PASS ' + name);
    else { failed++; console.error('[quick-launch] FAIL ' + name + (detail ? ' → ' + detail : '')); }
  };
  // 会改配置、写剪贴板，和其他落盘自检一样必须隔离数据目录
  if (!process.env.PFM_DATA_DIR) {
    check('快速搜索面板自检必须设置 PFM_DATA_DIR，拒绝改写用户真实配置', false);
    app.exit(1);
    return;
  }
  const mode = process.env.PFM_SELFTEST_QUICK_LAUNCH === 'startup-taken' ? 'startup-taken' : 'full';
  console.log('[quick-launch] 模式=' + mode);
  const consoleErrors = [];
  collectConsole(mainWin.webContents, consoleErrors, 'main');
  const watched = new Set();
  const watchPanel = () => {
    const p = getQuickPanel();
    if (p && !watched.has(p.webContents.id)) {
      watched.add(p.webContents.id);
      collectConsole(p.webContents, consoleErrors, 'panel');
    }
  };
  // 剪贴板是开发机上真实的那一个。跑完放回去；测试里每次复制前先写一个哨兵值，
  // 这样残留的旧内容碰巧相等也不会让断言假绿。
  const savedClipboard = clipboard.readText();
  const sentinel = () => { const v = 'QL-SENTINEL-' + Date.now(); clipboard.writeText(v); return v; };

  const inMain = (code) => mainWin.webContents.executeJavaScript(code, true);
  const inPanel = (code) => {
    const p = getQuickPanel();
    if (!p) return Promise.reject(new Error('quick panel is not created'));
    return p.webContents.executeJavaScript(code, true);
  };
  const visible = () => { const p = getQuickPanel(); return !!(p && p.isVisible()); };
  const typeInPanel = (q) => inPanel('(() => { const i = document.getElementById("ql-input"); i.value = '
    + JSON.stringify(q) + '; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
  const keyInPanel = (key, opts) => inPanel('(() => { const a = document.activeElement; const el = a && a !== document.body ? a : document.getElementById("ql-input");'
    + ' el.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: ' + JSON.stringify(key) + ', bubbles: true, cancelable: true }, '
    + JSON.stringify(opts || {}) + '))); return true; })()');
  const listRels = () => inPanel('Array.from(document.querySelectorAll("#ql-list .ql-item")).map(e => e.dataset.rel).join("|")');
  const activeIdx = () => inPanel('Array.from(document.querySelectorAll("#ql-list .ql-item")).findIndex(e => e.classList.contains("active"))');
  const readCfg = () => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } };
  const pressAndShow = async (acc) => {
    const pressed = backend.press(acc);
    const shown = pressed && await waitFor(() => visible(), 5000);
    watchPanel();
    return !!shown;
  };
  const hideWithEsc = async () => {
    await keyInPanel('Escape');
    return !!await waitFor(() => !visible(), 3000);
  };

  // 两个窗口的安全配置逐项比对。只排除 preload（面板故意用最小白名单）；
  // 别的任何一项不同都算不一致——将来主窗口加了一项安全开关而面板没跟上，这里会红。
  const comparePrefs = (label) => {
    const p = getQuickPanel();
    const mp = mainWin.webContents.getLastWebPreferences() || {};
    const pp = p ? (p.webContents.getLastWebPreferences() || {}) : {};
    const keys = [...new Set([...Object.keys(mp), ...Object.keys(pp)])].filter(k => k !== 'preload');
    const diff = keys.filter(k => JSON.stringify(mp[k]) !== JSON.stringify(pp[k]))
      .map(k => k + ': main=' + JSON.stringify(mp[k]) + ' panel=' + JSON.stringify(pp[k]));
    check('面板与主窗口的 webPreferences 逐项一致，只有 preload 不同（' + label + '，共 ' + keys.length + ' 项）',
      keys.length >= 5 && diff.length === 0, diff.join('; '));
    check('面板 contextIsolation 开、nodeIntegration 关（' + label + '）',
      pp.contextIsolation === true && pp.nodeIntegration === false, JSON.stringify(pp));
    check('面板沙箱与主窗口同一个判定（sandbox=' + pp.sandbox + '）', pp.sandbox === mp.sandbox && typeof pp.sandbox === 'boolean');
  };
  const probeBridge = async (label) => {
    const r = JSON.parse(await inPanel('JSON.stringify({ req: typeof require, proc: typeof process, mod: typeof module,'
      + ' full: typeof window.promptFlowApi, keys: Object.keys(window.quickLaunchApi || {}).sort().join(",") })'));
    check('面板页面拿不到 Node 能力（require/process/module 不可见，' + label + '）',
      r.req === 'undefined' && r.proc === 'undefined' && r.mod === 'undefined', JSON.stringify(r));
    check('面板只暴露最小白名单，拿不到主窗口那套写操作（' + label + '）',
      r.keys === 'copy,hide,onShow,readFile,search' && r.full === 'undefined', JSON.stringify(r));
    // getLastWebPreferences 不带 preload 路径，只能按行为查：两个窗口各自拿到的是哪座桥
    const m = await inMain('typeof window.promptFlowApi + "," + typeof window.quickLaunchApi');
    check('面板用最小白名单 preload，主窗口仍是完整的 preload.js（' + label + '）', m === 'object,undefined', m);
  };

  try {
    // 沙箱下渲染进程起不来时主窗口会被就地重建，新窗口会再跑一遍这条自检；
    // 旧窗口这一份就此作罢，不能拿着已销毁的窗口往下走、更不能替它退出进程
    const alive = await new Promise((resolve) => {
      if (!mainWin.webContents.isLoading()) { resolve(true); return; }
      mainWin.webContents.once('did-finish-load', () => resolve(true));
      mainWin.once('closed', () => resolve(false));
    });
    if (!alive || mainWin.isDestroyed()) {
      console.log('[quick-launch] 主窗口被重建，交给新窗口继续自检');
      return;
    }
    // 渲染进程 init 走到最后才查快捷键状态（checkQuickLaunchAtStartup），
    // state.quickLaunch 有值说明设置面板的处理器也都挂好了
    const st = await waitFor(() => inMain('typeof state !== "undefined" && state.quickLaunch ? JSON.stringify(state.quickLaunch) : null'), 15000);
    const status = st ? JSON.parse(st) : null;
    check('自检模式下用的是内存替身，没有注册真实的系统快捷键', typeof backend.press === 'function' && typeof backend.registeredKeys === 'function');

    if (mode === 'startup-taken') {
      await runStartupTaken();
    } else {
      await runFull();
    }

    async function runStartupTaken() {
      check('启动时快捷键被占用：主进程报告未生效（E_SHORTCUT_TAKEN）',
        !!status && status.enabled === true && status.registered === false && status.error === 'E_SHORTCUT_TAKEN', st);
      check('启动注册失败后没有残留任何注册', backend.registeredKeys().length === 0, backend.registeredKeys().join(','));
      const want = fillVars(I18N.en.err_E_SHORTCUT_TAKEN, { detail: DEFAULT_KEY });
      const toastText = await waitFor(async () => {
        const txt = await inMain('$("toast").textContent');
        return txt === want ? txt : null;
      }, 5000);
      check('启动时注册失败会当面提示用户（toast，不静默失效）', toastText === want, String(toastText));
      check('没注册上时不预先建面板', !getQuickPanel());
      // 自检入口：不经快捷键直接呼出
      const shown = await showQuickPanel();
      watchPanel();
      check('自检入口可以不经快捷键直接呼出面板', shown === true && visible());
      comparePrefs('强制关沙箱');
      await probeBridge('强制关沙箱');
      check('Esc 收起面板（强制关沙箱）', await hideWithEsc());
    }

    async function runFull() {
      check('配置开着时启动即注册了快捷键',
        !!status && status.enabled && status.registered && status.shortcut === DEFAULT_KEY
        && backend.registeredKeys().join(',') === DEFAULT_KEY, st + ' / ' + backend.registeredKeys().join(','));
      const prewarmed = getQuickPanel();
      check('开着时启动就预先建好了面板（第一次呼出不用等页面加载）', !!prewarmed && !prewarmed.isVisible());
      const firstId = prewarmed ? prewarmed.webContents.id : null;

      // ---- 主窗口最小化时呼出 ----
      mainWin.minimize();
      await waitFor(() => mainWin.isMinimized(), 3000);
      const shown = await pressAndShow(DEFAULT_KEY);
      check('主窗口最小化时按快捷键也能呼出面板', shown && mainWin.isMinimized());
      const panel = getQuickPanel();
      check('面板置顶且是固定尺寸的小窗口', !!panel && panel.isAlwaysOnTop() && !panel.isResizable() && !panel.isMinimizable());
      {
        const b = panel.getBounds();
        const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        const dx = Math.abs((b.x + b.width / 2) - (wa.x + wa.width / 2));
        const dy = Math.abs((b.y + b.height / 2) - (wa.y + wa.height / 2));
        check('面板居中于当前显示器的工作区', dx <= 3 && dy <= 3, JSON.stringify({ b, wa }));
      }
      {
        const look = JSON.parse(await waitFor(() => inPanel('document.body.className === "theme-dark" ? JSON.stringify({ cls: document.body.className,'
          + ' ph: document.getElementById("ql-input").placeholder, hint: document.getElementById("ql-hint").textContent }) : null'), 3000) || '{}');
        check('面板跟随当前主题（深色）', look.cls === 'theme-dark', JSON.stringify(look));
        check('面板跟随当前语言（英文）', look.ph === I18N.en.qlPlaceholder && look.hint === I18N.en.qlHint, JSON.stringify(look));
      }

      // ---- 安全配置 ----
      comparePrefs('默认沙箱判定');
      await probeBridge('默认沙箱判定');
      {
        const sel = 'document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\').content';
        const a = await inMain(sel);
        const b = await inPanel(sel);
        check('面板的 CSP 与主窗口逐字一致', !!a && a === b && /script-src 'self'/.test(b), a + ' / ' + b);
      }
      {
        const before = panel.webContents.getURL();
        await inPanel('location.href = ' + JSON.stringify(mainWin.webContents.getURL()) + '; true').catch(() => {});
        await sleep(500);
        check('面板内导航被拦截（停在自己那一页，连主窗口的页面也不许）', panel.webContents.getURL() === before, panel.webContents.getURL());
        check('面板禁止 window.open', await inPanel('window.open("about:blank") === null'));
      }

      // ---- 输入即搜 ----
      await typeInPanel('QLPLAIN');
      const rels = await waitFor(async () => { const r = await listRels(); return r === PLAIN_REL ? r : null; }, 3000);
      check('输入即搜：结果列出匹配的提示词', rels === PLAIN_REL, String(await listRels()));

      // ---- 乱序 ----
      // 让 QLFILL 这次查询慢 600ms 才回来，在它回来之前改搜 QLPLAIN（快）。
      // 没有序号守卫的话，慢的那次后到，会把列表盖成 QLFILL 的结果。
      ipcMain.removeHandler('search');
      ipcMain.handle('search', async (e, q) => {
        if (String(q).trim() === 'QLFILL') await sleep(600);
        return searchAll(q);
      });
      try {
        await typeInPanel('QLFILL');
        await sleep(250);
        await typeInPanel('QLPLAIN');
        await sleep(1100);
        const after = await listRels();
        check('搜索结果乱序返回时，旧查询的结果不会盖掉新查询（序号守卫）', after === PLAIN_REL, after);
      } finally {
        ipcMain.removeHandler('search');
        ipcMain.handle('search', async (e, query) => searchAll(query));
      }

      // ---- Enter 复制 ----
      {
        const expected = FRONTMATTER.parse(fs.readFileSync(path.join(DATA_ROOT, PLAIN_REL), 'utf8')).body;
        const s0 = sentinel();
        await keyInPanel('Enter');
        const clip = await waitFor(() => { const c = clipboard.readText(); return c !== s0 && !visible() ? c : null; }, 4000);
        check('Enter 把选中的提示词正文（不含 frontmatter）写进剪贴板',
          clip === expected && clip.includes('QLPLAIN-BODY-7731') && !clip.includes('title:'), JSON.stringify(String(clip).slice(0, 160)));
        check('复制成功后面板隐藏', !visible());
      }

      // ---- 复用同一个实例 ----
      await pressAndShow(DEFAULT_KEY);
      check('隐藏而不是销毁：再次呼出复用同一个面板实例', !!getQuickPanel() && getQuickPanel().webContents.id === firstId);

      // ---- ↑↓ 选择 + include + 占位符 ----
      await typeInPanel('QL');
      const all = await waitFor(async () => { const r = await listRels(); return r.split('|').length === 3 ? r : null; }, 3000);
      const order = String(all || '').split('|');
      check('搜索 QL 列出三条（↑↓ 测试的前提）', order.length === 3, String(all));
      await keyInPanel('ArrowDown');
      const a1 = await activeIdx();
      await keyInPanel('ArrowUp');
      await keyInPanel('ArrowUp');
      const a2 = await activeIdx();
      check('↑↓ 移动选中项，到头回绕', a1 === 1 && a2 === 2, a1 + ',' + a2);
      const target = order.indexOf(FILL_REL);
      for (let i = 0; i < (target - a2 + 3) % 3; i++) await keyInPanel('ArrowDown');
      check('↓ 移到了带占位符的那一条', await activeIdx() === target);
      const s1 = sentinel();
      await keyInPanel('Enter');
      const tokens = await waitFor(() => inPanel('document.getElementById("ql-fill").classList.contains("hidden") ? null :'
        + ' JSON.stringify(Array.from(document.querySelectorAll("#ql-fill input[data-token]")).map(i => [i.dataset.token, i.value]))'), 3000);
      const tk = tokens ? JSON.parse(tokens) : [];
      check('有占位符时在面板内弹出填空表单，先不复制',
        tk.length === 2 && visible() && clipboard.readText() === s1, String(tokens));
      check('填空表单预填了主窗口记住的值（同一份填充记忆）',
        tk.some(([k, v]) => k === '[QL备注]' && v === 'MEMO-7') && tk.some(([k, v]) => k === '[QL目标]' && v === ''), String(tokens));
      await inPanel('(() => { const i = document.querySelector(\'#ql-fill input[data-token="[QL目标]"]\'); i.value = "VALUE-42"; i.focus(); return true; })()');
      await keyInPanel('Enter', { ctrlKey: true });
      {
        let body = FRONTMATTER.parse(fs.readFileSync(path.join(DATA_ROOT, FILL_REL), 'utf8')).body;
        body = INCLUDES.resolveSync(body, rel => fs.readFileSync(path.join(DATA_ROOT, rel), 'utf8'));
        const expected = PLACEHOLDERS.fill(body, { '[QL目标]': 'VALUE-42', '[QL备注]': 'MEMO-7' });
        const clip = await waitFor(() => { const c = clipboard.readText(); return c !== s1 && !visible() ? c : null; }, 4000);
        check('Ctrl+Enter 填好后复制：{{include:}} 已展开、占位符已替换、frontmatter 已剥掉',
          clip === expected && clip.includes('SNIPPET-INCLUDED-5521') && clip.includes('VALUE-42') && clip.includes('MEMO-7')
          && !clip.includes('{{include') && !clip.includes('[QL目标]') && !clip.includes('title:'),
          JSON.stringify(String(clip).slice(0, 200)));
        check('填空复制成功后面板隐藏', !visible());
      }

      // ---- Esc ----
      await pressAndShow(DEFAULT_KEY);
      check('Esc 收起面板', await hideWithEsc());
      check('Esc 只是隐藏，面板实例还在', !!getQuickPanel() && getQuickPanel().webContents.id === firstId);
      await pressAndShow(DEFAULT_KEY);
      await typeInPanel('QLFILL');
      await waitFor(async () => (await listRels()) === FILL_REL, 3000);
      await keyInPanel('Enter');
      await waitFor(() => inPanel('!document.getElementById("ql-fill").classList.contains("hidden")'), 3000);
      check('填空表单里按 Esc 也能收起', await hideWithEsc());
      await pressAndShow(DEFAULT_KEY);
      check('再次呼出时回到搜索列表，不残留上一次的填空表单',
        await inPanel('document.getElementById("ql-fill").classList.contains("hidden") && !document.getElementById("ql-list").classList.contains("hidden")'));

      // ---- 失焦 ----
      // 真实的失焦依赖系统把焦点给了谁，自动化里不可控（面板可能从没拿到过焦点）。
      // 这里发窗口的 blur 事件，验的是"失焦即隐藏"这条接线在不在。
      getQuickPanel().emit('blur');
      check('面板失焦即收起', !!await waitFor(() => !visible(), 3000));

      // ---- 设置面板 ----
      mainWin.restore();
      await waitFor(() => !mainWin.isMinimized(), 3000);
      await inMain('openSettings(); true');
      const statusLine = () => inMain('$("quick-launch-status").textContent');
      const onText = (k) => fillVars(I18N.en.quickLaunchStatusOn, { shortcut: k });
      check('设置里开关已开、状态行显示已生效',
        !!await waitFor(async () => (await statusLine()) === onText(DEFAULT_KEY) && await inMain('$("chk-quick-launch").checked'), 3000),
        String(await statusLine()));
      // 关开关：走真实 click
      await inMain('$("chk-quick-launch").click(); true');
      await waitFor(() => backend.registeredKeys().length === 0, 3000);
      check('关掉开关立即注销快捷键（再按没反应）', backend.registeredKeys().length === 0 && backend.press(DEFAULT_KEY) === false);
      check('关掉开关写进了配置', readCfg().quickLaunchEnabled === false);
      check('关掉后状态行显示未开启', !!await waitFor(async () => (await statusLine()) === I18N.en.quickLaunchStatusOff, 3000));
      // 被占用：PFM_SELFTEST_SHORTCUT_TAKEN 里列了 Ctrl+Shift+K。输入小写，顺带验规范化
      await inMain('$("quick-launch-shortcut").value = "ctrl+shift+k"; $("chk-quick-launch").click(); true');
      {
        const want = fillVars(I18N.en.err_E_SHORTCUT_TAKEN, { detail: 'Ctrl+Shift+K' });
        const got = await waitFor(async () => { const x = await inMain('$("toast").textContent'); return x === want ? x : null; }, 3000);
        check('快捷键被占用时提示用户（不静默失效）', got === want, String(await inMain('$("toast").textContent')));
        const cfg = readCfg();
        check('注册失败时开关拨回关闭、配置没写进去、没有残留注册',
          !await inMain('$("chk-quick-launch").checked') && cfg.quickLaunchEnabled === false
          && cfg.quickLaunchShortcut === DEFAULT_KEY && backend.registeredKeys().length === 0, JSON.stringify(cfg));
      }
      // 格式不对
      await inMain('$("quick-launch-shortcut").value = "Ctrl+K"; $("btn-quick-launch-apply").click(); true');
      {
        const want = fillVars(I18N.en.err_E_SHORTCUT_INVALID, { detail: 'Ctrl+K' });
        const got = await waitFor(async () => { const x = await inMain('$("toast").textContent'); return x === want ? x : null; }, 3000);
        check('格式不对的快捷键被拒绝并提示，输入框保留用户敲的值',
          got === want && readCfg().quickLaunchShortcut === DEFAULT_KEY && await inMain('$("quick-launch-shortcut").value') === 'Ctrl+K',
          String(await inMain('$("toast").textContent')));
      }
      // 换一个合法的组合键并打开
      await inMain('$("quick-launch-shortcut").value = "alt+ctrl+j"; $("chk-quick-launch").click(); true');
      await waitFor(() => backend.registeredKeys().join(',') === 'Ctrl+Alt+J', 3000);
      check('改组合键：新键规范化后注册、旧键不再响应',
        backend.registeredKeys().join(',') === 'Ctrl+Alt+J' && backend.press(DEFAULT_KEY) === false, backend.registeredKeys().join(','));
      {
        const cfg = readCfg();
        check('新组合键写进了配置（规范化后的写法）', cfg.quickLaunchEnabled === true && cfg.quickLaunchShortcut === 'Ctrl+Alt+J', JSON.stringify(cfg));
        check('状态行和输入框显示新组合键',
          !!await waitFor(async () => (await statusLine()) === onText('Ctrl+Alt+J') && await inMain('$("quick-launch-shortcut").value') === 'Ctrl+Alt+J', 3000));
      }
      check('新组合键能呼出面板', await pressAndShow('Ctrl+Alt+J'));
      await hideWithEsc();
      // 开着的时候换回默认键
      await inMain('$("quick-launch-shortcut").value = "Ctrl+Alt+Space"; $("btn-quick-launch-apply").click(); true');
      await waitFor(() => backend.registeredKeys().join(',') === DEFAULT_KEY, 3000);
      check('开着时换键：旧键注销、新键生效', backend.registeredKeys().join(',') === DEFAULT_KEY && backend.press('Ctrl+Alt+J') === false);

      // ---- 切语言、切主题之后再呼出 ----
      await inMain('setLang("zh").then(() => true)');
      check('切换语言后设置里的状态行跟着变',
        !!await waitFor(async () => (await statusLine()) === fillVars(I18N.zh.quickLaunchStatusOn, { shortcut: DEFAULT_KEY }), 3000));
      await inMain('toggleTheme().then(() => true)');
      await pressAndShow(DEFAULT_KEY);
      {
        const look = JSON.parse(await waitFor(() => inPanel('document.body.className === "theme-light" ? JSON.stringify({ cls: document.body.className,'
          + ' ph: document.getElementById("ql-input").placeholder }) : null'), 3000) || '{}');
        check('主窗口切了语言和主题，下一次呼出面板就跟着变', look.cls === 'theme-light' && look.ph === I18N.zh.qlPlaceholder, JSON.stringify(look));
      }
      await hideWithEsc();
    }

    check('两个窗口都没有控制台报错', consoleErrors.length === 0, consoleErrors.join(' | '));
  } catch (e) {
    check('自检流程异常', false, e && e.stack ? e.stack : String(e));
  }
  try { clipboard.writeText(savedClipboard); } catch {}
  // 退出时注销：主进程的 will-quit 处理器先注册（模块加载时），这里后注册，
  // 所以轮到这里时注销应该已经发生了。
  // 退出流程卡住（关窗握手没走完）时兜底，不能让测试进程挂到外层超时
  const quitTimer = setTimeout(() => {
    console.error('[quick-launch] FAIL 退出流程 15 秒内没有走完');
    app.exit(1);
  }, 15000);
  app.once('will-quit', () => {
    clearTimeout(quitTimer);
    const ok = backend.registeredKeys().length === 0 && backend.calls.unregisterAll > 0;
    check('退出前注销了全部全局快捷键', ok, 'registered=' + backend.registeredKeys().join(',') + ' unregisterAll=' + backend.calls.unregisterAll);
    console.log('[quick-launch] ' + (failed ? '有失败项（' + failed + '）' : '全部通过'));
    // process.exitCode 在正常退出流程里会被 Electron 自己的退出码盖掉（实测失败时照样 0），
    // 只能在这里显式 exit。主进程的 will-quit（注销快捷键）先注册，已经跑过了。
    if (failed) app.exit(1);
  });
  // 走正常的退出流程（不是 app.exit）：要验的正是 will-quit 里的注销。
  // full 模式关主窗口（用户点 ✕），startup-taken 走 app.quit（菜单退出）——两条路都要能退：
  // 面板是隐藏不销毁的，只关主窗口时如果面板还活着，window-all-closed 永远不触发、
  // 进程退不掉；app.quit 那条路会把所有窗口一起关掉，测不出这个问题（变异对照实测过）。
  if (mode === 'full') mainWin.close();
  else app.quit();
}

module.exports = { run };
