const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// 版本文件名由本程序生成，只允许 <时间戳>.md 或 restored-<数字>-<时间戳>.md 形态。
const VERSION_FILE_RE = /^(?:restored-\d+-)?\d{8}-\d{6}(?:-\d{3})?\.md$/;

function timestampName(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`;
}

function createVersionStore(options) {
  const {
    versionsDir,
    maxUnpinned,
    appError,
    ensureDir,
    writeFileAtomic,
    now = () => new Date(),
    logError = (...args) => console.error(...args)
  } = options || {};

  function versionDirFor(relPath) {
    const rel = String(relPath == null ? '' : relPath).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) throw appError('E_PATH_EMPTY');
    if (rel.includes('\0')) throw appError('E_PATH_BAD_CHAR');
    const resolved = path.resolve(versionsDir, rel);
    // 跨盘符时 path.relative 返回绝对路径，必须和 .. 一起拦截。
    const relV = path.relative(versionsDir, resolved);
    if (relV.startsWith('..') || path.isAbsolute(relV)) throw appError('E_PATH_ESCAPE', relPath);
    return resolved;
  }

  function versionFilePath(relPath, file) {
    const name = String(file == null ? '' : file);
    if (!VERSION_FILE_RE.test(name)) throw appError('E_BAD_VERSION_FILE', name);
    return path.join(versionDirFor(relPath), name);
  }

  // 区分不存在和损坏：损坏的索引改名留档，避免星标被静默清空后无从恢复。
  async function readIndexJson(idxPath, fallback) {
    let raw;
    try {
      raw = await fsp.readFile(idxPath, 'utf8');
    } catch {
      return { ...fallback };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      throw new Error('not an object');
    } catch (e) {
      const bak = idxPath + '.corrupt-' + timestampName(now());
      try { await fsp.rename(idxPath, bak); } catch {}
      logError('[index] 索引损坏，已改名留档:', bak, e.message);
      return { ...fallback };
    }
  }

  async function readVersionIndex(relPath) {
    return readIndexJson(path.join(versionDirFor(relPath), 'index.json'), { pinned: {} });
  }

  async function writeVersionIndex(relPath, index) {
    const dir = versionDirFor(relPath);
    await ensureDir(dir);
    await writeFileAtomic(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
  }

  async function pruneVersions(relPath) {
    const dir = versionDirFor(relPath);
    let files;
    try {
      files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md'));
    } catch {
      return;
    }
    if (files.length <= maxUnpinned) return;
    const index = await readVersionIndex(relPath);
    const pinned = index.pinned || {};
    // 星标版本不计入上限，也永不自动删除。
    const unpinned = files.filter(f => !pinned[f]).sort();
    const excess = unpinned.length - maxUnpinned;
    if (excess <= 0) return;
    for (const f of unpinned.slice(0, excess)) {
      try { await fsp.unlink(path.join(dir, f)); } catch {}
    }
  }

  // 撞名时向后挪一毫秒，保持文件名格式和时间排序。
  async function saveVersion(relPath, content) {
    const dir = versionDirFor(relPath);
    await ensureDir(dir);
    let d = now();
    let name = timestampName(d) + '.md';
    for (let i = 0; i < 1000 && fs.existsSync(path.join(dir, name)); i++) {
      d = new Date(d.getTime() + 1);
      name = timestampName(d) + '.md';
    }
    await writeFileAtomic(path.join(dir, name), content);
    await pruneVersions(relPath);
  }

  async function listVersions(relPath) {
    const dir = versionDirFor(relPath);
    let files;
    try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md')); } catch { return []; }
    const index = await readVersionIndex(relPath);
    return files.map(f => {
      const timestamp = f.replace(/\.md$/, '');
      return { file: f, timestamp, pinned: !!(index.pinned && index.pinned[f]) };
    }).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async function readVersion(relPath, file) {
    return fsp.readFile(versionFilePath(relPath, file), 'utf8');
  }

  async function pinVersion(relPath, file, pinned) {
    versionFilePath(relPath, file);
    const index = await readVersionIndex(relPath);
    index.pinned = index.pinned || {};
    if (pinned) index.pinned[file] = true; else delete index.pinned[file];
    await writeVersionIndex(relPath, index);
    return true;
  }

  return {
    versionDirFor,
    versionFilePath,
    timestampName,
    readIndexJson,
    saveVersion,
    pruneVersions,
    listVersions,
    readVersion,
    pinVersion
  };
}

module.exports = { createVersionStore, timestampName, VERSION_FILE_RE };
