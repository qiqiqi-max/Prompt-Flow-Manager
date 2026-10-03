// tests/import-transaction.test.js
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createImportTransaction } = require('../lib/import-transaction');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:import-transaction] PASS ' + msg);
  else { failures++; console.error('[test:import-transaction] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-import-tx-'));
  try {
    const existing = path.join(root, 'config.json');
    const missing = path.join(root, 'trash', 'index.json');
    const created = path.join(root, 'prompts', 'new.md');
    const createdDir = path.join(root, '.versions', 'prompts', 'new.md');
    await fsp.writeFile(existing, 'old config');
    const tx = createImportTransaction();
    await tx.snapshot(existing);
    await tx.snapshot(missing);
    await tx.trackDir(createdDir);
    await fsp.mkdir(path.dirname(created), { recursive: true });
    await fsp.writeFile(created, 'new');
    tx.trackFile(created);
    await fsp.mkdir(createdDir, { recursive: true });
    await fsp.writeFile(path.join(createdDir, 'v.md'), 'version');
    tx.trackFile(path.join(createdDir, 'v.md'));
    await fsp.writeFile(existing, 'new config');
    await fsp.mkdir(path.dirname(missing), { recursive: true });
    await fsp.writeFile(missing, 'new trash');
    const result = await tx.rollback();
    ok(result.ok === true, '回滚成功', JSON.stringify(result));
    ok(!fs.existsSync(created) && !fs.existsSync(createdDir), '删除本次导入新建的文件和目录');
    ok(fs.readFileSync(existing, 'utf8') === 'old config', '恢复导入前已存在的文件');
    ok(!fs.existsSync(missing), '删除导入前不存在但被写入的文件');

    const preexistingDir = path.join(root, 'existing-dir');
    await fsp.mkdir(preexistingDir);
    const tx2 = createImportTransaction();
    await tx2.trackDir(preexistingDir);
    await tx2.rollback();
    ok(fs.existsSync(preexistingDir), '不删除导入前已存在的目录');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (failures) process.exit(1);
  console.log('[test:import-transaction] 通过');
})().catch((e) => { console.error(e); process.exit(1); });
