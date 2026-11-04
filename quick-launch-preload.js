// quick-launch-preload.js - 快速搜索面板专用的桥接
//
// 为什么不复用 preload.js：那份白名单是给主窗口的，带着 saveFile / trash /
// exportZip / importZip 这一整套写操作。面板只需要"搜、读、复制、隐藏"，
// 它渲染的又是库里的标题和正文片段（外部导入的 .md 也在里面）。按最小权限给，
// 万一哪天面板上出现了注入点，拿到手的也只有这五个只读/自用的方法。
//
// IPC 通道本身是全局的（ipcMain.handle 不分窗口），所以这里不是唯一防线：
// 只对面板有意义的两条（quick-launch-copy / quick-launch-hide）在主进程里还会
// 核对发送方是不是面板（见 electron-main.js 的 isQuickPanelSender）。
//
// 安全配置（contextIsolation / nodeIntegration / sandbox）与主窗口相同，
// 由 tests/quick-launch.test.js 逐项比对两个窗口的 webPreferences。
const { contextBridge, ipcRenderer } = require('electron');
let showToken = null;

const quickLaunchApi = {
  // 复用主窗口那条 search：同一份 searchAll、同一份正文缓存
  search: (q) => ipcRenderer.invoke('search', q),
  // 展开 {{include:}} 要读被引用的文件，同样走主窗口那条（读取白名单在主进程）
  readFile: (rel) => ipcRenderer.invoke('read-file', rel),
  // 复制成功的唯一出口：主进程写剪贴板并隐藏面板。rel 一并传过去，
  // 将来要在"复制成功"处统计用量的话，主进程那一处就够了。
  copy: (text, rel, token = showToken) => ipcRenderer.invoke('quick-launch-copy', text, rel, token),
  hide: () => ipcRenderer.invoke('quick-launch-hide'),
  // 每次呼出前主进程推一次当前语言 / 主题 / 填充记忆
  onShow: (cb) => {
    const handler = (e, info) => {
      showToken = { showGeneration: info.showGeneration, workspaceRevision: info.workspaceRevision };
      cb(info);
    };
    ipcRenderer.on('quick-launch-show', handler);
    return () => ipcRenderer.removeListener('quick-launch-show', handler);
  }
};

// 名字不叫 api / promptFlowApi：前者会和页面脚本的顶层 const 撞名（见 CLAUDE.md
// 踩过的坑第 3 条），后者会让人误以为这是主窗口那一整套白名单。
contextBridge.exposeInMainWorld('quickLaunchApi', quickLaunchApi);
