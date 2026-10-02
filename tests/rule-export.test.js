// tests/rule-export.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const ruleExport = require('../lib/rule-export');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:rule-export] PASS ' + msg);
  else { failures++; console.error('[test:rule-export] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};
const allowed = new Set(['CLAUDE.md', '.cursorrules']);

async function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-rule-export-'));
  try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

(async () => {
  await withDir(async (dir) => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'mine', 'utf8');
    const plan = await ruleExport.plan(dir, [{ name: 'CLAUDE.md', content: 'new' }, { name: '.cursorrules', content: 'rules' }], allowed);
    ok(JSON.stringify(plan.existing) === '["CLAUDE.md"]', '能找出已存在的规则文件', JSON.stringify(plan.existing));
    const res = await ruleExport.write(plan, 'skip');
    ok(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8') === 'mine', '选择跳过时保留已有文件');
    ok(fs.readFileSync(path.join(dir, '.cursorrules'), 'utf8') === 'rules', '选择跳过时仍写入新文件');
    ok(JSON.stringify(res.skipped) === '["CLAUDE.md"]', '返回跳过的文件', JSON.stringify(res));
  });

  await withDir(async (dir) => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'mine', 'utf8');
    const plan = await ruleExport.plan(dir, [{ name: 'CLAUDE.md', content: 'new' }], allowed);
    const res = await ruleExport.write(plan, 'overwrite');
    ok(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8') === 'new', '选择覆盖时写入新内容');
    ok(!fs.readdirSync(dir).some(n => n.endsWith('.part')), '覆盖后没有残留临时文件');
    ok(JSON.stringify(res.written) === '["CLAUDE.md"]', '返回已写入文件');
  });

  await withDir(async (dir) => {
    const plan = await ruleExport.plan(dir, [
      { name: '../CLAUDE.md', content: 'bad' },
      { name: 'README.md', content: 'bad' },
      { name: '.cursorrules', content: 'ok' }
    ], allowed);
    ok(plan.items.map(i => i.name).join(',') === '.cursorrules', '只接受白名单中的纯文件名');
  });

  if (failures) process.exit(1);
  console.log('[test:rule-export] 通过');
})().catch((e) => { console.error(e); process.exit(1); });
