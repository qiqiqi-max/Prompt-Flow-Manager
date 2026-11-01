// 文件树多选的选择模型：渲染进程与测试共用这一份（加载方式同 src/frontmatter.js）。
//
// 只管"选中了哪些 rel、锚点在哪"，不碰 DOM。DOM 那一侧由 renderer.js 把每一行
// 折成 { rel, visible } 传进来，visible 必须按**渲染结果**算（offsetParent !== null），
// 见 CLAUDE.md 踩过的坑第 12 条：筛选写的是行内 display:none，折叠用的是
// .tree-children 上的 hidden 类，按 style 字符串判可见性只认得前一种。
//
// 为什么可见性过滤放在这里而不是让调用方先 filter 好再传：Shift+点击的范围
// 必须是"屏幕上从锚点到这一行之间看得见的那些"，夹在中间的折叠目录、被筛掉的行
// 都不能被顺带选上——否则批量删除会删掉用户根本看不见的文件。这条规则放进纯函数，
// 裸 node 才测得到它；留给调用方的话，漏掉过滤也照样能跑，只是选多了。
//
// 所有函数都返回新对象，不改入参：渲染进程整体替换 state.treeSelection，
// 不会出现"判断时一份、渲染时另一份"的半更新状态。
const TREE_SELECTION = {
  empty() {
    return { selected: new Set(), anchor: null };
  },

  // 普通单击打开文件时调用：不选中任何东西（打开文件的行为不变），只把锚点放在这一行。
  // 于是"点 A，Shift+点 D"选中 A..D，"点 A，Ctrl+点 B"选中 A 和 B——和资源管理器一致。
  focusAnchor(rel) {
    return { selected: new Set(), anchor: rel };
  },

  // Ctrl+点击：切换这一行，并把锚点挪到它身上（下一次 Shift+点击从这里起算）。
  // 选择为空、锚点还看得见且不是这一行时，先把锚点那一行并进来：用户刚单击打开 A，
  // 再 Ctrl+点 B，期望的是 A、B 两个都选上，而不是只有 B——后者要求用户先
  // Ctrl+点一下自己已经"选着"的 A，没人会想到。
  toggle(model, rel, rows) {
    const selected = new Set(model.selected);
    if (!selected.size && model.anchor != null && model.anchor !== rel && Array.isArray(rows)
      && rows.some(r => r && r.visible && r.rel === model.anchor)) {
      selected.add(model.anchor);
    }
    if (selected.has(rel)) selected.delete(rel);
    else selected.add(rel);
    return { selected, anchor: rel };
  },

  // Shift+点击：从锚点到 rel，按 rows 的顺序只取看得见的行。
  // additive 为 true（Ctrl+Shift）时并进已有选择，否则替换掉。
  // 锚点不存在或已经看不见时，退化成"只选这一行并把锚点设在这里"——
  // 拿一个看不见的锚点去算范围，选中的边界在屏幕上根本找不到。
  range(model, rel, rows, additive) {
    const visible = rows.filter(r => r && r.visible).map(r => r.rel);
    const to = visible.indexOf(rel);
    if (to === -1) return { selected: new Set(model.selected), anchor: model.anchor };
    const from = model.anchor == null ? -1 : visible.indexOf(model.anchor);
    const selected = additive ? new Set(model.selected) : new Set();
    if (from === -1) {
      selected.add(rel);
      return { selected, anchor: rel };
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    for (let i = lo; i <= hi; i++) selected.add(visible[i]);
    // 锚点不动：连续 Shift+点击时范围都从同一个起点算，这是文件管理器的通行做法。
    return { selected, anchor: model.anchor };
  },

  // 筛选、折叠、重建树之后调用：选择里已经不存在或者看不见的条目剔掉。
  // 锚点同理——留着一个看不见的锚点，下一次 Shift+点击会退化，但更糟的是
  // 它可能在下次展开后突然"复活"，范围起点跳到用户没想到的地方。
  prune(model, rows) {
    const visible = new Set(rows.filter(r => r && r.visible).map(r => r.rel));
    const selected = new Set([...model.selected].filter(rel => visible.has(rel)));
    const anchor = model.anchor != null && visible.has(model.anchor) ? model.anchor : null;
    return { selected, anchor };
  },

  // 按树上的顺序列出选中项。批量操作的执行顺序、结果汇总里的顺序都用它，
  // 不用 Set 的插入顺序——那是用户点选的先后，和屏幕上的顺序对不上。
  ordered(model, rows) {
    const out = [];
    for (const r of rows) if (r && model.selected.has(r.rel)) out.push(r.rel);
    return out;
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = TREE_SELECTION;
