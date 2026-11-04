const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

// Compile variants in memory: reverse controls cannot leave real sources modified on interruption.
function load(name, mutation) {
  const filename = path.join(__dirname, '../lib/' + name + '.js');
  if (!fs.existsSync(filename)) return {};
  let source = fs.readFileSync(filename, 'utf8');
  if (mutation && mutation[0] === name) {
    assert.ok(source.includes(mutation[1]), 'reverse mutation anchor exists');
    source = source.split(mutation[1]).join(mutation[2]);
  }
  const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = compiled.require.bind(compiled);
  compiled.require = rel => rel === './workspace-data' ? load('workspace-data', mutation) : originalRequire(rel);
  compiled._compile(source, filename);
  return compiled.exports;
}
const fields = { name: 'A', description: 'desc', stack: 'Node', path: 'D:/A', constraints: 'offline' };
const makeProject = i => ({ id: 'p-' + i, ...fields, values: {}, revision: 1, createdAt: 1, updatedAt: 1 });
const makeRun = i => ({ id: 'r-' + i, workflowRel: 'workflows/a.md', name: 'Run A', projectId: null, contextSnapshot: { ...fields, values: {} }, originGraphSnapshot: [{ id: 'a', prompt: 'prompts/a.md', label: 'A', next: [] }], graphSnapshot: [{ id: 'a', prompt: 'prompts/a.md', label: 'A', next: [] }], progress: { v: 1, current: 'a', done: [], skipped: [], history: [], values: {}, updatedAt: 1 }, revision: 1, createdAt: 1, updatedAt: 1, completedAt: null, availability: 'available' });
const projectsDoc = projects => ({ schema: 1, revision: 1, activeProjectId: null, projects });
const runsDoc = runs => ({ schema: 1, revision: 1, legacyImported: false, selectedByWorkflow: {}, runs });
async function fixture(mutation, exercise) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pfm-workspace-'));
  const previous = process.env.PFM_DATA_DIR; process.env.PFM_DATA_DIR = root;
  let id = 0; let timestamp = 100;
  const appError = (code, detail) => Object.assign(new Error(code + (detail ? '|' + detail : '')), { code });
  const writeFileAtomic = async (file, bytes) => { const temporary = file + '.tmp'; await fsp.writeFile(temporary, bytes); await fsp.rename(temporary, file); };
  const options = { file: path.join(root, 'projects.json'), appError, writeFileAtomic, now: () => ++timestamp, newId: () => 'p-' + ++id };
  const { createProjectStore } = load('project-store', mutation); const { createRunStore } = load('run-store', mutation);
  try {
    assert.equal(typeof createProjectStore, 'function', 'project store factory exists');
    assert.equal(typeof createRunStore, 'function', 'run store factory exists');
    await exercise({ root, options, project: createProjectStore(options), run: createRunStore({ ...options, file: path.join(root, 'workflow-runs.json') }), createProjectStore, createRunStore });
  } finally {
    if (previous === undefined) delete process.env.PFM_DATA_DIR; else process.env.PFM_DATA_DIR = previous;
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep), 'cleanup remains inside temp directory');
    await fsp.rm(absolute, { recursive: true, force: true });
  }
}

const cases = [
  ['CRUD persists across fresh stores', async ({ project, createProjectStore, options }) => { const created = await project.create(fields); const updated = await project.update(created.projects[0].id, 1, { name: 'edited' }); const remembered = await project.remember('p-1', 2, { '[custom]': 'private' }); const copy = await project.duplicate('p-1', 3); await project.select('p-2', copy.revision); await project.remove('p-1', remembered.projects[0].revision); const fresh = await createProjectStore(options).read(); assert.deepEqual([updated.projects[0].name, fresh.projects.length, fresh.activeProjectId, fresh.projects[0].id, fresh.projects[0].values, fresh.projects[0].revision], ['edited', 1, 'p-2', 'p-2', { '[custom]': 'private' }, 1]); }, ['project-store', 'values: { ...project.values }', 'values: {}']],
  ['stale entity revision is rejected', async ({ project }) => { await project.create(fields); await project.update('p-1', 1, { name: 'new' }); await assert.rejects(project.update('p-1', 1, { name: 'stale' }), /E_PROJECT_CONFLICT/); }, ['project-store', 'if (project.revision !== revision)', 'if (false)']],
  ['selection uses document revision', async ({ project }) => { await project.create(fields); const d = await project.create({ name: 'B' }); await assert.rejects(project.select('p-1', 1), /E_PROJECT_CONFLICT/); const selected = await project.select('p-1', d.revision); const cleared = await project.select(null, selected.revision); assert.equal(cleared.activeProjectId, null); }, ['project-store', 'if (document.revision !== revision)', 'if (false)']],
  ['project capacity rejects 101st without trimming', async ({ project }) => { await project.write(projectsDoc(Array.from({ length: 100 }, (_, i) => makeProject(i)))); await assert.rejects(project.create(fields), /E_PROJECT_LIMIT/); assert.equal((await project.read()).projects.length, 100); }, ['workspace-data', 'document.projects.length > 100', 'document.projects.length > 101']],
  ['run capacity rejects 1001st without trimming', async ({ run }) => { const runs = Array.from({ length: 1000 }, (_, i) => makeRun(i)); await run.write(runsDoc(runs)); await assert.rejects(run.write(runsDoc([...runs, makeRun(1000)])), /E_RUN_LIMIT/); assert.equal((await run.read()).runs.length, 1000); }, ['workspace-data', 'document.runs.length > 1000', 'document.runs.length > 1001']],
  ['name length is validated', async ({ project }) => { await assert.rejects(project.create({ name: 'x'.repeat(201) }), /E_WORKSPACE_INVALID/); }, ['workspace-data', 'max: 200, required: true', 'max: 201, required: true']],
  ['ordinary field length is validated', async ({ project }) => { await assert.rejects(project.create({ name: 'A', description: 'x'.repeat(20001) }), /E_WORKSPACE_INVALID/); }, ['workspace-data', 'max: 20000', 'max: 20001']],
  ['placeholder count is validated rather than trimmed', async ({ project }) => { await project.create(fields); await assert.rejects(project.remember('p-1', 1, Object.fromEntries(Array.from({ length: 201 }, (_, i) => ['[' + i + ']', 'v']))), /E_WORKSPACE_INVALID/); }, ['workspace-data', 'Object.keys(raw).length > 200', 'Object.keys(raw).length > 201']],
  ['placeholder length is validated rather than truncated', async ({ project }) => { await project.create(fields); await assert.rejects(project.remember('p-1', 1, { '[large]': 'x'.repeat(20001) }), /E_WORKSPACE_INVALID/); }, ['workspace-data', 'value.length > 20000', 'value.length > 20001']],
  ['dangerous input fields are rejected', async ({ project }) => { await assert.rejects(project.create(JSON.parse('{"name":"A","__proto__":{"polluted":true}}')), /E_WORKSPACE_INVALID/); assert.equal({}.polluted, undefined); }, ['workspace-data', 'if (DANGEROUS.has(key))', 'if (false)']],
  ['run graph refuses 501 steps', async ({ run }) => { const r = makeRun(0); r.graphSnapshot = Array.from({ length: 501 }, (_, i) => ({ id: 's-' + i, prompt: 'prompts/a.md', label: 'A', next: [] })); await assert.rejects(run.write(runsDoc([r])), /E_WORKSPACE_INVALID/); }, ['workspace-data', 'graph.length > 500', 'graph.length > 501']],
  ['run relative paths cannot traverse', async ({ run }) => { const r = makeRun(0); r.workflowRel = 'workflows/../secret.md'; await assert.rejects(run.write(runsDoc([r])), /E_WORKSPACE_INVALID/); }, ['workspace-data', "parts.some(part => !part || part === '.' || part === '..')", 'false']],
  ['run selection belongs to same workflow', async ({ run }) => { const d = runsDoc([makeRun(0)]); d.selectedByWorkflow['workflows/b.md'] = 'r-0'; await assert.rejects(run.write(d), /E_WORKSPACE_INVALID/); }, ['workspace-data', 'run.workflowRel !== rel', 'false']],
  ['unknown schema stays byte identical after rejected write', async ({ project, options }) => { const raw = '{"schema":2,"future":"keep me"}'; await fsp.writeFile(options.file, raw); await assert.rejects(project.write(projectsDoc([])), /E_WORKSPACE_SCHEMA/); assert.equal(await fsp.readFile(options.file, 'utf8'), raw); }, ['workspace-data', 'if (document.schema !== 1)', 'if (false)']],
  ['corruption preserves recovery evidence and original bytes', async ({ project, options, root }) => { const raw = '{broken'; await fsp.writeFile(options.file, raw); await assert.rejects(project.read(), /E_WORKSPACE_RECOVERY/); const backups = (await fsp.readdir(root)).filter(n => n.startsWith('projects.json.corrupt-')); assert.equal(backups.length, 1); assert.equal(await fsp.readFile(path.join(root, backups[0]), 'utf8'), raw); assert.equal(await fsp.readFile(options.file, 'utf8'), raw); }, ['workspace-data', 'await fsp.copyFile(file, backup, fs.constants.COPYFILE_EXCL);', 'void backup;']],
  ['recovery failure refuses subsequent writes', async ({ options, createProjectStore }) => { await fsp.writeFile(options.file, '{broken'); const store = createProjectStore({ ...options, fsp: { ...fsp, copyFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } }); await assert.rejects(store.write(projectsDoc([])), /E_WORKSPACE_RECOVERY_FAILED/); assert.equal(await fsp.readFile(options.file, 'utf8'), '{broken'); }, ['workspace-data', "throw fail('E_WORKSPACE_RECOVERY_FAILED', backup);", "throw fail('E_WORKSPACE_RECOVERY', backup);"]],
  ['hardlinked business file is refused', async ({ root, project, options }) => { const target = path.join(root, 'target.json'); await fsp.writeFile(target, JSON.stringify(projectsDoc([]))); await fsp.link(target, options.file); await assert.rejects(project.read(), /E_WORKSPACE_LINK/); }, ['workspace-data', 'if (stat.isSymbolicLink() || (target === absolute && stat.nlink > 1))', 'if (false)']],
  ['linked parent directory is refused', async ({ root, options, createProjectStore }) => { const target = path.join(root, 'target'); await fsp.mkdir(target); const link = path.join(root, 'linked'); await fsp.symlink(target, link, 'junction'); const store = createProjectStore({ ...options, file: path.join(link, 'projects.json') }); await assert.rejects(store.create(fields), /E_WORKSPACE_LINK/); }, ['workspace-data', 'if (stat.isSymbolicLink() || (target === absolute && stat.nlink > 1))', 'if (false)']],
  ['atomic write fault leaves previous bytes and fresh reads unchanged', async ({ project, options, createProjectStore }) => { await project.create(fields); const raw = await fsp.readFile(options.file, 'utf8'); const store = createProjectStore({ ...options, writeFileAtomic: async () => { throw new Error('disk fault'); } }); await assert.rejects(store.update('p-1', 1, { name: 'lost' }), /E_WORKSPACE_WRITE/); assert.equal(await fsp.readFile(options.file, 'utf8'), raw); assert.equal((await store.read()).projects[0].name, 'A'); }, ['workspace-data', "throw fail('E_WORKSPACE_WRITE', error.message);", "return document;"]],
  ['oversize reads are rejected before reading bytes', async ({ options, createProjectStore }) => { await fsp.writeFile(options.file, ' '.repeat(16 * 1024 * 1024 + 1)); const store = createProjectStore({ ...options, fsp: { ...fsp, readFile: async () => { throw new Error('oversize file was read'); } } }); await assert.rejects(store.read(), /E_WORKSPACE_SIZE/); }, ['workspace-data', 'if (stat.size > MAX_BYTES)', 'if (false)']],
  ['oversize encoded writes are rejected', async ({ project }) => { const d = projectsDoc(Array.from({ length: 100 }, (_, i) => ({ ...makeProject(i), description: '文'.repeat(20000), stack: '文'.repeat(20000), path: '文'.repeat(20000), constraints: '文'.repeat(20000) }))); await assert.rejects(project.write(d), /E_WORKSPACE_SIZE/); }, ['workspace-data', 'if (Buffer.byteLength(raw) > MAX_BYTES)', 'if (false)']],
  ['read failures are not treated as empty stores', async ({ options, createProjectStore }) => { const store = createProjectStore({ ...options, fsp: { ...fsp, lstat: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } }); await assert.rejects(store.create(fields), /E_WORKSPACE_READ/); }, ['workspace-data', "throw fail('E_WORKSPACE_READ', error.message);", 'return null;']],
  ['valid run retains exact graph and progress on fresh read', async ({ run, options, createRunStore, root }) => { const d = runsDoc([makeRun(0)]); d.selectedByWorkflow['workflows/a.md'] = 'r-0'; d.legacyImported = true; await run.write(d); assert.deepEqual(await createRunStore({ ...options, file: path.join(root, 'workflow-runs.json') }).read(), d); }, ['run-store', 'return storage.read();', 'return Promise.resolve(empty());']],
  ['unbound run accepts empty project fields with frozen globals', async ({ run }) => { const r = makeRun(0); r.contextSnapshot = { name: '', description: '', stack: '', path: '', constraints: '', values: { '[custom]': 'global snapshot' } }; await assert.doesNotReject(run.write(runsDoc([r]))); assert.deepEqual((await run.read()).runs[0].contextSnapshot, r.contextSnapshot); }, ['workspace-data', 'fields(run.contextSnapshot, false, true);', 'fields(run.contextSnapshot);']],
  ['invalid revisions are rejected', async ({ project }) => { const d = projectsDoc([makeProject(0)]); d.projects[0].revision = -1; await assert.rejects(project.write(d), /E_WORKSPACE_INVALID/); }, ['workspace-data', 'value < 0) invalid(\'revision\')', 'value < -1) invalid(\'revision\')']],
  ['duplicate IDs cannot create ambiguous records', async ({ project }) => { await assert.rejects(project.write(projectsDoc([makeProject(0), makeProject(0)])), /E_WORKSPACE_INVALID/); }, ['workspace-data', 'if (ids.has(project.id))', 'if (false)']],
  ['unsafe IDs are rejected', async ({ project }) => { const p = makeProject(0); p.id = '../bad'; await assert.rejects(project.write(projectsDoc([p])), /E_WORKSPACE_INVALID/); }, ['workspace-data', 'if (!/^[A-Za-z0-9_-]+$/.test(value))', 'if (false)']],
  ['memory preserves clearing and unrelated remembered values', async ({ project }) => { await project.create(fields); await project.remember('p-1', 1, { '[first]': 'one', '[second]': 'two' }); await project.remember('p-1', 2, { '[first]': '' }); assert.deepEqual((await project.read()).projects[0].values, { '[first]': '', '[second]': 'two' }); }, ['project-store', 'project.values = { ...project.values, ...values };', 'project.values = { ...values };']],
  ['valid maximum field and value lengths are preserved', async ({ project }) => { await project.create({ name: 'n'.repeat(200), description: 'x'.repeat(20000) }); await project.remember('p-1', 1, { '[large]': 'v'.repeat(20000) }); const p = (await project.read()).projects[0]; assert.deepEqual([p.name.length, p.description.length, p.values['[large]']?.length], [200, 20000, 20000]); }, ['project-store', 'project.values = { ...project.values, ...values };', 'project.values = {};']],
  ['structured corruption is preserved rather than empty-reset', async ({ project, options, root }) => { const raw = JSON.stringify({ schema: 1, revision: 1, activeProjectId: null, projects: 'broken' }); await fsp.writeFile(options.file, raw); await assert.rejects(project.read(), /E_WORKSPACE_RECOVERY/); assert.equal(await fsp.readFile(options.file, 'utf8'), raw); assert.ok((await fsp.readdir(root)).some(name => name.startsWith('projects.json.corrupt-'))); }, ['workspace-data', 'return preserve();', 'return empty();']],
  ['run value types are rejected', async ({ run }) => { const r = makeRun(0); r.progress.values = { '[bad]': 7 }; await assert.rejects(run.write(runsDoc([r])), /E_WORKSPACE_INVALID/); }, ['workspace-data', "typeof value !== 'string' || value.length > 20000", 'value.length > 20000']],
  ['graph prompt cannot read arbitrary directories', async ({ run }) => { const r = makeRun(0); r.graphSnapshot[0].prompt = 'config/a.md'; await assert.rejects(run.write(runsDoc([r])), /E_WORKSPACE_INVALID/); }, ['workspace-data', "!directories.some(root => value.startsWith(root + '/'))", 'false']],
  ['graph snapshots retain skippable steps without prompt', async ({ run }) => { const r = makeRun(0); r.graphSnapshot[0].prompt = ''; await assert.doesNotReject(run.write(runsDoc([r]))); assert.equal((await run.read()).runs[0].graphSnapshot[0].prompt, ''); }, ['workspace-data', 'if (step.prompt) relative', 'if (true) relative']],
  ['graph snapshots retain existing template references', async ({ run }) => { const r = makeRun(0); r.graphSnapshot[0].prompt = 'templates/a.md'; await assert.doesNotReject(run.write(runsDoc([r]))); assert.equal((await run.read()).runs[0].graphSnapshot[0].prompt, 'templates/a.md'); }, ['workspace-data', "['prompts', 'templates', 'workflows']", "['prompts']"]],
  ['mutation IDs and revisions are validated before lookup', async ({ project }) => { await project.create(fields); await assert.rejects(project.update('p-1', '1', { name: 'new' }), /E_WORKSPACE_INVALID/); await assert.rejects(project.remove('../bad', 1), /E_WORKSPACE_INVALID/); }, ['project-store', 'validate.id(id); validate.revision(revision);', 'void revision;']],
  ['selection validates revision type', async ({ project }) => { await project.create(fields); await assert.rejects(project.select(null, '1'), /E_WORKSPACE_INVALID/); }, ['project-store', 'validate.revision(revision);', 'void revision;']]
];

for (const [name, exercise, mutation] of cases) {
  test(name, async () => {
    await fixture(null, exercise);
    await assert.rejects(fixture(mutation, exercise), error => error instanceof assert.AssertionError, 'targeted reverse control: ' + name);
  });
}
