// preload.js - 渲染进程与主进程之间的唯一通道
// contextIsolation: true + nodeIntegration: false 模式：
// 渲染进程拿不到 require / process / fs，只能调用这里白名单里的方法。
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getRoot: () => ipcRenderer.invoke('get-root'),
  listTree: () => ipcRenderer.invoke('list-tree'),
  // 树 + 元数据一次拿回，省掉一次整库遍历与一次 IPC 往返（见主进程 listTreeAndMeta）
  listTreeAndMeta: () => ipcRenderer.invoke('list-tree-and-meta'),
  readFile: (rel) => ipcRenderer.invoke('read-file', rel),
  saveFile: (rel, content, options) => ipcRenderer.invoke('save-file', rel, content, options),
  createFile: (rel, content) => ipcRenderer.invoke('create-file', rel, content),
  readDraft: (rel) => ipcRenderer.invoke('read-draft', rel),
  saveDraft: (rel, content, baseContent) => ipcRenderer.invoke('save-draft', rel, content, baseContent),
  clearDraft: (rel) => ipcRenderer.invoke('clear-draft', rel),
  rename: (oldRel, newRel) => ipcRenderer.invoke('rename', oldRel, newRel),
  // 工作流引用同步：改名/移动提示词后，把 workflows 里指向旧路径的引用批量迁走
  findWorkflowRefs: (rel) => ipcRenderer.invoke('find-workflow-refs', rel),
  updateWorkflowRefs: (targets, oldRel, newRel) => ipcRenderer.invoke('update-workflow-refs', targets, oldRel, newRel),
  // 反方向：这个提示词被哪些工作流引用；顺带带上全库悬空引用体检
  workflowReferences: (rel) => ipcRenderer.invoke('workflow-references', rel),
  // 使用统计与收藏（存在 usage.json，见 lib/usage-store.js）。三个都返回同一个形状：
  // { favorites: [rel], frequent: [{ rel, count, lastUsedAt, score }] }（frequent 已按常用排好序），
  // recordUsage 额外带 recorded（文件不存在时为 false，不记账）。
  recordUsage: (rel) => ipcRenderer.invoke('record-usage', rel),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  setFavorite: (rel, on) => ipcRenderer.invoke('set-favorite', rel, on),
  trash: (rel) => ipcRenderer.invoke('trash', rel),
  // 文件树多选的批量操作。主进程逐项结算，返回 { ok, failed, skipped }，
  // 部分失败不抛错；整批被拒（参数无效 / 另一批还在跑）才抛。
  batchMove: (rels, dirRel) => ipcRenderer.invoke('batch-move', rels, dirRel),
  batchTags: (rels, payload) => ipcRenderer.invoke('batch-tags', rels, payload),
  batchTrash: (rels) => ipcRenderer.invoke('batch-trash', rels),
  listTrash: () => ipcRenderer.invoke('list-trash'),
  restore: (id) => ipcRenderer.invoke('restore', id),
  emptyTrash: () => ipcRenderer.invoke('empty-trash'),
  listVersions: (rel) => ipcRenderer.invoke('list-versions', rel),
  readVersion: (rel, file) => ipcRenderer.invoke('read-version', rel, file),
  pinVersion: (rel, file, pinned) => ipcRenderer.invoke('pin-version', rel, file, pinned),
  rollbackVersion: (rel, file) => ipcRenderer.invoke('rollback-version', rel, file),
  // 版本说明：读"当前内容"那一行的说明；改某个版本（file 为 null 时是当前内容）的说明
  getCurrentNote: (rel) => ipcRenderer.invoke('get-current-note', rel),
  setVersionNote: (rel, file, note) => ipcRenderer.invoke('set-version-note', rel, file, note),
  getMetaList: () => ipcRenderer.invoke('get-meta-list'),
  search: (q) => ipcRenderer.invoke('search', q),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (cfg) => ipcRenderer.invoke('set-config', cfg),
  confirm: (msg) => ipcRenderer.invoke('confirm', msg),
  // 保存 / 不保存 / 取消三选一。切文件、切标签时草稿还在就问这个，
  // 而不是像原先那样直接替用户保存。
  confirmUnsaved: (opts) => ipcRenderer.invoke('confirm-unsaved', opts),
  exportZip: () => ipcRenderer.invoke('export-zip'),
  exportSingle: (rel) => ipcRenderer.invoke('export-single', rel),
  // 一键将装配好的 AI 规则（CLAUDE.md / AGENTS.md / Copilot / Cursor 规则文件）导出到用户指定的项目根目录。
  // 只传构建好的内容，写哪些相对路径由主进程的 RULE_EXPORT_ALLOWED 决定
  exportProjectRules: (payload) => ipcRenderer.invoke('export-project-rules', payload),
  getStages: () => ipcRenderer.invoke('get-stages'),
  addProjectType: (t) => ipcRenderer.invoke('add-project-type', t),
  removeProjectType: (t) => ipcRenderer.invoke('remove-project-type', t),
  importSingle: () => ipcRenderer.invoke('import-single'),
  importZip: () => ipcRenderer.invoke('import-zip'),
  // 菜单的"重新加载"先问渲染进程有没有未保存改动，确认后再由主进程真的重载。
  reloadWindow: () => ipcRenderer.invoke('reload-window'),
  // 启动自愈的报告（摘掉了哪些幽灵条目、收养了哪些孤立正文、删了哪些残留临时文件）。
  // 只读，不触发任何写操作。
  getHealReport: () => ipcRenderer.invoke('get-heal-report'),
  // 诊断信息：环境事实 + 数量统计 + 日志尾部。只读，不含提示词正文和文件名。
  getDiagnostics: () => ipcRenderer.invoke('get-diagnostics'),
  // 把上面那份诊断信息存成 JSON 文件。会弹保存框，由用户自己决定放哪、给谁看——
  // 里面带真实的数据目录路径（路径指错是本项目最严重那次故障的根因），
  // 所以绝不自动上传。
  exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
  // 升级检查的结论。只读，主进程在启动时查一次就存着（见 runUpdateCheck）。
  // 这里**不提供**"立刻去查一次"的方法：查更新是出网行为，触发权留在主进程，
  // 不让渲染进程（可能正在渲染导入的第三方 .md）有办法反复驱动出网。
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  // 打开发布页。故意不收 url 参数：地址只能是主进程里的本地常量。
  // 收了参数就等于把 shell.openExternal 的目标交给渲染进程。
  openReleasePage: () => ipcRenderer.invoke('open-release-page'),
  // 忽略某个版本（只对这一个版本生效，下一版照常提示）
  skipUpdateVersion: (version) => ipcRenderer.invoke('skip-update-version', version),
  // 全局快捷键（快速搜索面板）。状态以主进程此刻真正注册着的为准，不是配置里的值；
  // 设置走单独的通道而不是 setConfig：要先注册成功才落盘（见 lib/quick-launch.js）。
  getQuickLaunchStatus: () => ipcRenderer.invoke('get-quick-launch-status'),
  setQuickLaunch: (patch) => ipcRenderer.invoke('set-quick-launch', patch),
  onMenuAction: (cb) => {
    const handler = (e, action) => cb(action);
    ipcRenderer.on('menu-action', handler);
    return () => ipcRenderer.removeListener('menu-action', handler);
  },
  // 主进程发现新版本后推过来。返回取消订阅函数，和 onMenuAction 同一个形状。
  onUpdateAvailable: (cb) => {
    const handler = (e, info) => cb(info);
    ipcRenderer.on('update-available', handler);
    return () => ipcRenderer.removeListener('update-available', handler);
  },
  // 内容目录在应用之外被改了（CLI / MCP / git pull / 外部编辑器）。
  // 只推 { changes: [{ rel, type }], truncated }，不带正文：渲染进程要哪个自己 readFile。
  onLibraryChanged: (cb) => {
    const handler = (e, info) => cb(info);
    ipcRenderer.on('library-changed', handler);
    return () => ipcRenderer.removeListener('library-changed', handler);
  },
  // 快速面板复制后主窗口刷新统计；不把底层 IPC event 暴露给页面。
  onUsageChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('usage-changed', handler);
    return () => ipcRenderer.removeListener('usage-changed', handler);
  }
};

// 注意：这里的名字不能叫 'api'。contextBridge 暴露的是 non-configurable 属性，
// 而 renderer.js 里有 const api = ...；同名会让整个 renderer.js 因
// "Identifier 'api' has already been declared" 而不执行。
contextBridge.exposeInMainWorld('promptFlowApi', api);
