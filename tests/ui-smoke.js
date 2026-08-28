// tests/ui-smoke.js
// 真正把 Electron 窗口加载起来，验证渲染进程能跑通。
// 为什么必须有这一层：本项目出过两次"进程正常、界面全白"的故障
//   1) renderer.js 顶层标识符与其他脚本重名，整段脚本被 SyntaxError 掐死；
//   2) 打包后 preload / index.html 的路径指向了数据目录。
// 纯静态检查测不到，只有把页面真正加载起来才暴露。
// 运行：npm run test:ui
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

const child = spawn(electronBin, [root], {
  cwd: root,
  env: { ...process.env, PFM_SELFTEST: '1', ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let out = '';
child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });

const timeout = setTimeout(() => {
  console.error('\n[test:ui] 超时：60 秒内没有完成自检，判定失败');
  child.kill();
  process.exit(1);
}, 60000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  const passed = code === 0 && /\[selftest\] 全部通过/.test(out);
  console.log('\n[test:ui] ' + (passed ? '通过' : '失败（exit=' + code + '）'));
  process.exit(passed ? 0 : 1);
});
