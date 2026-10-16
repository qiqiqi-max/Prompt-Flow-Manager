// 工作流 flow 段的图分析：分层、成环、不可达步骤。
//
// 为什么单独抽一个文件：这些判断全是图论语义，和"画成什么样"无关，但此前都
// 长在 renderer.js 的 renderFlowDiagram / auditFlowRefs 里。想验证"某个步骤
// 从入口走不到"就得拉起整个 Electron 去数 DOM 节点 —— 于是这条检查干脆没有。
// 抽出来之后 tests/flow-graph.test.js 用裸 node 就能把每种图形验一遍。
//
// 加载方式同 frontmatter.js / workflow-refs.js：浏览器里靠 <script> 声明全局，
// 主进程和测试里靠结尾的 module.exports require。
const FLOW_GRAPH = {
  // 只有 id 存在、且 next 指向已存在步骤的边才算边。
  // 指向不存在的 id 由"引用失效"那套报（flowMissingNext），不是图论问题。
  analyze(steps) {
    const list = Array.isArray(steps) ? steps.filter(s => s && s.id) : [];
    const byId = new Map(list.map(s => [s.id, s]));
    const edges = [];
    for (const s of list) {
      for (const n of s.next || []) {
        if (byId.has(n)) edges.push({ from: s.id, to: n });
      }
    }
    const indeg = new Map(list.map(s => [s.id, 0]));
    for (const e of edges) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);

    // 入口 = 没有入边的步骤。全图成环时一个入口都没有（见下面的 size 判断）。
    const sources = list.filter(s => (indeg.get(s.id) || 0) === 0).map(s => s.id);

    // 分层用 Kahn 拓扑排序：出队时直接把层级推给后继，一趟 O(V+E)。
    // 层级 = 所有前驱层级最大值 + 1（最长前导路径），所以分支汇合时高度取最长的
    // 那条，画出来不会出现"边往回拐"。
    const level = new Map();
    const pending = new Map(indeg);
    const queue = sources.slice();
    for (const id of queue) level.set(id, 0);
    let visited = 0;
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head];
      visited++;
      const lv = level.get(id) || 0;
      for (const e of edges) {
        if (e.from !== id) continue;
        level.set(e.to, Math.max(level.get(e.to) == null ? 0 : level.get(e.to), lv + 1));
        pending.set(e.to, pending.get(e.to) - 1);
        if (pending.get(e.to) === 0) queue.push(e.to);
      }
    }

    // 环里的节点入度永远降不到 0，拿不到层级，visited 会小于总数。
    const hasCycle = visited < list.length;
    if (hasCycle) {
      // 全图成环时没有任何入口，末层要从 -1 起算，否则所有节点都落到第 1 层、
      // 第 0 层空着，画出来是一条空白层。
      let tail = -1;
      for (const lv of level.values()) tail = Math.max(tail, lv);
      for (const s of list) if (!level.has(s.id)) level.set(s.id, tail + 1);
    }

    // 不可达：从入口出发顺着 next 走不到，但它自己又有入边。
    // 只判"有入边却没走到"，不判 sources —— sources 按定义就是入口。
    //
    // 全图成环时 sources 为空、BFS 一个都到不了，这时不做这个判断：
    // 那种图的问题是"成环"，把每个节点都标成不可达只是噪声（下面的
    // sources.length 判断就是干这个的）。
    const unreachable = [];
    if (sources.length) {
      const seen = new Set(sources);
      const stack = sources.slice();
      while (stack.length) {
        const id = stack.pop();
        for (const e of edges) {
          if (e.from !== id || seen.has(e.to)) continue;
          seen.add(e.to);
          stack.push(e.to);
        }
      }
      for (const s of list) {
        if (!seen.has(s.id) && (indeg.get(s.id) || 0) > 0) unreachable.push(s.id);
      }
    }

    return {
      byId,
      edges,
      indeg,
      sources,
      level,
      layers: layersOf(list, level),
      hasCycle,
      unreachable,
      // 给外部算宽度用：最长层的节点数
      maxLevel: list.length ? Math.max(0, ...level.values()) : 0
    };
  }
};

function layersOf(list, level) {
  const max = list.length ? Math.max(0, ...level.values()) : 0;
  const layers = Array.from({ length: max + 1 }, () => []);
  for (const s of list) {
    const lv = level.get(s.id);
    layers[lv == null ? 0 : lv].push(s);
  }
  return layers;
}

if (typeof module !== 'undefined' && module.exports) module.exports = FLOW_GRAPH;
