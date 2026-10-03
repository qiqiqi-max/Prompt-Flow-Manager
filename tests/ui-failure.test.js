// tests/ui-failure.test.js
// 真实启动 Electron，并让配置写入失败，检查界面提示和状态恢复。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronBin = require(path.join(root, 'node_modules', 'electron'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-ui-failure-'));
fs.mkdirSync(path.join(dataDir, 'prompts', 'testing'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'prompts', 'testing', 'ui-failure.md'), '---\ntitle: UI Failure\n---\nbody');

const script = `
  (async () => {
    const rel = 'prompts/testing/ui-failure.md';
    await refreshTree();
    const before = state.lockedFiles.has(rel);
    await toggleLockFile(rel);
    const toastEl = $('toast');
    const lockMessage = toastEl.textContent;
    const restored = state.lockedFiles.has(rel) === before;
    backgroundSaveToastAt = 0;
    saveSidebarWidthDebounced(333);
    await saveSidebarWidthDebounced.flush();
    await new Promise(resolve => setTimeout(resolve, 20));
    const backgroundMessage = toastEl.textContent;
    const ok = restored
      && /锁定状态保存失败|Failed to save the lock state/.test(lockMessage)
      && /部分界面状态没有保存成功|Some interface state was not saved/.test(backgroundMessage);
    console.log(ok ? '[ui-failure] PASS 配置写入失败时界面提示并恢复状态'
      : '[ui-failure] FAIL ' + JSON.stringify({ restored, lockMessage, backgroundMessage }));
  })()`;

const child = spawn(electronBin, [root], {
  cwd: root,
  env: {
    ...process.env,
    PFM_SELFTEST: '1',
    PFM_DATA_DIR: dataDir,
    PFM_SELFTEST_CONFIG_WRITE_FAIL: '1',
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
  const passed = code === 0 && /\[ui-failure\] PASS/.test(out) && !/\[ui-failure\] FAIL/.test(out);
  console.log(passed ? '[test:ui-failure] 通过' : '[test:ui-failure] 失败');
  process.exit(passed ? 0 : 1);
});
