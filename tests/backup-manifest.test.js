// tests/backup-manifest.test.js
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const archiver = require('archiver');
const { buildManifest, verifyManifest } = require('../lib/backup-manifest');
const { readZipMarkdownEntries, BACKUP_MANIFEST_ENTRY } = require('../lib/zip-import');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:backup-manifest] PASS ' + msg);
  else { failures++; console.error('[test:backup-manifest] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};
const hash = s => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const entries = [
  { path: 'prompts/a.md', size: 1, sha256: hash('a') },
  { path: '.trash/index.json', size: 12, sha256: hash('{"items":[]}') }
];
const manifest = buildManifest(entries, { appVersion: '1.6.0', createdAt: '2026-01-01T00:00:00.000Z' });
ok(manifest.schema === 1 && manifest.files.length === 2 && manifest.files[0].path === '.trash/index.json', '生成按路径排序的备份清单');
ok(verifyManifest(entries, manifest).ok === true, '完整备份通过清单校验');
ok(verifyManifest(entries, null).legacy === true, '旧备份没有清单时按兼容模式处理');
ok(JSON.stringify(verifyManifest(entries.slice(1), manifest).missing) === '["prompts/a.md"]', '发现缺失文件');
ok(JSON.stringify(verifyManifest([{ ...entries[0], sha256: hash('b') }, entries[1]], manifest).changed) === '["prompts/a.md"]', '发现内容被修改的文件');
ok(JSON.stringify(verifyManifest([...entries, { path: 'prompts/extra.md', size: 1, sha256: hash('x') }], manifest).extra) === '["prompts/extra.md"]', '发现清单外的额外文件');
ok(verifyManifest(entries, { schema: 99, files: [] }).ok === false, '拒绝不支持的清单版本');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-manifest-'));
  try {
    const zipPath = path.join(dir, 'backup.zip');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      const zip = archiver('zip');
      out.on('close', resolve);
      zip.on('error', reject);
      zip.pipe(out);
      zip.append('a', { name: 'prompts/a.md' });
      zip.append(JSON.stringify(manifest), { name: BACKUP_MANIFEST_ENTRY });
      zip.finalize();
    });
    const read = await readZipMarkdownEntries(zipPath, { includeManifest: true });
    const file = read.entries.find(e => e.path === 'prompts/a.md');
    ok(!!read.entries.find(e => e.path === BACKUP_MANIFEST_ENTRY), '读取 ZIP 时带出备份清单');
    ok(file && file.size === 1 && file.sha256 === hash('a'), '读取 ZIP 时按原始字节计算大小和校验值');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures) process.exit(1);
  console.log('[test:backup-manifest] 通过');
})().catch((e) => { console.error(e); process.exit(1); });
