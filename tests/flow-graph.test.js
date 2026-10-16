// tests/flow-graph.test.js
// 回归测试：src/flow-graph.js 的分层、成环与不可达判断。
//
// 为什么单独一个文件：这些判断此前长在 renderer.js 里，验证它们要拉起 Electron
// 去数 DOM 节点，于是"某个步骤从入口走不到"这一类问题**从来没有被检查过**。
// 抽成模块后每种图形都能用裸 node 摆出来验。
//
// 反向对照在文件末尾：同一批断言拿一个"分层就是数组下标"的朴素实现跑一遍，
// 必须红够多条 —— 它证明的是这批断言有分辨力。
//
// 运行：PFM_DATA_DIR=<临时目录> npm run test:flow-graph
const path = require('path');
const root = path.resolve(__dirname, '..');
const FLOW_GRAPH = require(path.join(root, 'src', 'flow-graph.js'));

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:flow-graph] PASS ' + msg);
  else { failures++; console.error('[test:flow-graph] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};

const step = (id, next) => ({ id, prompt: 'prompts/' + id + '.md', label: id, next: next || [] });

// ---------- 一、线性 ----------
{
  const g = FLOW_GRAPH.analyze([step('a', ['b']), step('b', ['c']), step('c', [])]);
  ok(g.sources.length === 1 && g.sources[0] === 'a', '线性流程的入口只有一个');
  ok(g.level.get('a') === 0 && g.level.get('b') === 1 && g.level.get('c') === 2,
    '线性流程逐级分层', JSON.stringify(Array.from(g.level)));
  ok(g.hasCycle === false && g.unreachable.length === 0, '线性流程没有环也没有不可达');
  ok(g.layers.length === 3 && g.layers.every(l => l.length === 1), '线性流程每层一个节点');
}

// ---------- 二、分支与汇合 ----------
{
  // a → [b, c] → d：仓库里 workflows/branch-flow-example.md 就是这个形状
  const g = FLOW_GRAPH.analyze([step('a', ['b', 'c']), step('b', ['d']), step('c', ['d']), step('d', [])]);
  ok(g.edges.length === 4, '分支汇合有 4 条边', String(g.edges.length));
  ok(g.level.get('b') === 1 && g.level.get('c') === 1, '两条分支在同一层');
  // 汇合点取最长前导路径
  ok(g.level.get('d') === 2, '汇合点层级取最长前导路径', String(g.level.get('d')));
  ok(g.layers[1].length === 2, '同层两个节点会排在一层里', JSON.stringify(g.layers.map(l => l.map(s => s.id))));
  ok(g.unreachable.length === 0 && g.hasCycle === false, '分支汇合没有环也没有不可达');
}

// ---------- 三、不可达步骤 ----------
{
  // 孤立节点：没人指向它，它自己也没有出边 —— 它其实会被当成入口（0 入边），
  // 所以"不可达"要的是**有入边但从入口走不到**的形状：b、c 互相指向。
  const g = FLOW_GRAPH.analyze([step('a', []), step('b', ['c']), step('c', ['b'])]);
  ok(g.unreachable.length === 2 && g.unreachable.includes('b') && g.unreachable.includes('c'),
    '自成一环、入口到不了的步骤被判为不可达', JSON.stringify(g.unreachable));
  ok(g.sources.includes('a') && !g.unreachable.includes('a'), '真正的入口不算不可达');
  ok(g.hasCycle === true, '自成一环标记为成环', String(g.hasCycle));

  // 链断开：a → b，c → d 互不相干，两组各自有入口，都不算不可达
  const g2 = FLOW_GRAPH.analyze([step('a', ['b']), step('b', []), step('c', ['d']), step('d', [])]);
  ok(g2.unreachable.length === 0, '两段互不相连的链各自有入口，都不算不可达');
  ok(g2.sources.length === 2, '两段链有两个入口');
}

// ---------- 四、全图成环 ----------
{
  // 没有任何入口：不判不可达（那会把每个节点都标红，而真正的问题是成环）
  const g = FLOW_GRAPH.analyze([step('a', ['b']), step('b', ['a'])]);
  ok(g.sources.length === 0, '全图成环时没有入口');
  ok(g.hasCycle === true, '全图成环被识别');
  ok(g.unreachable.length === 0, '全图成环时不逐个标不可达（问题在环，不在可达性）',
    JSON.stringify(g.unreachable));
  ok(g.layers.length === 2 || g.layers.length === 1, '全图成环仍然能分出层而不是崩掉',
    JSON.stringify(g.layers.map(l => l.map(s => s.id))));
  // 关键：不能出现"第 0 层空着、节点全挤在第 1 层"的空白层
  ok(g.layers[0].length > 0, '成环时第 0 层不是空的（否则图上一条空白层）',
    JSON.stringify(g.layers.map(l => l.map(s => s.id))));
}

// ---------- 五、残缺与边界输入 ----------
{
  // next 指向不存在的 id 不算边（由"引用失效"那套单独报），更不该让它影响分层
  const g = FLOW_GRAPH.analyze([step('a', ['ghost']), step('b', [])]);
  ok(g.edges.length === 0, '指向不存在步骤的 next 不算边', JSON.stringify(g.edges));
  ok(g.level.get('a') === 0 && g.level.get('b') === 0, '残缺 next 不影响分层');
  ok(g.unreachable.length === 0, '残缺 next 不产生不可达步骤');

  // 缺 id 的步骤直接跳过，不能进图（否则 byId 里会出现 undefined 键）
  const g2 = FLOW_GRAPH.analyze([{ prompt: 'x', next: [] }, step('a', [])]);
  ok(g2.byId.size === 1 && g2.byId.has('a'), '缺 id 的步骤不进图', JSON.stringify(Array.from(g2.byId.keys())));

  ok(FLOW_GRAPH.analyze([]).layers.length === 1, '空流程也能分析（零层会崩调用方）');
  ok(FLOW_GRAPH.analyze(null).edges.length === 0, 'null 输入不抛错');
  // 自环：指向自己
  const g3 = FLOW_GRAPH.analyze([step('a', ['a']), step('b', [])]);
  ok(g3.hasCycle === true && g3.unreachable.includes('a'), '自环被判为成环且不可达',
    JSON.stringify({ cycle: g3.hasCycle, unreachable: g3.unreachable }));
}

// ---------- 六、反向对照：朴素实现必须红 ----------
// 朴素实现 = "按数组下标分层，next 里出现过的 id 就算可达"。
// 它不做拓扑排序、不判入口可达性，所以分支汇合和不可达这两类会出错。
{
  const naive = (steps) => {
    const list = steps || [];
    const level = new Map(list.map((s, i) => [s.id, i]));
    const reachable = new Set();
    for (const s of list) for (const n of s.next || []) reachable.add(n);
    return {
      level,
      unreachable: list.filter(s => !reachable.has(s.id)).map(s => s.id)
    };
  };
  const cases = [
    {
      name: '分支汇合的层级',
      steps: [step('a', ['b', 'c']), step('b', ['d']), step('c', ['d']), step('d', [])],
      check: (impl) => impl.level.get('b') === 1 && impl.level.get('c') === 1 && impl.level.get('d') === 2
    },
    {
      name: '自成一环的不可达',
      steps: [step('a', []), step('b', ['c']), step('c', ['b'])],
      check: (impl) => impl.unreachable.length === 2
    }
  ];
  let discriminators = 0;
  for (const c of cases) {
    const real = FLOW_GRAPH.analyze(c.steps);
    const short = naive(c.steps);
    // 两边各自"通过自己的判定"时的结果必须不同
    if (c.check(real) !== c.check(short)) discriminators++;
    else {
      console.error('[test:flow-graph] FAIL 反向对照用例没有分辨力：' + c.name);
      failures++;
    }
  }
  ok(discriminators === cases.length,
    '反向对照：每条用例都能分辨朴素实现（' + discriminators + '/' + cases.length + '）');
}

console.log(failures ? `[test:flow-graph] ${failures} 条失败` : '[test:flow-graph] 通过');
process.exit(failures ? 1 : 0);
