const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function createTrashStore(options) {
  const {
    trashDir,
    appError,
    ensureDir,
    writeFileAtomic,
    readIndexJson,
    random = Math.random,
    clock = Date.now,
    nowIso = () => new Date().toISOString(),
    rm = (...args) => fsp.rm(...args),
    logError = (...args) => console.error(...args)
  } = options || {};
  const trashDirNorm = path.normalize(trashDir);
  const indexPath = path.join(trashDirNorm, 'index.json');

  // 存放名来自 index.json，必须是 .trash 下的单层名字，避免清空时递归删除库外目录。
  function storePath(storeName) {
    const name = String(storeName == null ? '' : storeName);
    if (!name) throw appError('E_TRASH_BAD_STORE', String(storeName));
    if (name.includes('\0')) throw appError('E_TRASH_BAD_STORE', name);
    if (/[\\/]/.test(name) || name === '.' || name === '..') throw appError('E_TRASH_BAD_STORE', name);
    const resolved = path.resolve(trashDirNorm, name);
    const rel = path.relative(trashDirNorm, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw appError('E_TRASH_BAD_STORE', name);
    return resolved;
  }

  function suffix() {
    return Math.floor(random() * 1e6);
  }

  function uniqueStoreName(id, ext = '') {
    let name = id + ext;
    for (let i = 0; i < 1000; i++) {
      if (!fs.existsSync(path.join(trashDirNorm, name))) return name;
      name = i < 100 ? `${id}-${suffix()}${ext}` : `${id}-${suffix()}-${i}${ext}`;
    }
    throw appError('E_TRASH_NAME_EXHAUSTED', id);
  }

  function uniqueVersionStoreName(id) {
    let name = `${id}-versions`;
    for (let i = 0; i < 1000; i++) {
      if (!fs.existsSync(path.join(trashDirNorm, name))) return name;
      name = i < 100 ? `${id}-${suffix()}-versions` : `${id}-${suffix()}-${i}-versions`;
    }
    throw appError('E_TRASH_NAME_EXHAUSTED', id);
  }

  async function readIndex() {
    const index = await readIndexJson(indexPath, { items: [] });
    if (!Array.isArray(index.items)) index.items = [];
    return index;
  }

  async function writeIndex(index) {
    await ensureDir(trashDirNorm);
    await writeFileAtomic(indexPath, JSON.stringify(index, null, 2));
  }

  // 调用方必须先完成路径白名单和锁定检查。索引写失败时会尽量恢复原状。
  async function moveToTrash({ rel, fullPath, versionDir, onFileMoved = () => {} }) {
    await ensureDir(trashDirNorm);
    const id = `${clock()}-${suffix()}`;
    const storeName = uniqueStoreName(id, path.extname(rel));
    const storeFull = storePath(storeName);
    await fsp.rename(fullPath, storeFull);
    onFileMoved(fullPath);

    const index = await readIndex();
    let versionStore = null;
    if (versionDir && fs.existsSync(versionDir)) {
      versionStore = uniqueVersionStoreName(id);
      await fsp.rename(versionDir, storePath(versionStore));
    }
    index.items.unshift({
      id,
      originalRel: rel,
      name: path.basename(rel),
      trashedAt: nowIso(),
      store: storeName,
      versionStore
    });

    try {
      await writeIndex(index);
      return { id, store: storeName, versionStore };
    } catch (err) {
      let back = true;
      try {
        await fsp.rename(storeFull, fullPath);
        onFileMoved(fullPath);
      } catch (e2) {
        back = false;
        logError('删除回滚失败，正文留在回收站但索引没有条目:', storeFull, e2.message);
      }
      if (versionStore) {
        try { await fsp.rename(storePath(versionStore), versionDir); } catch (e2) {
          logError('删除回滚：版本目录没能搬回:', versionStore, e2.message);
        }
      }
      throw appError(back ? 'E_TRASH_INDEX_WRITE' : 'E_TRASH_ORPHANED', rel);
    }
  }

  function restoredRel(originalRel, n) {
    const ext = path.extname(originalRel);
    const base = ext ? originalRel.slice(0, -ext.length) : originalRel;
    return `${base}-restored${n}${ext}`;
  }

  async function restoreVersionDir(item, finalRel, versionDirFor) {
    if (!item.versionStore) return;
    try {
      const source = storePath(item.versionStore);
      if (!fs.existsSync(source)) return;
      const target = versionDirFor(finalRel);
      if (!fs.existsSync(target)) {
        await ensureDir(path.dirname(target));
        await fsp.rename(source, target);
        return;
      }
      for (const file of await fsp.readdir(source)) {
        let name = file;
        for (let i = 0; fs.existsSync(path.join(target, name)); i++) {
          if (i >= 1000) throw appError('E_TRASH_NAME_EXHAUSTED', file);
          name = `restored-${suffix()}-${i}-${file}`;
        }
        await fsp.rename(path.join(source, file), path.join(target, name));
      }
      try { await fsp.rmdir(source); } catch {}
    } catch (e) {
      logError('还原版本目录失败:', e);
    }
  }

  // resolveWritable 由主进程传入，确保恢复入口和删除入口使用同一份写入白名单。
  async function restoreFromTrash(id, { resolveWritable, versionDirFor, onFileMoved = () => {} }) {
    const index = await readIndex();
    const item = index.items.find(i => i.id === id);
    if (!item) throw appError('E_TRASH_ITEM_MISSING');
    const source = storePath(item.store);
    if (!fs.existsSync(source)) {
      index.items = index.items.filter(i => i.id !== id);
      await writeIndex(index);
      throw appError('E_TRASH_STORE_MISSING', item.originalRel);
    }

    let finalRel = item.originalRel;
    let target = resolveWritable(finalRel);
    await ensureDir(path.dirname(target));
    for (let n = 1; fs.existsSync(target); n++) {
      if (n > 10000) throw appError('E_TRASH_NAME_EXHAUSTED', item.originalRel);
      finalRel = restoredRel(item.originalRel, n);
      target = resolveWritable(finalRel);
    }
    await fsp.rename(source, target);
    onFileMoved(target);
    await restoreVersionDir(item, finalRel, versionDirFor);
    index.items = index.items.filter(i => i.id !== id);
    await writeIndex(index);
    return { rel: finalRel };
  }

  // 删除失败的条目继续保留在索引里，让用户还能看到并重试。
  async function empty() {
    const index = await readIndex();
    const kept = [];
    const failedNames = [];
    for (const item of index.items) {
      let full;
      try { full = storePath(item.store); } catch (e) {
        logError('清空回收站跳过损坏条目:', item.store, e.message);
        continue;
      }
      let ok = true;
      try { await rm(full, { recursive: true, force: true }); } catch (e) {
        ok = false;
        logError('清空回收站条目失败:', item.store, e.message);
      }
      if (item.versionStore) {
        let versionFull = null;
        try { versionFull = storePath(item.versionStore); } catch (e) {
          logError('清空回收站跳过损坏的版本目录名:', item.versionStore, e.message);
        }
        if (versionFull) {
          try { await rm(versionFull, { recursive: true, force: true }); } catch (e) {
            ok = false;
            logError('清空回收站版本目录失败:', item.versionStore, e.message);
          }
        }
      }
      if (!ok) {
        kept.push(item);
        failedNames.push(item.name || item.originalRel || item.id);
      }
    }
    await writeIndex({ items: kept });
    return { kept, failedNames };
  }

  return {
    trashDir: trashDirNorm,
    storePath,
    uniqueStoreName,
    uniqueVersionStoreName,
    readIndex,
    writeIndex,
    moveToTrash,
    restoreFromTrash,
    empty
  };
}

module.exports = { createTrashStore };
