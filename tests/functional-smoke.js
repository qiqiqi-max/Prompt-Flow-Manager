// tests/functional-smoke.js
// 端到端功能自检：真正拉起 Electron，从渲染进程调 contextBridge 暴露的 API，
// 走完整条 IPC 链路（新建 → 保存 → 版本 → 星标 → 回滚 → 锁定 → 删除 → 恢复 → 搜索 → 越权防护），
// 最后切到英文界面，检查有没有残留中文（历史上 renderer.js 里几十处文案是硬编码的）。
// 数据目录与配置文件都指向系统临时目录，不会碰你真实的提示词库和设置。
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

// 导出/导入要弹系统对话框，自动化跑不了。主进程在自检模式下会把 dialog 换成
// 按队列返回结果的桩（见 installSelfTestDialogStubs），队列就是下面这个文件。
// 顺序必须与 functionalScript 里的调用顺序严格一致。
const outDir = path.join(dataDir, '__export');
fs.mkdirSync(outDir, { recursive: true });
const exportedMd = path.join(outDir, 'exported.md');
const exportedZip = path.join(outDir, 'exported.zip');
const dialogQueue = [
  { canceled: false, filePath: exportedMd },                 // exportSingle
  { canceled: false, filePath: exportedZip },                // exportZip
  { canceled: false, filePaths: [exportedMd] },              // importSingle
  { canceled: false, filePaths: [exportedZip] },             // importZip
  { canceled: true }                                         // exportZip（验证取消分支）
];
const dialogQueuePath = path.join(dataDir, '__dialogs.json');
fs.writeFileSync(dialogQueuePath, JSON.stringify(dialogQueue), 'utf8');

const child = spawn(electronBin, [root], {
  cwd: root,
  env: {
    ...process.env,
    PFM_SELFTEST: '1',
    PFM_SELFTEST_FUNCTIONAL: '1',
    PFM_DATA_DIR: dataDir,
    PFM_SELFTEST_LANG: 'en',
    PFM_SELFTEST_DIALOGS: dialogQueuePath,
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
  // 落盘产物在清理前先校验：ZIP 必须是真 ZIP（PK 头），单文件导出必须有内容
  const artifacts = [];
  try {
    if (fs.existsSync(exportedMd)) {
      const md = fs.readFileSync(exportedMd, 'utf8');
      artifacts.push(['导出的 .md 有内容且含 frontmatter', md.length > 20 && md.startsWith('---')]);
    } else artifacts.push(['导出的 .md 已落盘', false]);
    if (fs.existsSync(exportedZip)) {
      const buf = fs.readFileSync(exportedZip);
      artifacts.push(['导出的 ZIP 是合法 ZIP（PK 头）', buf.length > 100 && buf[0] === 0x50 && buf[1] === 0x4b]);
    } else artifacts.push(['导出的 ZIP 已落盘', false]);
    const rest = JSON.parse(fs.readFileSync(dialogQueuePath, 'utf8'));
    artifacts.push(['对话框队列已被按序全部消费（剩 ' + rest.length + ' 项）', rest.length === 0]);
  } catch (e) {
    artifacts.push(['产物校验未抛异常: ' + e.message, false]);
  }
  let artifactsOk = true;
  for (const [name, ok] of artifacts) {
    console.log('[test:fn] ' + (ok ? 'PASS ' : 'FAIL ') + name);
    if (!ok) artifactsOk = false;
  }
  cleanup();
  const passed = code === 0
    && /\[selftest\] 全部通过/.test(out)
    && /切换到英文后界面外壳无残留中文/.test(out)
    && /导出 ZIP 返回成功/.test(out)
    && !/\[selftest[^\]]*\] FAIL/.test(out)
    && artifactsOk;
  console.log('\n[test:fn] ' + (passed ? '通过' : '失败（exit=' + code + '）'));
  process.exit(passed ? 0 : 1);
});
