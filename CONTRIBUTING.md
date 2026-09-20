# 参与开发

本文只写"和别的项目不一样、不看会踩"的部分。通用的 Git 礼仪不在这里重复。

先读一遍 [CLAUDE.md](CLAUDE.md)，尤其是末尾「踩过的坑」。那里每一条都真实发生过。

## 一、反向对照：每条测试都必须证明自己会变红

这是本项目**唯一不可协商**的规则。

新增或修改任何断言后，都要再跑一次「把修复撤掉」的版本，确认那条断言**确实变红**。
如果撤掉修复之后它还是绿的，这条断言就是**空断言**，必须重写——不是"可以先留着"，
是必须重写，因为它比没有更糟：它占着一行 PASS，让人以为这块有人看着。

流程：

```bash
# 1. 记录当前状态（真实源码应当全绿）
npm test

# 2. 把被修复的那一行改回出问题前的写法
#    （或删掉修复所依赖的键、文件、配置项）

# 3. 重跑。目标断言必须出现在失败列表里
npm test

# 4. 恢复源码，确认回到全绿
```

改完记得把临时改动清干净：`git status` 里不应该留下 `.bak` / `.tmp-*` / `.ctrl-*`。

### 为什么规则这么硬：本仓库真实出现过的空断言

下面每一条都是**先写完、自认为没问题、被反向对照当场证伪**的：

| 断言想查的东西 | 为什么它永远是绿的 |
|----------------|--------------------|
| 错误码有没有被本地化 | 正则写成 `new RegExp('\b' + code + '\b')`。在模板字符串里 `\b` 是**退格符**（U+0008），不是单词边界。首字符成了控制字符，永远匹配不上，于是"没有残留错误码"永远成立。4 条断言就这么白绿着 |
| 主进程里还有没有内联的大段脚本 | 只扫 `executeJavaScript(\`` 这一种形状。而真实的写法是 `const uiScript = \`...\`;`，赋值给变量再传。把 133 行脚本原样塞回去，守卫全绿 |
| 打包产物能不能起来 | 用 `/\d+\.\d+\.\d+/` 去 `dist/` 里找 exe。`dist/` 不清理，`readdirSync` 先返回了三周前的旧版本——"打包检查通过"其实在验证一个陈旧 exe |
| 源码里不许出现某种写法 | 直接 `grep` 全文。命中的是**注释里解释这种写法为什么不好**的那句话。检查前要先剥注释 |
| 白名单里的全局在 renderer.js 里都存在 | 用 `\b` 收尾去匹配 `const $ = ...`。`$` 和后面的空格都是非单词字符，两侧非单词就没有词边界，`\b` 永远匹配不上，于是 `$` 被误报成"不存在" |
| 某个功能返回成功 | 匹配 `/导出 ZIP 返回成功/`。失败时打的是 `FAIL 导出 ZIP 返回成功`，同一个正则照样命中。通过和失败都为真 |
| 清空了库，界面应该没有节点 | 库为空时界面仍然渲染 3 个顶层分组。这个"反向对照"本身是无效的——**构造失败场景时也要验证它真的失败了** |

共同点：这些断言都不是逻辑写错，是**匹配目标错了**，而错了之后表现恰好是"恒真"。
静态阅读发现不了，只有真的把修复撤掉才看得见。

### 两个推论

**构造的失败场景，本身也要验证。** 上表最后一行就是：以为"清空库"能让断言变红，
实际不能，于是得出"断言有效"的错误结论。换成必然失败的路径（缺 `PFM_DATA_DIR`
时代码显式 `fail()`）才算数。

**"没有 FAIL"证明不了"这条真的跑到了"。** 被 `if` 包住而条件不成立时，整段静静跳过，
输出里既没有 FAIL 也没有 PASS。所以关键检查项要进 `mustHave` 清单显式点名，
见 `tests/functional-smoke.js`：

```js
const mustHave = [
  /\[selftest\] PASS 英文界面下原生确认框走了 i18n/,
  ...
];
const missing = mustHave.filter(re => !re.test(out));
```

### 已有的参考实现

有两种做法，按被测对象选：

**一、把反向对照做进测试自身**（适合逻辑能单独跑起来的模块）。
`tests/debounce.test.js` 跑完真实实现后，再用修复前的旧版实现跑同一批断言，
要求它**必须失败**，否则测试判定自己无效：

```js
const controlOk = legacyFails > 0;
if (!controlOk) {
  console.error('[test:debounce] FAIL 反向对照居然全绿：这批断言分辨不出旧版实现，测试无效');
}
```

改动 debounce 相关代码时照这个模式走。

**二、单独一个变异脚本**（适合断言本身是"查源码文本"的那种）。
`npm run test:reverse` 覆盖 `npm test` 里「升级检查」那一节：对每条断言施加一次
最小反向改动（改真实源文件），跑真实的 `npm test`，要求**指定的那条**断言出现在
失败列表里。

为什么这类断言非得这么验：它们查的是源码文本，而文本匹配失手的表现往往恰好是
恒真。这一节写完时自认为没问题，跑一遍变异脚本抓出四条空断言——

| 空断言 | 为什么恒真 |
|--------|-----------|
| "升级检查不 await" | 切片锚在 `await createWindow()` 上，而这句在主进程里有两处，`indexOf` 命中的是沙箱降级那处。于是这条在一段根本没有 `runUpdateCheck` 的文本上"成立" |
| 横幅三条（走 textContent / 不用 innerHTML / 版本号过白名单） | 结束锚点写的是一行注释，而这一节先剥了注释，`indexOf` 返回 -1，切片成了空串，三条一起假绿 |
| "整个函数体被 try 包住" | 写成 `/try \{/`。函数里另有一处内层 `try`（包住配置写盘），把外层删掉照样命中 |
| "请求不带本机标识" | 写成黑名单（查 `machineId`、`os.hostname()`）。加一行 `'X-Machine': require('os').hostname()` 直接绕过——黑名单只拦得住它想得到的拼法。改成白名单：枚举允许出现的请求头字段名，多一个就红 |

只要求"出现了失败"也不够：改动可能恰好撞红邻近的另一条断言，那说明目标断言
依然是空的。所以每个用例都指定期望变红的**那一条**。实测有一条就是这么暴露的：
删掉横幅里的白名单调用，红的是"数调用次数"那条，而不是目标断言——因为切片区域里
另一个函数有一句一模一样的调用。

这个脚本会改真实源文件，所以还原路径按最坏情况写：内存 + 系统临时目录双份备份，
显式接管 `SIGINT`/`SIGTERM`（node 默认收到 SIGINT 直接终止进程，`finally` 不会跑），
每次跑完比对 md5，收尾再确认回到基线全绿。

`npm run test:reverse-split` 是同一套做法的第二个实例，盯的是「自检模块拆分」那一节
——也就是 `lib/selftest.js` 和主进程之间那份手写的注入契约。它同样抓出了三条空断言，
形状和上面那四条不一样，值得单列：

| 空断言 | 为什么恒真 |
|--------|-----------|
| "三个入口都有 requireInit 守卫" | 写成 `match(/requireInit\(/g).length >= 4`——数出现次数。把 `requireInit` 的函数体换成 `void who;`，四处文本一个没少，断言照绿，而守卫已经形同虚设。**数文本量证明不了文本在干活** |
| "attachSelfTest 不从模块作用域取 win" | 只切函数签名来查 `win`。在模块里加 `let win = null;` 再写 `targetWin = targetWin \|\| win;`，签名里干干净净，而模块已经重新持有了一个会被重建窗口换掉的引用 |
| "不自己解析数据目录" | 只查 `app.getPath(`。改用 `process.env.PFM_DATA_DIR \|\| __dirname` 就绕过去了，而那同样是第二份 DATA_ROOT 真值来源 |

第一条那个教训最通用：**断言要盯行为，不要盯符号出现的次数**。改法是两头都查——
定义里真的 `throw`，且每个入口的第一条语句就是它（挪到后面等于前面那些活已经干完了）。

还有一类失败是**用例自己写错**，不是断言空。`init 不再校验漏传` 那条的 find 串少算了
中间夹的三行注释，`mutate` 直接报"要替换的代码没找到"——这正是它该有的行为：
用例和代码脱节必须当失败，而不是静静跳过。所以 `mutate` 返回没命中的那条 `find`
并打出来，绝不返回"跳过"。

## 二、测试不许碰真实数据

功能类自检会真的写文件、真的改配置、真的删东西。所有这类开关都**强制**要求
同时设置 `PFM_DATA_DIR`，没设就直接 `fail()` 退出：

```
功能自检必须设置 PFM_DATA_DIR，拒绝在真实数据目录上跑
语言自检必须设置 PFM_DATA_DIR，拒绝改写用户真实配置
UI 点击自检必须设置 PFM_DATA_DIR，拒绝在真实库上点
```

新增任何会落盘的自检分支，都要加同样的前置检查。这不是防御性编程，是防止
开发机上的提示词库被测试清空。

## 三、测试分层

```bash
npm run lint          # eslint（真实文件才查得到，见第四节）
npm test              # 静态约束 + ZIP 单测 + 压缩解压往返
npm run test:ui       # 拉起 Electron，验证渲染 + 只读体检 + 真实点击流程
npm run test:fn       # 端到端走 IPC，含英文界面残留中文检查
npm run test:tabs     # 重启后标签页与正文恢复
npm run test:debounce # 防抖/flush（自带反向对照）
npm run test:close    # 关窗落盘握手
npm run test:render   # markdown 渲染成本上限
npm run test:heal     # 启动自愈修坏数据目录（自带反向对照）
npm run test:logger   # 日志滚动/脱敏 + 诊断导出（裸 node，自带两组反向对照）
npm run test:sandbox  # 沙箱降级状态机（裸 node，自带两组反向对照）
npm run test:update   # 升级检查：版本比较 + 出网约束（裸 node，自带三组反向对照）
npm run test:contrast # 配色对比度与焦点可见性（裸 node，自带一组反向对照）
npm run test:reverse  # 把第一节那套流程自动化：逐条改坏源码，验证目标断言真的变红
npm run test:reverse-split # 同上，针对「自检模块拆分」那一节的注入契约
npm run test:all      # 以上除 packaged 外全跑
npm run bench         # 搜索压测（临时目录）

npm run dist          # 打包
npm run test:packaged # 对打包产物跑自检（必须先 dist）
```

`test:packaged` 不在 `test:all` 里，因为它依赖 `dist/` 产物。它覆盖的是
**开发模式结构上测不到**的一整类故障：开发模式下 `CODE_ROOT` 和 `DATA_ROOT`
恰好是同一个目录，把 preload 路径写成 `DATA_ROOT` 也照样能跑；打包后两者分叉，
才会白屏。历史上最严重的一次故障正是这个。

改了打包相关的东西（`build.files`、路径解析、`ensureSeedData`），必须跑一次
`npm run dist && npm run test:packaged`。

### 换 Electron 版本：先确认二进制真的换了

`npm i -D electron@<版本>` **不保证**二进制跟着换。二进制的下载解压是 electron 包
自己的 `install.js` 干的，它开头的 `isInstalled()` 看到旧 `node_modules/electron/dist/`
还在就直接 return，退出码 0、一句话都不说。结果是 package.json 写着新版本，
`test:ui` / `test:fn` 拉起的还是旧二进制，而所有测试照常全绿。

`npm test` 现在有断言逐字比对 `node_modules/electron/dist/version` 和 package.json 的声明值，所以这条
不会再静默通过（版本必须锁成确定版本，不能带 `^`，否则没法逐字比）。换版本的动作：

```bash
rm -rf node_modules/electron/dist
npm i -D electron@43.7.2
node -e "console.log(require('fs').readFileSync('node_modules/electron/dist/version','utf8'))"
npx electron --version     # 两个都要是新版本才算换成功
```

下载卡住时走镜像。GitHub 的 release 主机在国内经常直接 504（实测三次重试全是
`HTTPError: Response code 504`，手敲 curl 25 秒只下来 863KB）：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm i -D electron@43.7.2
```

这条断言的反向对照是**手工**做的：它要改 `node_modules`，不适合进自动变异脚本
——脚本中途被打断就会把错的版本号留在那里，之后每次 `npm test` 都红在一个
看不懂的地方。要复验按这三步（第三步的版本号跟着 package.json 写）：

```bash
node -e "require('fs').writeFileSync('node_modules/electron/dist/version','38.8.6')"
npm test   # 必须红在「装着的 electron 二进制与 package.json 一致」
node -e "require('fs').writeFileSync('node_modules/electron/dist/version','43.7.2')"
```

注意 `electron-builder` 打包时下的是**另一份**二进制，和 `node_modules` 里那份无关。
所以"打包产物是新版本"和"跑测试用的是新版本"是两件独立的事，得分别确认。

### 自检开关

| 环境变量 | 作用 | 要求 |
|----------|------|------|
| `PFM_SELFTEST=1` | 页面加载完跑启动自检并退出 | |
| `PFM_DATA_DIR=<目录>` | 把 DATA_ROOT 指向临时目录 | 下面几项的前置 |
| `PFM_SELFTEST_FUNCTIONAL=1` | 端到端功能自检 | 必须配 `PFM_DATA_DIR` |
| `PFM_SELFTEST_UI=1` | 真实事件序列点界面 | 必须配 `PFM_DATA_DIR` |
| `PFM_SELFTEST_LANG=en` | 切语言后查残留中文 | 必须配 `PFM_DATA_DIR` |
| `PFM_SELFTEST_CLOSE=<模式>` | 关窗落盘握手 | 必须配 `PFM_DATA_DIR` |
| `PFM_SELFTEST_READONLY=1` | 只读体检：每个文件能否读取/解析/渲染 | 只读，不写 |
| `PFM_SELFTEST_DIALOGS=<json>` | 用队列文件替换系统对话框 | 顺序必须与调用顺序一致 |
| `PFM_SELFTEST_OPEN=<相对路径>` | 启动后先打开指定文件 | |
| `PFM_SELFTEST_SHOT=<png>` | 存一张渲染截图供人工核对 | |
| `PFM_SELFTEST_BENCH=<条数>` | 生成指定规模的库跑搜索压测 | |

### 运行期逃生口（不是自检开关）

| 环境变量 | 作用 |
|----------|------|
| `PFM_SANDBOX=on\|off` | 强制开/关渲染进程沙箱，覆盖自动判定 |
| `PFM_UPDATE_CHECK=on\|off` | 强制开/关启动时的升级检查，覆盖设置项和时间间隔 |

`PFM_SANDBOX` 和上面那张表不是一类东西：它面向**用户**，不是面向测试。
沙箱默认开启，只有在这台机器上被证明起不来之后才自动降级
（判定逻辑见 `lib/sandbox-state.js` 的文件头）。而自动降级是无声发生的，
所以需要一个不改代码就能强制回到某一侧的开关：

- `off`：想跳过自动判定，一开始就不要沙箱
- `on`：想验证"降级是不是误判"，或者装完运行库想立刻回到沙箱

正常情况下 `off` 用不着：渲染进程在沙箱下起不来时，主进程会当场重建一个
无沙箱窗口（用户只看到窗口闪一下），并把结论落盘让下次启动直接跳过沙箱。

它**不写状态文件**——临时手段不该污染自动判定的历史。这一点有断言盯着。

`PFM_UPDATE_CHECK` 同理面向用户，但要挡的是另一件事：升级检查是本项目**唯一**
主动出网的地方（另一处 `shell.openExternal` 由用户点击触发）。所以它默认可关，
设置面板里有开关，这个环境变量再多给一层不改配置就能停掉的手段：

- `off`：内网/离线环境，或者不希望软件自己联网。设成 off 之后连请求都不发
- `on`：压过设置项**和**每天一次的时间间隔，用来手动验证这条链路
  （否则一天只有一次机会，改完得等到明天）

出网这件事的约束写在 `lib/update-check.js` 的文件头：只读 `tag_name`、
发布页地址是本地常量、任何失败都静默、请求里不带本机标识。每一条都有断言，
反向对照见 `npm run test:update`。

## 四、自检脚本是真实文件，不许写回模板字符串

`src/selftest/*.js` 里的脚本由主进程 `loadSelfTestScript()` 读进来，再交给
`webContents.executeJavaScript()` 执行。它们曾经是主进程里的模板字符串，共 415 行。

**为什么必须是真实文件**：模板字符串里的代码对所有静态检查都是不透明的。
实测在里面塞一个 `const const x = 1`，`node --check`、eslint、冒烟测试**三层全绿**，
而它一运行必炸。拆成 `.js` 文件后 eslint 立刻抓出一个死变量和上面那个退格符 bug。

几条约束：

- 每个文件必须是**单个可求值表达式**，`executeJavaScript(script, true)` 的要求。
  统一写成 `(async () => { ... })()`。
- 用到的渲染进程全局（`state` / `openFile` / `setLang` …）要加进
  `eslint.config.js` 的 `selftestRendererGlobals`。这是**白名单不是关闭 no-undef**，
  所以拼错的名字仍然会被抓到。冒烟测试会逐个回查这些名字在 `src/renderer.js` 里
  真有顶层声明，防止改名后白名单静默脱节。
- 从 `CODE_ROOT` 读，不是 `DATA_ROOT`。这是代码资源，打包后在 asar 内。
- 新增文件后确认 `build.files` 覆盖得到（目前 `src/**/*` 覆盖），
  `tests/packaged-smoke.js` 会直接查 asar 目录清单来卡这一条。

`tests/smoke.test.js` 有守卫：主进程里出现超过 10 行的内联脚本模板字符串就报错。
短的内联 DOM 探测（两三行）是允许的。

## 五、i18n

加文案要同时补 `zh` 和 `en`，冒烟测试会比对两边键数量和缺失键。

主进程也要本地化。原生对话框（确认框、文件选择框）**不在 DOM 里**，
"clone body 查残留中文"那套检查完全看不到它们——历史上主进程把按钮写死成中文，
英文用户看到的是"提示是英文、按钮是取消/确定"的混排框，而自动化一直是绿的。
现在的做法是让对话框真的弹一次，由桩记下实际参数再断言参数里没有中文。

只静态查源码有没有 `mt()` 是不够的：传错键、`mt()` 查不到键回退成中文，
源码看着都是对的。

确实需要保留中文的地方要显式豁免，见 CLAUDE.md。

## 六、提交

- 提交信息用中文，一句话说清**改了什么行为**，不写"修复 bug"这种。
  参考现有 log：`修复弹层被自己的打开点击关掉：新建/重命名/移动/导入全部失效`
- 一个提交一件事。修复 + 顺手重构要拆开。
- 不直接推 `main`，走分支 + PR。
- 推之前至少跑 `npm run lint && npm test`；碰了渲染或 IPC 就跑 `npm run test:all`；
  碰了打包就补 `npm run dist && npm run test:packaged`。

## 七、代码注释写什么

注释解释**为什么**，不解释代码在做什么。特别值得写的是"这里为什么不能用那种
看起来更自然的写法"——本项目的注释大量是这一类，因为踩过：

```js
// split/join 而不是 replace：lang.js 里有两处 __LANG__，
// 而 replace(字符串, ...) 只换第一处，第二处会原样留成字面量。
```

这种注释救的是下一个想"顺手简化一下"的人。
