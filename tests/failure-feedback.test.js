// tests/failure-feedback.test.js
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('[test:failure-feedback] PASS ' + msg);
  else { failures++; console.error('[test:failure-feedback] FAIL ' + msg); }
};

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron-main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const trashStart = main.indexOf("ipcMain.handle('trash'");
const trashBlock = trashStart >= 0 ? main.slice(trashStart, main.indexOf("ipcMain.handle('list-trash'", trashStart)) : '';
ok(!/try \{ st = await fsp\.stat\(full\); \} catch \{ return true; \}/.test(trashBlock), '删除时读取文件状态失败不会被当成成功');
ok(/if \(err && err\.code === 'ENOENT'\) return true;/.test(trashBlock) && /throw appError\('E_TRASH_STAT', rel\)/.test(trashBlock), '删除只把文件已不存在视为成功，其他读取失败返回明确错误');

const pickStart = renderer.indexOf('async function pickProjectType()');
const pickBlock = pickStart >= 0 ? renderer.slice(pickStart, renderer.indexOf('async function newPrompt()', pickStart)) : '';
ok(!/catch \(e\) \{ \/\* 已存在则忽略 \*\/ \}/.test(pickBlock), '新增工程类型失败时不会静默吞掉');
ok(/E_TYPE_EXISTS/.test(pickBlock) && /toast\(tErr\('addTypeFailed', e\), 'error'\)/.test(pickBlock) && /return null;/.test(pickBlock), '新增工程类型只忽略重复类型，其他失败会提示并取消新建');

if (failures) process.exit(1);
console.log('[test:failure-feedback] 通过');
