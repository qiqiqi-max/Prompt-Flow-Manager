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
    PFM_SELFTEST_UI: '1',
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
  // 这几条对应曾经真实坏掉过的功能，必须出现在输出里：
  // 1) 流程图解析整段失效（只解析出 1 个空步骤）
  // 2) 点「新建提示词」没反应（打开弹层的 click 冒泡后把弹层自己关掉）
  const mustHave = [
    /\[readonly\] PASS 所有文件都能读取并解析/,
    /\[readonly\] PASS 流程图都能渲染出节点/,
    /\[readonly\] PASS 流程图每个节点都指向存在的提示词/,
    /\[selftest:ui\] PASS 点「新建提示词」后弹出阶段选择且在视口内/,
    /\[selftest:ui\] PASS 整条新建流程真的落盘了文件/,
    /\[selftest:ui\] PASS 点弹层外部能关闭/,
    /\[selftest:ui\] PASS 右键菜单能弹出且有菜单项/,
    /\[selftest:ui\] PASS 文件树方向键能切到下一个文件/,
    // 折叠目录里的文件曾经仍留在方向键导航序列里（判可见性时只认行内 display:none，
    // 认不出折叠用的 hidden 类），按一下方向键就打开一个屏幕上看不见的文件。
    // 这条必须在输出里，否则"折叠场景根本没跑到"也会显示全绿。
    /\[selftest:ui\] PASS 能折叠一个带文件的目录用于验证/,
    /\[selftest:ui\] PASS 方向键不会跳进折叠目录里看不见的文件/
  ];
  const missing = mustHave.filter(re => !re.test(out));
  if (missing.length) console.error('[test:ui] 缺少必需的检查项: ' + missing.map(String).join(', '));
  const passed = code === 0
    && /\[selftest\] 全部通过/.test(out)
    && missing.length === 0
    && !/FAIL/.test(out);
  console.log('\n[test:ui] ' + (passed ? '通过' : '失败（exit=' + code + '）'));
  process.exit(passed ? 0 : 1);
});
