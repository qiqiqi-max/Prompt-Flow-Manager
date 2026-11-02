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
// 一个外部已删除文件的收藏和高频统计：usage.json 里有，库里没有。
// 收藏区和常用列表必须把它过滤掉，否则用户点上去只会得到"打开失败"。
// 次数给得很高、时间是现在，保证不过滤时它一定排进常用第一（否则这条断言分辨不出过滤有没有生效）。
fs.writeFileSync(path.join(dataDir, 'usage.json'), JSON.stringify({
  schema: 1,
  items: { 'prompts/testing/外部已删除.md': { count: 50, lastUsedAt: Date.now() } },
  favorites: ['prompts/testing/外部已删除.md']
}, null, 2), 'utf8');

// 文件树批量操作会弹原生确认框，自动化里由对话框桩按队列应答（见 installSelfTestDialogStubs）。
// 顺序必须与 src/selftest/ui.js 里的调用顺序一致：
//   1. 批量移动后"是否同步工作流引用"——两个被移动的文件都被同一个工作流引用，只问一次
//   2. 批量删除的确认（列出锁定和被引用的文件）
// 引用同步要是按文件各问一次，第二问会吃掉删除那一项，删除被当成取消，
// 后面的删除断言全红，退出时还会剩下"队列已空"的报错——这正是要它变红的地方。
const dialogQueuePath = path.join(dataDir, '__dialogs.json');
fs.writeFileSync(dialogQueuePath, JSON.stringify([
  { kind: 'message', response: 1 },   // 批量移动：同步引用 → 确定
  { kind: 'message', response: 1 }    // 批量删除：确定
]), 'utf8');

const child = spawn(electronBin, [root], {
  cwd: root,
  env: {
    ...process.env,
    PFM_SELFTEST: '1',
    PFM_SELFTEST_READONLY: '1',
    PFM_SELFTEST_UI: '1',
    PFM_SELFTEST_DIALOGS: dialogQueuePath,
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
// 加上工作流执行模式那一段（十来次点击 + 造夹具 + 两次读写 config）之后，
// 在多个 Electron 测试并行的高负载机器上实测 119 秒才跑完，又贴着线了，所以放到 180 秒。
const UI_TIMEOUT_MS = 180000;
const startedAt = Date.now();
const timeout = setTimeout(() => {
  console.error('\n[test:ui] 超时：' + (UI_TIMEOUT_MS / 1000) + ' 秒内没完成自检，判定失败');
  child.kill();
  cleanup();
  process.exit(1);
}, UI_TIMEOUT_MS);

child.on('exit', (code) => {
  clearTimeout(timeout);
  // 清理前先读对话框队列：临时目录一删就没得看了
  let queueLeft = -1;
  try { queueLeft = JSON.parse(fs.readFileSync(dialogQueuePath, 'utf8')).length; } catch (_) { queueLeft = -1; }
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
    // 版本说明：从编辑区填写到历史抽屉显示的整条路径，以及说明随内容进入历史的语义。
    /\[selftest:ui\] PASS 带说明保存后历史抽屉里能看到说明/,
    /\[selftest:ui\] PASS Ctrl\+Shift\+S 聚焦说明框且不触发保存/,
    /\[selftest:ui\] PASS 说明框里 Enter 保存，上一句说明随它描述的内容进入历史/,
    // 预览区就地填占位符。这几条要显式点名：整段包在 if (marks().length) 里，
    // 种子内容改了导致标记不上时，段里一条都不会输出，而"没有 FAIL"照样是绿的。
    /\[selftest:ui\] PASS 预览区把 \[占位符\] 标成了可点的 chip/,
    /\[selftest:ui\] PASS 有占位符时显示提示行/,
    /\[selftest:ui\] PASS 点 chip 会弹出就地填写框/,
    /\[selftest:ui\] PASS 填过的 chip 显示填进去的值/,
    /\[selftest:ui\] PASS 复制用的是填好的正文/,
    /\[selftest:ui\] PASS 复制不会改动磁盘上的文件/,
    // 占位符的选项与默认值（种子 部署检查.md）。同样要点名，理由同上。
    /\[selftest:ui\] PASS 有选项的 chip 带上了"可选"标记/,
    /\[selftest:ui\] PASS 有默认值的 chip 显示默认值并带上"默认"标记/,
    /\[selftest:ui\] PASS 就地填写有选项的占位符时出现下拉框，列出全部选项/,
    /\[selftest:ui\] PASS 在下拉框里选一项会写进填写框/,
    /\[selftest:ui\] PASS 就地填写框里 Shift\+Enter 不提交/,
    /\[selftest:ui\] PASS 就地填写框里 Enter 提交，chip 显示选中的值/,
    /\[selftest:ui\] PASS 复制时没改过的默认值按默认值填入/,
    /\[selftest:ui\] PASS 复制面板里有默认值的框预填默认值，有选项的带下拉框/,
    /\[selftest:ui\] PASS 复制面板里上次填过的值优先于默认值/,
    // 装配器导出目标：默认值保证老用户行为不变，勾选落盘并在重开时恢复。
    /\[selftest:ui\] PASS 装配器列出全部导出目标/,
    /\[selftest:ui\] PASS 没存过勾选状态时默认只勾 CLAUDE\.md 和 \.cursorrules/,
    /\[selftest:ui\] PASS 勾选导出目标后写进配置/,
    /\[selftest:ui\] PASS 重新打开装配器时导出目标按配置恢复/,
    // 收藏 / 常用 / 跟随文件。整段都依赖"右键菜单里找得到收藏"，找不到时后面的
    // 检查虽然会 FAIL，但逐条点名才能保证改动之后它们一条都没被静静跳过。
    /\[selftest:ui\] PASS 前置：usage\.json 里确实有外部已删除文件的收藏和统计/,
    /\[selftest:ui\] PASS 右键菜单里有「收藏」/,
    /\[selftest:ui\] PASS 收藏后侧边栏显示收藏区且列出这个文件/,
    /\[selftest:ui\] PASS 收藏区不显示外部已删除的文件（不留幽灵条目）/,
    /\[selftest:ui\] PASS 点收藏条目能打开对应文件/,
    /\[selftest:ui\] PASS 复制成功记了次数和最后使用时间/,
    /\[selftest:ui\] PASS 常用列表按使用排序且不显示外部已删除的文件/,
    /\[selftest:ui\] PASS 取消复制不计入使用次数/,
    /\[selftest:ui\] PASS 改名后收藏和统计跟着文件走/,
    /\[selftest:ui\] PASS 删进回收站时保留收藏和统计/,
    /\[selftest:ui\] PASS 从回收站恢复后收藏和统计还在/,
    /\[selftest:ui\] PASS 清空回收站后统计和收藏一起清掉/,
    // 文件树多选与批量操作。前置条件（B 夹在 A、C 之间 / 筛选真的把 B 藏起来了）也点名：
    // 前置不成立时"跳过看不见的行"那条在有没有修复时都可能是绿的。
    /\[selftest:ui\] PASS 多选：普通单击仍然打开文件且不进入多选/,
    /\[selftest:ui\] PASS 多选：单击 A 后 Ctrl\+点击 C，两个都选中并出现批量条/,
    /\[selftest:ui\] PASS 多选：Esc 清空选择/,
    /\[selftest:ui\] PASS 多选前置：树上 B 夹在 A 和 C 之间/,
    /\[selftest:ui\] PASS 多选前置：标签筛选把 B 隐藏了而 A、C 可见/,
    /\[selftest:ui\] PASS 多选：Shift\+点击跳过被筛掉、看不见的行/,
    /\[selftest:ui\] PASS 多选：折叠目录后目录里的选中项被剔掉、批量条收起/,
    /\[selftest:ui\] PASS 批量：进行中再次触发被拦下/,
    /\[selftest:ui\] PASS 批量移动：两个文件都移到了目标目录，同名的生成新名字/,
    /\[selftest:ui\] PASS 批量移动：已打开的标签页跟着改路径/,
    /\[selftest:ui\] PASS 批量移动：确认一次后两个文件的工作流引用都更新了/,
    /\[selftest:ui\] PASS 批量打标签：多行列表保留写法并追加/,
    /\[selftest:ui\] PASS 批量打标签：当前打开的标签页重读了磁盘/,
    /\[selftest:ui\] PASS 批量删除：结果汇总列出被跳过的锁定文件及原因/,
    /\[selftest:ui\] PASS 批量删除：锁定的文件还在/,
    /\[selftest:ui\] PASS 批量删除：被删文件的标签页关掉了，当前标签切到相邻的那个/,
    // 工作流执行模式的关键路径。整段在一个块里顺序依赖（前一步没走到，后面的断言
    // 就测的是别的状态），点名每一条，防止中途断掉时剩下的静静消失。
    /\[selftest:ui\] PASS 打开工作流时流程图上方有「开始执行」/,
    /\[selftest:ui\] PASS 开始执行后入口步骤高亮为当前步骤/,
    /\[selftest:ui\] PASS 执行面板显示当前步骤的提示词正文/,
    /\[selftest:ui\] PASS 复制本步走填写面板并写进剪贴板/,
    /\[selftest:ui\] PASS 复制本步后这一步标记完成/,
    /\[selftest:ui\] PASS 遇到分支时列出可前往的步骤让用户选/,
    /\[selftest:ui\] PASS 选择分支后它成为当前步骤/,
    /\[selftest:ui\] PASS 同一次执行里填过的同名占位符在后续步骤预填/,
    /\[selftest:ui\] PASS 取消填写面板时不前进/,
    /\[selftest:ui\] PASS 退出执行后显示「继续执行」和「重新开始」/,
    /\[selftest:ui\] PASS 执行进度按工作流写进 config/,
    /\[selftest:ui\] PASS 继续执行回到上次的步骤，已完成的仍打勾/,
    /\[selftest:ui\] PASS 汇合点等另一条分支：完成左支后转到右支/,
    /\[selftest:ui\] PASS 坏引用步骤给出提示且不能复制/,
    /\[selftest:ui\] PASS 跳过坏引用步骤后进入汇合点/,
    /\[selftest:ui\] PASS 回退回到上一步/
  ];
  const missing = mustHave.filter(re => !re.test(out));
  if (missing.length) console.error('[test:ui] 缺少必需的检查项: ' + missing.map(String).join(', '));
  // 对话框队列必须刚好被吃完：剩下的说明有一次该弹的框没弹（比如引用同步被跳过），
  // 不够用（桩打出"队列已空"）说明多弹了框（比如引用同步按文件各问了一次）。
  const dialogsOk = queueLeft === 0 && !/对话框桩：message 队列已空/.test(out);
  console.log('[test:ui] ' + (dialogsOk ? 'PASS' : 'FAIL') + ' 原生确认框弹出次数与预期一致（队列剩 ' + queueLeft + ' 项）');
  const passed = code === 0
    && /\[selftest\] 全部通过/.test(out)
    && missing.length === 0
    && dialogsOk
    && !/FAIL/.test(out);
  // 打出耗时：离上限还有多远要看得见，否则下一次又是贴着线跑到超时才发现。
  console.log('\n[test:ui] ' + (passed ? '通过' : '失败（exit=' + code + '）')
    + '，整段耗时 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒（上限 ' + (UI_TIMEOUT_MS / 1000) + ' 秒）');
  process.exit(passed ? 0 : 1);
});
