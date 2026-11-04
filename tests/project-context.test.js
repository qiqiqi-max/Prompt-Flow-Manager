const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const filename = path.join(__dirname, '../src/project-context.js');
const actual = fs.existsSync(filename) ? require(filename) : {};
const project = { name: 'A', description: 'desc', stack: 'Node', path: 'D:/A', constraints: 'offline', values: { '[custom]': 'private', '[项目名称]': 'remembered A' } };
const cases = [
  ['project fields isolate global memory', api => api.resolve({ token: '[项目名称]', hint: '项目名称' }, { context: api.snapshot({ ...project, values: {} }), globalValues: { '[项目名称]': 'B' } }), 'A', "if (context !== null) {", "if (false) {"],
  ['explicit run value wins', api => api.resolve({ token: '[项目名称]', hint: '项目名称' }, { context: api.snapshot(project), values: { '[项目名称]': 'run A' } }), 'run A', 'if (own(values, token))', 'if (false)'],
  ['cleared value remains cleared', api => api.resolve({ token: '[项目名称]', hint: '项目名称', default: 'default' }, { context: api.snapshot(project), values: { '[项目名称]': '' } }), '', 'if (own(values, token))', 'if (false)'],
  ['project memory precedes fields', api => api.resolve({ token: '[项目名称]', hint: '项目名称' }, { context: api.snapshot(project) }), 'remembered A', 'if (own(context.values, token))', 'if (false)'],
  ['null context reads live globals', api => api.resolve({ token: '[custom]', hint: 'custom' }, { context: null, globalValues: { '[custom]': 'B' } }), 'B', 'else if (own(globalValues, token))', 'else if (false)'],
  ['unbound snapshot freezes global memory', api => { const global = { '[custom]': 'old' }; const context = api.snapshot(null, global); global['[custom]'] = 'new'; return api.resolve({ token: '[custom]', hint: 'custom' }, { context, globalValues: global }); }, 'old', 'values: cleanValues(project ? project.values : globalValues)', 'values: {}'],
  ['selected project suppresses unknown global values', api => api.resolve({ token: '[unknown]', hint: 'unknown', default: 'template' }, { context: api.snapshot(project), globalValues: { '[unknown]': 'B' } }), 'template', 'if (context !== null) {', 'if (false) {'],
  ['template default works', api => api.resolve({ token: '[language=Go]', hint: 'language', default: 'Go' }, { context: null }), 'Go', "return typeof descriptor.default === 'string' ? descriptor.default : '';", "return '';"],
  ['English and Chinese aliases match descriptors exactly', api => ['项目名称', 'Project name', '项目描述', 'Project description', '技术栈', 'Tech stack', '项目路径', 'Project path', '项目约束', 'Project constraints'].map(hint => api.resolve({ token: '[' + hint + '=fallback]', hint }, { context: api.snapshot({ ...project, values: {} }) })), ['A', 'A', 'desc', 'desc', 'Node', 'Node', 'D:/A', 'D:/A', 'offline', 'offline'], 'const field = aliases[descriptor.hint];', 'const field = null;'],
  ['aliases never match substrings or inherited properties', api => ['My Project name', 'project name', 'constructor'].map(hint => api.resolve({ token: '[' + hint + ']', hint }, { context: api.snapshot(project) })), ['', '', ''], 'const field = aliases[descriptor.hint];', "const field = descriptor.hint.includes('Project name') ? 'name' : aliases[descriptor.hint];"],
  ['inherited explicit values are ignored', api => api.resolve({ token: '[custom]', hint: 'custom', default: 'default' }, { context: null, values: Object.create({ '[custom]': 'inherited' }) }), 'default', 'Object.prototype.hasOwnProperty.call(raw, key)', 'key in raw'],
  ['dangerous keys never enter clean memory', api => Object.keys(api.cleanValues(JSON.parse('{"__proto__":"x","constructor":"x","prototype":"x","[safe]":"ok"}'))), ['[safe]'], 'if (dangerous.has(key)) continue;', 'if (false) continue;'],
  ['oversize memory values are dropped whole', api => api.cleanValues({ '[large]': 'x'.repeat(20001), '[safe]': 'ok' }), { '[safe]': 'ok' }, 'value.length > 20000', 'value.length > 30000'],
  ['memory keeps first 200 safe values', api => Object.keys(api.cleanValues(Object.fromEntries(Array.from({ length: 201 }, (_, i) => ['[' + i + ']', 'v'])))).length, 200, 'count >= 200', 'count >= 201'],
  ['snapshot is independent of later project edits', api => { const source = { ...project, values: { '[custom]': 'old' } }; const snapshot = api.snapshot(source); source.name = 'changed'; source.values['[custom]'] = 'changed'; return [snapshot.name, snapshot.values['[custom]']]; }, ['A', 'old'], 'values: cleanValues(project ? project.values : globalValues)', 'values: project ? project.values : globalValues'],
  ['fieldValues exposes bilingual exact tokens', api => api.fieldValues(project), { '[项目名称]': 'A', '[Project name]': 'A', '[项目描述]': 'desc', '[Project description]': 'desc', '[技术栈]': 'Node', '[Tech stack]': 'Node', '[项目路径]': 'D:/A', '[Project path]': 'D:/A', '[项目约束]': 'offline', '[Project constraints]': 'offline' }, "out['[' + label + ']']", 'out[label]']
];

for (const [name, exercise, expected, find, replace] of cases) {
  test(name, () => {
    assert.equal(typeof actual.resolve, 'function', 'PROJECT_CONTEXT.resolve exists');
    assert.deepEqual(exercise(actual), expected);
    const source = fs.readFileSync(filename, 'utf8');
    assert.ok(source.includes(find), 'reverse mutation anchor exists: ' + name);
    const control = new Module(filename, module);
    control.filename = filename;
    control.paths = Module._nodeModulePaths(path.dirname(filename));
    control._compile(source.replace(find, replace), filename);
    assert.throws(() => assert.deepEqual(exercise(control.exports), expected), assert.AssertionError, 'targeted reverse control: ' + name);
  });
}
