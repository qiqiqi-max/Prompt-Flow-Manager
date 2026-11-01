// tests/quick-launch-logic.test.js
// lib/quick-launch.js 的纯逻辑：快捷键校验、注册状态机、设置变更的提交/回滚顺序、居中。
// 不启动 Electron（globalShortcut 用同形替身）。真实窗口那一层见 tests/quick-launch.test.js。
//
// 反向对照在文件末尾：同一批断言拿一份"最自然的写法"再跑一遍，要求指定的那些条必须红。
// 那份写法不是瞎编的坏代码，每一处都是写这个功能时第一反应会写出来的样子：
//   校验只 trim 非空；enabled 写成 !== false；换键先注销旧的再注册新的、只信 register 的返回值；
//   设置变更先落盘再注册、不回滚；状态按"有没有注册着一个键"算；居中按 width/2 算、忽略工作区原点。
// 做法照 tests/placeholders.test.js 末尾那条朴素实现对照。
const path = require('path');
const real = require(path.join(__dirname, '..', 'lib', 'quick-launch.js'));

const appError = (code, detail) => new Error(detail == null || detail === '' ? code : code + '|' + detail);

// ---------- 反向对照用的朴素实现 ----------
const legacy = {
  DEFAULT_ACCELERATOR: 'Ctrl+Alt+Space',
  normalizeAccelerator(input) {
    const s = typeof input === 'string' ? input.trim() : '';
    return s ? { ok: true, accelerator: s } : { ok: false, reason: 'empty' };
  },
  resolveSettings(cfg) {
    const c = cfg || {};
    const n = legacy.normalizeAccelerator(c.quickLaunchShortcut || legacy.DEFAULT_ACCELERATOR);
    return { enabled: c.quickLaunchEnabled !== false, accelerator: n.ok ? n.accelerator : legacy.DEFAULT_ACCELERATOR, raw: String(c.quickLaunchShortcut || ''), invalid: false };
  },
  createShortcutController({ globalShortcut, onTrigger }) {
    let current = null;
    return {
      apply({ enabled, accelerator }) {
        if (current) { globalShortcut.unregister(current); current = null; }
        if (!enabled || !accelerator) return { registered: false, accelerator, error: null };
        let ok = false;
        try { ok = globalShortcut.register(accelerator, () => onTrigger()) !== false; } catch { ok = false; }
        if (ok) current = accelerator;
        return { registered: ok, accelerator, error: ok ? null : 'E_SHORTCUT_TAKEN' };
      },
      unregisterAll() { globalShortcut.unregisterAll(); current = null; },
      current: () => current
    };
  },
  async applySettingsChange({ controller, loadConfig, updateConfig, appError: ae }, patch) {
    const cur = legacy.resolveSettings(await loadConfig());
    const accelerator = patch.shortcut != null ? legacy.normalizeAccelerator(patch.shortcut).accelerator : cur.accelerator;
    const enabled = patch.enabled == null ? cur.enabled : patch.enabled === true;
    await updateConfig({ quickLaunchEnabled: enabled, ...(patch.shortcut != null ? { quickLaunchShortcut: accelerator } : {}) });
    const res = controller.apply({ enabled, accelerator });
    if (enabled && !res.registered) throw ae('E_SHORTCUT_TAKEN', accelerator);
    return legacy.statusOf(controller, await loadConfig());
  },
  statusOf(controller, cfg) {
    const s = legacy.resolveSettings(cfg);
    const registered = !!controller.current();
    return { enabled: s.enabled, shortcut: s.accelerator, registered, error: s.enabled && !registered ? 'E_SHORTCUT_TAKEN' : null };
  },
  createFakeGlobalShortcut: real.createFakeGlobalShortcut,
  centerBounds(workArea, size) {
    return { x: Math.round((workArea.width - size.width) / 2), y: Math.round((workArea.height - size.height) / 2), width: size.width, height: size.height };
  }
};

// 内存里的配置存储。failWrite 模拟 E_CONFIG_WRITE（磁盘满 / 文件被占用）。
function memStore(initial) {
  let data = { ...initial };
  const st = { writes: 0, failWrite: false };
  st.loadConfig = async () => ({ ...data });
  st.updateConfig = async (patch) => {
    if (st.failWrite) throw appError('E_CONFIG_WRITE', 'config.json');
    st.writes++;
    data = { ...data, ...patch };
    return { ...data };
  };
  st.data = () => ({ ...data });
  return st;
}

async function runChecks(Q) {
  const out = [];
  const check = (name, ok, detail) => out.push([name, !!ok, ok ? '' : (detail || '')]);
  const norm = (s) => Q.normalizeAccelerator(s);

  // ---- 校验与规范化 ----
  check('默认组合键是 Ctrl+Alt+Space', Q.DEFAULT_ACCELERATOR === 'Ctrl+Alt+Space');
  check('默认组合键本身能通过校验（不能默认给一个自己都不认的键）',
    norm(Q.DEFAULT_ACCELERATOR).ok && norm(Q.DEFAULT_ACCELERATOR).accelerator === Q.DEFAULT_ACCELERATOR);
  for (const [input, want] of [
    ['ctrl+alt+space', 'Ctrl+Alt+Space'],
    ['Alt+Ctrl+Space', 'Ctrl+Alt+Space'],
    [' Control + Shift + p ', 'Ctrl+Shift+P'],
    ['CommandOrControl+Alt+k', 'Ctrl+Alt+K'],
    ['Win+Alt+1', 'Alt+Super+1'],
    ['Ctrl+F9', 'Ctrl+F9'],
    ['F13', 'F13'],
    ['shift+f24', 'Shift+F24']
  ]) {
    const r = norm(input);
    check('规范化：' + JSON.stringify(input) + ' → ' + want, r.ok && r.accelerator === want, JSON.stringify(r));
  }
  for (const [input, reason] of [
    ['', 'empty'], ['   ', 'empty'], [null, 'empty'],
    ['Ctrl+', 'syntax'], ['Ctrl++K', 'syntax'], ['K+Ctrl', 'syntax'], ['Ctrl+Alt+K+J', 'syntax'],
    ['Ctrl+Alt', 'no-key'],
    ['Ctrl+Control+K', 'duplicate-modifier'],
    ['Ctrl+Alt+Enter', 'unknown-key'], ['Ctrl+Alt+Esc', 'unknown-key'], ['Ctrl+Alt+F25', 'unknown-key'],
    ['K', 'needs-modifier'], ['Ctrl+K', 'needs-modifier'], ['Alt+F', 'needs-modifier'], ['Shift+F5', 'needs-modifier'], ['F5', 'needs-modifier'],
    ['Alt+Space', 'reserved'], ['Ctrl+Space', 'reserved'], ['Alt+F4', 'reserved']
  ]) {
    const r = norm(input);
    check('拒绝：' + JSON.stringify(input) + '（' + reason + '）', !r.ok && r.reason === reason, JSON.stringify(r));
  }
  check('拒绝超长输入', !norm('Ctrl+'.repeat(20) + 'K').ok);

  // ---- 读配置 ----
  {
    const s = Q.resolveSettings({});
    check('全新配置：默认关闭、组合键取默认值', s.enabled === false && s.accelerator === 'Ctrl+Alt+Space', JSON.stringify(s));
    check('enabled 只认严格的 true（手改成字符串 "true" 不算开）',
      Q.resolveSettings({ quickLaunchEnabled: 'true' }).enabled === false && Q.resolveSettings({ quickLaunchEnabled: true }).enabled === true);
    const bad = Q.resolveSettings({ quickLaunchEnabled: true, quickLaunchShortcut: 'Ctrl+Q' });
    check('配置里的组合键不合法时标成 invalid，不静默换成默认键', bad.invalid === true && bad.accelerator === null, JSON.stringify(bad));
  }

  // ---- 注册状态机 ----
  {
    const gs = Q.createFakeGlobalShortcut({ taken: ['Ctrl+Shift+K'] });
    let hits = 0;
    const c = Q.createShortcutController({ globalShortcut: gs, onTrigger: () => { hits++; } });
    const r1 = c.apply({ enabled: true, accelerator: 'Ctrl+Alt+Space' });
    gs.press('Ctrl+Alt+Space');
    check('开启：注册成功并能触发', r1.registered && c.current() === 'Ctrl+Alt+Space' && hits === 1, JSON.stringify(r1));
    const r2 = c.apply({ enabled: true, accelerator: 'Ctrl+Shift+K' });
    check('换成被占用的键：报 E_SHORTCUT_TAKEN', !r2.registered && r2.error === 'E_SHORTCUT_TAKEN', JSON.stringify(r2));
    check('换键失败时旧键仍然注册着（先注册新的、成功才注销旧的）',
      c.current() === 'Ctrl+Alt+Space' && gs.isRegistered('Ctrl+Alt+Space'), gs.registeredKeys().join(','));
    const r3 = c.apply({ enabled: true, accelerator: 'Ctrl+Alt+J' });
    check('换成空闲的键：新键注册、旧键注销',
      r3.registered && gs.registeredKeys().join(',') === 'Ctrl+Alt+J', gs.registeredKeys().join(','));
    const before = gs.calls.register;
    c.apply({ enabled: true, accelerator: 'Ctrl+Alt+J' });
    check('重复应用同一个键不会注销重注册', gs.calls.register === before);
    c.apply({ enabled: false, accelerator: 'Ctrl+Alt+J' });
    check('关闭：立即注销', gs.registeredKeys().length === 0 && c.current() === null);
    c.apply({ enabled: true, accelerator: 'Ctrl+Alt+J' });
    c.unregisterAll();
    check('unregisterAll 清空注册', gs.registeredKeys().length === 0 && c.current() === null && gs.calls.unregisterAll === 1);
  }
  {
    // register 返回 true 但系统里其实没注册上：只信返回值就会显示"已生效"、按了没反应
    const liar = { register: () => true, unregister() {}, unregisterAll() {}, isRegistered: () => false };
    const c = Q.createShortcutController({ globalShortcut: liar, onTrigger() {} });
    const r = c.apply({ enabled: true, accelerator: 'Ctrl+Alt+Space' });
    check('注册结果要 isRegistered 二次确认，不只信 register 的返回值', !r.registered && c.current() === null, JSON.stringify(r));
    const thrower = { register() { throw new Error('bad accelerator'); }, unregister() {}, unregisterAll() {}, isRegistered: () => false };
    const c2 = Q.createShortcutController({ globalShortcut: thrower, onTrigger() {} });
    let threw = false;
    let r2 = null;
    try { r2 = c2.apply({ enabled: true, accelerator: 'Ctrl+Alt+Space' }); } catch { threw = true; }
    check('register 抛异常时当成注册失败，不往外抛', !threw && r2 && !r2.registered);
  }

  // ---- 设置变更：先注册、成功才落盘；落盘失败回滚 ----
  const mk = (cfg, taken) => {
    const gs = Q.createFakeGlobalShortcut({ taken: taken || [] });
    const controller = Q.createShortcutController({ globalShortcut: gs, onTrigger() {} });
    const store = memStore(cfg);
    const deps = { controller, loadConfig: store.loadConfig, updateConfig: store.updateConfig, appError };
    return { gs, controller, store, deps };
  };
  const tryApply = async (deps, patch) => {
    try { return { status: await Q.applySettingsChange(deps, patch) }; } catch (e) { return { error: e }; }
  };
  {
    const { gs, store, deps } = mk({});
    const r = await tryApply(deps, { enabled: true });
    check('打开开关：注册默认键并写进配置',
      r.status && r.status.registered && gs.registeredKeys().join(',') === 'Ctrl+Alt+Space' && store.data().quickLaunchEnabled === true,
      JSON.stringify(r.status || String(r.error)));
  }
  {
    const { gs, store, deps } = mk({}, ['Ctrl+Alt+Space']);
    const r = await tryApply(deps, { enabled: true });
    check('键被占用：抛 E_SHORTCUT_TAKEN', r.error && /E_SHORTCUT_TAKEN\|Ctrl\+Alt\+Space/.test(r.error.message), String(r.error));
    check('键被占用：配置不写（否则每次启动都会失败一次）', store.writes === 0 && store.data().quickLaunchEnabled !== true, JSON.stringify(store.data()));
    check('键被占用：没有残留注册', gs.registeredKeys().length === 0);
  }
  {
    const { gs, store, deps } = mk({});
    store.failWrite = true;
    const r = await tryApply(deps, { enabled: true });
    check('打开开关时配置写失败：抛 E_CONFIG_WRITE', r.error && /E_CONFIG_WRITE/.test(r.error.message), String(r.error));
    check('打开开关时配置写失败：注册回滚（会话里生效、磁盘上没有，重启后会悄悄变回去）', gs.registeredKeys().length === 0, gs.registeredKeys().join(','));
  }
  {
    const { gs, controller, store, deps } = mk({ quickLaunchEnabled: true, quickLaunchShortcut: 'Ctrl+Alt+Space' });
    controller.apply({ enabled: true, accelerator: 'Ctrl+Alt+Space' });
    store.failWrite = true;
    const r = await tryApply(deps, { shortcut: 'Ctrl+Alt+J' });
    check('换键时配置写失败：回到旧键（新键注销、旧键重新注册）',
      r.error && gs.registeredKeys().join(',') === 'Ctrl+Alt+Space', gs.registeredKeys().join(','));
  }
  {
    const { gs, store, deps } = mk({});
    const r = await tryApply(deps, { enabled: true, shortcut: 'Ctrl+K' });
    check('格式不对：抛 E_SHORTCUT_INVALID，不注册不落盘',
      r.error && /E_SHORTCUT_INVALID\|Ctrl\+K/.test(r.error.message) && gs.calls.register === 0 && store.writes === 0, String(r.error));
  }
  {
    const { gs, store, deps } = mk({ quickLaunchEnabled: true, quickLaunchShortcut: 'garbage' });
    const r = await tryApply(deps, { enabled: false });
    check('配置里的键是坏的也能关掉开关', r.status && r.status.enabled === false && store.data().quickLaunchEnabled === false && gs.calls.register === 0,
      JSON.stringify(r.status || String(r.error)));
  }
  {
    const { deps } = mk({});
    const r = await tryApply(deps, { enabled: true, shortcut: 'alt+ctrl+j' });
    check('改键：存的是规范化后的写法', r.status && r.status.shortcut === 'Ctrl+Alt+J', JSON.stringify(r.status || String(r.error)));
  }

  // ---- 状态 ----
  {
    const gs = Q.createFakeGlobalShortcut();
    const c = Q.createShortcutController({ globalShortcut: gs, onTrigger() {} });
    c.apply({ enabled: true, accelerator: 'Ctrl+Alt+Space' });
    const s = Q.statusOf(c, { quickLaunchEnabled: true, quickLaunchShortcut: 'Ctrl+Alt+J' });
    check('状态以"注册着的键 == 配置里的键"为准（注册着别的键不算已生效）', s.registered === false && s.error === 'E_SHORTCUT_TAKEN', JSON.stringify(s));
  }

  // ---- 居中 ----
  {
    const b = Q.centerBounds({ x: -1920, y: 0, width: 1920, height: 1040 }, { width: 640, height: 420 });
    check('居中：副屏在主屏左边（x 为负）', b.x === -1280 && b.y === 310 && b.width === 640, JSON.stringify(b));
    const t = Q.centerBounds({ x: 0, y: 40, width: 1920, height: 1040 }, { width: 640, height: 420 });
    check('居中：任务栏在顶部（工作区 y 不是 0）', t.x === 640 && t.y === 350, JSON.stringify(t));
    const s = Q.centerBounds({ x: 0, y: 0, width: 600, height: 400 }, { width: 640, height: 420 });
    check('居中：工作区放不下时夹到工作区', s.width === 600 && s.height === 400 && s.x === 0 && s.y === 0, JSON.stringify(s));
  }
  return out;
}

(async () => {
  const results = await runChecks(real);
  let failed = 0;
  for (const [name, pass, detail] of results) {
    console.log('[test:quick-launch-logic] ' + (pass ? 'PASS ' : 'FAIL ') + name + (!pass && detail ? ' → ' + detail : ''));
    if (!pass) failed++;
  }

  console.log('\n[test:quick-launch-logic] --- 反向对照：朴素实现必须红 ---');
  const naive = await runChecks(legacy);
  const red = naive.filter(([, pass]) => !pass).map(([n]) => n);
  for (const n of red) console.log('  红：' + n);
  // 指定必须红的那几条：每一条对应朴素实现里的一处"自然写法"。
  // 只要求"红够多少条"不够——红的可能全是规范化那一批，而回滚、换键顺序这些最要紧的
  // 断言仍然是空的。
  const mustRed = [
    '规范化："ctrl+alt+space" → Ctrl+Alt+Space',
    '拒绝："Ctrl+K"（needs-modifier）',
    '拒绝："Alt+Space"（reserved）',
    '全新配置：默认关闭、组合键取默认值',
    '配置里的组合键不合法时标成 invalid，不静默换成默认键',
    '换键失败时旧键仍然注册着（先注册新的、成功才注销旧的）',
    '重复应用同一个键不会注销重注册',
    '注册结果要 isRegistered 二次确认，不只信 register 的返回值',
    '键被占用：配置不写（否则每次启动都会失败一次）',
    '格式不对：抛 E_SHORTCUT_INVALID，不注册不落盘',
    '状态以"注册着的键 == 配置里的键"为准（注册着别的键不算已生效）',
    '居中：副屏在主屏左边（x 为负）',
    '居中：工作区放不下时夹到工作区'
  ];
  const known = new Set(results.map(([n]) => n));
  const typo = mustRed.filter(n => !known.has(n));
  if (typo.length) console.error('[test:quick-launch-logic] FAIL 反向对照点名的断言不存在（改名后没同步）：\n      ' + typo.join('\n      '));
  const notRed = mustRed.filter(n => known.has(n) && !red.includes(n));
  if (notRed.length) {
    console.error('[test:quick-launch-logic] FAIL 这几条在朴素实现下竟然也绿，属于空断言：\n      ' + notRed.join('\n      '));
  }
  // 第二份对照：回滚那两条在上面的朴素实现下是绿的——它先落盘，写失败就直接抛了，
  // 根本没走到注册，于是"没有残留注册"碰巧成立。这正是 CONTRIBUTING 说的
  // "构造的失败场景本身也要验证"。真正要分辨的是"先注册、再落盘、但不回滚"
  // 这个修了一半的版本：顺序对了，落盘失败时新键留在系统里。
  const noRollback = {
    ...real,
    async applySettingsChange({ controller, loadConfig, updateConfig, appError: ae }, patch) {
      const cur = real.resolveSettings(await loadConfig());
      const n = patch.shortcut != null ? real.normalizeAccelerator(patch.shortcut) : null;
      if (n && !n.ok) throw ae('E_SHORTCUT_INVALID', String(patch.shortcut));
      const accelerator = n ? n.accelerator : cur.accelerator;
      const enabled = patch.enabled == null ? cur.enabled : patch.enabled === true;
      const res = controller.apply({ enabled, accelerator });
      if (enabled && !res.registered) throw ae('E_SHORTCUT_TAKEN', accelerator);
      await updateConfig({ quickLaunchEnabled: enabled, ...(n ? { quickLaunchShortcut: accelerator } : {}) });
      return real.statusOf(controller, await loadConfig());
    }
  };
  const red2 = (await runChecks(noRollback)).filter(([, pass]) => !pass).map(([n]) => n);
  const mustRed2 = [
    '打开开关时配置写失败：注册回滚（会话里生效、磁盘上没有，重启后会悄悄变回去）',
    '换键时配置写失败：回到旧键（新键注销、旧键重新注册）'
  ];
  console.log('\n[test:quick-launch-logic] --- 反向对照二：先注册再落盘但不回滚，必须红 ---');
  for (const n of red2) console.log('  红：' + n);
  const notRed2 = mustRed2.filter(n => !red2.includes(n));
  if (notRed2.length) {
    console.error('[test:quick-launch-logic] FAIL 回滚断言分辨不出"不回滚"的实现，属于空断言：\n      ' + notRed2.join('\n      '));
  }
  // 第二份对照只该红回滚那两条；红了别的说明它和真实模块的差异不止"不回滚"，对照就不干净了
  const extra2 = red2.filter(n => !mustRed2.includes(n));
  if (extra2.length) console.error('[test:quick-launch-logic] FAIL 反向对照二红了回滚以外的断言（对照不干净）：\n      ' + extra2.join('\n      '));
  const passed = failed === 0 && typo.length === 0 && notRed.length === 0 && notRed2.length === 0 && extra2.length === 0;
  console.log('\n[test:quick-launch-logic] ' + (passed ? '通过' : '失败')
    + '（共 ' + results.length + ' 条，真实模块失败 ' + failed + ' 条，反向对照红 ' + red.length + ' 条）');
  process.exit(passed ? 0 : 1);
})();
