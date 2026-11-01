const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

async function readJsonObject(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// 目标已有版本目录时逐个并入。index.json 不能和快照一样"撞名就改名"：
// 改成 restored-…-index.json 之后它既不是索引也不是快照，源目录里的星标和版本说明
// 就此失效。所以快照照旧挪过去（撞名改名），索引最后单独合并：
//   pinned / notes 按快照的新名字并进目标索引；
//   current 取源目录的——正文是从源路径搬过来的，"当前内容"的说明属于它。
async function mergeVersionDir(source, target, rename, random, appError) {
  const renamed = new Map();
  let hasSourceIndex = false;
  for (const file of await fsp.readdir(source)) {
    if (file === 'index.json') { hasSourceIndex = true; continue; }
    let name = file;
    for (let i = 0; fs.existsSync(path.join(target, name)); i++) {
      if (i >= 1000) throw appError('E_RENAME_HISTORY_MOVE', file);
      name = `restored-${Math.floor(random() * 1e6)}-${i}-${file}`;
    }
    await rename(path.join(source, file), path.join(target, name));
    renamed.set(file, name);
  }
  if (hasSourceIndex) {
    const sourceIndexPath = path.join(source, 'index.json');
    const targetIndexPath = path.join(target, 'index.json');
    const src = await readJsonObject(sourceIndexPath);
    const merged = await readJsonObject(targetIndexPath);
    merged.pinned = { ...(merged.pinned && typeof merged.pinned === 'object' ? merged.pinned : {}) };
    merged.notes = { ...(merged.notes && typeof merged.notes === 'object' ? merged.notes : {}) };
    for (const [file, value] of Object.entries(src.pinned && typeof src.pinned === 'object' ? src.pinned : {})) {
      if (value === true && renamed.has(file)) merged.pinned[renamed.get(file)] = true;
    }
    for (const [file, value] of Object.entries(src.notes && typeof src.notes === 'object' ? src.notes : {})) {
      if (typeof value === 'string' && renamed.has(file)) merged.notes[renamed.get(file)] = value;
    }
    if (!Object.keys(merged.notes).length) delete merged.notes;
    if (src.current) merged.current = src.current; else delete merged.current;
    await fsp.writeFile(targetIndexPath, JSON.stringify(merged, null, 2), 'utf8');
    await fsp.unlink(sourceIndexPath);
  }
  await fsp.rmdir(source);
}

// 正文和版本历史必须一起移动。历史移动失败时把正文移回原处，避免两者分离。
async function movePromptWithHistory(options) {
  const {
    oldRel,
    newRel,
    oldFull,
    newFull,
    oldVersionDir,
    newVersionDir,
    appError,
    onFileMoved = () => {},
    rename = (...args) => fsp.rename(...args),
    random = Math.random,
    logError = (...args) => console.error(...args)
  } = options || {};

  if (fs.existsSync(newFull)) throw appError('E_TARGET_EXISTS', newRel);
  await fsp.mkdir(path.dirname(newFull), { recursive: true });
  await rename(oldFull, newFull);
  onFileMoved(oldFull);
  onFileMoved(newFull);

  if (!fs.existsSync(oldVersionDir)) return;
  try {
    await fsp.mkdir(path.dirname(newVersionDir), { recursive: true });
    if (fs.existsSync(newVersionDir)) await mergeVersionDir(oldVersionDir, newVersionDir, rename, random, appError);
    else await rename(oldVersionDir, newVersionDir);
  } catch (err) {
    try {
      await rename(newFull, oldFull);
      onFileMoved(oldFull);
      onFileMoved(newFull);
    } catch (rollbackErr) {
      logError('改名回滚失败，正文留在新路径:', newRel, rollbackErr.message);
      throw appError('E_RENAME_PARTIAL', newRel);
    }
    logError('改名时版本历史移动失败，已撤回正文移动:', oldRel, '->', newRel, err.message);
    throw appError('E_RENAME_HISTORY_MOVE', oldRel);
  }
}

module.exports = { movePromptWithHistory };
