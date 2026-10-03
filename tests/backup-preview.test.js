// tests/backup-preview.test.js
const { summarizeBackupEntries } = require('../lib/backup-preview');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:backup-preview] PASS ' + msg);
  else { failures++; console.error('[test:backup-preview] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};

const backup = summarizeBackupEntries([
  { path: 'prompts/a.md' },
  { path: 'workflows/b.md' },
  { path: 'templates/c.md' },
  { path: '.versions/prompts/a.md/20260101-010203-004.md' },
  { path: '.versions/prompts/a.md/index.json' },
  { path: '.trash/index.json' },
  { path: '.trash/1-2.md' },
  { path: '.pfm/portable-config.json' }
], rel => rel === 'prompts/a.md');
ok(backup.mode === 'backup', '识别完整备份');
ok(backup.files === 3 && backup.versions === 1 && backup.trash === 1 && backup.settings === true, '统计文件、版本、回收站和设置', JSON.stringify(backup));
ok(JSON.stringify(backup.conflicts) === '["prompts/a.md"]', '列出会另存的重名文件');

const markdown = summarizeBackupEntries([{ path: 'misc/a.md' }, { path: 'b.md' }], () => false);
ok(markdown.mode === 'markdown' && markdown.files === 2 && markdown.versions === 0 && markdown.settings === false, '普通 ZIP 只统计 Markdown');

const many = summarizeBackupEntries(Array.from({ length: 12 }, (_, i) => ({ path: `prompts/${i}.md` })), () => true);
ok(many.conflicts.length === 10 && many.conflictCount === 12, '重名清单限制长度但保留总数');

if (failures) process.exit(1);
console.log('[test:backup-preview] 通过');
