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
// 桩按 kind 取件：不带 kind 的是文件对话框（save/open），kind:'message' 的是
// 消息框。两类各自按先后顺序消费，互不干扰——所以下面插进来的三个未保存应答
// 不会把导出/导入那四项挪位。同类内部的顺序必须与调用顺序严格一致。
const outDir = path.join(dataDir, '__export');
fs.mkdirSync(outDir, { recursive: true });
const exportedMd = path.join(outDir, 'exported.md');
const exportedZip = path.join(outDir, 'exported.zip');
const exportedDiag = path.join(outDir, 'diag.json');
const dialogQueue = [
  { canceled: false, filePath: exportedMd },                 // exportSingle
  { canceled: false, filePath: exportedZip },                // exportZip
  { canceled: false, filePaths: [exportedMd] },              // importSingle
  { canceled: false, filePaths: [exportedZip] },             // importZip
  { canceled: true },                                        // exportZip（验证取消分支）
  // 诊断信息导出（functional.js 第 14 节）。位置必须在这里：文件类对话框
  // 按先后顺序消费，第 14 节排在第 11 节之后、第 13 节不占文件类队列。
  { canceled: false, filePath: exportedDiag },               // exportDiagnostics
  // 未保存改动的三选一（confirm-unsaved）：buttons 是 [保存, 不保存, 取消]，
  // 所以 response 0/1/2 分别对应三条分支。顺序 = functionalScript 第 13 节
  // 13a 取消 → 13b 不保存 → 13c 保存。
  { kind: 'message', response: 2 },                          // 13a 取消
  { kind: 'message', response: 1 },                          // 13b 不保存
  { kind: 'message', response: 0 },                          // 13c 保存
  // 切到英文后的原生对话框探针（见主进程语言自检那一段）。原生框不在 DOM 里，
  // "clone body 查残留中文"看不到它们，所以真的弹一次、由桩记下实际参数再断言。
  // 两条都返回取消：探针只关心弹出时的按钮/标题文案，不该真导出文件。
  { kind: 'message', response: 0 },                          // 探针：confirm
  { canceled: true }                                         // 探针：exportZip（不写文件）
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

    // ---- 日志与诊断包：断言放在进程外，退出后直接读磁盘 ----
    // 进程里自己说"我写了日志"证明不了文件真的在盘上（logger 落盘失败是**静默**的，
    // 只累加 failures），所以这几条必须从外面看。
    const logFile = path.join(dataDir, 'logs', 'app.log');
    if (fs.existsSync(logFile)) {
      const logText = fs.readFileSync(logFile, 'utf8');
      const lines = logText.split('\n').filter(s => s.length > 0);
      const LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (INFO|WARN|ERROR) /;
      artifacts.push(['日志落在 logs/app.log（不是数据根目录顶层）', lines.length > 0]);
      artifacts.push(['每行都是 <ISO> <LEVEL> 形状（' + lines.length + ' 行）',
        lines.every(l => LINE_RE.test(l))]);
      // 自愈那几行现在走 logger，必须同时出现在文件里——这是"接进去了"的证据。
      // 只看 stdout 不够：改回 console.* 后 stdout 一模一样，文件里却什么都没有。
      artifacts.push(['自愈的输出真的进了日志文件', /\[heal\]/.test(logText)]);
    } else {
      artifacts.push(['日志文件 logs/app.log 已生成', false]);
    }
    if (fs.existsSync(exportedDiag)) {
      const raw = fs.readFileSync(exportedDiag, 'utf8');
      let diag = null;
      try { diag = JSON.parse(raw); } catch (_) { diag = null; }
      artifacts.push(['导出的诊断包是可解析 JSON 且带 schema', !!diag && diag.schema === 1]);
      // 原子写：临时文件必须已经 rename 掉，不能在目标目录留 .part
      const leftParts = fs.readdirSync(outDir).filter(n => n.endsWith('.part'));
      artifacts.push(['诊断包走了原子写且没留下 .part（剩 ' + leftParts.length + ' 个）',
        leftParts.length === 0]);
      // 诊断包会被贴进 issue，所以不能带正文，也不能带用户文件名。
      // 这里查的是功能自检自己造的那些文件名（它们在这次运行里真实存在过）。
      const leaked = ['自检临时', '自检改名', '第一版正文', '未保存A'].filter(s => raw.includes(s));
      artifacts.push(['诊断包不含用户文件名/正文' + (leaked.length ? '，泄漏：' + leaked.join(',') : ''),
        leaked.length === 0]);
      artifacts.push(['诊断包里两个根目录原样给出（排查路径问题的唯一依据）',
        !!diag && !!diag.roots && typeof diag.roots.dataRoot === 'string' && diag.roots.dataRoot.length > 0]);
      // 路径脱敏必须查一个**真的含路径**的字段。
      // 原先这里写的是"日志文件里没有裸的绝对路径"——那是个空断言：正常启动
      // 落进 app.log 的只有 [heal] 那一行，它压根不含任何路径，所以无论
      // maskRoots 有没有生效都是绿的。logger.dir 一定是个目录，脱敏掉了就是
      // <data>\logs，没脱敏就是完整的临时目录路径（里面带 Windows 用户名）。
      const loggerDir = diag && diag.logger ? String(diag.logger.dir || '') : '';
      artifacts.push(['诊断包里的日志目录已脱敏成 <data>（不带真实绝对路径）: ' + loggerDir,
        loggerDir.includes('<data>') && !loggerDir.toLowerCase().includes(dataDir.toLowerCase())]);
    } else {
      artifacts.push(['诊断包已落盘', false]);
    }

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
  // 必须出现在输出里的检查项。一律带上 PASS 前缀去匹配：
  // 光写 /导出 ZIP 返回成功/ 是个空断言——失败时打的是
  // "[selftest] FAIL [fn] 导出 ZIP 返回成功"，同一个正则照样命中，
  // 通过与失败两种情况都为真，实际只靠下面那条 FAIL 兜着。
  // 而 FAIL 那条只能证明"没有失败"，证明不了"这一条真的跑到了"——
  // 断言被整段跳过（比如包在 if 里而条件没成立）时它是绿的。
  const mustHave = [
    // 占位符替换的回显检查。放进清单是因为它包在 if (PFM_SELFTEST_LANG) 里，
    // 环境变量没传时整段跳过，"没有 FAIL"照样是绿的。
    /\[selftest\] PASS lang\.js 的 __LANG__ 占位符全部替换成 en/,
    /\[selftest:fn\] PASS 导出 ZIP 返回成功/,
    // 三选一对话框的三条分支各自都要落到磁盘断言上，见 functionalScript 第 13 节
    /\[selftest:fn\] PASS 未保存三选一点取消：没有切走/,
    /\[selftest:fn\] PASS 未保存三选一点取消：磁盘正文没被动过/,
    /\[selftest:fn\] PASS 未保存三选一点不保存：切过去了/,
    /\[selftest:fn\] PASS 未保存三选一点不保存：version 没有自增/,
    /\[selftest:fn\] PASS 未保存三选一点保存：草稿真的落盘了/,
    /\[selftest:fn\] PASS 未保存三选一点保存：version 自增到 2/,
    // 原生对话框的本地化。这两条必须在清单里：它们在 if (lang === 'en' &&
    // PFM_SELFTEST_DIALOGS) 里，条件不成立时整段被跳过，只靠"没有 FAIL"是绿的。
    /\[selftest\] PASS 英文界面下原生确认框走了 i18n/,
    /\[selftest\] PASS 英文界面下文件对话框标题走了 i18n/,
    // 诊断/日志（第 14 节）。同样包在 if (window.__pfmDialogStubs) 里，
    // 而且 getDiagnostics / exportDiagnostics 是新加的 preload 方法——
    // 忘了加就是 undefined，整段 try 直接跳到 catch，输出里一条都不剩。
    /\[selftest:fn\] PASS 诊断报告里日志是启用状态/,
    /\[selftest:fn\] PASS 日志尾部里有启动自愈留下的记录/,
    /\[selftest:fn\] PASS 诊断包不含提示词正文/,
    /\[selftest:fn\] PASS 导出诊断信息返回成功且带字节数/
  ];
  const missing = mustHave.filter(re => !re.test(out));
  if (missing.length) console.error('[test:fn] 缺少必需的检查项: ' + missing.map(String).join(', '));
  const passed = code === 0
    && /\[selftest\] 全部通过/.test(out)
    && /PASS 切换到英文后界面外壳无残留中文/.test(out)
    && missing.length === 0
    && !/\[selftest[^\]]*\] FAIL/.test(out)
    && artifactsOk;
  console.log('\n[test:fn] ' + (passed ? '通过' : '失败（exit=' + code + '）'));
  process.exit(passed ? 0 : 1);
});
