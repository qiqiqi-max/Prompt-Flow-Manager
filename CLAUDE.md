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

### 已知限制

主进程 `throw new Error('...')` 的文案仍是中文，英文界面下 `tErr()` 拼出来会混中文。
正常操作路径上渲染进程会先自己判断并给出本地化提示，所以这只在异常路径可见。
彻底解决需要给主进程异常加错误码，暂未做。

## 测试

三层，各管一件事：

```bash
npm test         # 静态检查 + ZIP 导入逻辑单测 + 真实压缩解压往返
npm run test:ui  # 拉起 Electron，验证 contextBridge / 依赖加载 / 文件树真的渲染出来
npm run test:fn  # 端到端走 IPC：新建→保存→版本→星标→回滚→锁定→删除→恢复→搜索→越权防护
npm run test:all # 三层一起跑
```

主进程的自检开关（都只在测试里用）：

| 环境变量 | 作用 |
|----------|------|
| `PFM_SELFTEST=1` | 页面加载完自动跑启动自检并退出 |
| `PFM_SELFTEST_FUNCTIONAL=1` | 追加功能自检；**必须同时设 PFM_DATA_DIR**，否则拒绝执行 |
| `PFM_DATA_DIR=<目录>` | 把 DATA_ROOT 指到临时目录，避免测试动到真实提示词库 |
| `PFM_SELFTEST_SHOT=<png>` | 存一张真实渲染截图，便于人工核对界面 |

**还没有自动化覆盖的部分**（改动这些地方要手动点一遍）：
带系统对话框的导出/导入（export-zip / export-single / import-single / import-zip 的
dialog 分支）、以及纯交互 UI —— 拖拽移动、右键菜单、键盘导航、主题切换、
侧边栏拖宽、标签栏、流程图渲染、版本 diff 视图、代码块复制。

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
