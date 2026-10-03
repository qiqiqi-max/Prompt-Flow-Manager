// tests/workflow-refs.test.js
const WORKFLOW_REFS = require('../src/workflow-refs');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:workflow-refs] PASS ' + msg);
  else { failures++; console.error('[test:workflow-refs] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};

const doc = [
  '---',
  'title: Demo',
  'flow:',
  '  - id: a',
  '    prompt: prompts/a.md',
  '    label: A',
  '  - id: b',
  '    prompt: "prompts/a.md"',
  '  - id: c',
  "    prompt: 'prompts/a.md.bak'",
  '  - id: d',
  '    prompt: prompts/sub/a.md',
  'notes: prompts/a.md',
  '---',
  'Body mentions prompts/a.md and should stay unchanged.'
].join('\n');

ok(WORKFLOW_REFS.hasPromptRef(doc, 'prompts/a.md') === true, '能识别 flow 里的精确 prompt 引用');
ok(WORKFLOW_REFS.hasPromptRef(doc, 'prompts/b.md') === false, '只在正文或其他字段出现时不算引用');

const res = WORKFLOW_REFS.replacePromptRefs(doc, 'prompts/a.md', 'prompts/new name.md');
ok(res.count === 2, '只替换两个精确 prompt 引用', String(res.count));
ok(res.content.includes('    prompt: "prompts/new name.md"'), '带空格的新路径会安全加引号');
ok(res.content.includes("    prompt: 'prompts/a.md.bak'"), '不修改前缀相同的其他路径');
ok(res.content.includes('    prompt: prompts/sub/a.md'), '不修改子目录里的同名文件');
ok(res.content.includes('notes: prompts/a.md'), '不修改 flow 以外的 frontmatter 字段');
ok(res.content.endsWith('Body mentions prompts/a.md and should stay unchanged.'), '不修改工作流正文');

const crlf = doc.replace(/\n/g, '\r\n');
const crlfRes = WORKFLOW_REFS.replacePromptRefs(crlf, 'prompts/a.md', 'prompts/b.md');
ok(crlfRes.count === 2 && crlfRes.content.includes('\r\n    prompt: prompts/b.md\r\n'), '保留 Windows 换行格式');

const noFrontmatter = 'prompt: prompts/a.md';
ok(WORKFLOW_REFS.replacePromptRefs(noFrontmatter, 'prompts/a.md', 'prompts/b.md').count === 0, '没有 frontmatter 时不修改');

if (failures) process.exit(1);
console.log('[test:workflow-refs] 通过');
