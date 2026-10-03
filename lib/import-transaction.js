const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// 记录一次导入新建或修改过的文件。回滚时先删除新建文件，再恢复导入前的快照。
function createImportTransaction() {
  const snapshots = new Map();
  const files = new Set();
  const dirs = [];

  async function snapshot(file) {
    const full = path.resolve(file);
    if (snapshots.has(full)) return;
    try { snapshots.set(full, await fsp.readFile(full)); }
    catch (e) {
      if (e && e.code === 'ENOENT') snapshots.set(full, null);
      else throw e;
    }
  }

  async function trackDir(dir) {
    const full = path.resolve(dir);
    if (!fs.existsSync(full)) dirs.push(full);
  }

  function trackFile(file) {
    files.add(path.resolve(file));
  }

  async function rollback() {
    const errors = [];
    for (const file of [...files].reverse()) {
      if (snapshots.has(file)) continue;
      try { await fsp.rm(file, { force: true }); } catch (e) { errors.push(file + ': ' + e.message); }
    }
    for (const [file, data] of [...snapshots].reverse()) {
      try {
        if (data == null) await fsp.rm(file, { force: true });
        else {
          await fsp.mkdir(path.dirname(file), { recursive: true });
          await fsp.writeFile(file, data);
        }
      } catch (e) {
        errors.push(file + ': ' + e.message);
      }
    }
    for (const dir of dirs.sort((a, b) => b.length - a.length)) {
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch (e) { errors.push(dir + ': ' + e.message); }
    }
    return { ok: errors.length === 0, errors };
  }

  return { snapshot, trackDir, trackFile, rollback };
}

module.exports = { createImportTransaction };
