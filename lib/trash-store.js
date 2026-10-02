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
    empty
  };
}

module.exports = { createTrashStore };
