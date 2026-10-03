const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

async function mergeVersionDir(source, target, rename, random, appError) {
  for (const file of await fsp.readdir(source)) {
    let name = file;
    for (let i = 0; fs.existsSync(path.join(target, name)); i++) {
      if (i >= 1000) throw appError('E_RENAME_HISTORY_MOVE', file);
      name = `restored-${Math.floor(random() * 1e6)}-${i}-${file}`;
    }
    await rename(path.join(source, file), path.join(target, name));
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
