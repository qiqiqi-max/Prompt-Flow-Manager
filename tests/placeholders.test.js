// tests/placeholders.test.js
// 回归测试：src/placeholders.js 的 extract / fill。
//
// 为什么单独一个文件：这个模块的全部难度在"判定"上，而判定的失败方式是**静默**的。
// 少提取一个占位符，用户把 [在此描述要实现的功能] 原样发给模型；多提取一个，
// 填充面板上多出一个假空，填下去会把 [文字](url) 改成 [值](url) —— 链接文字被
// 悄悄替换。两种都不会抛错、不会有任何日志，只能靠断言在这里拦住。
//
// 基准用仓库里的真实种子文件，不用手写小字符串：手写的例子只能证明"我想到的情况
// 是对的"，而这批 .md 是用户真正会点复制的那些内容，也是模板约定的实际样本。
// 每个文件里的占位符是数出来的，断言写死具体条数和具体 token 原文 —— `>= 1`
// 这种断言在"多提取了两个"的情况下照样绿。
//
// 反向对照在文件末尾：同一批断言拿一个**朴素正则实现**（只 /\[([^\]\n]+)\]/g
// 扫一遍 + split/join 全文替换，不排除链接 / 行内代码 / 围栏块）再跑一遍，要求它
// 必须红够多条。它证明的是"这批断言有分辨力"，不是"朴素实现有 bug"——后者是显然的。
// 做法照 tests/contrast.test.js 末尾那条"旧配色确实被判不达标（N 对）"。
//
// 不启动 Electron：这个模块只有纯字符串逻辑。
// 运行：PFM_DATA_DIR=<临时目录> npm run test:placeholders
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const PLACEHOLDERS = require(path.join(root, 'src', 'placeholders.js'));
const FRONTMATTER = require(path.join(root, 'src', 'frontmatter.js'));

// ---------- 基准：仓库里的真实种子文件 ----------
//
// 条数和 token 原文都是逐个文件数出来的（见各条断言）。改种子内容会让这些断言变红，
// 这是故意的：它们是这个模块的验收基准，不是可以随手跟着改的期望值。
const SEEDS = {
  template: 'templates/prompt-template.md',
  codegen: 'prompts/code-generation/功能实现.md',
  init: 'prompts/project-init/需求分析.md',
  deploy: 'prompts/deployment/部署检查.md',
  testing: 'prompts/testing/测试策略.md',
  review: 'prompts/code-review/代码审查.md'
};

// 正文 = 剥掉 frontmatter 之后的部分。copyContent() 就是这么取的，
// placeholders.js 的文件头也把这一点写成了前提。
const bodies = {};
const raws = {};
for (const [key, rel] of Object.entries(SEEDS)) {
  raws[key] = fs.readFileSync(path.join(root, rel), 'utf8');
  bodies[key] = FRONTMATTER.parse(raws[key]).body;
}

// 各种"同形但不是占位符"的 Markdown 用法。每一类单独一行，断言逐类检查。
const NOT_PLACEHOLDER = {
  行内链接: '详见 [使用说明](https://example.com/doc) 一节。',
  带标题的链接: '详见 [使用说明](https://example.com/doc "标题") 一节。',
  图片: '![界面截图](./shot.png) 就是这个样子。',
  引用式链接: '详见 [使用说明][doc-ref] 一节。',
  链接定义行: '[doc-ref]: https://example.com/doc',
  未勾选任务: '- [ ] 还没做的事',
  已勾选任务: '- [x] 已经做完的事',
  大写已勾选: '- [X] 已经做完的事',
  行内代码: '用 `[占位符]` 标出需要替换的部分',
  双反引号行内代码: '用 ``[占位符]`` 标出需要替换的部分',
  空方括号: '数组是 [] 或者 [   ] 这种。'
};

// 围栏代码块：代码里的 []、[0]、数组字面量太常见。
const FENCED = [
  '前面的散文。',
  '```js',
  'const a = arr[0];',
  'const b = [1, 2, 3];',
  'const c = obj[key];',
  '```',
  '后面的散文。'
].join('\n');

const FENCED_TILDE = [
  '~~~',
  'items[index] = [值]',
  '~~~'
].join('\n');

// 跨行的方括号：匹配不许跨过换行。
const CROSS_LINE = '这里开了一个 [没有\n收口的方括号] 在下一行。';

// 嵌套：placeholders.js 的决定是整段放过（理由见那个文件的文件头）。
const NESTED = '请 [参考 [文档](https://example.com) 的写法] 来写。';

// fill 的"不误伤"基准。同一个 token 出现四次：两次是真占位符，
// 一次在行内代码里，一次在围栏块里。后两次必须一字不动。
const FILL_BODY = [
  '# 标题',
  '',
  '- **甲**：[填我]',
  '- **乙**：[别填我]',
  '- **甲又一次**：[填我]',
  '',
  '说明：用 `[填我]` 表示要替换的地方。',
  '',
  '```',
  'echo "[填我]"',
  '```',
  '',
  '参考 [填我](https://example.com) 这个链接。'
].join('\n');

// 逐字写死的期望结果。这是最强的形式：任何误伤都会改掉某个字节，
// 而不是只改掉我恰好想到要查的那几处。
const FILL_EXPECTED = [
  '# 标题',
  '',
  '- **甲**：真实的值',
  '- **乙**：[别填我]',
  '- **甲又一次**：真实的值',
  '',
  '说明：用 `[填我]` 表示要替换的地方。',
  '',
  '```',
  'echo "[填我]"',
  '```',
  '',
  '参考 [填我](https://example.com) 这个链接。'
].join('\n');

const tokensOf = (impl, body) => impl.extract(body).map(p => p.token);

// ---------- 扩展语法：选项 [提示|a|b] 与默认值 [提示=值] ----------
//
// 断言名集中定义成常量：下面的变异对照要按名字点"必须变红的那一条"，
// 名字写两遍的话改了一边、另一边静默对不上，对照就成了空对照。
const CK = {
  deploySyntax: '部署检查.md 的 hint / options / default 解析正确（内置示例）',
  options: '选项：[语言|Python|Go|Rust] 解析出提示与三个选项',
  twoSegs: '选项：两段的 [是|否] 保持旧行为（整段是提示文字，没有选项）',
  emptySeg: '选项：有空段的 [a||b] / [|a|b] / [a|b|] 不算选项',
  escapedPipe: '选项：含 \\| 的不算选项（用户想写字面量竖线）',
  dedup: '选项：重复项去重，去重后不足两个就不算选项',
  defaultBasic: '默认值：[目标=提升性能] 解析出提示与默认值',
  defaultSpaced: '默认值：[x = 1] 两侧有空格的是散文，不算默认值',
  defaultCompare: '默认值：[a==b] / [a>=b] / [a!=b] / [a<=b] / [=>] 这类比较不算默认值',
  defaultMulti: '默认值：[a=b=c] 多个等号不算默认值',
  defaultUrl: '默认值：[https://x.com/?a=1] 带 :// 的 URL 不算默认值',
  defaultEmpty: '默认值：[=foo] / [foo=] 一侧为空不算默认值',
  combo: '组合：[语言=Go|Python|Go|Rust] 默认值只认第一段，选项段里的 = 是文字',
  tableCell: '表格：单元格里含 | 的方括号不当占位符（GFM 先按 | 切单元格）',
  tablePlain: '表格：单元格里不含 | 的普通占位符照旧提取',
  tableEnds: '表格：空行之后恢复识别，正文里的选项语法照常生效',
  tableFence: '表格：延伸到围栏行就停，围栏后面的行不算表格',
  notTable: '表格：没有分隔行的 | 行不是表格，选项语法照常生效',
  exclusions: '扩展语法不破坏排除规则：链接 / 图片 / 行内代码 / 围栏块 / 勾选框里的一个都不提取',
  shape: 'extract 每项都有 token / hint / options / default 四个字段（旧语法 options=[]、default=null）',
  tokenRaw: 'token 仍是占位符原文（fillMemory 的 key），不是 hint',
  distinct: '[目标] 和 [目标=提升性能] 是两个不同的 token',
  dedupToken: '同一个扩展语法 token 出现多次只提取一次',
  fillNoDefault: 'fill 不套默认值（"直接复制原文"传 {}，必须一字不动）',
  fillOptToken: 'fill 按整段原文替换选项 token（逐字对比）',
  fillMultiline: 'fill 原样插入多行值',
  wdApply: 'withDefaults：没填 / 填了空白的 token 取默认值',
  wdPrefer: 'withDefaults：填了的值优先于默认值',
  wdPure: 'withDefaults：不改传入的 values，没有默认值的 token 不凭空加 key',
  wdMap: 'withDefaults：values 是 Map 时同样生效',
  wdEndToEnd: 'withDefaults + fill：没改直接复制按默认值填（逐字对比）'
};

const COMBO = '[语言=Go|Python|Go|Rust]';
const TABLE = [
  '| 项目 | 取值 |',
  '| --- | :---: |',
  '| 语言 | [a|b|c] |',
  '| 目标 | [在此填写] |',
  '',
  '正文：[语言|Python|Go|Rust]'
].join('\n');
const TABLE_NO_LEAD = [
  '项目 | 取值',
  '--- | ---',
  '语言 | [甲|乙|丙]'
].join('\n');
const FENCED_DELIM = [
  '```',
  '| a |',
  '|---|',
  '```',
  '[语言|Python|Go|Rust]'
].join('\n');
// 两行都含 |：没有分隔行时它们也凑得成"表头 + 下一行"，少了分隔行这条要求就会被当成表格。
const PIPE_PROSE = '选一个 | [语言|Python|Go|Rust] | 都行\n或者 | 别的 | 也行';
const EXT_EXCLUDED = [
  '[语言|Python|Go](https://example.com)',
  '![目标=提升性能](./a.png)',
  '用 `[语言|Python|Go]` 和 ``[目标=提升性能]`` 表示',
  '```',
  '[语言|Python|Go]',
  'x[目标=提升性能]',
  '```',
  '- [x] 完成',
  '[目标=提升性能]: https://example.com'
].join('\n');
const FILL_EXT_BODY = [
  '语言：[语言|Python|Go|Rust]',
  '目标：[目标=提升性能]',
  '代码：`[语言|Python|Go|Rust]`',
  '再一次：[语言|Python|Go|Rust]'
].join('\n');

// ---------- 断言集：真实模块和朴素实现都跑这一批 ----------
function runChecks(impl) {
  const results = [];
  const ok = (name, cond, detail) => {
    let pass = false;
    let note = detail;
    try {
      pass = !!cond();
    } catch (e) {
      note = '抛出异常：' + (e && e.message ? e.message : e);
    }
    results.push([name, pass, typeof note === 'function' ? note() : note]);
  };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ===== 种子文件：具体条数 + 具体 token 原文 =====

  // templates/prompt-template.md 正文里只有一个 [...]，而它在行内代码里：
  // "输入格式（用 `[占位符]` 标出需要替换的部分）"。那句话是在讲这条约定本身，
  // 不是一个要填的空。所以真占位符是 0 个。
  ok('模板文件提取到 0 个占位符（唯一的 [...] 在行内代码里）',
    () => tokensOf(impl, bodies.template).length === 0,
    () => JSON.stringify(tokensOf(impl, bodies.template)));
  // 单独一条盯死"行内代码里的 [占位符] 没被提取"。这是任务里点名的真实样例。
  ok('模板文件行内代码里的 [占位符] 没被提取',
    () => !tokensOf(impl, bodies.template).includes('[占位符]'),
    () => JSON.stringify(tokensOf(impl, bodies.template)));
  // 前置条件：确认那句话真的在文件里。不验这一步，上面两条可能只是因为
  // 文件被改过而空绿 —— heal.test.js 踩过这个坑（以为清空库能让断言变红）。
  ok('前置：模板文件里确实有 `[占位符]` 这句话',
    () => bodies.template.includes('`[占位符]`'));

  // prompts/code-generation/功能实现.md：上下文小节三条，正好三个。
  // 文件里还有一个围栏块（// 文件：path/to/file.ts），里面没有方括号。
  ok('功能实现.md 提取到 3 个占位符',
    () => tokensOf(impl, bodies.codegen).length === 3,
    () => JSON.stringify(tokensOf(impl, bodies.codegen)));
  ok('功能实现.md 的 3 个 token 原文与顺序都对',
    () => eq(tokensOf(impl, bodies.codegen), [
      '[如 React + TypeScript + Vite]',
      '[在此描述要实现的功能]',
      '[列出涉及的文件路径，或粘贴现有代码]'
    ]),
    () => JSON.stringify(tokensOf(impl, bodies.codegen)));
  ok('功能实现.md 的 hint 是去掉方括号的文字',
    () => eq(impl.extract(bodies.codegen).map(p => p.hint), [
      '如 React + TypeScript + Vite',
      '在此描述要实现的功能',
      '列出涉及的文件路径，或粘贴现有代码'
    ]),
    () => JSON.stringify(impl.extract(bodies.codegen).map(p => p.hint)));

  // prompts/project-init/需求分析.md："## 我的想法"下面独占一行的那一个。
  ok('需求分析.md 提取到 1 个占位符，token 正确',
    () => eq(tokensOf(impl, bodies.init), ['[在此粘贴你的想法、用户原话、或问题描述]']),
    () => JSON.stringify(tokensOf(impl, bodies.init)));

  // prompts/deployment/部署检查.md：发布信息小节三条。
  // 注意这三条都是 "**目标环境**：[...]" 的形状 —— 冒号在方括号**前面**，
  // 不是链接定义行 [ref]: url，不能被那条规则牵连。
  // 这个文件也是扩展语法的内置示例：一条选项、一条旧语法、一条默认值 + 选项。
  ok('部署检查.md 提取到 3 个占位符，token 与顺序都对',
    () => eq(tokensOf(impl, bodies.deploy), [
      '[目标环境|生产|预发|测试]',
      '[在此描述变更内容]',
      '[部署方式=Docker|Docker|静态资源|CI 流水线]'
    ]),
    () => JSON.stringify(tokensOf(impl, bodies.deploy)));
  ok(CK.deploySyntax,
    () => eq(impl.extract(bodies.deploy).map(p => [p.hint, p.options, p.default]), [
      ['目标环境', ['生产', '预发', '测试'], null],
      ['在此描述变更内容', [], null],
      ['部署方式', ['Docker', '静态资源', 'CI 流水线'], 'Docker']
    ]),
    () => JSON.stringify(impl.extract(bodies.deploy)));

  // prompts/testing/测试策略.md："## 被测功能"下面独占一行的那一个。
  ok('测试策略.md 提取到 1 个占位符，token 正确',
    () => eq(tokensOf(impl, bodies.testing), ['[在此描述功能或粘贴实现]']),
    () => JSON.stringify(tokensOf(impl, bodies.testing)));

  // prompts/code-review/代码审查.md：通篇没有占位符（全是审查维度清单）。
  // 这条防的是"宁可多报"的实现：面板对这个文件必须完全不弹。
  ok('代码审查.md 提取到 0 个占位符',
    () => tokensOf(impl, bodies.review).length === 0,
    () => JSON.stringify(tokensOf(impl, bodies.review)));

  // ===== 逐类排除 =====
  for (const [label, text] of Object.entries(NOT_PLACEHOLDER)) {
    ok('排除：' + label,
      () => tokensOf(impl, text).length === 0,
      () => JSON.stringify(tokensOf(impl, text)));
  }
  ok('排除：围栏代码块（```）里的方括号',
    () => tokensOf(impl, FENCED).length === 0,
    () => JSON.stringify(tokensOf(impl, FENCED)));
  ok('排除：围栏代码块（~~~）里的方括号',
    () => tokensOf(impl, FENCED_TILDE).length === 0,
    () => JSON.stringify(tokensOf(impl, FENCED_TILDE)));
  ok('排除：跨行的方括号',
    () => tokensOf(impl, CROSS_LINE).length === 0,
    () => JSON.stringify(tokensOf(impl, CROSS_LINE)));
  ok('排除：嵌套方括号整段放过',
    () => tokensOf(impl, NESTED).length === 0,
    () => JSON.stringify(tokensOf(impl, NESTED)));
  // 围栏块收口之后必须恢复识别，不能把后面整篇都当代码。
  ok('围栏块之后恢复识别',
    () => eq(tokensOf(impl, FENCED + '\n\n- 目标：[在此填写]'), ['[在此填写]']),
    () => JSON.stringify(tokensOf(impl, FENCED + '\n\n- 目标：[在此填写]')));
  // 一行里既有链接又有占位符：只认占位符。
  ok('同一行里的链接被排除、占位符被认出',
    () => eq(tokensOf(impl, '按 [规范](https://example.com) 实现 [目标功能] 即可。'), ['[目标功能]']),
    () => JSON.stringify(tokensOf(impl, '按 [规范](https://example.com) 实现 [目标功能] 即可。')));

  // ===== 去重与顺序 =====
  ok('extract 去重且按首次出现顺序',
    () => eq(tokensOf(impl, '[乙] 然后 [甲]\n再来一次 [乙]\n最后 [甲]'), ['[乙]', '[甲]']),
    () => JSON.stringify(tokensOf(impl, '[乙] 然后 [甲]\n再来一次 [乙]\n最后 [甲]')));

  // ===== fill =====
  ok('fill 替换掉填了值的 token（逐字对比整篇结果）',
    () => impl.fill(FILL_BODY, { '[填我]': '真实的值' }) === FILL_EXPECTED,
    () => JSON.stringify(impl.fill(FILL_BODY, { '[填我]': '真实的值' })));
  ok('fill 同一个 token 出现多次全部替换',
    () => impl.fill(FILL_BODY, { '[填我]': '真实的值' }).split('真实的值').length - 1 === 2,
    () => JSON.stringify(impl.fill(FILL_BODY, { '[填我]': '真实的值' })));
  ok('fill 对没填的 token 原样保留',
    () => impl.fill(FILL_BODY, { '[填我]': '真实的值' }).includes('[别填我]'));
  ok('fill 对填了空串的 token 原样保留',
    () => impl.fill(FILL_BODY, { '[填我]': '真实的值', '[别填我]': '' }).includes('[别填我]'),
    () => JSON.stringify(impl.fill(FILL_BODY, { '[填我]': '真实的值', '[别填我]': '' })));
  ok('fill 对只填了空白的 token 原样保留',
    () => impl.fill(FILL_BODY, { '[别填我]': '   ' }).includes('[别填我]'),
    () => JSON.stringify(impl.fill(FILL_BODY, { '[别填我]': '   ' })));
  ok('fill 不传 values 时原文一字不动',
    () => impl.fill(FILL_BODY, {}) === FILL_BODY && impl.fill(FILL_BODY, null) === FILL_BODY);
  ok('fill 不动行内代码里的同名字面量',
    () => impl.fill(FILL_BODY, { '[填我]': '真实的值' }).includes('`[填我]`'));
  ok('fill 不动围栏块里的同名字面量',
    () => impl.fill(FILL_BODY, { '[填我]': '真实的值' }).includes('echo "[填我]"'));
  ok('fill 不动链接文字里的同名字面量',
    () => impl.fill(FILL_BODY, { '[填我]': '真实的值' }).includes('[填我](https://example.com)'));

  // 真实文件上的"除目标 token 外字节不变"：把值换回 token 必须逐字还原原文。
  // 值选一个原文里不可能出现的串，这样 split/join 还原是安全的。
  const MARK = '《填充测试值》';
  const filledSeed = impl.fill(bodies.codegen, { '[在此描述要实现的功能]': MARK });
  ok('fill 在真实文件上除目标 token 外字节不变',
    () => filledSeed.split(MARK).join('[在此描述要实现的功能]') === bodies.codegen);
  ok('fill 在真实文件上确实改了一处（前置条件）',
    () => filledSeed !== bodies.codegen && filledSeed.split(MARK).length - 1 === 1);
  // 只填一个，另外两个必须还在。
  ok('fill 在真实文件上保留了另外两个没填的 token',
    () => filledSeed.includes('[如 React + TypeScript + Vite]')
      && filledSeed.includes('[列出涉及的文件路径，或粘贴现有代码]'));

  // ===== 文件头写明的前提：body 必须已剥掉 frontmatter =====
  // 这条不是测模块的行为，是把那个假设钉在测试里：整篇原文喂进来会把
  // `tags: [编码, 实现, 通用]` 当成占位符，用户一填就把 yaml 写坏。
  ok('前提：整篇原文（带 frontmatter）喂进来会误抓 tags 数组',
    () => tokensOf(impl, raws.codegen).includes('[编码, 实现, 通用]'),
    () => JSON.stringify(tokensOf(impl, raws.codegen)));
  ok('前提：走 FRONTMATTER.parse().body 则不会抓到 tags 数组',
    () => !tokensOf(impl, bodies.codegen).includes('[编码, 实现, 通用]'));

  // ===== 边界输入 =====
  ok('空输入 / null / undefined 不抛错，返回空数组',
    () => eq(impl.extract(''), []) && eq(impl.extract(null), []) && eq(impl.extract(undefined), []));

  // ===== 扩展语法 =====
  // 每条都同时查"认了"和"认成什么"：只查条数的话，把 [语言|Python|Go] 当成
  // 旧语法（hint 是整段）也是 1 条，照样绿。
  const ext = (text) => impl.extract(text).map(p => [p.hint, p.options, p.default]);
  const show = (text) => () => JSON.stringify(impl.extract(text));

  ok(CK.options, () => eq(ext('[语言|Python|Go|Rust]'), [['语言', ['Python', 'Go', 'Rust'], null]]),
    show('[语言|Python|Go|Rust]'));
  // 段两侧的空白 trim 掉：[ 语言 | Python | Go ] 和紧凑写法同义。
  ok('选项：段两侧的空白被 trim',
    () => eq(ext('[ 语言 | Python | Go ]'), [['语言', ['Python', 'Go'], null]]),
    show('[ 语言 | Python | Go ]'));
  ok(CK.twoSegs, () => eq(ext('[是|否]'), [['是|否', [], null]]), show('[是|否]'));
  ok(CK.emptySeg,
    () => eq(ext('[a||b] [|a|b] [a|b|]'), [['a||b', [], null], ['|a|b', [], null], ['a|b|', [], null]]),
    show('[a||b] [|a|b] [a|b|]'));
  ok(CK.escapedPipe, () => eq(ext('[正则 a\\|b|c|d]'), [['正则 a\\|b|c|d', [], null]]),
    show('[正则 a\\|b|c|d]'));
  ok(CK.dedup,
    () => eq(ext('[语言|Go|Go|Rust] [语言|Go|Go]'), [['语言', ['Go', 'Rust'], null], ['语言|Go|Go', [], null]]),
    show('[语言|Go|Go|Rust] [语言|Go|Go]'));

  ok(CK.defaultBasic, () => eq(ext('[目标=提升性能]'), [['目标', [], '提升性能']]), show('[目标=提升性能]'));
  ok(CK.defaultSpaced, () => eq(ext('[x = 1]'), [['x = 1', [], null]]), show('[x = 1]'));
  ok(CK.defaultCompare,
    () => eq(ext('[a==b] [a>=b] [a!=b] [a<=b] [=>]').map(r => r[2]), [null, null, null, null, null]),
    show('[a==b] [a>=b] [a!=b] [a<=b] [=>]'));
  ok(CK.defaultMulti, () => eq(ext('[a=b=c]'), [['a=b=c', [], null]]), show('[a=b=c]'));
  ok(CK.defaultUrl, () => eq(ext('[https://x.com/?a=1]'), [['https://x.com/?a=1', [], null]]),
    show('[https://x.com/?a=1]'));
  ok(CK.defaultEmpty, () => eq(ext('[=foo] [foo=]'), [['=foo', [], null], ['foo=', [], null]]),
    show('[=foo] [foo=]'));
  ok(CK.combo, () => eq(ext(COMBO), [['语言', ['Python', 'Go', 'Rust'], 'Go']]), show(COMBO));
  ok('组合：选项段里的 = 不当默认值',
    () => eq(ext('[参数|a=1|b=2]'), [['参数', ['a=1', 'b=2'], null]]), show('[参数|a=1|b=2]'));

  // ===== 扩展语法的判定边界：表格 =====
  ok(CK.tableCell, () => !tokensOf(impl, TABLE).includes('[a|b|c]'), () => JSON.stringify(tokensOf(impl, TABLE)));
  ok(CK.tablePlain, () => tokensOf(impl, TABLE).includes('[在此填写]'), () => JSON.stringify(tokensOf(impl, TABLE)));
  ok(CK.tableEnds,
    () => eq(ext(TABLE), [['在此填写', [], null], ['语言', ['Python', 'Go', 'Rust'], null]]), show(TABLE));
  ok('表格：没有首尾 | 的表格同样认',
    () => tokensOf(impl, TABLE_NO_LEAD).length === 0, () => JSON.stringify(tokensOf(impl, TABLE_NO_LEAD)));
  ok(CK.tableFence,
    () => eq(tokensOf(impl, FENCED_DELIM), ['[语言|Python|Go|Rust]']), () => JSON.stringify(tokensOf(impl, FENCED_DELIM)));
  ok(CK.notTable,
    () => eq(ext(PIPE_PROSE), [['语言', ['Python', 'Go', 'Rust'], null]]), show(PIPE_PROSE));

  // ===== 扩展语法不破坏排除规则 =====
  ok(CK.exclusions, () => tokensOf(impl, EXT_EXCLUDED).length === 0, () => JSON.stringify(tokensOf(impl, EXT_EXCLUDED)));

  // ===== 接口形状与向后兼容 =====
  ok(CK.shape,
    () => impl.extract('[旧语法] [语言|Python|Go] [目标=x]').every(p =>
      eq(Object.keys(p).sort(), ['default', 'hint', 'options', 'token']))
      && eq(impl.extract('[旧语法]'), [{ token: '[旧语法]', hint: '旧语法', options: [], default: null }]),
    show('[旧语法] [语言|Python|Go] [目标=x]'));
  ok(CK.tokenRaw, () => eq(tokensOf(impl, COMBO), [COMBO]), () => JSON.stringify(tokensOf(impl, COMBO)));
  ok(CK.distinct, () => eq(tokensOf(impl, '[目标] [目标=提升性能]'), ['[目标]', '[目标=提升性能]']),
    () => JSON.stringify(tokensOf(impl, '[目标] [目标=提升性能]')));
  ok(CK.dedupToken, () => eq(tokensOf(impl, FILL_EXT_BODY), ['[语言|Python|Go|Rust]', '[目标=提升性能]']),
    () => JSON.stringify(tokensOf(impl, FILL_EXT_BODY)));

  // ===== fill / withDefaults =====
  ok(CK.fillNoDefault, () => impl.fill(FILL_EXT_BODY, {}) === FILL_EXT_BODY,
    () => JSON.stringify(impl.fill(FILL_EXT_BODY, {})));
  ok(CK.fillOptToken,
    () => impl.fill(FILL_EXT_BODY, { '[语言|Python|Go|Rust]': 'Go' }) === [
      '语言：Go', '目标：[目标=提升性能]', '代码：`[语言|Python|Go|Rust]`', '再一次：Go'
    ].join('\n'),
    () => JSON.stringify(impl.fill(FILL_EXT_BODY, { '[语言|Python|Go|Rust]': 'Go' })));
  ok(CK.fillMultiline,
    () => impl.fill('报错：[粘贴报错]', { '[粘贴报错]': 'Error: x\n  at a.js:1\n  at b.js:2' })
      === '报错：Error: x\n  at a.js:1\n  at b.js:2');
  ok(CK.wdApply,
    () => eq(impl.withDefaults(FILL_EXT_BODY, {}), { '[目标=提升性能]': '提升性能' })
      && impl.withDefaults(FILL_EXT_BODY, { '[目标=提升性能]': '  ' })['[目标=提升性能]'] === '提升性能',
    () => JSON.stringify(impl.withDefaults(FILL_EXT_BODY, {})));
  ok(CK.wdPrefer,
    () => impl.withDefaults(FILL_EXT_BODY, { '[目标=提升性能]': '降低内存' })['[目标=提升性能]'] === '降低内存',
    () => JSON.stringify(impl.withDefaults(FILL_EXT_BODY, { '[目标=提升性能]': '降低内存' })));
  ok(CK.wdPure, () => {
    const input = { '[语言|Python|Go|Rust]': 'Go' };
    const out = impl.withDefaults(FILL_EXT_BODY, input);
    return eq(input, { '[语言|Python|Go|Rust]': 'Go' })
      && eq(out, { '[语言|Python|Go|Rust]': 'Go', '[目标=提升性能]': '提升性能' });
  });
  ok(CK.wdMap,
    () => eq(impl.withDefaults(FILL_EXT_BODY, new Map([['[语言|Python|Go|Rust]', 'Rust']])),
      { '[语言|Python|Go|Rust]': 'Rust', '[目标=提升性能]': '提升性能' }));
  ok(CK.wdEndToEnd,
    () => impl.fill(FILL_EXT_BODY, impl.withDefaults(FILL_EXT_BODY, { '[语言|Python|Go|Rust]': 'Go' })) === [
      '语言：Go', '目标：提升性能', '代码：`[语言|Python|Go|Rust]`', '再一次：Go'
    ].join('\n'),
    () => JSON.stringify(impl.fill(FILL_EXT_BODY, impl.withDefaults(FILL_EXT_BODY, {}))));

  return results;
}

// ---------- 反向对照用的朴素实现 ----------
//
// 就是"先想到的那个写法"：一个不排除任何 Markdown 用法的正则 + split/join 全文替换。
// 它跑同一批断言必须红够多条 —— 否则说明这批断言分辨不出"处理了判定"和"没处理"，
// 绿也是白绿。
const NAIVE = {
  extract(body) {
    const seen = new Set();
    const out = [];
    for (const m of String(body == null ? '' : body).matchAll(/\[([^\]\n]+)\]/g)) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      out.push({ token: m[0], hint: m[1] });
    }
    return out;
  },
  fill(body, values) {
    let out = String(body == null ? '' : body);
    for (const [token, v] of Object.entries(values || {})) {
      if (v == null || !String(v).trim()) continue;
      out = out.split(token).join(String(v));
    }
    return out;
  }
};

// ---------- 跑 ----------
const real = runChecks(PLACEHOLDERS);
let failed = 0;
for (const [name, pass, detail] of real) {
  console.log('[test:placeholders] ' + (pass ? 'PASS ' : 'FAIL ') + name
    + (!pass && detail ? ' → ' + detail : ''));
  if (!pass) failed++;
}

console.log('\n[test:placeholders] --- 反向对照：朴素正则实现必须红 ---');
const naive = runChecks(NAIVE);
const naiveFails = naive.filter(([, pass]) => !pass);
for (const [name] of naiveFails) console.log('  红：' + name);
console.log('[test:placeholders] 朴素实现失败 ' + naiveFails.length + '/' + naive.length + ' 条');

// 下限按实际数出来的类别定：链接、带标题的链接、图片、引用式链接、链接定义行、
// 三种任务列表、两种行内代码、空方括号、两种围栏块、嵌套、模板文件那三条、
// fill 的几条误伤 —— 远超 12。定在 12 是留出余量，不是凑数：低于这个数说明
// 断言集被削弱了（比如有人把"逐类排除"那段删了），此时即使真实模块全绿也不可信。
const controlOk = naiveFails.length >= 12;
if (!controlOk) {
  console.error('[test:placeholders] FAIL 反向对照只红了 ' + naiveFails.length
    + ' 条：这批断言分辨不出朴素实现，测试无效');
}
// 反向对照还得证明它红的是"判定"那部分，不是随便红几条。
const naiveNames = naiveFails.map(([n]) => n);
const mustRed = [
  '模板文件行内代码里的 [占位符] 没被提取',
  '排除：行内链接',
  '排除：图片',
  '排除：引用式链接',
  '排除：链接定义行',
  '排除：未勾选任务',
  '排除：已勾选任务',
  '排除：行内代码',
  '排除：围栏代码块（```）里的方括号',
  '排除：嵌套方括号整段放过',
  'fill 不动行内代码里的同名字面量'
];
const notRed = mustRed.filter(n => !naiveNames.includes(n));
if (notRed.length) {
  console.error('[test:placeholders] FAIL 这几条在朴素实现下竟然也绿，属于空断言：\n      '
    + notRed.join('\n      '));
}

// ---------- 反向对照二：扩展语法的逐条变异 ----------
//
// 朴素实现连 options / default 字段都没有，扩展语法那批断言在它下面全红，
// 但这只证明"断言认得出没实现"，证明不了"每条判定边界都有断言盯着"。
// 所以再做一组变异：把真实模块的源码读进内存，每次只撤掉一条规则
// （find → replace），在隔离的上下文里求值成一个新模块，跑同一批断言，
// 要求**点名的那一条**变红。只要求"有东西红"不够：改动可能恰好撞红邻近的
// 另一条，目标断言依然是空的（CONTRIBUTING.md 第一节）。
//
// 不改磁盘上的文件：变异只存在于内存里，中途被打断也不会留下改坏的源码。
// find 串必须在源码里恰好出现一次，否则当失败 —— 用例和代码脱节时静静跳过，
// 等于这条对照不存在。
const vm = require('vm');
const realSrc = fs.readFileSync(path.join(root, 'src', 'placeholders.js'), 'utf8');
const loadVariant = (src) => {
  const sandbox = { module: { exports: {} }, Map, Set, Array, Object, String, JSON };
  vm.runInNewContext(src, sandbox, { filename: 'placeholders.variant.js' });
  return sandbox.module.exports;
};
const MUTANTS = [
  { name: '撤掉表格规则', find: "if (inTable && inner.includes('|')) continue;", replace: '', red: CK.tableCell },
  { name: '表格不在空行收口', find: "olines[r].trim() && !FENCE.test(olines[r])", replace: '!FENCE.test(olines[r])', red: CK.tableEnds },
  { name: '表格延伸不在围栏行停', find: "olines[r].trim() && !FENCE.test(olines[r])", replace: 'olines[r].trim()', red: CK.tableFence },
  { name: '表格不要求分隔行', find: "if (!olines[k].includes('|') || !TABLE_DELIM.test(olines[k])) continue;",
    replace: "if (!olines[k].includes('|')) continue;", red: CK.notTable },
  { name: '一个选项也算选项', find: 'uniq.length >= 2', replace: 'uniq.length >= 1', red: CK.twoSegs },
  { name: '不查空段', find: 'if (segs.every(Boolean)) {', replace: 'if (true) {', red: CK.emptySeg },
  { name: '不查转义竖线', find: "inner.includes('|') && !inner.includes('\\\\|')", replace: "inner.includes('|')", red: CK.escapedPipe },
  { name: '选项不去重', find: 'Array.from(new Set(segs.slice(1)))', replace: 'segs.slice(1)', red: CK.dedup },
  { name: '= 两侧允许空白', find: 'const DEFAULT_EQ = /(?<=[^\\s=!<>])=(?=[^\\s=!<>])/;', replace: 'const DEFAULT_EQ = /=/;', red: CK.defaultSpaced },
  { name: '= 两侧允许比较符', find: 'const DEFAULT_EQ = /(?<=[^\\s=!<>])=(?=[^\\s=!<>])/;', replace: 'const DEFAULT_EQ = /(?<=\\S)=(?=\\S)/;', red: CK.defaultCompare },
  { name: '允许多个等号', find: "hint.split('=').length === 2 && ", replace: '', red: CK.defaultMulti },
  { name: '不排除 URL', find: "!hint.includes('://') && ", replace: '', red: CK.defaultUrl },
  // 正向环视改成负向环视：看着等价，但负向环视在字符串开头 / 结尾也成立，
  // [=foo] / [foo=] 就会被读成"空提示 + 默认值"。
  { name: '环视改成负向（放过开头结尾）', find: 'const DEFAULT_EQ = /(?<=[^\\s=!<>])=(?=[^\\s=!<>])/;',
    replace: 'const DEFAULT_EQ = /(?<![\\s=!<>])=(?![\\s=!<>])/;', red: CK.defaultEmpty },
  { name: '默认值在整段上解析', find: 'let hint = head.trim();', replace: 'let hint = inner.trim();', red: CK.combo },
  { name: 'token 换成 hint', find: 'token: oline.slice(i, j + 1),', replace: 'token: parsed.hint,', red: CK.tokenRaw },
  { name: 'extract 不带 options', find: 'options: hit.options.slice(), ', replace: '', red: CK.shape },
  { name: 'withDefaults 覆盖已填的值', find: 'if (hit.default === null || valueFor(out, hit.token)) continue;',
    replace: 'if (hit.default === null) continue;', red: CK.wdPrefer },
  { name: 'withDefaults 不复制 values', find: 'const out = {};\n      if (values && typeof Map',
    replace: 'const out = values || {};\n      if (false && values && typeof Map', red: CK.wdPure },
  { name: 'withDefaults 不认 Map', find: 'for (const [k, v] of values) out[k] = v;', replace: '', red: CK.wdMap },
  { name: 'fill 自己套默认值', find: 'const v = valueFor(values, hit.token);', replace: 'const v = valueFor(values, hit.token) || hit.default;', red: CK.fillNoDefault }
];
console.log('\n[test:placeholders] --- 反向对照二：逐条撤掉扩展语法的规则，点名的断言必须红 ---');
const mutantMisses = [];
for (const m of MUTANTS) {
  const hits = realSrc.split(m.find).length - 1;
  if (hits !== 1) { mutantMisses.push(m.name + '（find 串命中 ' + hits + ' 次，用例和源码脱节）'); continue; }
  let variant;
  try {
    variant = loadVariant(realSrc.replace(m.find, m.replace));
  } catch (e) {
    mutantMisses.push(m.name + '（变异后无法求值：' + e.message + '）');
    continue;
  }
  const res = runChecks(variant);
  const target = res.find(([n]) => n === m.red);
  if (!target) { mutantMisses.push(m.name + '（找不到断言「' + m.red + '」）'); continue; }
  if (target[1]) mutantMisses.push(m.name + '（「' + m.red + '」仍然是绿的：空断言）');
  else console.log('  红：' + m.name + ' → ' + m.red);
}
if (mutantMisses.length) {
  console.error('[test:placeholders] FAIL 反向对照二没有按预期变红：\n      ' + mutantMisses.join('\n      '));
}
console.log('[test:placeholders] 变异 ' + MUTANTS.length + ' 个，按预期变红 ' + (MUTANTS.length - mutantMisses.length) + ' 个');

const passed = failed === 0 && controlOk && notRed.length === 0 && mutantMisses.length === 0;
console.log('\n[test:placeholders] ' + (passed ? '通过' : '失败')
  + '（共 ' + real.length + ' 条，真实模块失败 ' + failed
  + ' 条，反向对照红 ' + naiveFails.length + ' 条）');
process.exit(passed ? 0 : 1);
