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

// 120 秒不是随手写的余量：自检本身包含只读体检（遍历整库并逐个渲染）和
// 一百多步真实点击，每步都带等待，实测已经到 60 秒上下，而 CI 机器更慢。
// 第一版上限 60 秒时，新增的占位符点击段把它顶过了线，报出来的是"超时"
// 而不是任何一条失败的断言——超时值要留出余量，否则它自己会变成假故障源。
const timeout = setTimeout(() => {
  console.error('\n[test:ui] 超时：120 秒内没完成自检，判定失败');
  child.kill();
  cleanup();
  process.exit(1);
}, 120000);

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
    /\[selftest:ui\] PASS 文件树方向键能把焦点移到下一行/,
    // 方向键曾经每移一行就 click() 一次，按住 ↓ 会沿途给每个文件开标签。
    /\[selftest:ui\] PASS 方向键只移焦点、不打开文件/,
    /\[selftest:ui\] PASS Enter 打开聚焦的文件/,
    /\[selftest:ui\] PASS 方向键能切回上一行/,
    // 折叠目录里的文件曾经仍留在方向键导航序列里（判可见性时只认行内 display:none，
    // 认不出折叠用的 hidden 类），按一下方向键就打开一个屏幕上看不见的文件。
    // 这条必须在输出里，否则"折叠场景根本没跑到"也会显示全绿。
    /\[selftest:ui\] PASS 能折叠一个带文件的目录用于验证/,
    /\[selftest:ui\] PASS 方向键不会跳进折叠目录里看不见的文件/,
    /\[selftest:ui\] PASS 能挑出一个只命中部分文件的阶段用于验证筛选/,
    /\[selftest:ui\] PASS 刷新文件树后筛选仍然生效/,
    /\[selftest:ui\] PASS 刷新文件树后筛选下拉框保持选中值/,
    /\[selftest:ui\] PASS 第二条提示不被第一条的计时器提前隐藏/,
    /\[selftest:ui\] PASS 提示到时会自动隐藏/,
    // 复用关系 chip：这枚 chip 的数据来自全库工作流扫描，只有真的把索引建起来
    // 才会有内容。它在 DOM 里不出现时说不上是"没有引用"还是"没接上"，所以要点名。
    /\[selftest:ui\] PASS 被引用的提示词在元数据栏显示引用 chip/,
    /\[selftest:ui\] PASS 引用 chip 带上了工作流列表/,
    /\[selftest:ui\] PASS 点引用 chip 能跳到引用它的工作流/,
    /\[selftest:ui\] PASS 没有引用的文件不显示引用 chip/,
    // 弹层的对话框语义与焦点管理：role/aria-modal、Tab 圈在弹层里、
    // 关闭后归还焦点、不残留角色属性。这四条此前一条都没有——按 Tab 焦点会
    // 跑到弹层背后的侧边栏上，关掉之后焦点被丢到 body。
    /\[selftest:ui\] PASS 居中弹层读出对话框语义/,
    // 这条的名字说的是"在移动"而不是"被圈住"：合成的 keydown 不会触发浏览器
    // 默认的 Tab 行为，所以光看"焦点没跑出去"在有无陷阱时都成立——第一版那么写，
    // 撤掉陷阱照样绿（实测）。改成要求焦点真的移动并绕回起点之后才分辨得出来。
    /\[selftest:ui\] PASS 按 Tab 焦点在弹层里循环（真的在移动）/,
    /\[selftest:ui\] PASS 弹层关闭后焦点归还给打开的按钮/,
    /\[selftest:ui\] PASS 关闭后不残留对话框属性/,
    // 预览区就地填占位符。这几条要显式点名：整段包在 if (marks().length) 里，
    // 种子内容改了导致标记不上时，段里一条都不会输出，而"没有 FAIL"照样是绿的。
    /\[selftest:ui\] PASS 预览区把 \[占位符\] 标成了可点的 chip/,
    /\[selftest:ui\] PASS 有占位符时显示提示行/,
    /\[selftest:ui\] PASS 点 chip 会弹出就地填写框/,
    /\[selftest:ui\] PASS 填过的 chip 显示填进去的值/,
    /\[selftest:ui\] PASS 复制用的是填好的正文/,
    /\[selftest:ui\] PASS 复制不会改动磁盘上的文件/
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
