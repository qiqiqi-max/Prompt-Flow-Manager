'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const espree = require('espree');
const vm = require('node:vm');
const { createWorkspaceService } = require('../lib/workspace-service');
const { createProjectStore } = require('../lib/project-store');
const { createRunStore } = require('../lib/run-store');
const { createWriteQueue } = require('../lib/write-queue');
const { createWriteGate } = require('../lib/write-gate');
const { createImportTransaction } = require('../lib/import-transaction');
const { createTrashStore } = require('../lib/trash-store');
const { movePromptWithHistory } = require('../lib/file-move');
const mainFile = path.resolve(__dirname, '../electron-main.js');
const source = () => fs.readFileSync(mainFile, 'utf8');
const functions = ['queueWrite', 'queueWriteMulti', 'lockRank', 'createLifecycleTransaction', 'rollbackLifecycle', 'renameEntryLocked', 'trashEntryLocked', 'isLockedLocked', 'invalidateWorkspaceForExternalChange'];
function compile(raw, context) { const tree = espree.parse(raw, { ecmaVersion: 'latest', range: true }); const parts = functions.map(name => { const node = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name); assert.ok(node, name + ' must exist'); return raw.slice(...node.range); }); vm.createContext(context); vm.runInContext(parts.join('\n') + '\nglobalThis.entry = {queueWrite,queueWriteMulti,renameEntryLocked,trashEntryLocked,invalidateWorkspaceForExternalChange};', context); return context.entry; }
async function fixture(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-lifecycle-')); const prev = process.env.PFM_DATA_DIR; process.env.PFM_DATA_DIR = dir;
  const rel = 'workflows/a.md'; const next = 'workflows/b.md'; const full = r => path.join(dir, r); const versionDirFor = r => full('.versions/' + r);
  const atomic = async (file, body) => { await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file + '.tmp', body); await fs.promises.rename(file + '.tmp', file); };
  const config = { lockedFiles: [rel], flowRuns: {}, fillMemory: {} }; await atomic(full('config.json'), JSON.stringify(config));
  await atomic(full(rel), '---\nflow:\n  - id: a\n    prompt: prompts/a.md\n---\nbody'); await atomic(path.join(versionDirFor(rel), 'v.md'), 'old'); await atomic(path.join(versionDirFor(rel), 'index.json'), '{"pinned":{"v.md":true}}'); await atomic(path.join(versionDirFor(next), 'existing.md'), 'existing');
  const gate = createWriteGate(); const writeQueue = createWriteQueue(gate); let failed = false; let configFailure = false; let rollbackFailure = false;
  const projects = createProjectStore({ file: full('projects.json'), writeFileAtomic: atomic });
  const runs = createRunStore({ file: full('workflow-runs.json'), writeFileAtomic: async (file, body) => { if (failed) { failed = false; throw new Error('workspace write fault'); } return atomic(file, body); } });
  const loadConfig = async () => JSON.parse(await fs.promises.readFile(full('config.json'), 'utf8'));
  const workspaceService = createWorkspaceService({ projects, runs, queue: writeQueue, loadConfig, readWorkflow: async r => { const content = await fs.promises.readFile(full(r), 'utf8'); return { hash: content, steps: require('../src/flow-graph').parseSteps(content) }; } });
  await workspaceService.initialize(); const state = await workspaceService.runAction('create', { workflowRel: rel, name: 'R', revision: 1, projectId: null });
  const trashStore = createTrashStore({ trashDir: full('.trash'), appError: (c, d) => new Error(c + '|' + d), ensureDir: p => fs.promises.mkdir(p, { recursive: true }), writeFileAtomic: atomic, readIndexJson: async (file, fallback) => { try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } } });
  const ctx = { fs, fsp: fs.promises, path, DATA_ROOT: dir, CONFIG_PATH: full('config.json'), PROJECTS_PATH: full('projects.json'), RUNS_PATH: full('workflow-runs.json'), writeQueue, createImportTransaction: () => { const tx = createImportTransaction(); return { ...tx, rollback: async () => rollbackFailure ? { ok: false, errors: ['retained evidence path'] } : tx.rollback() }; }, workspaceService, loadConfig, saveConfig: async cfg => { if (configFailure) return false; await atomic(full('config.json'), JSON.stringify(cfg)); return true; }, appError: (c, d) => new Error(c + (d ? '|' + d : '')), safeJoinWritable: full, versionDirFor, movePromptWithHistory, dropFromCache: () => {}, trashStore };
  const main = compile(raw, { ...ctx, hideQuickPanel: () => {} });
  return { ...main, state, rel, next, full, workspaceService, gate, fail: () => { failed = true; }, failConfig: () => { configFailure = true; }, failRollback: () => { rollbackFailure = true; }, loadConfig, async unlock() { await atomic(full('config.json'), JSON.stringify({ ...await loadConfig(), lockedFiles: [] })); }, async close() { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.promises.rm(dir, { recursive: true, force: true }); if (prev === undefined) delete process.env.PFM_DATA_DIR; else process.env.PFM_DATA_DIR = prev; } };
}
async function exercise(raw, fn) { const f = await fixture(raw); try { return await fn(f); } finally { await f.close(); } }
const cases = [
  ['rename transaction updates locks and all runs while legacy config remains', 'await workspaceService.relocateWorkflowLocked(oldRel, newRel);', 'void 0;', async f => { const before = await f.loadConfig(); await f.queueWriteMulti(['ver:' + f.rel, 'ver:' + f.next, 'workspace', 'config'], () => f.renameEntryLocked(f.rel, f.next)); assert.equal((await f.workspaceService.getState()).runs.runs[0].workflowRel, f.next); const cfg = await f.loadConfig(); assert.deepEqual(cfg.lockedFiles, [f.next]); assert.deepEqual(cfg.flowRuns, before.flowRuns); assert.equal(fs.readFileSync(f.full(f.next), 'utf8').endsWith('body'), true); assert.equal(fs.readFileSync(f.full('.versions/' + f.next + '/existing.md'), 'utf8'), 'existing'); }],
  ['rename workspace fault restores body both version directories and config', 'await rollbackLifecycle(transaction, error);', 'throw error;', async f => { const cfg = await f.loadConfig(); f.fail(); await assert.rejects(f.queueWriteMulti(['ver:' + f.rel, 'ver:' + f.next, 'workspace', 'config'], () => f.renameEntryLocked(f.rel, f.next)), /E_WORKSPACE_WRITE/); assert.equal(fs.existsSync(f.full(f.rel)), true); assert.equal(fs.existsSync(f.full(f.next)), false); assert.equal(fs.readFileSync(f.full('.versions/' + f.rel + '/v.md'), 'utf8'), 'old'); assert.deepEqual(fs.readdirSync(f.full('.versions/' + f.next)), ['existing.md']); assert.deepEqual(await f.loadConfig(), cfg); assert.deepEqual((await f.workspaceService.getState()).runs, f.state.runs); }],
  ['config write fault restores workspace and file rename', 'if (!await saveConfig(next)) throw appError(\'E_CONFIG_WRITE\', CONFIG_PATH);', 'void 0;', async f => { f.failConfig(); await assert.rejects(f.queueWriteMulti(['ver:' + f.rel, 'ver:' + f.next, 'workspace', 'config'], () => f.renameEntryLocked(f.rel, f.next)), /E_CONFIG_WRITE/); assert.equal(fs.existsSync(f.full(f.rel)), true); assert.deepEqual((await f.workspaceService.getState()).runs, f.state.runs); }],
  ['trash respects config lock and workspace failure rolls back body versions and index', 'await workspaceService.removeWorkflowLocked(rel);', 'void 0;', async f => { await assert.rejects(f.queueWriteMulti(['ver:' + f.rel, 'trash', 'workspace', 'config'], () => f.trashEntryLocked(f.rel)), /E_LOCKED/); await f.unlock(); f.fail(); await assert.rejects(f.queueWriteMulti(['ver:' + f.rel, 'trash', 'workspace', 'config'], () => f.trashEntryLocked(f.rel)), /E_WORKSPACE_WRITE/); assert.ok(fs.existsSync(f.full(f.rel))); assert.ok(fs.existsSync(f.full('.versions/' + f.rel + '/index.json'))); const names = fs.existsSync(f.full('.trash')) ? fs.readdirSync(f.full('.trash')).filter(n => n !== 'index.json') : []; assert.deepEqual(names, []); assert.deepEqual((await f.workspaceService.getState()).runs, f.state.runs); }],
  ['rollback failure surfaces retained evidence explicitly', "if (!result.ok) throw appError('E_WORKSPACE_ROLLBACK'", "if (false) throw appError('E_WORKSPACE_ROLLBACK'", async f => { f.fail(); f.failRollback(); await assert.rejects(f.queueWriteMulti(['ver:' + f.rel, 'ver:' + f.next, 'workspace', 'config'], () => f.renameEntryLocked(f.rel, f.next)), /E_WORKSPACE_ROLLBACK.*retained evidence/); }]
];
for (const [name, from, to, body] of cases) { test(name, () => exercise(source(), body)); test(name + ' [reverse control]', async () => { const raw = source(); assert.ok(raw.includes(from)); await assert.rejects(exercise(raw.replace(from, to), body), error => error instanceof assert.AssertionError); }); }
const reservation = async f => {
  let release; const holder = f.queueWrite('trash', () => new Promise(resolve => { release = resolve; }));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const multi = f.queueWriteMulti(['ver:' + f.rel, 'trash', 'workspace', 'config'], () => f.trashEntryLocked(f.rel));
  await new Promise(resolve => setTimeout(resolve, 10));
  let probe = false; const pending = f.queueWrite('ver:' + f.rel, () => { probe = true; });
  const imported = f.gate.exclusive(async () => 'imported');
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(probe, false); release();
  let timer;
  try {
    const outcomes = await Promise.race([Promise.allSettled([holder, multi, pending, imported]), new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: 'nested shared deadlock' })), 1000); })]);
    assert.equal(outcomes[1].reason.message.startsWith('E_LOCKED'), true); assert.equal(outcomes[3].value, 'imported');
  } finally { clearTimeout(timer); }
};
test('main reserves all keys before import and never nests shared lifecycle queues', () => exercise(source(), reservation));
test('main atomic reservation [reverse control]', async () => {
  const raw = source(); const from = 'return writeQueue.run(uniq, fn);'; assert.ok(raw.includes(from));
  const to = 'const acquire = i => i >= uniq.length ? fn() : queueWrite(uniq[i], () => acquire(i + 1)); return acquire(0);';
  await assert.rejects(exercise(raw.replace(from, to), reservation), error => error instanceof assert.AssertionError && /nested shared deadlock/.test(error.message));
});
const appendOnly = async f => {
  await f.unlock(); const unrelated = f.full('.trash/unrelated.md'); await fs.promises.mkdir(path.dirname(unrelated), { recursive: true }); await fs.promises.writeFile(unrelated, 'retained');
  const originalRead = fs.promises.readFile;
  fs.promises.readFile = async (file, ...args) => { if (file === unrelated) throw new Error('unrelated trash body must not be read'); return originalRead(file, ...args); };
  try { await assert.doesNotReject(f.queueWriteMulti(['ver:' + f.rel, 'trash', 'workspace', 'config'], () => f.trashEntryLocked(f.rel))); }
  finally { fs.promises.readFile = originalRead; }
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'retained');
};
test('trash transaction reads only its own body and versions plus the index', () => exercise(source(), appendOnly));
test('trash append snapshot bounds [reverse control]', async () => { const raw = source(); const from = 'if (!appendOnly) await transaction.snapshot(file);'; assert.ok(raw.includes(from)); await assert.rejects(exercise(raw.replace(from, 'await transaction.snapshot(file);'), appendOnly), error => error instanceof assert.AssertionError); });
const externalRemoval = async f => { await fs.promises.unlink(f.full(f.rel)); await f.invalidateWorkspaceForExternalChange([{ rel: f.rel, type: 'removed' }]); const state = await f.workspaceService.getState(); assert.equal(state.runs.runs[0].availability, 'missing'); await fs.promises.writeFile(f.full(f.rel), 'replacement'); await assert.rejects(f.workspaceService.runAction('skip', { id: state.runs.runs[0].id, revision: state.runs.runs[0].revision }), /E_RUN_UNAVAILABLE/); };
test('observed external deletion disables history before the path is reused', () => exercise(source(), externalRemoval));
test('external deletion history [reverse control]', async () => { const raw = source(); const from = "change.type === 'removed' && change.rel.startsWith('workflows/')"; assert.ok(raw.includes(from)); await assert.rejects(exercise(raw.replace(from, 'false'), externalRemoval), error => error instanceof assert.AssertionError); });
