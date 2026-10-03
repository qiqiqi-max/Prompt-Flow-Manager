const { backupRelForEntry, backupVersionForEntry, backupTrashForEntry, PORTABLE_CONFIG_ENTRY } = require('./zip-import');

function summarizeBackupEntries(entries, exists) {
  const list = Array.isArray(entries) ? entries : [];
  const contentEntries = list.filter(entry => entry.path !== PORTABLE_CONFIG_ENTRY
    && !backupVersionForEntry(entry.path) && !backupTrashForEntry(entry.path));
  const isBackup = contentEntries.length > 0 && contentEntries.every(entry => backupRelForEntry(entry.path));
  const conflictsAll = isBackup
    ? contentEntries.map(entry => backupRelForEntry(entry.path)).filter(rel => exists(rel))
    : [];
  return {
    mode: isBackup ? 'backup' : 'markdown',
    files: contentEntries.length,
    versions: isBackup ? list.filter(entry => {
      const info = backupVersionForEntry(entry.path);
      return info && info.file !== 'index.json';
    }).length : 0,
    settings: isBackup && list.some(entry => entry.path === PORTABLE_CONFIG_ENTRY),
    trash: isBackup ? list.filter(entry => {
      const info = backupTrashForEntry(entry.path);
      return info && info.kind === 'store';
    }).length : 0,
    conflictCount: conflictsAll.length,
    conflicts: conflictsAll.slice(0, 10)
  };
}

module.exports = { summarizeBackupEntries };
