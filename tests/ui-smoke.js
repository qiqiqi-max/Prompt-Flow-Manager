// tests/ui-smoke.js
// 真正把 Electron 窗口加载起来，验证渲染进程能跑通，并对库内容做只读体检
// （每个文件能否读取/解析/渲染，工作流的流程图能否解析出节点、节点是否指向存在的文件）。
// 为什么必须有这一层：本项目出过两次"进程正常、界面全白"的故障
//   1) renderer.js 顶层标识符与其他脚本重名，整段脚本被 SyntaxError 掐死；
//   2) 打包后 preload / index.html 的路径指向了数据目录。
// 纯静态检查测不到，只有把页面真正加载起来才暴露。
// 运行：npm run test:ui
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

// 只读体检跑在临时目录的种子数据副本上：内容和真实库一致，但不碰用户的库。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-ui-'));
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name));
    else fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
};
for (const d of ['prompts', 'workflows', 'templates']) {
  const src = path.join(root, d);
  if (fs.existsSync(src)) copyDir(src, path.join(dataDir, d));
}

const child = spawn(electronBin, [root], {
  cwd: root,
  env: {
    ...process.env,
    PFM_SELFTEST: '1',
    PFM_SELFTEST_READONLY: '1',
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
  console.error('\n[test:ui] 超时：60 秒内没有完成自检，判定失败');
  child.kill();
  cleanup();
  process.exit(1);
}, 60000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  cleanup();
  // 流程图解析曾经整段失效（只解析出 1 个空步骤），所以这几条必须出现
  const passed = code === 0
    && /\[selftest\] 全部通过/.test(out)
    && /\[readonly\] PASS 所有文件都能读取并解析/.test(out)
    && /\[readonly\] PASS 流程图都能渲染出节点/.test(out)
    && /\[readonly\] PASS 流程图每个节点都指向存在的提示词/.test(out)
    && !/FAIL/.test(out);
  console.log('\n[test:ui] ' + (passed ? '通过' : '失败（exit=' + code + '）'));
  process.exit(passed ? 0 : 1);
});
