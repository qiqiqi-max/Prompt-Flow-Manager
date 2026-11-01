// 占位符提取与填充：复制提示词之前那一步"填空"的纯逻辑，渲染进程与测试共用这一份。
//
// 为什么需要它：templates/prompt-template.md 写明了一条约定 —— 正文里用
// [提示文字] 标出需要替换的部分，种子提示词也都照做了。但 copyContent() 一直是
// 把正文原样塞进剪贴板，占位符原封不动，用户粘到对话框里再一个个手改；改漏一个
// 就是把 [在此描述要实现的功能] 原样发给模型。约定和代码之间缺的就是这一层。
//
// 加载方式和 src/i18n.js / src/frontmatter.js 一样：浏览器里靠 <script> 声明全局，
// 主进程 / 测试里靠结尾的 module.exports 直接 require。渲染进程禁用了 require
// （contextIsolation: true），所以不能用 CommonJS 单一入口。
//
// 注意（这是最容易被后来的人踩的假设）：传进来的 body 必须是**已经剥掉
// frontmatter 的正文**，也就是 FRONTMATTER.parse(content).body。这里不认
// frontmatter、也不会跳过它 —— 把整篇原文直接喂进来的话，`tags: [编码, 实现]`
// 会被当成一个占位符，用户一填就把 yaml 写坏。这个假设没有任何运行时检查能兜住，
// 唯一的防线是调用方（copyContent 已经先走 parseFrontmatter 取 body）和
// tests/placeholders.test.js 里那条专门盯它的断言。
//
// 判定规则见 isPlaceholder 上方那段注释。核心难点不是"找出 [...]"，而是
// Markdown 里一大堆同形但完全不是占位符的 [...] 用法都必须排除干净 —— 误判一个
// 就等于在用户的提示词里挖一个假空，填下去会改坏语义。
//
// 嵌套方括号的决定：`[外面 [里面] 外面]` 这种**整段放过，一个都不提取**。
// 理由：模板约定里的占位符从来是扁平的一层，出现嵌套时更可能是
// `[参考 [文档](url) 的写法]` 这类夹了链接的普通散文。若按"取最内层"处理，
// 用户填完会得到 `[外面 值 外面]` —— 半截被改写、方括号还留着，看上去就是个 bug；
// 若按"取最外层"处理，输入框的提示语里会塞进一整段 Markdown。两种都不如原样不动：
// 保留原文至少让用户看得见、能自己手改，这和"没填的 token 一律原样保留"是同一个取舍。
//
// ---- 扩展语法：选项与默认值 ----
//
// 先按上面那套规则判定"这对方括号是不是占位符"，判定是之后才解析里面的写法。
// 也就是说扩展语法**只改变一个已经算数的占位符怎么填**，不会让原来不算数的
// [...]（链接、勾选框、代码里的）变成算数 —— 唯一的例外是下面的表格规则，它只收紧。
//
//   选项   [语言|Python|Go|Rust]   第一段是提示文字，后面每段一个选项。
//          条件：按 | 切开**至少三段**、每段 trim 后非空、去重后至少两个选项、
//          里面没有 \|（转义的竖线是用户想写字面量）。
//          为什么要三段：两段的 [a|b] 在散文里几乎总是"a 或 b"的意思
//          （[是|否]、[前端|后端] 本来就是旧语法下的普通占位符），把它读成
//          "提示 a、唯一选项 b"既改了提示语又给出一个只有一项的下拉框。
//          两段的写法保持旧行为：整段当提示文字，hint 就是 "a|b"。
//   默认值 [目标=提升性能]           = 左边是提示文字，右边是默认值。
//          条件：恰好一个 =，紧贴两侧都不是空白，也不是 = ! < > 这几个字符，
//          两侧 trim 后都非空，且整段不含 ://（URL 的查询串 ?a=1 不是默认值）。
//          [x = 1]、[a==b]、[a>=b]、[=>]、[a=b=c] 都不满足，保持旧行为。
//          代价：默认值本身不能含 =；想在占位符提示语里写字面量等号，两侧加空格。
//   组合   [语言=Go|Python|Go|Rust]  只有第一段（提示段）认默认值；选项段里的 =
//          是选项文字的一部分。默认值不必是选项之一（选项只是候选，允许自定义）。
//
// 表格：GFM 表格行里 | 是单元格分隔符，`| 语言 | [a|b|c] |` 渲染出来根本不是一个
// 占位符而是被切开的几个单元格。所以位于表格（有表头分隔行 |---| 的那一块）里的
// [...] 只要含 |，一律不当占位符；不含 | 的照旧认（`| 目标 | [在此填写] |` 是常见写法）。
// 代价：表格单元格里没法用选项语法。
//
// 向后兼容的代价写在这里，免得以后有人当成 bug "修"掉：
//   - 原来就存在的 [a|b|c]、[k=v] 形状的占位符，token 原文不变（fillMemory 照旧命中），
//     但 hint 变成第一段 / 等号左边，填写时多了下拉框 / 预填值。
//   - 预填默认值意味着"不改直接复制"会把默认值填进去，见 withDefaults。
//   - 同一个 token 原文只解析一次：选项和默认值是 token 原文的函数，同文同义。
const PLACEHOLDERS = (function () {
  // 用 IIFE 而不是像 frontmatter.js 那样直接写对象字面量：下面这几个 helper 必须
  // 是私有的。渲染进程里这个文件是 <script> 加载的，顶层 function 声明就等于全局
  // 变量，叫 scanLine / maskInert 这种通名和 renderer.js 撞上就是 no-redeclare ——
  // i18n.js 的注释里记着一次同类事故：重复声明会让整个脚本一行都不执行。
  // 对外只暴露 PLACEHOLDERS 这一个全局。

  // 掩码字符。被判为"藏不住占位符"的区域整片换成它，长度和换行位置都不动，
  // 于是掩码串上算出来的下标可以直接拿去切原文。
  const MASK = '\u0000';

  // 围栏代码块的开 / 闭行。CommonMark：最多 3 个空格缩进，3 个以上的 ` 或 ~，
  // 收口要求同字符且不短于开栏。
  const FENCE = /^ {0,3}(`{3,}|~{3,})/;

  // 列表项前缀（含有序列表）。只用来算"列表项内容从第几列开始"：任务列表的
  // 勾选框必须正好长在那一列才算勾选框，否则 `- 见 [x] 一节` 也会被误杀。
  const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

  // GFM 表格的表头分隔行：| --- | :---: | 这种。至少要有一个 |，否则 `---` 是分隔线
  // （或 setext 标题的下划线），不是表格。
  const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

  // 默认值语法里那个 =：前后紧贴的字符不能是空白或 = ! < >。
  // 用前后环视而不是 split('=')：要同时排除 [x = 1]（散文里的等式）和
  // [a==b] / [a>=b]（比较），split 之后这些信息就没了。
  const DEFAULT_EQ = /(?<=[^\s=!<>])=(?=[^\s=!<>])/;

  // 解析一个已经判定为占位符的方括号内文（不含方括号、未 trim）。
  // 返回 { hint, options, default }：options 没有时是空数组，default 没有时是 null。
  // 规则和理由见文件头"扩展语法"一节；任何一条不满足都退回旧行为（整段 trim 当 hint）。
  function parseInner(inner) {
    const plain = { hint: inner.trim(), options: [], default: null };
    let head = inner;
    let options = [];
    if (inner.includes('|') && !inner.includes('\\|')) {
      const segs = inner.split('|').map(s => s.trim());
      // "至少三段"不单独判断：两段只有一个选项，过不了下面"去重后至少两个"那一条。
      if (segs.every(Boolean)) {
        const uniq = Array.from(new Set(segs.slice(1)));
        if (uniq.length >= 2) { head = segs[0]; options = uniq; }
      }
    }
    let hint = head.trim();
    let def = null;
    // 两侧非空不用再判：hint 已 trim，DEFAULT_EQ 又要求 = 两侧紧贴非空白字符
    // （正向环视，字符串开头 / 结尾不满足），[=foo] / [foo=] 在这里就过不去。
    if (!hint.includes('://') && hint.split('=').length === 2 && DEFAULT_EQ.test(hint)) {
      const at = hint.indexOf('=');
      def = hint.slice(at + 1).trim();
      hint = hint.slice(0, at).trim();
    }
    if (!options.length && def === null) return plain;
    return { hint, options, default: def };
  }

  // 每一行是否落在 GFM 表格里，按行号给出布尔数组。
  // 一律看原文：GFM 切单元格时行内代码里的 | 也算数。
  // 表格 = 一行含 | 的表头 + 紧跟的分隔行 + 之后直到空行 / 围栏行为止的各行。
  // 围栏块里长得像表格的内容不用另外排除：那几行本来就被掩码，不会产出占位符；
  // 要防的是表格"漫过"围栏把围栏后面的行也算进去，所以延伸遇到围栏行就停。
  // 不校验列数是否对得上，也不管中途有没有别的块开始：这条规则只影响含 | 的 [...]，
  // 多认几行的代价只是那几行里的 [a|b|c] 不当选项用；少认则会把被单元格切开的
  // 东西当成占位符，后者更坏。
  function tableRows(olines) {
    const inTable = olines.map(() => false);
    for (let k = 1; k < olines.length; k++) {
      if (!olines[k].includes('|') || !TABLE_DELIM.test(olines[k])) continue;
      if (!olines[k - 1].includes('|')) continue;
      inTable[k - 1] = true;
      let r = k;
      for (; r < olines.length && olines[r].trim() && !FENCE.test(olines[r]); r++) inTable[r] = true;
      k = r;
    }
    return inTable;
  }

  // [起始下标, 结束下标) 的逐行切片。不用 split('\n') 是因为后面所有判断都按
  // 全文下标走（掩码串和原文共用一套下标），split 之后就得再自己累加偏移。
  function lineSpans(s) {
    const spans = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\n') { spans.push([start, i]); start = i + 1; }
    }
    spans.push([start, s.length]);
    return spans;
  }

  // 行内代码：` 的连续段按等长配对（CommonMark 的规则），配上的一对连同中间内容
  // 一起掩掉。落单的 ` 是普通字符，不掩。
  //
  // 这一条不是假想需求：prompt-template.md 里"用 `[占位符]` 标出需要替换的部分"
  // 正是这种情况 —— 那句话是在讲这条约定本身，不是一个要填的空。
  function maskCodeSpans(line, base, blank) {
    const runs = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '`') continue;
      let j = i;
      while (j < line.length && line[j] === '`') j++;
      runs.push([i, j - i]);
      i = j - 1;
    }
    for (let a = 0; a < runs.length; a++) {
      const open = runs[a];
      for (let b = a + 1; b < runs.length; b++) {
        if (runs[b][1] !== open[1]) continue;
        blank(base + open[0], base + runs[b][0] + runs[b][1]);
        a = b; // 收口之后从它后面接着找，别把收口那段又当成新的开口
        break;
      }
    }
  }

  // 逐行跑围栏状态机 + 行内代码配对，产出和原文等长的掩码串。
  // 行内代码只在围栏外处理；围栏没收口就一直惰性到文末（CommonMark 就是这个行为）。
  function maskInert(s) {
    const buf = s.split('');
    const blank = (from, to) => {
      for (let k = from; k < to; k++) {
        if (buf[k] !== '\n' && buf[k] !== '\r') buf[k] = MASK;
      }
    };
    let fence = null;
    for (const span of lineSpans(s)) {
      const line = s.slice(span[0], span[1]);
      const m = line.match(FENCE);
      if (fence) {
        blank(span[0], span[1]);
        if (m && m[1][0] === fence.char && m[1].length >= fence.len) fence = null;
        continue;
      }
      if (m) {
        blank(span[0], span[1]); // 开栏行本身也掩：info string 里照样可能有 []
        fence = { char: m[1][0], len: m[1].length };
        continue;
      }
      maskCodeSpans(line, span[0], blank);
    }
    return buf.join('');
  }

  // 一行里找出所有真占位符，push 进 hits。
  // oline 是原文那一行、mline 是同一行的掩码版；相邻字符一律看原文（掩码只用来
  // 决定"这个 [ 算不算数"，不该影响"] 后面是不是 ( "这类对文档事实的判断）。
  //
  // 匹配不跨行：按行扫本身就保证了这一点。跨行的 [ 通常是别的东西写歪了（表格、
  // 没收口的链接），把它当占位符会让 fill 一刀切掉中间好几行内容。
  //
  // inTable 为真时这一行在 GFM 表格里，含 | 的 [...] 不算（见文件头"表格"一段）。
  function scanLine(oline, mline, base, hits, inTable) {
    const listPrefix = oline.match(LIST_ITEM);
    const itemStart = listPrefix ? listPrefix[0].length : -1;
    for (let i = 0; i < mline.length; i++) {
      if (mline[i] !== '[') continue;

      // 按深度找配对的 ]，顺手记下中间有没有再开一层。
      let depth = 0;
      let j = i;
      let nested = false;
      for (; j < mline.length; j++) {
        const c = mline[j];
        if (c === '[') { depth++; if (depth > 1) nested = true; }
        else if (c === ']') { depth--; if (depth === 0) break; }
      }
      // 没收口：这个 [ 是散文里的半截括号。从下一个字符继续找 —— 不知道它到哪
      // 结束，跳到别处都是猜。
      if (j >= mline.length) continue;
      // 嵌套整段放过（理由见文件头）。i = j 让外层 i++ 接到 ] 后面，
      // 内层那个 [里面] 不会被回头捡起来。
      if (nested) { i = j; continue; }

      const inner = mline.slice(i + 1, j);
      const before = i > 0 ? oline[i - 1] : '';
      const after = j + 1 < oline.length ? oline[j + 1] : '';

      // 行内链接 / 图片：[文字](url)、![alt](url)。] 紧跟 ( 就是链接目标，
      // CommonMark 不允许中间有空格，所以只看紧邻那一个字符。
      if (after === '(') continue;
      // 图片语法的 alt：! 紧贴 [ 时这对方括号是 alt 文本，不是空。
      if (before === '!') continue;
      // 引用式链接 [文字][ref]：标签段（] 后紧跟 [）和引用段（[ 前紧贴 ]）
      // 两头都要放过。少了第二条，[ref] 会被当成一个待填的空。
      if (after === '[') continue;
      if (before === ']') continue;
      // 链接定义行 [ref]: https://...
      // 必须限定在行首（前面只有空白），否则 `- **目标环境**：[如 生产 / 预发]`
      // 这种"冒号在前"的正常行会被牵连。注意只认半角 :，全角 ： 是散文。
      if (after === ':' && /^[ \t]*$/.test(oline.slice(0, i))) continue;
      // 任务列表勾选框 - [ ] / - [x]。位置必须正好是列表项内容的第一列。
      if (itemStart === i && /^[xX ]$/.test(inner)) continue;
      // 空的或只有空白的：[]、[ ]、[    ]。这些是数组字面量、勾选框、排版，
      // 没有任何提示语可显示，当成空只会给用户一个填不明白的输入框。
      if (!inner.trim()) continue;
      // 表格单元格里的 |：GFM 先按 | 切单元格，这对方括号在渲染结果里已经不存在了。
      if (inTable && inner.includes('|')) continue;

      const parsed = parseInner(inner);
      hits.push({
        token: oline.slice(i, j + 1), // 含方括号的完整原文，fill 的 key 就是它
        hint: parsed.hint,            // 输入框提示语（选项语法取第一段，默认值语法取 = 左边）
        options: parsed.options,      // 下拉候选，没有时是 []
        default: parsed.default,      // 默认值，没有时是 null
        start: base + i,
        end: base + j + 1             // 右开
      });
      i = j;
    }
  }

  function scanBody(body) {
    const src = String(body == null ? '' : body);
    const masked = maskInert(src);
    const hits = [];
    const spans = lineSpans(src);
    const olines = spans.map(sp => src.slice(sp[0], sp[1]));
    const mlines = spans.map(sp => masked.slice(sp[0], sp[1]));
    const inTable = tableRows(olines);
    spans.forEach((sp, k) => scanLine(olines[k], mlines[k], sp[0], hits, inTable[k]));
    return hits;
  }

  // values 里取 token 对应的值。空串 / 只有空白 / 没这个 key 一律当"没填"。
  // 只有空白也算没填是刻意的：输入框里误敲了一个空格，若照填就等于把提示语
  // 悄悄抹成空白 —— 那正是这个模块要防的事。
  function valueFor(values, token) {
    if (!values) return '';
    let v;
    if (typeof Map !== 'undefined' && values instanceof Map) v = values.get(token);
    else if (Object.prototype.hasOwnProperty.call(values, token)) v = values[token];
    if (v == null) return '';
    const s = String(v);
    return s.trim() ? s : '';
  }

  return {
    // 正文里所有真占位符的出现位置，按出现顺序，**不去重**。
    // 每项 { token, hint, options, default, start, end }，end 右开。
    // fill 需要位置（同名 token 可能一部分在代码块里，只能按位置替换），
    // UI 要做高亮也用得上。
    scan: scanBody,

    // 去重后按首次出现顺序返回 [{ token, hint, options, default }]。
    //   token   含方括号的原文，fill 的 key，也是 fillMemory 的 key。扩展语法下照样是
    //           整段原文（[语言|Python|Go|Rust]），不是 hint —— 换成 hint 会让
    //           [语言|Python|Go] 和 [语言|Go|Rust] 共用一个 key，填一个改俩。
    //   hint    输入框提示语（已 trim）。旧语法下是方括号里的全部文字。
    //   options 下拉候选（字符串数组，已去重）。旧语法下是 []。
    //   default 默认值字符串。旧语法下是 null。
    // 新增字段对旧调用方是纯追加：只读 token / hint 的代码行为不变。
    // 没有占位符时返回空数组 —— 调用方据此决定要不要弹填充面板。
    extract(body) {
      const seen = new Set();
      const out = [];
      for (const hit of scanBody(body)) {
        if (seen.has(hit.token)) continue;
        seen.add(hit.token);
        out.push({ token: hit.token, hint: hit.hint, options: hit.options.slice(), default: hit.default });
      }
      return out;
    },

    // 把默认值并进 values，返回一个新的普通对象（不改传入的 values）：
    // 某个 token 在 values 里没填（没这个 key / 空串 / 只有空白，判定和 fill 同一套）
    // 而它有默认值时，取默认值；填了的一律以填的为准。
    //
    // 为什么不让 fill 自己套默认值：fill 的底线是"没填的原样保留"，填充面板的
    // "直接复制原文"就是传 {} 给 fill，要的正是一字不动。默认值该不该生效是调用方的
    // 决定（"用户没改直接复制"才生效），所以拆成单独一步，fill 的签名和语义都不变。
    //
    // 优先级（从高到低）：values 里这次填的 > 默认值。上次填过的值（fillMemory）
    // 由调用方在预填时排在默认值前面，见 renderer.js 的 promptFillPlaceholders。
    withDefaults(body, values) {
      const out = {};
      if (values && typeof Map !== 'undefined' && values instanceof Map) {
        for (const [k, v] of values) out[k] = v;
      } else if (values) {
        for (const k of Object.keys(values)) out[k] = values[k];
      }
      for (const hit of scanBody(body)) {
        if (hit.default === null || valueFor(out, hit.token)) continue;
        out[hit.token] = hit.default;
      }
      return out;
    },

    // 用 values（token -> 用户填的值，普通对象或 Map）替换正文里的占位符，返回新正文。
    //
    // 两条语义是底线，别"顺手优化"掉：
    //   1. 没填 / 填了空白的 token **原样保留**。用户可能故意跳过某一项，
    //      抹成空白等于悄悄改了提示词的语义，而且改完还看不出来少了什么。
    //   2. 同一个 token 出现多次全部替换 —— 但只替换 scan 认过的那些位置。
    //      按 split/join 全文替换会连带改掉代码块和行内代码里同样的字面量。
    fill(body, values) {
      const src = String(body == null ? '' : body);
      const hits = scanBody(src);
      let out = '';
      let at = 0;
      for (const hit of hits) {
        const v = valueFor(values, hit.token);
        if (!v) continue;
        out += src.slice(at, hit.start) + v;
        at = hit.end;
      }
      return out + src.slice(at);
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PLACEHOLDERS;
