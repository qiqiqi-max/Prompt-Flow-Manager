// tests/sandbox.test.js
// lib/sandbox-state.js 的单测。不启动 Electron：那个模块刻意不 require('electron')
// （目录由调用方传进来、时间由 now 参数注入），就是为了能在这里用裸 node 跑，
// 而且能把"七天后重试"这种跨周的时间线在几毫秒内走完。
//
// 为什么这一层必须有：沙箱降级是**持久的、自动的、界面上完全看不见的**。
// 判断错一次，用户就在无沙箱模式下跑到下次七天冷静期，而他没有任何办法察觉。
// 而真正的失败场景（缺 VC++ 运行库的机器上渲染进程起不来）在 CI 里根本造不出来，
// 所以状态机的每一条分支只能在这里验。
//
// 反向对照做进测试自身，形状照 tests/logger.test.js：
// 同一批断言先跑真实实现，再跑一组**故意退化**的桩，要求桩必须失败。
// 桩的三处退化正对应这个状态机存在的三个理由：
//   1. 一次没确认就降级          → "单次未确认不降级"那组必须变红
//   2. 降级之后永不重试          → "冷静期满重试"那组必须变红
//   3. 确认之后不清 strike/标记  → "确认后清账"那组必须变红
//
// 所有落盘都在 os.tmpdir() 下的 mkdtemp 目录里，绝不碰真实数据目录。
// 运行：npm run test:sandbox（或 node tests/sandbox.test.js）
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandboxState = require('../lib/sandbox-state');
const diagnostics = require('../lib/diagnostics');

const tmpDirs = [];
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-sandbox-test-'));
  tmpDirs.push(d);
  return d;
}
function cleanup() {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 留着也无害，在 tmp 里 */ }
  }
}

const DAY = 24 * 60 * 60 * 1000;

// ---------- 反向对照用的桩 ----------
// 它不是"旧版实现"——这个模块没有旧版。它扮演的是"如果这三条尺度都没写会怎样"：
// 一次失败就降级、降级就是终身、确认了也不清账。每一条都是真实可能被写出来的
// 简化版本，而每一条都会造成一类具体的用户伤害（见文件头）。
function makeStub() {
  const real = sandboxState;
  return {
    ...real,
    decide(opts) {
      const o = opts || {};
      const state = o.state || real.defaultState();
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
      // 退化 2：降级是终身的，冷静期不存在。
      if (state.mode === real.MODE_OFF) {
        return { sandbox: false, reason: state.reason || 'degraded', nextState: state, changed: false };
      }
      // 退化 1：一次没确认就直接降级，不给第二次机会。
      if (state.pending) {
        return {
          sandbox: false,
          reason: 'renderer-unconfirmed',
          nextState: { ...state, mode: real.MODE_OFF, reason: 'renderer-unconfirmed', strikes: 1, pending: null, degradedAt: iso },
          changed: true
        };
      }
      return { sandbox: true, reason: 'default-on', nextState: state, changed: false };
    },
    // 退化 3：确认了只清标记，不清 strike，也不记 lastConfirmedAt。
    // 形参保持和真实 confirm(dir, state, now) 同形（调用方按位置传第三个参数），
    // 但这里故意不用它——不记 lastConfirmedAt 正是这处退化的内容。
    // 下划线前缀是 eslint 的 argsIgnorePattern 要求，不是命名习惯。
    confirm(dir, state, _now) {
      const next = { ...state, pending: null };
      const res = real.write(dir, next);
      return { state: next, ...res };
    }
  };
}

// 第二组对照：**改动之前的行为**——无条件关闭沙箱。
//
// 为什么非要单独有这一组：上面那个桩在"默认开启沙箱"这一节是绿的（它也默认开），
// 于是本次改动最核心的那句主张恰好没有任何对照证明它有分辨力。而"无条件关闭"
// 正是这次改之前 electron-main.js 里那一行 appendSwitch('no-sandbox') 的语义，
// 是唯一真实存在过的旧实现。它必须让"默认开启"和"冷静期满重试"变红。
function makeAlwaysOffStub() {
  const real = sandboxState;
  return {
    ...real,
    decide(opts) {
      const o = opts || {};
      const state = o.state || real.defaultState();
      const env = o.env || {};
      const forced = String(env.PFM_SANDBOX || '').toLowerCase();
      // 环境变量那一节照旧走真实语义，这样它能留在 mustStayGreen 里，
      // 失败分布才说明问题出在"默认值"而不是整个模块都瘫了。
      if (forced === 'on' || forced === '1') {
        return { sandbox: true, reason: 'env-forced-on', nextState: state, changed: false };
      }
      if (forced === 'off' || forced === '0') {
        return { sandbox: false, reason: 'env-forced-off', nextState: state, changed: false };
      }
      return { sandbox: false, reason: 'degraded', nextState: state, changed: false };
    }
  };
}

// ---------- 断言收集 ----------
// 每个 section 返回 [名字, [[通过?, 说明], ...]]，主流程再统一打印。
// 这样同一批 section 能对真实实现和桩各跑一遍，直接比对失败分布。
function runSections(impl) {
  const out = [];
  const section = (name, fn) => {
    const local = [];
    const ok = (pass, msg) => local.push([!!pass, msg]);
    try {
      fn(ok);
    } catch (e) {
      local.push([false, '抛出异常：' + (e && e.stack ? e.stack : e)]);
    }
    out.push([name, local]);
  };

  section('默认开启沙箱', (ok) => {
    const d = impl.decide({ state: impl.defaultState(), env: {}, now: Date.now() });
    ok(d.sandbox === true, '干净状态下沙箱是开的：' + JSON.stringify(d.sandbox));
    ok(d.changed === false, '干净状态不需要写盘（避免每次启动都写一次）');
    // 这条盯的是"默认值来自代码而不是磁盘"：状态文件不存在时也必须开。
    const dir = mkTmp();
    const fresh = impl.decide({ state: impl.read(dir), env: {}, now: Date.now() });
    ok(fresh.sandbox === true, '状态文件不存在时也默认开启');
  });

  section('单次未确认不降级，只记一次', (ok) => {
    const dir = mkTmp();
    const t0 = Date.now();
    // 模拟：上一次启动按了标记，但渲染进程没确认（kill -9 / 断电 / 任务管理器）。
    impl.write(dir, { ...impl.defaultState(), pending: { at: new Date(t0 - 1000).toISOString(), mode: impl.MODE_ON } });
    const d = impl.decide({ state: impl.read(dir), env: {}, now: t0 });
    ok(d.sandbox === true, '一次没确认仍然开着沙箱（一次断电不该永久关掉隔离）：' + d.sandbox);
    ok(d.reason === 'retry-after-unconfirmed', '理由记成 retry-after-unconfirmed：' + d.reason);
    ok(d.nextState.strikes === 1, 'strike 累加到 1：' + d.nextState.strikes);
    ok(d.nextState.mode === impl.MODE_ON, '模式还没降级：' + d.nextState.mode);
    ok(d.nextState.pending === null, '旧标记已消费掉（否则同一次失败会被重复计数）');
  });

  section('连续两次未确认才降级', (ok) => {
    const dir = mkTmp();
    const t0 = Date.now();
    // 第一次未确认之后的状态：strikes=1、mode 仍是 sandbox。
    // 现在再来一次未确认。
    impl.write(dir, {
      ...impl.defaultState(),
      strikes: 1,
      pending: { at: new Date(t0 - 1000).toISOString(), mode: impl.MODE_ON }
    });
    const d = impl.decide({ state: impl.read(dir), env: {}, now: t0 });
    ok(d.sandbox === false, '第二次未确认后这一次关掉沙箱：' + d.sandbox);
    ok(d.nextState.mode === impl.MODE_OFF, '状态落到 no-sandbox：' + d.nextState.mode);
    ok(d.reason === 'renderer-unconfirmed', '理由是 renderer-unconfirmed：' + d.reason);
    ok(typeof d.nextState.degradedAt === 'string' && d.nextState.degradedAt.length > 0,
      '记下降级时刻（冷静期要靠它计算）：' + d.nextState.degradedAt);
    ok(d.changed === true, '这次结论必须落盘');
  });

  section('降级期内保持关闭', (ok) => {
    const dir = mkTmp();
    const t0 = Date.now();
    impl.write(dir, {
      ...impl.defaultState(),
      mode: impl.MODE_OFF, reason: 'renderer-unconfirmed', strikes: 2,
      degradedAt: new Date(t0 - 1 * DAY).toISOString()
    });
    const d = impl.decide({ state: impl.read(dir), env: {}, now: t0 });
    ok(d.sandbox === false, '降级一天后仍然关着（不要每次启动都拿用户当试验品）：' + d.sandbox);
    ok(d.changed === false, '不需要写盘');
  });

  section('冷静期满自动重试沙箱', (ok) => {
    const dir = mkTmp();
    const t0 = Date.now();
    impl.write(dir, {
      ...impl.defaultState(),
      mode: impl.MODE_OFF, reason: 'renderer-unconfirmed', strikes: 2,
      degradedAt: new Date(t0 - 8 * DAY).toISOString()
    });
    const d = impl.decide({ state: impl.read(dir), env: {}, now: t0 });
    ok(d.sandbox === true, '八天后重新试一次沙箱（用户可能已经装上运行库）：' + d.sandbox);
    ok(d.reason === 'retry-after-degrade', '理由是 retry-after-degrade：' + d.reason);
    ok(d.nextState.mode === impl.MODE_ON, '状态回到 sandbox：' + d.nextState.mode);
    ok(d.nextState.strikes === 0, 'strike 归零，重新走两次判定：' + d.nextState.strikes);
    ok(d.nextState.degradedAt === null, '清掉降级时刻');
    // 边界：正好差一毫秒不该重试。这条防的是把 >= 写成 > 之外的方向性错误。
    impl.write(dir, {
      ...impl.defaultState(),
      mode: impl.MODE_OFF, reason: 'renderer-unconfirmed', strikes: 2,
      degradedAt: new Date(t0 - impl.RETRY_AFTER_MS + 1).toISOString()
    });
    const edge = impl.decide({ state: impl.read(dir), env: {}, now: t0 });
    ok(edge.sandbox === false, '差一毫秒不到期时不重试：' + edge.sandbox);
  });

  section('确认后清账', (ok) => {
    const dir = mkTmp();
    const t0 = Date.now();
    const base = { ...impl.defaultState(), strikes: 1 };
    const marked = impl.markAttempt(dir, base, t0);
    ok(marked.ok === true, 'markAttempt 落盘成功');
    ok(marked.state.pending && marked.state.pending.at, '标记写进去了：' + JSON.stringify(marked.state.pending));
    const onDisk = impl.read(dir);
    ok(!!(onDisk.pending && onDisk.pending.at), '标记真的在磁盘上（不是只在内存里）');

    const confirmed = impl.confirm(dir, marked.state, t0 + 100);
    ok(confirmed.state.pending === null, '确认后标记清掉');
    ok(confirmed.state.strikes === 0, '确认后 strike 归零（这是"沙箱在这台机器上能用"的唯一凭据）：'
      + confirmed.state.strikes);
    ok(typeof confirmed.state.lastConfirmedAt === 'string', '记下确认时刻：' + confirmed.state.lastConfirmedAt);
    const after = impl.read(dir);
    ok(after.pending === null && after.strikes === 0, '清账结果落到了磁盘');
    // 关键：清账之后下一次启动必须是干净的"开着"，而不是又累一个 strike。
    const next = impl.decide({ state: after, env: {}, now: t0 + 200 });
    ok(next.sandbox === true && next.nextState.strikes === 0,
      '确认过之后下次启动不再累加 strike：' + JSON.stringify({ s: next.sandbox, k: next.nextState.strikes }));
  });

  section('当场降级（渲染进程在确认前就没了）', (ok) => {
    const dir = mkTmp();
    const t0 = Date.now();
    const marked = impl.markAttempt(dir, impl.defaultState(), t0);
    const res = impl.degrade(dir, marked.state, 'renderer-gone', t0 + 50);
    ok(res.ok === true, 'degrade 落盘成功');
    ok(res.state.mode === impl.MODE_OFF, '状态是 no-sandbox：' + res.state.mode);
    ok(res.state.pending === null, '标记清掉（否则下次启动会再累一个 strike）');
    const d = impl.decide({ state: impl.read(dir), env: {}, now: t0 + 100 });
    ok(d.sandbox === false, '下一次启动读到的就是关闭：' + d.sandbox);
    ok(d.reason === 'renderer-gone', '理由传下去了（诊断包要显示它）：' + d.reason);
  });

  section('环境变量强制覆盖且不写盘', (ok) => {
    const dir = mkTmp();
    const t0 = Date.now();
    // 磁盘上是已降级状态，PFM_SANDBOX=on 必须能强行打开。
    impl.write(dir, {
      ...impl.defaultState(),
      mode: impl.MODE_OFF, reason: 'renderer-unconfirmed', strikes: 2,
      degradedAt: new Date(t0).toISOString()
    });
    const on = impl.decide({ state: impl.read(dir), env: { PFM_SANDBOX: 'on' }, now: t0 });
    ok(on.sandbox === true, 'PFM_SANDBOX=on 覆盖磁盘上的降级状态：' + on.sandbox);
    ok(on.changed === false, '覆盖不写盘（临时手段不该污染自动判断的历史）');
    ok(on.reason === 'env-forced-on', '理由标明是环境变量：' + on.reason);

    const off = impl.decide({ state: impl.defaultState(), env: { PFM_SANDBOX: 'off' }, now: t0 });
    ok(off.sandbox === false, 'PFM_SANDBOX=off 能关：' + off.sandbox);
    ok(off.changed === false, '关也不写盘');
    // 磁盘状态没被这两次覆盖改写。
    const still = impl.read(dir);
    ok(still.mode === impl.MODE_OFF && still.strikes === 2, '磁盘状态没被环境变量改动');
  });

  section('坏状态文件退化成默认（安全的那一侧）', (ok) => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, sandboxState.STATE_FILE), '{ 这不是 JSON', 'utf8');
    const s = impl.read(dir);
    ok(s.mode === impl.MODE_ON, '解析失败时当作沙箱开着：' + s.mode);
    ok(s.strikes === 0 && s.pending === null, '其余字段回落默认值');

    // pending 写坏成 true / 字符串时不能当成"上次没确认"——那会凭一个形状不对的值降级。
    fs.writeFileSync(path.join(dir, sandboxState.STATE_FILE),
      JSON.stringify({ schema: 1, mode: 'sandbox', pending: true, strikes: 1 }), 'utf8');
    const bad = impl.read(dir);
    ok(bad.pending === null, 'pending 形状不对时当作没有：' + JSON.stringify(bad.pending));
    const d = impl.decide({ state: bad, env: {}, now: Date.now() });
    ok(d.sandbox === true && d.nextState.strikes === 1, '不因为坏 pending 而降级：' + JSON.stringify(d.nextState));

    // mode 写成别的字符串时只认 no-sandbox，其余一律当开着。
    fs.writeFileSync(path.join(dir, sandboxState.STATE_FILE),
      JSON.stringify({ schema: 1, mode: 'whatever' }), 'utf8');
    ok(impl.read(dir).mode === impl.MODE_ON, '未知 mode 当作开着');
    // strikes 被写成负数/NaN 时不能变成"永远差一次才降级"或直接降级。
    fs.writeFileSync(path.join(dir, sandboxState.STATE_FILE),
      JSON.stringify({ schema: 1, mode: 'sandbox', strikes: -5 }), 'utf8');
    ok(impl.read(dir).strikes === 0, '负数 strikes 归零：' + impl.read(dir).strikes);
  });

  section('写盘失败只报告，不抛', (ok) => {
    // 目录不存在且父路径是个文件 → mkdir 必失败。
    const dir = mkTmp();
    const blocked = path.join(dir, 'a-file', 'nested');
    fs.writeFileSync(path.join(dir, 'a-file'), 'x', 'utf8');
    let threw = false;
    let res = null;
    try {
      res = impl.write(blocked, impl.defaultState());
    } catch {
      threw = true;
    }
    ok(!threw, '写不进去不抛异常（状态记不住不是启动失败）');
    ok(res && res.ok === false, '返回 ok:false');
    ok(res && typeof res.error === 'string' && res.error.length > 0, '带上错误原因：' + (res && res.error));
    // 读同样不能抛。
    let readThrew = false;
    try { impl.read(blocked); } catch { readThrew = true; }
    ok(!readThrew, '读不到也不抛');
  });

  section('状态文件不留临时残留', (ok) => {
    const dir = mkTmp();
    impl.write(dir, impl.defaultState());
    const names = fs.readdirSync(dir);
    ok(names.includes(sandboxState.STATE_FILE), '状态文件建出来了：' + names.join(', '));
    ok(!names.some(n => n.endsWith('.tmp')), '没有留下 .tmp 残留：' + names.join(', '));
    // 关键：临时名不能落进启动自愈的清理规则里，否则自愈会把它当残留删掉，
    // 或者反过来——把正在写的状态文件当成半截原子写。
    const TMP_PART_RE = /^\.tmp-\d+-\d+-.*\.part$/;
    ok(!names.some(n => TMP_PART_RE.test(n)), '临时名不符合 writeFileAtomic 的 .part 形态（自愈不会来动它）');
  });

  return out;
}

// ---------- 诊断包里的沙箱字段 ----------
// 这一节不进反向对照：它验的是 diagnostics 的脱敏，不是状态机的判断。
function runDiagnosticsSection() {
  const local = [];
  const ok = (pass, msg) => local.push([!!pass, msg]);
  try {
    const s = diagnostics.sanitizeSandbox({
      enabled: false, reason: 'renderer-unconfirmed', strikes: 2,
      degradedAt: '2026-01-01T00:00:00.000Z', lastConfirmedAt: null, confirmedThisRun: false
    });
    ok(s.enabled === false, 'enabled 原样带出：' + s.enabled);
    ok(s.reason === 'renderer-unconfirmed', '已知理由原样保留：' + s.reason);
    ok(s.strikes === 2, 'strikes 带出：' + s.strikes);
    ok(s.degradedAt === '2026-01-01T00:00:00.000Z', '降级时刻带出');

    // 白名单：未来有人把 reason 改成拼接 error.message，那里面会带路径和文件名。
    // 诊断包是要贴给别人看的，这是唯一挡住那次改动的地方。
    const leaky = diagnostics.sanitizeSandbox({
      enabled: false,
      reason: 'renderer-gone: 加载 D:\\用户\\提示词库\\银行需求.md 失败'
    });
    ok(leaky.reason === 'other', '未知理由被压成 other，不泄露拼接进去的内容：' + leaky.reason);
    ok(!JSON.stringify(leaky).includes('银行需求'), '整个对象里不含文件名');
    ok(!JSON.stringify(leaky).includes('D:\\'), '整个对象里不含路径');

    ok(diagnostics.sanitizeSandbox(null) === null, '没有沙箱信息时给 null');
    ok(diagnostics.sanitizeSandbox('sandbox') === null, '形状不对时给 null');
    const partial = diagnostics.sanitizeSandbox({ enabled: true });
    ok(partial.strikes === 0 && partial.degradedAt === null, '缺字段时形状仍然固定：' + JSON.stringify(partial));

    // collect() 必须把它挂上去，否则前面这些脱敏都到不了诊断包里。
    const root = mkTmp();
    const got = diagnostics.collect({
      dataRoot: root, codeRoot: root,
      sandbox: { enabled: true, reason: 'default-on', strikes: 0 }
    });
    ok(got.sandbox && got.sandbox.enabled === true, 'collect() 的结果里有 sandbox 段：' + JSON.stringify(got.sandbox));
    ok(got.sandbox.reason === 'default-on', 'collect() 带出理由：' + got.sandbox.reason);
  } catch (e) {
    local.push([false, '抛出异常：' + (e && e.stack ? e.stack : e)]);
  }
  return [['诊断包里的沙箱字段', local]];
}

function countFails(results) {
  let n = 0;
  for (const [, local] of results) for (const [ok] of local) if (!ok) n++;
  return n;
}

(async () => {
  console.log('[test:sandbox] lib/sandbox-state.js');

  const real = runSections(sandboxState);
  const diag = runDiagnosticsSection();
  for (const [name, local] of real.concat(diag)) {
    console.log('[test:sandbox] ' + name);
    for (const [pass, msg] of local) console.log('  ' + (pass ? 'PASS ' : 'FAIL ') + msg);
  }
  const realFails = countFails(real) + countFails(diag);

  // 反向对照：一次就降级 / 降级即终身 / 确认不清账的桩必须跑不过上面那批断言。
  const stub = runSections(makeStub());
  const stubFails = countFails(stub);
  const stubSections = stub.filter(([, l]) => l.some(([pass]) => !pass)).length;
  console.log('[test:sandbox] 反向对照（一次即降级/降级终身/确认不清账的桩）失败 '
    + stubFails + ' 项，覆盖 ' + stubSections + '/' + stub.length + ' 个 section');
  for (const [name, local] of stub) {
    const bad = local.filter(([pass]) => !pass);
    if (bad.length) console.log('  控制组失败 → ' + name + '：' + bad.map(([, m]) => m).join(' / '));
  }

  // 逐项点名：光看总数不够。三处退化各自对应的那一组都必须变红，
  // 否则某一组可能是恒真断言，被别组的失败数掩盖（CONTRIBUTING.md 的推论二）。
  const stubMap = new Map(stub.map(([name, local]) => [name, local]));
  const mustGoRed = [
    '单次未确认不降级，只记一次',
    '冷静期满自动重试沙箱',
    '确认后清账'
  ];
  const notRed = mustGoRed.filter(n => {
    const l = stubMap.get(n);
    return !l || !l.some(([pass]) => !pass);
  });
  if (notRed.length) {
    console.error('[test:sandbox] FAIL 这些 section 在控制组里居然全绿，对应断言无分辨力: '
      + notRed.join(' | '));
  }

  // 反过来也要点名：桩没退化的部分必须**保持绿**。
  // 若连"默认开启"和"环境变量覆盖"都跟着变红，说明这批断言在测别的东西
  // （比如共享的临时目录状态），失败分布就没有解释力了。
  const mustStayGreen = ['默认开启沙箱', '环境变量强制覆盖且不写盘', '写盘失败只报告，不抛'];
  const wrongRed = mustStayGreen.filter(n => {
    const l = stubMap.get(n);
    return l && l.some(([pass]) => !pass);
  });
  if (wrongRed.length) {
    console.error('[test:sandbox] FAIL 控制组里这些 section 也红了，说明断言串味了: ' + wrongRed.join(' | '));
  }

  if (stubFails === 0) {
    console.error('[test:sandbox] FAIL 反向对照全绿：这批断言分辨不出"一次就降级/永不重试"，测试无效');
  }

  // 第二组对照：改动之前的行为（无条件关沙箱）。上面那个桩默认也是开的，
  // 所以"默认开启沙箱"那一节在它上面是绿的——本次改动最核心的主张缺对照。
  const off = runSections(makeAlwaysOffStub());
  const offFails = countFails(off);
  const offMap = new Map(off.map(([name, local]) => [name, local]));
  const offMustGoRed = ['默认开启沙箱', '冷静期满自动重试沙箱'];
  const offNotRed = offMustGoRed.filter(n => {
    const l = offMap.get(n);
    return !l || !l.some(([pass]) => !pass);
  });
  console.log('[test:sandbox] 反向对照二（改动前的无条件关闭）失败 ' + offFails + ' 项；'
    + offMustGoRed.map(n => '"' + n + '"' + (offNotRed.includes(n) ? '未变红' : '已变红')).join('，'));
  for (const [name, local] of off) {
    const bad = local.filter(([pass]) => !pass);
    if (bad.length) console.log('  控制组二失败 → ' + name + '：' + bad.map(([, m]) => m).join(' / '));
  }
  if (offNotRed.length) {
    console.error('[test:sandbox] FAIL 无条件关闭沙箱时这些 section 仍是绿的，'
      + '说明"默认开启"这条主张没有断言在盯: ' + offNotRed.join(' | '));
  }
  // 环境变量那一节在这个桩里保留了真实语义，必须仍然全绿——
  // 否则说明失败是整个模块被换坏了，而不是默认值变了。
  const offEnv = offMap.get('环境变量强制覆盖且不写盘');
  const offEnvGreen = !!(offEnv && offEnv.every(([pass]) => pass));
  if (!offEnvGreen) {
    console.error('[test:sandbox] FAIL 控制组二把环境变量那节也弄红了，失败分布没有解释力');
  }

  const controlOk = stubFails > 0 && notRed.length === 0 && wrongRed.length === 0
    && offFails > 0 && offNotRed.length === 0 && offEnvGreen;

  cleanup();
  const leftovers = tmpDirs.filter(d => fs.existsSync(d));
  if (leftovers.length) console.log('[test:sandbox] 注意：临时目录未清净 ' + leftovers.length + ' 个');

  const passed = realFails === 0 && controlOk;
  console.log('\n[test:sandbox] ' + (passed ? '通过' : '失败')
    + '（真实实现失败 ' + realFails + ' 项，控制组失败 ' + stubFails + ' 项）');
  process.exit(passed ? 0 : 1);
})();
