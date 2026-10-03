// tests/backup-config.test.js
const BACKUP_CONFIG = require('../lib/backup-config');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:backup-config] PASS ' + msg);
  else { failures++; console.error('[test:backup-config] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};

const exported = BACKUP_CONFIG.exportPortable({
  theme: 'dark',
  lang: 'en',
  windowBounds: { width: 1, height: 2 },
  tabs: ['prompts/a.md'],
  lockedFiles: ['prompts/a.md', 'config.json', '../x.md'],
  projectTypes: ['A', ' B ', 'A', 3],
  fillMemory: { '[x]': 'old', bad: 1 },
  updateCheck: false,
  updateSkipVersion: '9.9.9'
});
ok(JSON.stringify(Object.keys(exported).sort()) === '["fillMemory","lockedFiles","projectTypes"]', '只导出可跨设备迁移的设置', JSON.stringify(exported));
ok(JSON.stringify(exported.lockedFiles) === '["prompts/a.md"]', '导出时过滤非法锁定路径');
ok(JSON.stringify(exported.projectTypes) === '["A","B"]', '导出时清理项目类型');
ok(JSON.stringify(exported.fillMemory) === '{"[x]":"old"}', '导出时只保留文本填充记忆');

const current = {
  theme: 'light',
  windowBounds: { width: 900, height: 700 },
  tabs: ['prompts/current.md'],
  lockedFiles: ['prompts/current.md'],
  projectTypes: ['C', 'A'],
  fillMemory: { '[x]': 'current', '[y]': 'keep' }
};
const merged = BACKUP_CONFIG.mergePortable(current, exported, new Map([['prompts/a.md', 'prompts/a-1.md']]));
ok(merged.theme === 'light' && merged.windowBounds.width === 900 && merged.tabs[0] === 'prompts/current.md', '导入不覆盖当前设备设置');
ok(JSON.stringify(merged.lockedFiles) === '["prompts/current.md","prompts/a-1.md"]', '锁定状态跟随导入后的新路径');
ok(JSON.stringify(merged.projectTypes) === '["C","A","B"]', '项目类型合并去重并保留当前顺序');
ok(merged.fillMemory['[x]'] === 'current' && merged.fillMemory['[y]'] === 'keep', '当前填充记忆优先');

const ignored = BACKUP_CONFIG.mergePortable(current, { lockedFiles: ['prompts/missing.md'], projectTypes: [] }, new Map());
ok(JSON.stringify(ignored.lockedFiles) === '["prompts/current.md"]', '不恢复没有对应导入文件的锁定');

if (failures) process.exit(1);
console.log('[test:backup-config] 通过');
