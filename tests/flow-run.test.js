// tests/flow-run.test.js
// 回归测试：src/flow-run.js 的执行状态机（开始 / 候选下一步 / 完成 / 跳过 / 回退）
// 与持久化数据（config.flowRuns）的校验修复。
//
// 反向对照在文件末尾：同一批关键用例拿三份"看起来也说得通"的朴素实现跑一遍，
// 每份都必须在它对应的用例上判错 —— 它们证明的是这批断言分辨得出规则写没写对：
//   1. 候选 = 上一步的 next 原样（不看汇合点）：分支走完一条就进了汇合点
//   2. 汇合点要等**所有**前驱（不区分回边）：环里的步骤互等，执行提前结束
//   3. 进度原样信任（{...raw}）：删掉的步骤 id 留在进度里，原型键照单全收
//
// 运行：npm run test:flow-run
const path = require('path');
const root = path.resolve(__dirname, '..');
const FLOW_GRAPH = require(path.join(root, 'src', 'flow-graph.js'));
const FLOW_RUN = require(path.join(root, 'src', 'flow-run.js'));

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:flow-run] PASS ' + msg);
  else { failures++; console.error('[test:flow-run] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};
const step = (id, next) => ({ id, prompt: 'prompts/' + id + '.md', label: id, next: next || [] });
const graphOf = (steps) => FLOW_GRAPH.analyze(steps);
const J = (v) => JSON.stringify(v);

// 分支汇合：仓库里 workflows/branch-flow-example.md 就是这个形状
const BRANCH = () => graphOf([step('a', ['b', 'c']), step('b', ['d']), step('c', ['d']), step('d', [])]);

// ---------- 一、线性 ----------
{
  const g = graphOf([step('a', ['b']), step('b', ['c']), step('c', [])]);
  let r = FLOW_RUN.start(g);
  ok(r.current === 'a', '线性流程从入口开始', J(r));
  r = FLOW_RUN.complete(g, r);
  ok(r.current === 'b' && J(r.done) === '["a"]', 'next 只有一个时完成后直接前进', J(r));
  r = FLOW_RUN.complete(g, FLOW_RUN.complete(g, r));
  const st = FLOW_RUN.status(g, r);
  ok(st.mode === 'finished' && st.settled === 3 && st.total === 3, '末步完成后执行结束', J(st));
  ok(FLOW_RUN.complete(g, r) === r, '结束之后再完成不改变状态');
}

// ---------- 二、分支与汇合 ----------
{
  const g = BRANCH();
  let r = FLOW_RUN.complete(g, FLOW_RUN.start(g));
  let st = FLOW_RUN.status(g, r);
  ok(st.mode === 'choose' && J(st.options) === '["b","c"]', '分支处停下等用户选，候选是可前往的步骤', J(st));
  ok(FLOW_RUN.choose(g, r, 'd') === r, '不在候选里的步骤选不了（汇合点还没就绪）');
  ok(FLOW_RUN.choose(g, r, 'nope') === r, '不存在的步骤选不了');
  r = FLOW_RUN.choose(g, r, 'b');
  ok(r.current === 'b', '选中分支后成为当前步骤');
  r = FLOW_RUN.complete(g, r);
  ok(r.current === 'c', '汇合点要等另一条分支：走完 b 之后去 c 而不是 d', J(r));
  r = FLOW_RUN.complete(g, r);
  ok(r.current === 'd', '两条分支都结算后进入汇合点', J(r));
}

// ---------- 三、跳过 ----------
{
  const g = BRANCH();
  let r = FLOW_RUN.choose(g, FLOW_RUN.complete(g, FLOW_RUN.start(g)), 'b');
  r = FLOW_RUN.complete(g, r);   // → c
  r = FLOW_RUN.skip(g, r);       // c 不走
  ok(r.current === 'd' && J(r.skipped) === '["c"]' && !r.done.includes('c'), '跳过的分支也算结算，汇合点照样能进', J(r));
  // 坏引用步骤的出路就是跳过：跳过不要求步骤能复制
  const g2 = graphOf([step('a', ['b']), step('b', [])]);
  const r2 = FLOW_RUN.skip(g2, FLOW_RUN.start(g2));
  ok(r2.current === 'b' && J(r2.skipped) === '["a"]', '跳过当前步后前进到下一步', J(r2));
}

// ---------- 四、回退 ----------
{
  const g = BRANCH();
  let r = FLOW_RUN.start(g);
  ok(!FLOW_RUN.canBack(r) && FLOW_RUN.back(g, r) === r, '还没结算任何步骤时不能回退');
  r = FLOW_RUN.choose(g, FLOW_RUN.complete(g, r), 'c');
  r = FLOW_RUN.back(g, r);
  ok(r.current === 'a' && !r.done.includes('a') && r.history.length === 0, '回退把上一步变回当前步骤、不再算完成', J(r));
  // 跳过的步骤也能回退
  const g2 = graphOf([step('a', ['b']), step('b', [])]);
  const r2 = FLOW_RUN.back(g2, FLOW_RUN.skip(g2, FLOW_RUN.start(g2)));
  ok(r2.current === 'a' && r2.skipped.length === 0, '跳过的步骤回退后不再算跳过', J(r2));
  // 从"等用户选"的状态回退
  const r3 = FLOW_RUN.back(g, FLOW_RUN.complete(g, FLOW_RUN.start(g)));
  ok(r3.current === 'a', '在分支选择处回退回到分支前那一步', J(r3));
}

// ---------- 五、入口 ----------
{
  // 两个入口：一开始就要选
  const g = graphOf([step('a', ['c']), step('b', ['c']), step('c', [])]);
  const r = FLOW_RUN.start(g);
  const st = FLOW_RUN.status(g, r);
  ok(r.current === null && st.mode === 'choose' && J(st.options) === '["a","b"]', '多个入口时开始就让用户选', J(st));
  // 全图成环：没有入口，退回第一步
  const gc = graphOf([step('a', ['b']), step('b', ['a'])]);
  ok(J(FLOW_RUN.entries(gc)) === '["a"]' && FLOW_RUN.start(gc).current === 'a', '全图成环时从书写顺序的第一步开始');
  // 回边不能变成门槛：a → b → c → b
  const gb = graphOf([step('a', ['b']), step('b', ['c']), step('c', ['b'])]);
  const rb = FLOW_RUN.complete(gb, FLOW_RUN.start(gb));
  ok(rb.current === 'b', '环里的回边不挡路：b 不用等 c', J(rb));
  // 空工作流
  const ge = graphOf([]);
  ok(FLOW_RUN.status(ge, FLOW_RUN.start(ge)).mode === 'finished', '没有步骤的工作流直接是结束状态');
}

// ---------- 六、持久化数据的修复 ----------
{
  const g = BRANCH();
  for (const [name, raw] of [['null', null], ['数组', []], ['字符串', 'x'], ['版本不认识', { v: 99, current: 'a' }]]) {
    ok(FLOW_RUN.restore(g, raw) === null, '坏进度当没有进度：' + name);
  }
  // 步骤被删 / 改 id
  const r = FLOW_RUN.restore(g, { v: 1, current: 'gone', done: ['a', 'old', 'a'], skipped: ['zzz'], history: ['old', 'a'], values: {} });
  ok(r && J(r.done) === '["a"]' && r.skipped.length === 0 && J(r.history) === '["a"]', '不存在的步骤 id 被剔掉、重复去掉', J(r));
  ok(r && r.current === null && J(FLOW_RUN.status(g, r).options) === '["b","c"]',
    'current 指向已删的步骤时按规则重新推进（这里是分支，等用户选）', J(r));
  // 既完成又跳过：以完成为准
  const r2 = FLOW_RUN.restore(g, { v: 1, current: null, done: ['a', 'b'], skipped: ['b'], history: ['a', 'b'] });
  ok(r2 && J(r2.skipped) === '[]' && r2.current === 'c', '同一步既完成又跳过时以完成为准，并推进到 c', J(r2));
  // history 缺了已结算的步骤：补到前面，回退还撤得到
  const r3 = FLOW_RUN.restore(g, { v: 1, current: 'd', done: ['a', 'b', 'c'], history: ['c'] });
  ok(r3 && J(r3.history) === '["a","b","c"]', '缺失的结算记录按拓扑顺序补进 history', J(r3));
  // current 已经结算过
  const r4 = FLOW_RUN.restore(g, { v: 1, current: 'a', done: ['a'], history: ['a'] });
  ok(r4 && r4.current === null && FLOW_RUN.status(g, r4).mode === 'choose', 'current 已结算时清掉并重新推进', J(r4));
  // 剔完什么都不剩
  ok(FLOW_RUN.restore(g, { v: 1, current: 'x', done: ['y'] }) === null, '剔掉无效部分后什么都不剩就当没有进度');
  // values：原型键、非字符串、空值、超长
  const poisoned = JSON.parse('{"v":1,"current":"a","values":{"__proto__":{"polluted":1},"[x]":"1","[n]":5,"[e]":"  ","[long]":"' + 'x'.repeat(20001) + '"}}');
  const r5 = FLOW_RUN.restore(g, poisoned);
  ok(r5 && J(r5.values) === '{"[x]":"1"}' && ({}).polluted === undefined && Object.getPrototypeOf(r5.values) === Object.prototype,
    'values 只留合法字符串，原型键、空值、超长值丢掉', J(r5 && r5.values).slice(0, 80));
  // equal：修过的和原样的能分辨，updatedAt 不算差异
  const raw = { v: 1, current: 'b', done: ['a'], skipped: [], history: ['a'], values: {}, updatedAt: 5 };
  ok(FLOW_RUN.equal(FLOW_RUN.restore(g, raw), { ...raw, updatedAt: 9 }), '原样能用的进度 restore 后判为未改动');
  ok(!FLOW_RUN.equal(r, { v: 1, current: 'gone', done: ['a', 'old', 'a'], skipped: ['zzz'], history: ['old', 'a'], values: {} }),
    '修过的进度判为有改动（渲染进程据此写回）');
  // serialize 只带白名单字段
  const s = FLOW_RUN.serialize({ ...FLOW_RUN.start(g), extra: 1 }, 123);
  ok(J(Object.keys(s).sort()) === '["current","done","history","skipped","updatedAt","v","values"]' && s.updatedAt === 123,
    '落盘只带白名单字段', J(s));
}

// ---------- 七、占位符值 ----------
{
  const g = BRANCH();
  let r = FLOW_RUN.start(g);
  r = FLOW_RUN.mergeValues(r, { '[项目]': '甲', '[空]': '' });
  r = FLOW_RUN.mergeValues(r, { '[项目]': '  ', '[语言]': 'Go' });
  ok(J(r.values) === '{"[项目]":"甲","[语言]":"Go"}', '留空不覆盖已填的值，空值不记', J(r.values));
  ok(FLOW_RUN.mergeValues(r, {}) === r, '没有新值时返回原对象');
}

// ---------- 八、config.flowRuns 整体 ----------
{
  const runs = FLOW_RUN.cleanRuns({
    'workflows/a.md': { v: 1, updatedAt: 1 },
    'prompts/x.md': { v: 1 },
    'workflows/../config.md': { v: 1 },
    'workflows/b.md': 'nope',
    'workflows/c.md': { v: 1, updatedAt: 2 }
  });
  ok(J(Object.keys(runs)) === '["workflows/c.md","workflows/a.md"]', '只认 workflows/ 下的 .md，值必须是对象，按更新时间排', J(Object.keys(runs)));
  const many = {};
  for (let i = 0; i < FLOW_RUN.MAX_RUNS + 5; i++) many['workflows/w' + i + '.md'] = { v: 1, updatedAt: i };
  const capped = FLOW_RUN.cleanRuns(many);
  ok(Object.keys(capped).length === FLOW_RUN.MAX_RUNS && !capped['workflows/w0.md'] && !!capped['workflows/w' + (FLOW_RUN.MAX_RUNS + 4) + '.md'],
    '超过上限时留最新的', String(Object.keys(capped).length));
  const moved = FLOW_RUN.renameRun(runs, 'workflows/a.md', 'workflows/sub/a2.md');
  ok(!moved['workflows/a.md'] && moved['workflows/sub/a2.md'] === runs['workflows/a.md'], '改名 / 移动时进度跟着走');
  ok(FLOW_RUN.renameRun(runs, 'workflows/none.md', 'workflows/x.md') === runs, '没有进度的工作流改名时原样返回');
  const out = FLOW_RUN.renameRun(runs, 'workflows/a.md', 'prompts/a.md');
  ok(!out['workflows/a.md'] && !out['prompts/a.md'], '挪出 workflows/ 之后进度丢掉而不是挂在非工作流键上', J(Object.keys(out)));
  const dropped = FLOW_RUN.dropRun(runs, 'workflows/c.md');
  ok(!dropped['workflows/c.md'] && !!dropped['workflows/a.md'], '删除时清掉进度');
  ok(FLOW_RUN.dropRun(runs, 'workflows/none.md') === runs, '没有进度的工作流删除时原样返回');
}

// ---------- 反向对照 ----------
// 三份朴素实现各自只犯一个错，其余行为照抄规则。每条关键用例都要求：
// 真实现判对、对应的朴素实现判错。只要求"有失败"不够——撞红了别的用例
// 说明目标用例本身还是空的，所以逐条点名。
{
  // 一个最小的执行引擎，规则可替换。只实现用例要用到的 start / complete / choose。
  const engine = ({ ready, prefer }) => {
    const settledOf = (r) => new Set([...r.done, ...r.skipped]);
    const opts = (g, r) => {
      if (r.current) return [];
      const settled = settledOf(r);
      const all = g.layers.flat().map(s => s.id).filter(id => ready(g, settled, id));
      const last = r.history[r.history.length - 1];
      const pref = prefer(g, r, settled, all, last);
      return pref.length ? pref : all;
    };
    const adv = (g, r) => { const o = opts(g, r); return o.length === 1 ? { ...r, current: o[0] } : r; };
    return {
      start: (g) => adv(g, FLOW_RUN.create()),
      complete: (g, r) => adv(g, { ...r, current: null, done: r.done.concat(r.current), history: r.history.concat(r.current) }),
      choose: (g, r, id) => (opts(g, r).includes(id) ? { ...r, current: id } : r),
      restore: FLOW_RUN.restore
    };
  };
  const gatedByLowerLevel = (g, settled, id) => !settled.has(id)
    && g.edges.every(e => e.to !== id || !(g.level.get(e.from) < g.level.get(id)) || settled.has(e.from));
  const preferNextReady = (g, r, settled, all, last) =>
    (last == null ? FLOW_RUN.entries(g) : g.byId.get(last).next).filter(id => all.includes(id));

  const naiveNoJoin = engine({
    ready: gatedByLowerLevel,
    // 上一步的 next 原样当候选，不看汇合点就没就绪
    prefer: (g, r, settled, all, last) => (last == null ? FLOW_RUN.entries(g) : g.byId.get(last).next).filter(id => !settled.has(id))
  });
  const naiveAllPreds = engine({
    // 所有前驱都要结算，不区分回边
    ready: (g, settled, id) => !settled.has(id) && g.edges.every(e => e.to !== id || settled.has(e.from)),
    prefer: preferNextReady
  });
  const naiveTrust = { ...FLOW_RUN, restore: (g, raw) => (raw && typeof raw === 'object' ? { ...raw } : null) };
  // 规则替换点本身也要验：用正确规则拼出来的引擎必须和真实现一致，
  // 否则下面"朴素实现判错"可能只是引擎骨架写错了，而不是被替换的那条规则。
  const faithful = engine({ ready: gatedByLowerLevel, prefer: preferNextReady });

  const cases = [
    {
      name: '分支走完一条不能直接进汇合点',
      naive: naiveNoJoin,
      check: (impl) => {
        const g = BRANCH();
        const r = impl.complete(g, impl.choose(g, impl.complete(g, impl.start(g)), 'b'));
        return r.current === 'c';
      }
    },
    {
      name: '环里的回边不是门槛',
      naive: naiveAllPreds,
      check: (impl) => {
        const g = graphOf([step('a', ['b']), step('b', ['c']), step('c', ['b'])]);
        return impl.complete(g, impl.start(g)).current === 'b';
      }
    },
    {
      name: '进度里已删除的步骤被剔掉',
      naive: naiveTrust,
      check: (impl) => {
        const g = BRANCH();
        const r = impl.restore(g, { v: 1, current: 'gone', done: ['a', 'old'], skipped: [], history: ['a', 'old'], values: {} });
        return !!r && J(r.done) === '["a"]' && r.current !== 'gone';
      }
    },
    {
      name: '进度里的原型键不进 values',
      naive: naiveTrust,
      check: (impl) => {
        const g = BRANCH();
        const r = impl.restore(g, JSON.parse('{"v":1,"current":"a","done":[],"skipped":[],"history":[],"values":{"__proto__":{"x":1},"[a]":"1"}}'));
        return !!r && !Object.prototype.hasOwnProperty.call(r.values, '__proto__');
      }
    }
  ];
  let discriminators = 0;
  for (const c of cases) {
    const real = c.check(FLOW_RUN);
    const naive = c.check(c.naive);
    if (real && !naive) discriminators++;
    else console.error('[test:flow-run] FAIL 反向对照用例没有分辨力：' + c.name + '（真实现 ' + real + '，朴素实现 ' + naive + '）');
  }
  ok(discriminators === cases.length, '反向对照：每条用例都能分辨对应的朴素实现（' + discriminators + '/' + cases.length + '）');
  const faithfulOk = cases.slice(0, 2).every(c => c.check(faithful));
  ok(faithfulOk, '反向对照的引擎骨架本身是对的：换回正确规则后两条用例都通过');
}

console.log(failures ? `[test:flow-run] ${failures} 条失败` : '[test:flow-run] 通过');
process.exit(failures ? 1 : 0);
