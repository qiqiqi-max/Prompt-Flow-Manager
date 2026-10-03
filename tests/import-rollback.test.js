// tests/import-rollback.test.js
// 真实启动 Electron：完整备份写入正文后注入失败，验证正文、设置和回收站都被撤回。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const archiver = require('archiver');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const electronBin = require(path.join(root, 'node_modules', 'electron'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-import-rollback-'));
const zipPath = path.join(dataDir, 'backup.zip');
const queuePath = path.join(dataDir, '__dialogs.json');
const hash = s => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

async function makeBackup() {
  const files = [
    ['prompts/testing/回滚导入.md', '---\ntitle: 回滚导入\n---\n正文'],
    ['.versions/prompts/testing/回滚导入.md/20260101-010203-004.md', '旧版本'],
    ['.pfm/portable-config.json', JSON.stringify({ schema: 1, config: { projectTypes: ['回滚类型'], lockedFiles: ['prompts/testing/回滚导入.md'], fillMemory: {} } })],
    ['.trash/index.json', JSON.stringify({ items: [{ id: 'old', originalRel: 'prompts/testing/回滚回收站.md', name: '回滚回收站.md', store: 'old.md' }] })],
    ['.trash/old.md', '回收站正文']
  ];
  const manifest = {
    schema: 1,
    app: 'prompt-flow-manager',
    appVersion: 'test',
    createdAt: new Date().toISOString(),
    files: files.map(([p, c]) => ({ path: p, size: Buffer.byteLength(c), sha256: hash(c) })).sort((a, b) => a.path.localeCompare(b.path))
  };
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const zip = archiver('zip');
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    for (const [p, c] of files) zip.append(c, { name: p });
    zip.append(JSON.stringify(manifest), { name: '.pfm/manifest.json' });
    zip.finalize();
  });
}

(async () => {
  await makeBackup();
  fs.writeFileSync(queuePath, JSON.stringify([{ canceled: false, filePaths: [zipPath] }, { kind: 'message', response: 1 }]));
  const script = `
    (async () => {
      const api = window.promptFlowApi;
      const before = await api.getMetaList();
      let message = '';
      try { await api.importZip(); } catch (e) { message = String(e.message || e); }
      const after = await api.getMetaList();
      const cfg = await api.getConfig();
      const trash = await api.listTrash();
      const ok = /E_IMPORT_ROLLED_BACK/.test(message)
        && before.length === after.length
        && !after.some(m => m.rel.includes('回滚导入'))
        && !(cfg.projectTypes || []).includes('回滚类型')
        && !(cfg.lockedFiles || []).some(r => r.includes('回滚导入'))
        && trash.items.length === 0;
      console.log(ok ? '[import-rollback] PASS 中途失败后整次导入被撤回' : '[import-rollback] FAIL ' + JSON.stringify({ message, before: before.length, after: after.length, cfg, trash }));
    })()`;
  const child = spawn(electronBin, [root], {
    cwd: root,
    env: {
      ...process.env,
      PFM_SELFTEST: '1',
      PFM_DATA_DIR: dataDir,
      PFM_SELFTEST_DIALOGS: queuePath,
      PFM_SELFTEST_IMPORT_FAIL_AFTER_FILES: '1',
      PFM_SELFTEST_EVAL: script,
      ELECTRON_ENABLE_LOGGING: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', d => { out += d; process.stdout.write(d); });
  child.stderr.on('data', d => { out += d; process.stderr.write(d); });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    const passed = code === 0 && /\[import-rollback\] PASS/.test(out) && !/\[import-rollback\] FAIL/.test(out);
    console.log(passed ? '[test:import-rollback] 通过' : '[test:import-rollback] 失败');
    process.exit(passed ? 0 : 1);
  });
})().catch((e) => { console.error(e); process.exit(1); });
