const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { createWriteGate } = require('../lib/write-gate');
const filename = path.join(__dirname, '../lib/write-queue.js');
const actual = fs.existsSync(filename) ? require(filename) : {};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const bounded = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('bounded queue timeout')), 250); })]); } finally { clearTimeout(timer); } };

async function overlapping(factory) {
  const gate = createWriteGate(); const queue = factory(gate);
  const started = deferred(); const release = deferred(); let count = 0;
  const a = queue.run(['workspace', 'workspace'], async () => { const before = count; started.resolve(); await release.promise; count = before + 1; });
  await started.promise;
  const b = queue.run(['workspace'], async () => { const before = count; count = before + 1; });
  await new Promise(resolve => setImmediate(resolve)); release.resolve();
  await bounded(Promise.all([a, b]));
  assert.equal(count, 2, 'overlapping updates preserve both changes');
}
async function exclusive(factory) {
  const gate = createWriteGate(); const queue = factory(gate);
  const started = deferred(); const release = deferred(); const events = [];
  const a = queue.run(['ver:a'], async () => { started.resolve(); await release.promise; events.push('A'); });
  await started.promise;
  const importTask = gate.exclusive(async () => { events.push('import'); await queue.runLocked(['workspace'], async () => { events.push('locked'); }); });
  const b = queue.run(['ver:a', 'workspace'], async () => { events.push('B'); });
  release.resolve(); await bounded(Promise.all([a, importTask, b]));
  assert.deepEqual(events, ['A', 'import', 'locked', 'B'], 'exclusive and overlapping reservations settle');
}
async function disjoint(factory) {
  const queue = factory(createWriteGate()); const started = deferred(); const release = deferred();
  const a = queue.run(['a'], async () => { started.resolve(); await release.promise; });
  await started.promise;
  try { assert.equal(await bounded(queue.run(['b'], () => 'independent')), 'independent', 'disjoint update proceeds while A waits'); }
  finally { release.resolve(); await a; }
}
async function reservation(factory) {
  const queue = factory(createWriteGate()); const started = deferred(); const release = deferred(); const events = [];
  const a = queue.run(['a'], async () => { started.resolve(); await release.promise; });
  await started.promise;
  const multi = queue.run(['a', 'b'], () => events.push('multi'));
  const b = queue.run(['b'], () => events.push('b'));
  await new Promise(resolve => setImmediate(resolve)); release.resolve();
  await bounded(Promise.all([a, multi, b]));
  assert.deepEqual(events, ['multi', 'b'], 'all keys are reserved before awaiting predecessors');
}

for (const [name, exercise, find, replacement] of [
  ['overlapping keys serialize without lost updates', overlapping, 'const predecessors = unique.map(key => tails.get(key)).filter(Boolean);', 'const predecessors = [];'],
  ['exclusive Locked operation bypasses ordinary reservations', exclusive, 'return Promise.resolve().then(fn);', 'return run(keys, fn);'],
  ['disjoint keys proceed independently', disjoint, 'const unique = [...new Set(keys)];', "const unique = ['all'];"],
  ['multi-key reservation is synchronous', reservation, 'for (const key of unique) tails.set(key, reserved);', 'await Promise.all(predecessors); for (const key of unique) tails.set(key, reserved);']
]) {
  test(name, async () => {
    assert.equal(typeof actual.createWriteQueue, 'function', 'createWriteQueue exists');
    await exercise(actual.createWriteQueue);
    const source = fs.readFileSync(filename, 'utf8'); assert.ok(source.includes(find));
    const control = new Module(filename, module); control.filename = filename; control.paths = Module._nodeModulePaths(path.dirname(filename));
    control._compile(source.replace(find, replacement), filename);
    await assert.rejects(exercise(control.exports.createWriteQueue), /AssertionError|bounded queue timeout/, 'targeted reverse control: ' + name);
  });
}
test('a rejected task releases every reserved key', async () => {
  assert.equal(typeof actual.createWriteQueue, 'function');
  const exercise = async factory => {
    const queue = factory(createWriteGate()); const started = deferred(); const release = deferred();
    const first = queue.run(['a', 'b'], async () => { started.resolve(); await release.promise; throw new Error('write fault'); });
    await started.promise;
    const next = queue.run(['a', 'b'], () => 'next');
    release.resolve(); await assert.rejects(first, /write fault/);
    assert.equal(await bounded(next), 'next');
  };
  await exercise(actual.createWriteQueue);
  const source = fs.readFileSync(filename, 'utf8').replace('release();', 'void release;');
  const control = new Module(filename, module); control._compile(source, filename);
  await assert.rejects(exercise(control.exports.createWriteQueue), /bounded queue timeout/);
});
