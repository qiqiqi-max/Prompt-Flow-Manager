# Prompt Flow Manager · 提示词流程管理系统

一个本地桌面应用，用于管理你做项目时用到的提示词与工作流。核心用途：**积累和复用提示词**——需要时从本软件复制到其他 AI 工具使用。

## 特性

- 📁 **分类管理**：提示词按项目阶段（初始化 / 编码 / 审查 / 测试 / 部署）分类存放
- 🔍 **全文搜索**：按标题、标签、内容搜索并高亮关键词；可折叠高级筛选（阶段 / 工程类型 / 标签）
- 📝 **Markdown 编辑**：轻量文本框，原地切换编辑/预览，Ctrl+S 保存
- 🔀 **流程可视化**：工作流自动渲染流程图，点击节点跳转对应提示词
- 🕘 **版本历史**：每次保存自动留档（保留最近 30 条未星标版本），可星标保护、对比差异、一键回滚
- 🗑️ **回收站**：删除走回收站，可恢复，不误删
- 💾 **导出备份**：一键打包整个库为 ZIP，或导出单个提示词为 .md 文件
- 📊 **统计概览**：空状态显示各阶段提示词数量分布
- 🕘 **最近打开**：空状态快速回到最近编辑过的提示词（自动记忆，最多 10 条）
- 🌐 **中英双语**：设置面板切换，界面文案全量覆盖（工程类型等用户数据不翻译）
- 🎨 **明暗主题**
- ⚙️ **自定义工程类型**：设置面板管理预设类型列表
- ⌨️ **键盘导航**：文件树上下箭头切换，Esc 关闭抽屉/编辑/清空搜索
- 📋 **代码块复制**：预览区代码块悬停显示复制按钮
- 📑 **创建副本**：基于现有提示词快速创建变体
- 🔒 **锁定防误删**：右键锁定重要提示词，已锁定的文件无法删除（主进程强制校验，改名后锁跟随）
- ↔️ **可调整侧边栏**：拖动分隔条调整宽度（自动记忆），双击重置

## 快速开始

### 环境要求
- Node.js 18+（推荐 20+）
- Windows 10+（打包目标）

### 安装与运行
```bash
npm install
npm start
```

### 测试
```bash
npm test         # 静态检查、ZIP 导入逻辑、真实压缩解压往返
npm run test:ui  # 拉起 Electron，确认界面真的能渲染出来
npm run test:fn  # 端到端功能自检（在临时目录里跑，不碰你的提示词库）
npm run test:all # 三层一起跑
npm run bench    # 搜索压测：默认 1000 条提示词，输出耗时与 I/O 次数
```

### 打包成 exe
```bash
npm run dist
```
生成的 portable exe 在 `dist/` 目录，双击即可运行。打包前会自动执行
`npm run sync-vendor`，把渲染进程用到的第三方库同步到 `src/vendor/`。

## 使用说明

### 基本操作
| 操作 | 方式 |
|------|------|
| 新建提示词 | 工具栏「＋ 提示词」或 Ctrl+N，或文件树右键「在此新建」 |
| 新建工作流 | 工具栏「＋ 工作流」 |
| 最近打开 | 空状态下「最近打开」列表，点击快速跳转 |
| 搜索 | 顶部搜索框，Ctrl+Shift+F 聚焦 |
| 编辑 | 选中文件后点「编辑」，Ctrl+S 保存 |
| 复制到 AI 工具 | 选中文件后点「复制」 |
| 创建副本 | 文件树右键「创建副本」（基于现有提示词创建变体） |
| 版本历史 | 点「历史」按钮，右侧抽屉 |
| 重命名 / 移动 / 删除 | 内容区按钮，或文件树右键 |
| 锁定文件 | 文件树右键「锁定（防误删）」，已锁定文件名旁显示 🔒 |
| 导出备份 | 工具栏「导出」或 Ctrl+E |
| 导出单个提示词 | 内容区「导出」按钮 |
| 自定义工程类型 | 工具栏 ⚙ 设置 |
| 切换主题 | 工具栏 🌓 或 Ctrl+Shift+L |
| 文件树导航 | 选中树区后 ↑/↓ 切换文件 |
| 调整侧边栏宽度 | 拖动分隔条，双击重置 |
| 关闭抽屉/编辑 | Esc |
| 清空搜索 | 搜索框内按 Esc |

### 提示词文件格式
每个提示词是一个 `.md` 文件，顶部 YAML frontmatter：
```yaml
---
title: 需求分析          # 显示名
stage: project-init      # 阶段（由所在目录决定，也在此记录）
projectType: 前端项目     # 工程类型
tags: [需求, 分析]        # 标签
description: 一句话说明
---
正文（会被复制出去的就是这部分）
```

`version` / `updatedAt` / `createdAt` 由软件自动维护，无需手填。

### 工作流文件格式
```yaml
---
title: 完整项目流程
flow:
  - id: step1
    prompt: prompts/project-init/需求分析.md
    label: 需求分析
    next: step2
  - id: step2
    prompt: prompts/code-generation/功能实现.md
    label: 功能实现
---
```
打开工作流文件会自动渲染流程图，点击节点跳转对应提示词。

## 数据位置

数据目录随运行方式不同：

| 运行方式 | 数据位置 |
|----------|----------|
| 源码运行（`npm start`） | 项目目录本身 |
| 打包后的 exe | `%APPDATA%\prompt-flow-manager\` |

打包后 exe 内部是只读的，所以数据落在系统 userData 目录；首次运行会把内置示例提示词拷过去。

两种方式下的目录结构一致：
- `prompts/` — 提示词
- `workflows/` — 工作流
- `templates/` — 模板
- `.versions/` — 版本快照
- `.trash/` — 回收站

**把上面这些目录整体拷走即完整备份**（含版本历史）。注意工具栏的「导出」只打包
`prompts/`、`workflows/`、`templates/`，不含版本快照。软件配置（主题、窗口大小、锁定列表）
存在 userData 的 `config.json`。

## 目录结构

```
prompt-project/
├── electron-main.js       主进程
├── preload.js             contextBridge 桥接（白名单 IPC）
├── lib/
│   └── zip-import.js      ZIP 导入逻辑（可单测）
├── scripts/
│   └── sync-vendor.js     同步第三方库到 src/vendor/
├── src/                   界面
│   ├── index.html
│   ├── styles.css
│   ├── renderer.js
│   ├── i18n.js
│   └── vendor/            marked / DOMPurify / diff-match-patch（自动生成，勿手改）
├── tests/
│   ├── smoke.test.js      npm test
│   └── ui-smoke.js        npm run test:ui
├── prompts/               提示词库（按阶段）
├── workflows/             工作流
├── templates/             模板
├── .versions/             版本快照（自动）
├── .trash/                回收站（自动）
└── package.json
```

## License
MIT
