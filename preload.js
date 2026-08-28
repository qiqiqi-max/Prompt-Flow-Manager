// preload.js - 渲染进程与主进程之间的唯一通道
// contextIsolation: true + nodeIntegration: false 模式：
// 渲染进程拿不到 require / process / fs，只能调用这里白名单里的方法。
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getRoot: () => ipcRenderer.invoke('get-root'),
  listTree: () => ipcRenderer.invoke('list-tree'),
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
  exportZip: () => ipcRenderer.invoke('export-zip'),
  exportSingle: (rel) => ipcRenderer.invoke('export-single', rel),
  getStages: () => ipcRenderer.invoke('get-stages'),
  addProjectType: (t) => ipcRenderer.invoke('add-project-type', t),
  removeProjectType: (t) => ipcRenderer.invoke('remove-project-type', t),
  importSingle: () => ipcRenderer.invoke('import-single'),
  importZip: () => ipcRenderer.invoke('import-zip'),
  onMenuAction: (cb) => {
    const handler = (e, action) => cb(action);
    ipcRenderer.on('menu-action', handler);
    return () => ipcRenderer.removeListener('menu-action', handler);
  }
};

// 注意：这里的名字不能叫 'api'。contextBridge 暴露的是 non-configurable 属性，
// 而 renderer.js 里有 const api = ...；同名会让整个 renderer.js 因
// "Identifier 'api' has already been declared" 而不执行。
contextBridge.exposeInMainWorld('promptFlowApi', api);
