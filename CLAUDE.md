# CLAUDE.md — Prompt Flow Manager 项目说明

本文件供 Claude（或其他 AI 助手）理解项目结构与约定。修改代码前请先阅读，尤其是最后的「踩过的坑」。

## 项目简介

Prompt Flow Manager 是一个 Electron 桌面应用，用于管理项目开发过程中的**提示词**与**工作流**。核心使用场景：用户在本软件管理/编辑提示词，需要时**复制出去**到其他 AI 工具（Claude 等）使用。软件本身不调用 AI。

## 技术栈

- **运行时**：Electron ^28 / Node.js
- **前端**：原生 HTML/CSS/JS（无框架）。marked（Markdown 预览）、DOMPurify（XSS 清洗）、diff-match-patch（版本对比）
- **打包**：electron-builder → Windows portable exe
- **运行时依赖只有两个**：archiver（导出压缩）、yauzl（导入解压）。渲染进程的三个库以构建产物形式放在 `src/vendor/`，属开发依赖。

## 架构

```
electron-main.js   主进程：窗口、IPC、文件系统、版本管理、回收站、导出、配置、自检
preload.js         桥接：contextBridge 暴露 window.promptFlowApi（白名单 IPC）
lib/
  zip-import.js    ZIP 导入的纯逻辑（可脱离 Electron 单测）
scripts/
  sync-vendor.js   把渲染进程需要的库从 node_modules 同步到 src/vendor/
src/
  index.html       界面结构（含 CSP）
  styles.css       样式（CSS 变量双主题）
  renderer.js      全部渲染逻辑（文件树/搜索/筛选/预览/编辑/流程图/历史/回收站）
  i18n.js          多语言表，全局声明 const I18N
  vendor/          marked / DOMPurify / diff-match-patch 的浏览器构建（由脚本生成，勿手改）
tests/
  smoke.test.js    静态与逻辑冒烟测试（npm test）
  ui-smoke.js      真实拉起 Electron 验证界面能渲染（npm run test:ui）
prompts/           提示词库，按阶段分子目录
workflows/         工作流定义（frontmatter 的 flow 字段）
.versions/         版本快照（每个文件一个子目录，内含时间戳 .md + index.json）
.trash/            回收站（index.json 记录元数据，实体文件用 id 命名）
templates/         模板
```

### 两个根目录，绝对不能混用

```js
const CODE_ROOT = __dirname;                                        // 只读代码资源
const DATA_ROOT = app.isPackaged ? app.getPath('userData') : __dirname;  // 用户数据
```

- `preload.js`、`src/` 只存在于 asar 内 → 一律用 **CODE_ROOT**。
- `prompts/`、`workflows/`、`templates/`、`.versions/`、`.trash/` 需要可写 → 一律用 **DATA_ROOT**。
- 打包后首次运行由 `ensureSeedData()` 把种子内容从 asar 拷到 DATA_ROOT。

## 关键约定

### 数据格式
每个 `.md` 文件 = YAML frontmatter + Markdown 正文。提示词字段：
`title` `stage` `projectType` `tags` `description`（用户编辑）+ `version` `updatedAt` `createdAt`（主进程自动维护）。

工作流在 frontmatter 中用 `flow` 数组定义线性步骤，每步含 `id` `prompt` `label` `next`。

### 安全边界
- 渲染进程 **无 Node 能力**：`contextIsolation: true`、`nodeIntegration: false`。
  所有能力经 `preload.js` 的白名单走 IPC。导入的 .md 属外部内容，
  若 DOMPurify 被绕过，开着 nodeIntegration 就意味着一次 XSS 直接升级为任意代码执行。
- `safeJoin(rel)` 强制普通文件操作落在 DATA_ROOT 内。
- `versionDirFor(rel)` 同样做越权校验；版本文件名走 `VERSION_FILE_RE` 白名单。
- 导入时 frontmatter 的 `title` 会成为文件名，必须过 `sanitizeTitle()`。
- ZIP 导入不落盘、不使用包内路径写文件 → 免疫 zip-slip。
- Markdown 预览经 DOMPurify 清洗；index.html 有 CSP（`script-src 'self'`）。
- `sandbox: false` 与 `--no-sandbox` 是对缺运行库的 Windows 环境的妥协，隔离由 contextIsolation 承担。

### 抛给渲染进程的错误必须带错误码

渲染进程要把错误翻译成用户语言，所以不能直接抛中文。Electron 的 IPC 只传
`Error.message`（自定义属性会丢），因此码编进 message：

```js
throw appError('E_LOCKED', rel);   // message = "E_LOCKED|prompts/a.md"
```

渲染侧 `describeError()` 解析出码，查 i18n 的 `err_<CODE>` 键，
带 `{detail}` 占位符的会把细节填进去；**认不出的码原样显示，不吞信息**。

加新错误码要同时做三件事，否则 `npm test` 会失败：
1. `appError('E_NEW_CODE', detail)`
2. `i18n.js` 的 zh 和 en 都加 `err_E_NEW_CODE`
3. 若一种语言带 `{detail}`，另一种也要带（测试会校验占位符一致）

### 正文缓存（搜索性能）

搜索要遍历整库读正文，是唯一随提示词数量线性变差的操作。

- `readParsedCached(fullPath)` 按 `(mtimeMs, size)` 缓存正文**和**解析后的 frontmatter。
  每次仍然 `stat`（很便宜），只重读真正变过的文件，所以外部编辑器改的文件也能发现。
- `getMetaList(includeContent)` 传 `true` 时把正文带出来。**searchAll 必须复用它**，
  否则又变回 2N 次 I/O（这是修过的问题）。`get-meta-list` 这个 IPC 不带正文，
  避免白白往渲染进程拷一份。
- **任何写入 / 改名 / 删除 / 回滚 / 恢复都要调 `dropFromCache(fullPath)`**，
  漏一处就会出现"改完还搜到旧内容"。测试里有断言数这个调用数量。

已知边界：同一个 mtime 刻度内把文件改成同样大小会命中旧缓存。两个维度要同时相等，
概率极低，代价只是搜索结果延迟一次刷新。

压测：`npm run bench`。1000 条规模下重复搜索约 230ms、读文件 0 次；
优化前是 ~920ms、读文件 2000 次。剩下的开销主要是 1000 次 `stat` 系统调用。

### 版本管理
- 每次保存：若内容变化，把**旧内容**存为 `.versions/<rel>/<时间戳>.md`（时间戳含毫秒，避免同秒覆盖）。
- 保留最近 30 个**未星标**版本；星标（index.json 的 `pinned`）不计入上限、永不自动删。
  配额只按未星标数量算，不要用文件总数。
- 回滚 = 当前内容先存为新版本（不丢），再写入历史版本并 bump 自动字段。

### 回收站与锁定
- 删除不真删，移到 `.trash/` 并记 `index.json`；可恢复。清空回收站才真删。
- 锁定（防误删）由**主进程**强制：`trash` handler 先查 `config.lockedFiles`。
  改名/移动允许，但锁会跟着文件走，避免"改名再删"绕过。

## 多语言（i18n）

**硬规则：renderer.js 里不许出现面向用户的中文字面量。** 所有文案走 `src/i18n.js`，
`npm test` 有断言卡这条（含未标注豁免就报错的检查）。

- `t(key)` / `t(key, { name })` —— 取文案，支持 `{name}` 占位符
- `tErr(key, e)` —— 失败提示统一格式：`<本地化前缀><分隔符><错误详情>`
- `dirLabel(key)` —— 目录名与阶段名（`prompts` / `testing` 这类键）的显示名，
  **不要直接读 `state.stageLabels`**，那是主进程给的中文
- 静态 HTML 用 `data-i18n` / `data-i18n-title` / `data-i18n-placeholder`

### 确实需要保留中文的地方，必须显式豁免

```js
console.error('保存展开状态失败:', e); // i18n-exempt: 开发日志

// i18n-exempt-start: 写入 .md 的文件内容，不是界面文案
const content = \`--- ... ---\`;
// i18n-exempt-end
```

已豁免的三类：开发日志（`console.error`）、会写进 frontmatter 的**用户数据**
（`前端项目` 等工程类型，翻译会破坏已有文件）、新建工作流时写入的模板正文
（其中 `prompt:` 路径指向中文文件名的种子提示词，翻译会让流程图节点全部失效）。

### 加新文案的流程

1. 在 `i18n.js` 的 `zh` 和 `en` **两处**都加键（键数不一致测试会失败）
2. 代码里用 `t('newKey')`
3. 如果这段文案会随语言切换而变，确认 `setLang()` 里重绘了对应区域 ——
   漏掉的区域会残留旧语言，直到用户手动触发一次渲染

### 主进程错误也已本地化

主进程统一抛 `appError('E_XXX', detail)`，渲染侧 `describeError()` 翻成当前语言，
见上面「抛给渲染进程的错误必须带错误码」。

## 测试

三层，各管一件事：

```bash
npm test         # 静态检查 + ZIP 导入逻辑单测 + 真实压缩解压往返
npm run test:ui  # 拉起 Electron，验证 contextBridge / 依赖加载 / 文件树真的渲染出来
npm run test:fn  # 端到端走 IPC：新建→保存→版本→星标→回滚→锁定→删除→恢复→搜索→越权防护
npm run test:all # 三层一起跑
npm run bench    # 搜索压测（临时目录，默认 1000 条）
```

主进程的自检开关（都只在测试里用）：

| 环境变量 | 作用 |
|----------|------|
| `PFM_SELFTEST=1` | 页面加载完自动跑启动自检并退出 |
| `PFM_SELFTEST_FUNCTIONAL=1` | 追加功能自检；**必须同时设 PFM_DATA_DIR**，否则拒绝执行 |
| `PFM_DATA_DIR=<目录>` | 把 DATA_ROOT 指到临时目录，避免测试动到真实提示词库 |
| `PFM_SELFTEST_SHOT=<png>` | 存一张真实渲染截图，便于人工核对界面 |
| `PFM_SELFTEST_LANG=en` | 切到指定语言后检查界面外壳有无残留中文 |
| `PFM_SELFTEST_DIALOGS=<json>` | 用队列文件替换系统对话框，跑通导出/导入 |
| `PFM_SELFTEST_BENCH=<条数>` | 生成指定规模的库并跑搜索压测 |

### 导出/导入怎么做到自动化的

这四个流程都要弹系统对话框。自检模式下 `installSelfTestDialogStubs()` 把
`dialog.showSaveDialog` / `showOpenDialog` 换成"按队列返回预设结果"的桩，
队列是 `PFM_SELFTEST_DIALOGS` 指向的 JSON 文件（每次取走一项并写回剩余项）。
所以**队列顺序必须和调用顺序严格一致**，改动调用顺序时记得同步
`tests/functional-smoke.js` 里的 `dialogQueue`。

两个开关都不设时这段完全不生效，生产行为不受影响。

**还没有自动化覆盖的部分**（改动这些地方要手动点一遍）：
纯鼠标/键盘交互 —— 拖拽移动、右键菜单、键盘导航、主题切换、侧边栏拖宽、
标签栏、流程图渲染、版本 diff 视图、代码块复制按钮。

## 扩展点（留冗余）

- `getMetaList` 已聚合全部元数据，加搜索/统计功能可直接用。
- STAGES、DEFAULT_PROJECT_TYPES 是常量，易扩展。
- 流程图第一版只线性，`flow` 的 `next` 字段已预留分支扩展空间。
- `ipcMain.handle` 集中在主进程，加新能力照此模式加 handler 即可。
- 需要在渲染进程用新的第三方库：把浏览器构建加进 `scripts/sync-vendor.js`，
  再在 index.html 加 `<script>`。不要试图在渲染进程 `require`。

## 不要做的事

- 不要在渲染进程用 `require`（没有），也不要直接访问 fs（走 IPC）。
- 不要用 DATA_ROOT 去加载 preload.js / src/ —— 打包版会白屏。
- 不要改写用户 frontmatter 的结构字段（如 flow），只更新自动字段——用 `bumpAutoFields` 而非整体重序列化。
- 不要静默删除文件；删除一律走 `.trash/`。
- 不要往 DATA_ROOT 追加日志文件（会无限增长），调试信息写 console。
- 不要把高频事件（resize/move）直接接到读写 config.json 的函数上，要防抖。

## 踩过的坑（改代码前务必看一眼，这些都真实发生过）

1. **打包版白屏**：`APP_ROOT` 打包后指向 userData，却拿它加载 `preload.js` 和 `src/index.html`，
   而这两个文件只在 asar 里。→ 拆成 CODE_ROOT / DATA_ROOT。
2. **renderer.js 整段不执行**：`i18n.js` 里已有全局 `const I18N`，renderer.js 又写了
   `const I18N = require('./i18n')`，抛 "Identifier 'I18N' has already been declared"，
   界面全白且只有一行控制台报错。**渲染进程的顶层 `const` 是全局词法声明，跨脚本会撞名。**
3. **contextBridge 名字不能叫 `api`**：暴露出来的是 non-configurable 属性，
   renderer.js 里的 `const api = ...` 会因此抛 "Identifier 'api' has already been declared"。
   现在桥接名是 `promptFlowApi`。
4. **调用了不存在的函数**：`import-single` / `import-zip` / `add-project-type` /
   `remove-project-type` 里写的 `createFile(null, ...)` 和 `setConfig(null, ...)` 从未定义过
   （那只是 ipcMain.handle 的匿名回调），一点就 ReferenceError。
   → 抽出具名的 `createFileAt()` / `updateConfig()`，handler 只做转发。
5. **archiver 不能解压**：`import-zip` 曾把 zip 文件 pipe 进 archiver 当解压用，
   结果什么都没导入却返回 `{ ok: true }`。解压必须用 yauzl。
6. **死循环**：重名处理的 `while (fs.existsSync(...)) { const ext = ... }` 循环体不改变候选名，
   主进程会直接卡死。→ 统一走 `uniqueRel()`，并有单测覆盖。
