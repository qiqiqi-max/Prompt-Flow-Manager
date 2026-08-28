// tests/functional-smoke.js
// 端到端功能自检：真正拉起 Electron，从渲染进程调 contextBridge 暴露的 API，
// 走完整条 IPC 链路（新建 → 保存 → 版本 → 星标 → 回滚 → 锁定 → 删除 → 恢复 → 搜索 → 越权防护）。
// 数据目录指向系统临时目录，不会碰你真实的提示词库。
// 运行：npm run test:fn
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
let electronBin;
try {
  electronBin = require(path.join(root, 'node_modules', 'electron'));
} catch (e) {
  console.error('找不到 electron，请先 npm install');
  process.exit(1);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-fn-'));
console.log('[test:fn] 临时数据目录: ' + dataDir);

const child = spawn(electronBin, [root], {
  cwd: root,
  env: {
    ...process.env,
    PFM_SELFTEST: '1',
    PFM_SELFTEST_FUNCTIONAL: '1',
    PFM_DATA_DIR: dataDir,
    ELECTRON_ENABLE_LOGGING: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let out = '';
child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });

const cleanup = () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {} };

const timeout = setTimeout(() => {
  console.error('\n[test:fn] 超时：90 秒内没完成，判定失败');
  child.kill();
  cleanup();
  process.exit(1);
}, 90000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  cleanup();
  const passed = code === 0 && /\[selftest\] 全部通过/.test(out) && !/FAIL/.test(out);
  console.log('\n[test:fn] ' + (passed ? '通过' : '失败（exit=' + code + '）'));
  process.exit(passed ? 0 : 1);
});
