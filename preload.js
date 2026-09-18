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
  saveFile: (rel, content) => ipcRenderer.invoke('save-file', rel, content),
  createFile: (rel, content) => ipcRenderer.invoke('create-file', rel, content),
  rename: (oldRel, newRel) => ipcRenderer.invoke('rename', oldRel, newRel),
  trash: (rel) => ipcRenderer.invoke('trash', rel),
  listTrash: () => ipcRenderer.invoke('list-trash'),
  restore: (id) => ipcRenderer.invoke('restore', id),
  emptyTrash: () => ipcRenderer.invoke('empty-trash'),
  listVersions: (rel) => ipcRenderer.invoke('list-versions', rel),
  readVersion: (rel, file) => ipcRenderer.invoke('read-version', rel, file),
  pinVersion: (rel, file, pinned) => ipcRenderer.invoke('pin-version', rel, file, pinned),
  rollbackVersion: (rel, file) => ipcRenderer.invoke('rollback-version', rel, file),
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
  }
};

// 注意：这里的名字不能叫 'api'。contextBridge 暴露的是 non-configurable 属性，
// 而 renderer.js 里有 const api = ...；同名会让整个 renderer.js 因
// "Identifier 'api' has already been declared" 而不执行。
contextBridge.exposeInMainWorld('promptFlowApi', api);
