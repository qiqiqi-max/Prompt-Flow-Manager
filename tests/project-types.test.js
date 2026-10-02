// tests/project-types.test.js
const projectTypes = require('../lib/project-types');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:project-types] PASS ' + msg);
  else { failures++; console.error('[test:project-types] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};
const code = (fn) => { try { fn(); return null; } catch (e) { return String(e.message).split('|')[0]; } };

const appError = (c, d) => new Error(d ? c + '|' + d : c);
const defaults = ['前端项目', '其他'];

ok(JSON.stringify(projectTypes.add({ projectTypes: ['A'] }, '  B  ', defaults, appError)) === '["A","B"]', '新增类型会去掉首尾空白');
ok(JSON.stringify(projectTypes.add({}, 'B', defaults, appError)) === '["前端项目","其他","B"]', '旧配置缺字段时使用默认类型');
ok(code(() => projectTypes.add({ projectTypes: ['A'] }, 'A', defaults, appError)) === 'E_TYPE_EXISTS', '拒绝重复类型');
ok(code(() => projectTypes.add({ projectTypes: ['A'] }, ' ', defaults, appError)) === 'E_TYPE_EMPTY', '拒绝空类型');
ok(code(() => projectTypes.add({ projectTypes: ['A'] }, 1, defaults, appError)) === 'E_TYPE_INVALID', '拒绝非字符串类型');
ok(JSON.stringify(projectTypes.remove({ projectTypes: ['A', 'B'] }, 'A', defaults, appError)) === '["B"]', '可以移除类型');
ok(projectTypes.remove({ projectTypes: ['A', 'B'] }, 'C', defaults, appError) === null, '移除不存在类型时保持原配置');
ok(code(() => projectTypes.remove({ projectTypes: ['A'] }, 'A', defaults, appError)) === 'E_TYPE_MIN_ONE', '至少保留一个类型');

if (failures) process.exit(1);
console.log('[test:project-types] 通过');
