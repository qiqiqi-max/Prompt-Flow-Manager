// tests/tag-rewrite.test.js
// 批量打标签的文本级改写（lib/tag-rewrite.js）：只动 tags 那一段，其余每一行原样。
//
// 要防的是"整体重新序列化 frontmatter"：FRONTMATTER.parse 认不得多行结构，
// 工作流的 flow 数组、多行写法的 tags 在它眼里是空串，再 stringify 回去就整段消失。
// 这种损坏不报错，用户下次打开工作流才发现流程图空了。
//
// 反向对照在文件末尾：拿"parse → 改 meta.tags → stringify"的朴素实现跑同一批用例，
// 指定的那几条必须红。
//
// 运行：npm run test:tag-rewrite
const path = require('path');
const REAL = require(path.join(__dirname, '..', 'lib', 'tag-rewrite.js'));
const FRONTMATTER = require(path.join(__dirname, '..', 'src', 'frontmatter.js'));

const codeOf = (fn) => {
  try { fn(); return null; } catch (e) { return String(e.message).split('|')[0]; }
};
const linesExcept = (text, re) => text.split(/\r?\n/).filter(l => !re.test(l));

const WORKFLOW = [
  '---',
  'title: 示例工作流',
  'tags: [流程]',
  'flow:',
  '  - id: a',
  '    prompt: prompts/project-init/需求分析.md',
  '    next: b',
  '  - id: b',
  '    prompt: prompts/testing/单测.md',
  'version: 3',
  '---',
  '# 正文',
  'tags: 这一行在正文里，不能被改'
].join('\n');

const BLOCK = [
  '---',
  'title: 多行标签',
  'tags:',
  '  - 前端',
  "  - '后端'",
  '  - "部署"',
  'stage: testing',
  '---',
  '正文'
].join('\n');

function runSuite(T) {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail == null ? '' : String(detail) });
  const safe = (fn) => { try { return fn(); } catch (e) { return { error: String(e.message), content: '', after: [] }; } };

  // 1. 行内数组：添加
  {
    const r = safe(() => T.rewriteTags(WORKFLOW, { add: ['新增'] }));
    ok('行内数组：添加后 tags 变成原有 + 新增', /^tags: \["流程", "新增"\]$/m.test(r.content), r.content.split('\n')[2]);
    ok('行内数组：flow 结构字段原样保留',
      r.content.includes('flow:\n  - id: a\n    prompt: prompts/project-init/需求分析.md\n    next: b\n  - id: b'), r.content);
    ok('行内数组：除 tags 那一行外每一行都没变',
      JSON.stringify(linesExcept(r.content, /^tags: \[/)) === JSON.stringify(linesExcept(WORKFLOW, /^tags: \[/)), r.content);
    ok('正文里长得像 tags: 的行不被改', r.content.endsWith('tags: 这一行在正文里，不能被改'), r.content.slice(-30));
  }
  // 2. 行内数组：删除，没写引号的旧写法也认
  {
    const r = safe(() => T.rewriteTags('---\ntitle: x\ntags: [a, b, c]\n---\n正文', { remove: ['b'] }));
    ok('行内数组（无引号写法）：删除一项', r.content === '---\ntitle: x\ntags: ["a", "c"]\n---\n正文', r.content);
  }
  // 3. 多行列表：添加 —— 原有项一字不改，新项沿用缩进
  {
    const r = safe(() => T.rewriteTags(BLOCK, { add: ['运维'] }));
    ok('多行列表：添加后保留多行写法，原有项（含引号风格）一字不改，新项沿用缩进',
      r.content.includes("tags:\n  - 前端\n  - '后端'\n  - \"部署\"\n  - \"运维\"\nstage: testing"), r.content);
    ok('多行列表：读回来是四项', JSON.stringify(T.readTags(r.content)) === JSON.stringify(['前端', '后端', '部署', '运维']),
      JSON.stringify(T.readTags(r.content)));
  }
  // 4. 多行列表：删除中间一项
  {
    const r = safe(() => T.rewriteTags(BLOCK, { remove: ['后端'] }));
    ok('多行列表：删除只拿掉那一行', r.content.includes('tags:\n  - 前端\n  - "部署"\nstage: testing'), r.content);
  }
  // 5. 顶格写的多行列表，删空
  {
    const src = '---\ntitle: x\ntags:\n- a\n- b\nstage: testing\n---\n';
    const r = safe(() => T.rewriteTags(src, { remove: ['a', 'b'] }));
    ok('顶格多行列表删空后写成 tags: []（而不是留一个下面没有项的 tags:）',
      r.content === '---\ntitle: x\ntags: []\nstage: testing\n---\n', r.content);
  }
  // 6. 缺失 tags 字段
  {
    const r = safe(() => T.rewriteTags('---\ntitle: x\nstage: testing\n---\n正文', { add: ['a'] }));
    ok('缺失 tags：在 frontmatter 末尾补一行，其余不变', r.content === '---\ntitle: x\nstage: testing\ntags: ["a"]\n---\n正文', r.content);
    const r2 = safe(() => T.rewriteTags('---\ntitle: x\n---\n正文', { remove: ['a'] }));
    ok('缺失 tags 时删除：不改文件', r2.changed === false && r2.content === '---\ntitle: x\n---\n正文', JSON.stringify(r2));
  }
  // 7. 没有 frontmatter
  {
    const r = safe(() => T.rewriteTags('# 只有正文\n内容', { add: ['a'] }));
    ok('没有 frontmatter：开头补一个只含 tags 的块，正文原样', r.content === '---\ntags: ["a"]\n---\n# 只有正文\n内容', r.content);
  }
  // 8. CRLF：没动的行连换行符都不变
  {
    const src = '---\r\ntitle: x\r\ntags:\r\n  - a\r\nstage: testing\r\n---\r\n正文\r\n';
    const r = safe(() => T.rewriteTags(src, { add: ['b'] }));
    ok('CRLF 文件：新行用 CRLF，没有混进裸 LF',
      r.content === '---\r\ntitle: x\r\ntags:\r\n  - a\r\n  - "b"\r\nstage: testing\r\n---\r\n正文\r\n', JSON.stringify(r.content));
  }
  // 9. 标量写法
  {
    const r = safe(() => T.rewriteTags('---\ntags: 单个\n---\n', { add: ['两个'] }));
    ok('标量写法：当成一项，改写成行内数组', r.content === '---\ntags: ["单个", "两个"]\n---\n', r.content);
    const r2 = safe(() => T.rewriteTags('---\ntags:\n---\n', { add: ['a'] }));
    ok('空值写法：直接写成行内数组', r2.content === '---\ntags: ["a"]\n---\n', r2.content);
  }
  // 10. 没有变化 / 去重
  {
    const r = safe(() => T.rewriteTags(BLOCK, { add: ['前端'] }));
    ok('已有的标签再添加：不改文件', r.changed === false && r.content === BLOCK, JSON.stringify(r.changed));
    const r2 = safe(() => T.rewriteTags('---\ntags: [a]\n---\n', { add: ['b', 'b', ' b '] }));
    ok('添加时去重、去首尾空白', r2.content === '---\ntags: ["a", "b"]\n---\n', r2.content);
  }
  // 11. 标签里带冒号、方括号、引号：必须加引号，不能改写别的字段
  {
    const r = safe(() => T.rewriteTags('---\ntitle: x\ntags: []\n---\n', { add: ['a: b', 'c]', 'd"e'] }));
    const meta = FRONTMATTER.parse(r.content).meta;
    ok('带冒号/方括号/引号的标签被安全引起来，解析回来一致且没多出字段',
      JSON.stringify(meta.tags) === JSON.stringify(['a: b', 'c]', 'd"e']) && Object.keys(meta).join() === 'title,tags',
      JSON.stringify(meta));
  }
  // 12. 认不得的写法：拒绝，不猜
  ok('多行行内数组被拒绝（E_TAGS_FORMAT）', codeOf(() => T.rewriteTags('---\ntags: [a,\n  b]\n---\n', { add: ['c'] })) === 'E_TAGS_FORMAT');
  ok('锚点/别名被拒绝', codeOf(() => T.rewriteTags('---\ntags: *base\n---\n', { add: ['c'] })) === 'E_TAGS_FORMAT');
  ok('映射写法被拒绝', codeOf(() => T.rewriteTags('---\ntags:\n  a: 1\n---\n', { add: ['c'] })) === 'E_TAGS_FORMAT');
  ok('带行尾注释被拒绝', codeOf(() => T.rewriteTags('---\ntags: a # 注释\n---\n', { add: ['c'] })) === 'E_TAGS_FORMAT');
  ok('两个顶层 tags 键被拒绝', codeOf(() => T.rewriteTags('---\ntags: [a]\ntags: [b]\n---\n', { add: ['c'] })) === 'E_TAGS_FORMAT');
  ok('带换行的标签被拒绝（E_TAGS_INVALID）', codeOf(() => T.rewriteTags('---\ntags: []\n---\n', { add: ['a\nversion: 99'] })) === 'E_TAGS_INVALID');
  // 13. 只认顶层 tags：缩进的 tags（某个嵌套对象里）和前缀相同的 key 不算
  {
    const src = '---\ntagsExtra: keep\nmeta:\n  tags: [inner]\n---\n';
    const r = safe(() => T.rewriteTags(src, { add: ['a'] }));
    ok('前缀相同的键和嵌套的 tags 不被当成 tags 字段',
      r.content === '---\ntagsExtra: keep\nmeta:\n  tags: [inner]\ntags: ["a"]\n---\n', r.content);
  }
  // 14. 行内写法下 readTags 和界面用的 FRONTMATTER.parse 读出来一致
  for (const src of ['---\ntags: [a, "b c"]\n---\n', '---\ntags: ["x", "y"]\n---\n', '---\ntags: z\n---\n']) {
    const mine = T.readTags(src);
    let theirs = FRONTMATTER.parse(src).meta.tags;
    if (typeof theirs === 'string') theirs = theirs ? [theirs] : [];
    ok('readTags 与 FRONTMATTER.parse 对行内写法读法一致：' + JSON.stringify(src.split('\n')[1]),
      JSON.stringify(mine) === JSON.stringify(theirs), JSON.stringify({ mine, theirs }));
  }
  return results;
}

let failed = 0;
for (const r of runSuite(REAL)) {
  if (r.pass) console.log('[test:tag-rewrite] PASS ' + r.name);
  else { failed++; console.error('[test:tag-rewrite] FAIL ' + r.name + ' -> ' + r.detail); }
}

// ---------- 反向对照：整体重新序列化 ----------
// 就是 CLAUDE.md 里明确禁止的那种写法：parse 出 meta，改 tags，stringify 回去。
const NAIVE = {
  readTags: (c) => { const t = FRONTMATTER.parse(c).meta.tags; return Array.isArray(t) ? t : (t ? [t] : []); },
  rewriteTags(content, opts) {
    const { meta, body } = FRONTMATTER.parse(content);
    const before = Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [String(meta.tags)] : []);
    const rm = (opts.remove || []).map(s => s.trim());
    const add = (opts.add || []).map(s => s.trim()).filter(Boolean);
    const after = before.filter(x => !rm.includes(x));
    for (const a of add) if (!after.includes(a)) after.push(a);
    if (JSON.stringify(after) === JSON.stringify(before)) return { content, changed: false, before, after };
    return { content: FRONTMATTER.stringify({ ...meta, tags: after }, body), changed: true, before, after };
  },
  normalizeTagList: REAL.normalizeTagList
};
const mustRed = [
  '行内数组：flow 结构字段原样保留',
  '行内数组：除 tags 那一行外每一行都没变',
  '多行列表：添加后保留多行写法，原有项（含引号风格）一字不改，新项沿用缩进',
  '多行列表：删除只拿掉那一行',
  'CRLF 文件：新行用 CRLF，没有混进裸 LF'
];
const naive = runSuite(NAIVE);
const stillGreen = mustRed.filter(name => (naive.find(r => r.name === name) || { pass: true }).pass);
if (stillGreen.length) {
  failed++;
  console.error('[test:tag-rewrite] FAIL 反向对照：整体重新序列化的实现在这些断言上仍然是绿的：' + stillGreen.join(' / '));
} else {
  console.log('[test:tag-rewrite] PASS 反向对照：整体重新序列化的实现在 ' + mustRed.length + ' 条目标断言上全部变红');
}

if (failed) {
  console.error('[test:tag-rewrite] ' + failed + ' 项失败');
  process.exit(1);
}
console.log('[test:tag-rewrite] 通过');
