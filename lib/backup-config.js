const { backupRelForEntry } = require('./zip-import');

function cleanTypes(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string') continue;
    const type = item.trim();
    if (type && !out.includes(type)) out.push(type);
  }
  return out;
}

function cleanLocks(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(backupRelForEntry).filter(Boolean))];
}

function cleanFillMemory(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, val] of Object.entries(value)) {
    if (typeof key === 'string' && typeof val === 'string') out[key] = val;
  }
  return out;
}

// 只导出跟内容一起迁移才有意义的设置；主题、窗口、标签页和升级状态属于当前设备。
function exportPortable(config) {
  const cfg = config || {};
  return {
    lockedFiles: cleanLocks(cfg.lockedFiles),
    projectTypes: cleanTypes(cfg.projectTypes),
    fillMemory: cleanFillMemory(cfg.fillMemory)
  };
}

// 合并时当前设备优先；锁定只恢复到本次实际导入的新路径上。
function mergePortable(current, imported, relMap) {
  const cur = current || {};
  const src = exportPortable(imported || {});
  const map = relMap instanceof Map ? relMap : new Map();
  const locks = cleanLocks(cur.lockedFiles);
  for (const rel of src.lockedFiles) {
    const mapped = map.get(rel);
    if (mapped && !locks.includes(mapped)) locks.push(mapped);
  }
  return {
    ...cur,
    lockedFiles: locks,
    projectTypes: cleanTypes([...cleanTypes(cur.projectTypes), ...src.projectTypes]),
    fillMemory: { ...src.fillMemory, ...cleanFillMemory(cur.fillMemory) }
  };
}

module.exports = { exportPortable, mergePortable };
