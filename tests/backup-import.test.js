// tests/backup-import.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const archiver = require('archiver');
const { readZipMarkdownEntries, backupRelForEntry, backupVersionForEntry } = require('../lib/zip-import');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:backup-import] PASS ' + msg);
  else { failures++; console.error('[test:backup-import] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};

async function makeZip(file, entries) {
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const zip = archiver('zip');
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    for (const [name, content] of entries) zip.append(content, { name });
    zip.finalize();
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-backup-import-'));
  try {
    const zipPath = path.join(dir, 'backup.zip');
    await makeZip(zipPath, [
      ['prompts/custom/nested/a.md', 'a'],
      ['workflows/flow.md', 'flow'],
      ['templates/base.md', 'template'],
      ['other/loose.md', 'loose'],
      ['.versions/prompts/a.md/20260101-010203-004.md', 'old'],
      ['.versions/prompts/a.md/index.json', '{"pinned":{"20260101-010203-004.md":true}}']
    ]);
    const { entries } = await readZipMarkdownEntries(zipPath, { includeVersionIndexes: true });
    const byName = Object.fromEntries(entries.map(e => [e.path, e]));
    ok(!!byName['prompts/custom/nested/a.md'], '读取 ZIP 时保留完整条目路径', JSON.stringify(entries.map(e => e.path)));
    ok(byName['workflows/flow.md'] && byName['workflows/flow.md'].name === 'flow.md', '仍提供文件名供普通导入使用');
    ok(!!byName['.versions/prompts/a.md/index.json'], '完整备份可读取版本星标索引');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  ok(backupRelForEntry('prompts/custom/nested/a.md') === 'prompts/custom/nested/a.md', '完整备份恢复提示词子目录');
  ok(backupRelForEntry('workflows/flow.md') === 'workflows/flow.md', '完整备份恢复工作流目录');
  ok(backupRelForEntry('templates/base.md') === 'templates/base.md', '完整备份恢复模板目录');
  ok(backupRelForEntry('backup/prompts/a.md') === null, '不信任非顶层备份路径');
  ok(backupRelForEntry('prompts/../config.md') === null, '拒绝路径穿越');
  ok(backupRelForEntry('prompts/a.txt') === null, '只恢复 Markdown');
  ok(backupRelForEntry('prompts\\windows\\a.md') === 'prompts/windows/a.md', '兼容 Windows 路径分隔符');
  const v = backupVersionForEntry('.versions/prompts/a.md/20260101-010203-004.md');
  ok(v && v.rel === 'prompts/a.md' && v.file === '20260101-010203-004.md', '识别备份里的版本快照');
  const idx = backupVersionForEntry('.versions/workflows/flow.md/index.json');
  ok(idx && idx.rel === 'workflows/flow.md' && idx.file === 'index.json', '识别备份里的版本星标索引');
  ok(backupVersionForEntry('.versions/prompts/../a.md/20260101-010203-004.md') === null, '版本路径拒绝穿越');
  ok(backupVersionForEntry('.versions/prompts/a.md/evil.md') === null, '拒绝非法版本文件名');
  ok(backupVersionForEntry('.versions/config.json/20260101-010203-004.md') === null, '版本只属于库内 Markdown');

  if (failures) process.exit(1);
  console.log('[test:backup-import] 通过');
})().catch((e) => { console.error(e); process.exit(1); });
