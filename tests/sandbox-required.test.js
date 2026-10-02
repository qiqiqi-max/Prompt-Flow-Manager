// tests/sandbox-required.test.js
// 严格验证默认安全路径：沙箱必须在本次启动中直接确认可用，禁止靠降级重建窗口通过。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronBin = require(path.join(root, 'node_modules', 'electron'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-sandbox-required-'));
const child = spawn(electronBin, [root], {
  cwd: root,
  env: {
    ...process.env,
    PFM_SELFTEST: '1',
    PFM_DATA_DIR: dataDir,
    PFM_SANDBOX: 'on',
    PFM_SANDBOX_REQUIRED: '1',
    ELECTRON_ENABLE_LOGGING: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let out = '';
child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });

const timer = setTimeout(() => {
  console.error('[test:sandbox-required] FAIL 60 秒内没有完成');
  child.kill();
}, 60000);

child.on('exit', (code) => {
  clearTimeout(timer);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  const checks = [
    [code === 0, '进程正常退出'],
    [/\[sandbox\] 渲染进程已确认可用，沙箱保持开启/.test(out), '沙箱下渲染进程已确认可用'],
    [/\[selftest\] 全部通过/.test(out), '启动自检通过'],
    [!/就地降级|无沙箱模式重建|拒绝降级/.test(out), '没有发生降级']
  ];
  let failed = 0;
  for (const [ok, msg] of checks) {
    if (ok) console.log('[test:sandbox-required] PASS ' + msg);
    else { failed++; console.error('[test:sandbox-required] FAIL ' + msg); }
  }
  process.exit(failed ? 1 : 0);
});
