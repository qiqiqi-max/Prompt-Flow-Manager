// tests/search-bench.js
// 搜索压测。搜索会遍历整个库，是唯一随提示词数量线性变差的操作。
// 在临时目录里生成指定条数的提示词，输出耗时、读文件次数和缓存命中率。
// 运行：npm run bench          （默认 1000 条）
//       npm run bench -- 5000
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const count = parseInt(process.argv[2], 10) || 1000;
let electronBin;
try {
  electronBin = require(path.join(root, 'node_modules', 'electron'));
} catch (e) {
  console.error('找不到 electron，请先 npm install');
  process.exit(1);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-bench-'));
const child = spawn(electronBin, [root], {
  cwd: root,
  env: { ...process.env, PFM_DATA_DIR: dataDir, PFM_SELFTEST_BENCH: String(count), ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));
const cleanup = () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {} };
const timer = setTimeout(() => { console.error('[bench] 超时'); child.kill(); cleanup(); process.exit(1); }, 300000);
child.on('exit', (code) => { clearTimeout(timer); cleanup(); process.exit(code || 0); });
