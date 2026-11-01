// 工作流执行模式的状态机：从哪一步开始、下一步能去哪、完成 / 跳过 / 回退，
// 以及持久化数据（config.flowRuns）的校验与修复。
//
// 为什么单独一个文件：执行模式最容易写错的是"汇合点什么时候能走""文件改过之后
// 旧进度还剩哪些能用"这类规则，它们和界面长什么样无关。留在 renderer.js 里的话，
// 验证一条"分支没走完就不该进汇合点"得拉起 Electron 去点按钮；抽出来之后
// tests/flow-run.test.js 用裸 node 就能把每种图形和每种坏数据摆一遍。
//
// 依赖 src/flow-graph.js 的 analyze() 结果（graph），自己不再做一遍图论：
// 入口、边、层级都以那份分析为准，流程图上画的和执行模式走的才是同一张图。
//
// 加载方式同 flow-graph.js：浏览器里靠 <script> 声明全局，主进程和测试里 require。
//
// 运行记录的形状（也是 config.flowRuns[<工作流 rel>] 的落盘格式）：
//   { v: 1, current: 'id' | null, done: [id], skipped: [id], history: [id],
//     values: { token: 值 }, updatedAt: 毫秒时间戳 }
//   current  正在做的步骤；null 表示在等用户从分支里选，或者已经走完
//   history  已结算步骤的结算顺序，回退按它倒着撤
//   values   这次执行里填过的占位符，后续步骤的填写面板拿它预填
//
// 汇合点规则：一个步骤要等它所有"层级更低"的前驱都结算（完成或跳过）之后才能进入。
// 分支 a → [b, c] → d 里，走完 b 时 d 还不能进，候选退回到还没走的 c；
// 不打算走的那条分支用"跳过"结算掉。只认层级更低的前驱，是为了不让环里的回边
// 变成门槛（a → b → c → b 里 b 和 c 互等，谁都开始不了）。
const FLOW_RUN = (function () {
  // 用 IIFE 的理由同 placeholders.js：下面这些 helper 是私有的，渲染进程里
  // 顶层 function 声明就是全局变量，叫 order / unique 这种通名迟早和 renderer.js 撞上。
  const SCHEMA = 1;
  // 工作流数量的上限。整份 flowRuns 每次都随 setConfig 序列化，没有上限就随使用无限长。
  const MAX_RUNS = 50;
  // 单个工作流里记住的占位符条数和单值长度上限，理由同上。超长的值整条丢弃而不是截断：
  // 截断后的半段内容预填进面板，用户不细看就会带着半截文本复制出去。
  const MAX_VALUES = 200;
  const MAX_VALUE_LEN = 20000;
  const MAX_KEY_LEN = 500;
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  // 键必须以 workflows/ 开头，__proto__ 这类原型键天然过不了这一关，不另列黑名单。
  const isRunKey = (k) => typeof k === 'string'
    && /^workflows\/.+\.md$/i.test(k) && !k.split('/').includes('..');
  const unique = (arr) => Array.from(new Set(arr));

  // 拓扑顺序：层级优先，层内按文件里的书写顺序。多个候选并列时按这个顺序列，
  // 选项的先后才稳定，不会两次渲染给出两种排法。
  function order(graph) {
    return unique(graph.layers.flat().map(s => s.id)).filter(id => graph.byId.has(id));
  }

  function settledSet(run) {
    return new Set([...run.done, ...run.skipped]);
  }

  function isReady(graph, settled, id) {
    if (settled.has(id)) return false;
    const lv = graph.level.get(id);
    for (const e of graph.edges) {
      if (e.to !== id) continue;
      if (graph.level.get(e.from) < lv && !settled.has(e.from)) return false;
    }
    return true;
  }

  // 入口 = flow-graph 算出来的 sources（没有入边的步骤）。全图成环时一个入口都没有，
  // 退回到书写顺序的第一步，否则这种工作流永远开始不了。
  function entries(graph) {
    if (graph.sources.length) return graph.sources.filter(id => graph.byId.has(id));
    const all = order(graph);
    return all.length ? [all[0]] : [];
  }

  function create() {
    return { v: SCHEMA, current: null, done: [], skipped: [], history: [], values: {}, updatedAt: 0 };
  }

  // 当前没有步骤时，接下来能去哪。
  //   刚开始：入口里已就绪的那些
  //   结算过步骤：优先上一步的 next 里已就绪的（next 只有一个就是直走，多个就是分支）；
  //   一个都没就绪（next 是还在等另一条分支的汇合点，或者是末步）时，
  //   退回到全图所有已就绪的步骤——也就是还没走的那条分支
  // 返回空数组 = 全部结算，执行结束。
  function options(graph, run) {
    if (!run || run.current) return [];
    const settled = settledSet(run);
    const ready = order(graph).filter(id => isReady(graph, settled, id));
    if (!ready.length) return [];
    const last = run.history.length ? run.history[run.history.length - 1] : null;
    let preferred;
    if (last === null) {
      preferred = entries(graph);
    } else {
      const step = graph.byId.get(last);
      preferred = step ? step.next || [] : [];
    }
    preferred = unique(preferred).filter(id => ready.includes(id));
    return preferred.length ? preferred : ready;
  }

  // 只剩一个去处就直接走过去，多个就停在 current = null 等用户选。
  function advance(graph, run) {
    if (run.current) return run;
    const opts = options(graph, run);
    return opts.length === 1 ? { ...run, current: opts[0] } : run;
  }

  function start(graph) {
    return advance(graph, create());
  }

  function settle(graph, run, kind) {
    if (!run || !run.current || !graph.byId.has(run.current)) return run;
    const id = run.current;
    const done = run.done.filter(x => x !== id);
    const skipped = run.skipped.filter(x => x !== id);
    (kind === 'done' ? done : skipped).push(id);
    const history = run.history.filter(x => x !== id).concat(id);
    return advance(graph, { ...run, current: null, done, skipped, history });
  }

  function complete(graph, run) { return settle(graph, run, 'done'); }
  function skip(graph, run) { return settle(graph, run, 'skipped'); }

  // 只能选 options 里给出的步骤：界面上的按钮就是按 options 画的，
  // 别的 id 进来说明界面和状态脱节了，原样返回而不是跳到一个没就绪的步骤上。
  function choose(graph, run, id) {
    if (!run || !options(graph, run).includes(id)) return run;
    return { ...run, current: id };
  }

  function canBack(run) {
    return !!run && run.history.length > 0;
  }

  // 撤回最近结算的那一步：它变回当前步骤、不再算完成。
  // 原来的 current（如果有）只是变回未开始，不记任何东西。
  function back(graph, run) {
    if (!canBack(run)) return run;
    const id = run.history[run.history.length - 1];
    return {
      ...run,
      current: id,
      history: run.history.slice(0, -1),
      done: run.done.filter(x => x !== id),
      skipped: run.skipped.filter(x => x !== id)
    };
  }

  // 界面用的汇总。mode：step 有当前步骤 / choose 等用户选 / finished 全部结算。
  function status(graph, run) {
    const total = graph.byId.size;
    if (!run) return { mode: 'idle', options: [], settled: 0, total };
    const settled = run.done.length + run.skipped.length;
    if (run.current) return { mode: 'step', options: [], settled, total };
    const opts = options(graph, run);
    return { mode: opts.length ? 'choose' : 'finished', options: opts, settled, total };
  }

  // 占位符值的清洗：只留字符串、超长整条丢弃、条数封顶。
  // 原型键（JSON.parse 出来的自有 __proto__）靠"只留字符串"挡住：只有把对象赋给
  // __proto__ 才会改原型，字符串赋过去是空操作。所以 typeof 那一行不能放宽。
  // 空串也丢：空值的含义是"这次没填"，留着它会在后续步骤里把输入框预填成空，
  // 盖掉 fillMemory 里本来能用的值。
  function cleanValues(raw) {
    const out = {};
    if (!isObj(raw)) return out;
    let n = 0;
    for (const k of Object.keys(raw)) {
      if (n >= MAX_VALUES) break;
      if (!k || k.length > MAX_KEY_LEN) continue;
      const v = raw[k];
      if (typeof v !== 'string' || !v.trim() || v.length > MAX_VALUE_LEN) continue;
      out[k] = v;
      n++;
    }
    return out;
  }

  // 把一次复制时填的值并进执行记录。留空的不覆盖：用户这次故意留空，
  // 不该把前面步骤填好的值抹掉（和 renderer.js 的 rememberFillValues 同一个取舍）。
  function mergeValues(run, filled) {
    if (!run) return run;
    const add = cleanValues(filled);
    if (!Object.keys(add).length) return run;
    // 后填的排到末尾，封顶时淘汰最早的那批
    const merged = { ...run.values };
    for (const k of Object.keys(add)) { delete merged[k]; merged[k] = add[k]; }
    const keys = Object.keys(merged);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_VALUES))) delete merged[k];
    return { ...run, values: merged };
  }

  // 落盘的进度 → 能用的执行记录。工作流文件随时可能被改（步骤删了、改了 id、
  // next 改了方向），config.json 也可能被手改，所以这里一律按"丢掉无效部分、不崩"处理：
  //   - 不是对象、版本不认识：当没有进度（返回 null）
  //   - 不存在的步骤 id 从 current / done / skipped / history 里剔掉
  //   - 同一步既算完成又算跳过：以完成为准
  //   - 结算过但不在 history 里的步骤补到 history 前面（按拓扑顺序），回退仍然撤得到
  //   - current 已经结算过：清掉，按规则重新推进
  //   - 剔完之后什么都不剩：当没有进度
  function restore(graph, raw) {
    if (!isObj(raw) || raw.v !== SCHEMA) return null;
    const valid = (id) => typeof id === 'string' && graph.byId.has(id);
    const list = (v) => unique(Array.isArray(v) ? v.filter(valid) : []);
    const done = list(raw.done);
    const doneSet = new Set(done);
    const skipped = list(raw.skipped).filter(id => !doneSet.has(id));
    const settled = new Set([...done, ...skipped]);
    let history = list(raw.history).filter(id => settled.has(id));
    const missing = order(graph).filter(id => settled.has(id) && !history.includes(id));
    history = missing.concat(history);
    let current = valid(raw.current) && !settled.has(raw.current) ? raw.current : null;
    const values = cleanValues(raw.values);
    const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
    if (!current && !history.length && !Object.keys(values).length) return null;
    return advance(graph, { v: SCHEMA, current, done, skipped, history, values, updatedAt });
  }

  // 只比较会落盘的内容（不比 updatedAt）。渲染进程据此判断 restore 有没有修过东西、
  // 要不要写回——不写回的话，坏数据每次打开都要重修一遍，而且永远留在 config 里。
  function equal(a, b) {
    if (!a || !b) return a === b;
    const pick = (r) => JSON.stringify([r.current, r.done, r.skipped, r.history, r.values]);
    return pick(a) === pick(b);
  }

  // config.flowRuns 整体的清洗：只认 workflows/ 下的 .md 作键，值必须是对象，
  // 条数超了按 updatedAt 留最新的。这一层不认识每个工作流的步骤
  // （那要读文件），步骤级的修复留给打开时的 restore。
  function cleanRuns(raw) {
    const out = {};
    if (!isObj(raw)) return out;
    const keys = Object.keys(raw).filter(k => isRunKey(k) && isObj(raw[k]));
    keys.sort((a, b) => (Number(raw[b].updatedAt) || 0) - (Number(raw[a].updatedAt) || 0));
    for (const k of keys.slice(0, MAX_RUNS)) out[k] = raw[k];
    return out;
  }

  // 工作流改名 / 移动时进度跟着走，做法同锁定标记跟随文件。
  // 没有命中时返回同一个对象，调用方用 === 判断要不要写盘。
  // 新路径已经不是工作流（挪出了 workflows/）时直接丢掉：留着也会被 cleanRuns 当坏键清掉。
  function renameRun(runs, oldRel, newRel) {
    if (!isObj(runs) || !Object.prototype.hasOwnProperty.call(runs, oldRel) || oldRel === newRel) return runs;
    const out = { ...runs };
    if (isRunKey(newRel)) out[newRel] = out[oldRel];
    delete out[oldRel];
    return out;
  }

  function dropRun(runs, rel) {
    if (!isObj(runs) || !Object.prototype.hasOwnProperty.call(runs, rel)) return runs;
    const out = { ...runs };
    delete out[rel];
    return out;
  }

  // 落盘前的形状。只带白名单字段：运行时可能往对象上挂别的东西，不该跟着进 config。
  function serialize(run, now) {
    return {
      v: SCHEMA,
      current: run.current || null,
      done: run.done.slice(),
      skipped: run.skipped.slice(),
      history: run.history.slice(),
      values: { ...run.values },
      updatedAt: Number.isFinite(now) ? now : Date.now()
    };
  }

  return {
    SCHEMA, MAX_RUNS,
    entries, create, start, options, complete, skip, choose, back, canBack, status,
    mergeValues, restore, equal, cleanRuns, renameRun, dropRun, serialize
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FLOW_RUN;
