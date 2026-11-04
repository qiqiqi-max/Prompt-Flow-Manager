'use strict';
// Load the real main process with in-memory mutations. No production hooks or source-file edits.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
if (process.env.PFM_SELFTEST !== '1' || !process.env.PFM_DATA_DIR) throw new Error('Backup selftest requires temporary PFM_DATA_DIR');
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const original = Module._extensions['.js'];
Module._extensions['.js'] = (mod, filename) => {
  const changes = (spec.mutations || []).filter(change => path.resolve(spec.root, change.file) === filename);
  if (!changes.length) return original(mod, filename);
  let source = fs.readFileSync(filename, 'utf8').replaceAll('\r\n', '\n');
  for (const change of changes) {
    if (!source.includes(change.from)) throw new Error('Missing mutation target: ' + change.file + ': ' + change.from);
    source = source.replace(change.from, change.to);
  }
  mod._compile(source, filename);
};
if (spec.observePreflight) {
  const fsp = require('node:fs/promises'); const open = fsp.open;
  fsp.open = async (file, flags, ...args) => {
    if (flags === 'wx' && String(file).replaceAll('\\', '/').endsWith('/preflight.md')) fs.writeFileSync(path.join(process.env.PFM_DATA_DIR, '__preflight-write'), 'content creation happened');
    return open(file, flags, ...args);
  };
}
const selftest = require(path.join(spec.root, 'lib/selftest'));
const installDialogs = selftest.installSelfTestDialogStubs;
selftest.installSelfTestDialogStubs = (...args) => {
  installDialogs(...args);
  const { dialog } = require('electron'); const show = dialog.showMessageBox;
  dialog.showMessageBox = async (...values) => {
    fs.writeFileSync(path.join(process.env.PFM_DATA_DIR, '__backup-preview.json'), JSON.stringify(values.at(-1)));
    if (spec.hook === 'dialog-import') await pause('preview-dialog');
    return show(...values);
  };
  for (const [name, phase, enabled] of [['showSaveDialog', 'export-dialog', spec.hook === 'dialog-export'], ['showOpenDialog', 'open-dialog', spec.hook === 'dialog-import']]) {
    if (!enabled) continue;
    const originalDialog = dialog[name]; dialog[name] = async (...values) => { await pause(phase); return originalDialog(...values); };
  }
};
if (spec.hook === 'business' || spec.hook === 'trash') {
  const transactions = require(path.join(spec.root, 'lib/import-transaction')); const create = transactions.createImportTransaction;
  transactions.createImportTransaction = (...args) => {
    const transaction = create(...args); const snapshot = transaction.snapshot; const rollback = transaction.rollback; const before = new Map();
    const read = file => { try { return fs.readFileSync(file).toString('base64'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
    transaction.snapshot = async file => { if (!before.has(file)) before.set(file, read(file)); return snapshot(file); };
    transaction.rollback = async () => {
      const result = await rollback();
      fs.writeFileSync(path.join(process.env.PFM_DATA_DIR, '__backup-rollback.json'), JSON.stringify([...before].map(([file, bytes]) => ({ file: path.relative(process.env.PFM_DATA_DIR, file).replaceAll('\\', '/'), equal: read(file) === bytes }))));
      return result;
    };
    return transaction;
  };
}
async function pause(phase) {
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.getAllWindows()[0];
  console.log('[workspace-backup-hook] phase=' + phase);
  await win.webContents.executeJavaScript('window.__backupQueued = false; window.__backupPhase = ' + JSON.stringify(phase));
  const started = Date.now();
  while (!await win.webContents.executeJavaScript('window.__backupQueued === true')) {
    if (Date.now() - started > 5000) throw new Error('backup queue handshake timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
if (spec.hook === 'business' || spec.hook === 'export') {
  const services = require(path.join(spec.root, 'lib/workspace-service'));
  const create = services.createWorkspaceService;
  services.createWorkspaceService = options => {
    const service = create(options);
    const name = spec.hook === 'business' ? 'importDataLocked' : 'exportDataLocked';
    const originalMethod = service[name]; let fired = false;
    service[name] = async (...args) => {
      const value = await originalMethod(...args);
      if (!fired) { fired = true; await pause(spec.hook); if (spec.hook === 'business') throw new Error('injected after business writes'); }
      return value;
    };
    return service;
  };
}
if (spec.hook === 'trash') {
  const stores = require(path.join(spec.root, 'lib/trash-store')); const create = stores.createTrashStore;
  stores.createTrashStore = options => {
    const store = create(options); const importItems = store.importItems;
    store.importItems = async (...args) => { const result = await importItems(...args); await pause('trash'); throw new Error('injected after trash writes: ' + result.imported); };
    return store;
  };
}
require(path.join(spec.root, 'electron-main.js'));
