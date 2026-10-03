const fsp = require('fs/promises');
const path = require('path');

let seq = 0;

function safeExportName(title) {
  const raw = String(title == null ? '' : title).trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '');
  const name = raw || 'untitled';
  return name.toLowerCase().endsWith('.md') ? name : name + '.md';
}

// 用户选择的位置可能已有文件。先写临时文件再替换，失败时原文件保持不变。
async function writeExportFile(target, content, options = {}) {
  const appError = options.appError;
  const rename = options.rename || ((...args) => fsp.rename(...args));
  let st = null;
  try { st = await fsp.stat(target); } catch (e) { if (!e || e.code !== 'ENOENT') throw appError('E_EXPORT_WRITE', e.message); }
  if (st && st.isDirectory()) throw appError('E_EXPORT_TARGET_DIR', target);
  const tmp = path.join(path.dirname(target), `.pfm-export-${process.pid}-${seq++}-${path.basename(target)}.part`);
  try {
    await fsp.writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, target);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch {}
    throw appError('E_EXPORT_WRITE', e.message);
  }
}

module.exports = { safeExportName, writeExportFile };
