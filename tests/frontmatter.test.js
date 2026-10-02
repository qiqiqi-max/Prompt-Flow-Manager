// tests/frontmatter.test.js
// 用户输入写进 frontmatter 时必须仍是单个标量，不能借换行或 YAML 语法改写别的字段。
const FRONTMATTER = require('../src/frontmatter');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:frontmatter] PASS ' + msg);
  else {
    failures++;
    console.error('[test:frontmatter] FAIL ' + msg + (extra ? ' -> ' + extra : ''));
  }
};

const values = [
  ['普通文本', '普通文本'],
  ['多行文本', '做一个后台\nstage: deployment\nprojectType: 恶意'],
  ['冒号和井号', '目标: 支持 A # 不是注释'],
  ['数组形状', '[a, b]'],
  ['布尔形状', 'true'],
  ['数字形状', '123'],
  ['引号与反斜杠', '他说 "C:\\work"'],
  ['首尾空白', '  保留中间  空格  ']
];

ok(typeof FRONTMATTER.stringify === 'function', '提供 stringify');
if (typeof FRONTMATTER.stringify === 'function') {
  for (const [label, description] of values) {
    const doc = FRONTMATTER.stringify({ title: 'Demo', stage: 'project-init', description }, '# Body');
    const parsed = FRONTMATTER.parse(doc);
    const expected = description.replace(/\s+/g, ' ').trim();
    ok(parsed.meta.description === expected, label + '：description 往返后仍是同一个字符串', JSON.stringify(parsed.meta));
    ok(parsed.meta.stage === 'project-init', label + '：不能改写 stage', JSON.stringify(parsed.meta));
    ok(!Object.prototype.hasOwnProperty.call(parsed.meta, 'projectType'), label + '：不能注入新字段', JSON.stringify(parsed.meta));
    ok(parsed.body === '# Body', label + '：正文保持不变', JSON.stringify(parsed.body));
  }

  const tagged = FRONTMATTER.parse(FRONTMATTER.stringify({ tags: ['脚手架', 'a,b', '[x]'] }, ''));
  ok(JSON.stringify(tagged.meta.tags) === JSON.stringify(['脚手架', 'a,b', '[x]']), '数组项中的逗号和方括号不会被拆坏', JSON.stringify(tagged.meta.tags));
}

const legacy = FRONTMATTER.parse('---\ntitle: "旧格式"\ntags: [a, "b"]\n---\nbody');
ok(legacy.meta.title === '旧格式', '兼容已有双引号标量');
ok(JSON.stringify(legacy.meta.tags) === '["a","b"]', '兼容已有简单数组');

if (failures) {
  console.error('\n[test:frontmatter] 失败 ' + failures + ' 项');
  process.exit(1);
}
console.log('\n[test:frontmatter] 通过');
