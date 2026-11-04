'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const archiver = require('archiver');
const Module = require('node:module');
const { documents, flow, template, leaf, bodies, relMap } = require('./workspace-backup-fixtures');
const sourceFile = path.resolve(__dirname, '../lib/workspace-backup.js');
const cases = new Map(); const overrides = new Map();
function test(name, body) { cases.set(name, body); nodeTest(name, body); }
const moduleFor = relative => overrides.get(relative) || require('../' + relative);
function subject() {
  const api = fs.existsSync(sourceFile) ? moduleFor('lib/workspace-backup.js') : {};
  assert.equal(typeof api.prepareImport, 'function', 'workspace backup preparation must exist');
  return api;
}
const freshId = () => { let n = 0; return () => 'fresh_' + ++n; };
const portable = () => ({ ...documents(), contents: new Map(bodies) });
const entry = (file, document) => ({ path: file, content: JSON.stringify(document) });
const paired = data => [entry('.pfm/projects.json', data.projects), entry('.pfm/workflow-runs.json', data.runs)];

test('imports new identities, bound projects, both graphs and incoming selection without changing locals', () => {
  const api = subject(); const current = documents('local', 1); const incoming = portable();
  const before = JSON.stringify([current, incoming]);
  const merged = api.prepareImport(current, incoming, relMap(), freshId());
  assert.deepEqual({
    local: [merged.projects.projects[0], merged.runs.runs[0]], active: merged.projects.activeProjectId,
    ids: merged.projects.projects.slice(1).map(p => p.id).concat(merged.runs.runs.slice(1).map(r => r.id)),
    bindings: merged.runs.runs.slice(1).map(r => r.projectId),
    graphs: merged.runs.runs.slice(1).map(r => [r.workflowRel, r.originGraphSnapshot[0].prompt, r.graphSnapshot[0].prompt]),
    selected: merged.runs.selectedByWorkflow, unchanged: JSON.stringify([current, incoming]) === before
  }, {
    local: [current.projects.projects[0], current.runs.runs[0]], active: 'local_p0', ids: ['fresh_1', 'fresh_2', 'fresh_3', 'fresh_4'],
    bindings: ['fresh_1', 'fresh_2'], graphs: Array(2).fill(['workflows/portable-1.md', 'prompts/testing/portable-1.md', 'prompts/testing/portable-1.md']),
    selected: { [flow]: 'local_r0', 'workflows/portable-1.md': 'fresh_4' }, unchanged: true
  }, 'remapped state');
});

test('remaps only actual flow prompt and active include text, retaining unknown frontmatter, prose and code', () => {
  const api = subject();
  const original = bodies[0][1] + 'Prose ' + template + '\n{{include:  templates/portable.md  }}\n`{{include: templates/portable.md}}`\n```md\n{{include: templates/portable.md}}\n```\n';
  const expected = original.replaceAll('    prompt: prompts/testing/portable.md', '    prompt: prompts/testing/portable-1.md')
    .replace('{{include:  templates/portable.md  }}', '{{include:  templates/portable-1.md  }}');
  assert.equal(api.remapImportedContent(original, relMap()), expected, 'precise flow and active include rewrite');
  assert.equal(api.remapImportedContent(bodies[1][1], relMap()), bodies[1][1].replace('\n{{include: templates/portable.md}}', '\n{{include: templates/portable-1.md}}'), 'prompt frontmatter remains metadata');
  assert.equal(api.remapImportedContent(bodies[2][1].replaceAll('\n', '\r\n'), relMap()), bodies[2][1].replace('{{include: templates/leaf.md}}', '{{include: templates/leaf-1.md}}').replaceAll('\n', '\r\n'), 'nested CRLF content rewrite');
});

test('Windows prompt paths execute imported collision copies', () => {
  const api = subject();
  const graph = require('../src/flow-graph');
  for (const reference of ['prompts\\testing\\portable.md', "'prompts\\testing\\portable.md'"]) {
    const original = bodies[0][1].replaceAll('    prompt: prompts/testing/portable.md', '    prompt: ' + reference);
    const transformed = api.remapImportedContent(original, relMap());
    assert.deepEqual(graph.parseSteps(transformed).map(step => step.prompt),
      ['prompts/testing/portable-1.md', 'prompts/testing/portable-1.md'], 'Windows references point at imported copies');
    assert.ok(transformed.includes('Workflow prose prompts/testing/portable.md'), 'Windows mapping preserves prose');
  }
});

test('nested unpackaged includes stay unresolved and list the original missing path', () => {
  const api = subject(); const map = relMap(); map.delete(leaf);
  const imported = api.prepareImport(documents('local', 0), portable(), map, freshId());
  assert.deepEqual(imported.runs.runs.map(r => [r.availability, r.missingDependencies]), Array(2).fill(['unresolved', [leaf]]));
});

test('actual workflow dependencies outside saved graphs are checked before imported execution', () => {
  const api = subject(); const incoming = portable();
  incoming.contents.set(flow, bodies[0][1].replace('    prompt: prompts/testing/portable.md', '    prompt: prompts/testing/absent.md'));
  const result = api.prepareImport(documents('local', 0), incoming, relMap(), freshId());
  assert.deepEqual(result.runs.runs[0].missingDependencies, ['prompts/testing/absent.md']);
});

test('an unresolved imported run stays blocked through a second backup even if names now exist', () => {
  const api = subject(); const incoming = portable(); incoming.runs.runs[0].availability = 'unresolved'; incoming.runs.runs[0].missingDependencies = [leaf];
  const result = api.prepareImport(documents('local', 0), incoming, relMap(), freshId());
  assert.deepEqual([result.runs.runs[0].availability, result.runs.runs[0].missingDependencies], ['unresolved', [leaf]]);
});

test('identity generation cannot reuse source or local IDs', () => {
  const api = subject(); const current = documents('local', 1); const incoming = portable();
  let n = 0; const ids = ['incoming_p0', 'local_r0'];
  const result = api.prepareImport(current, incoming, relMap(), () => ids[n++] || 'unique_' + n);
  assert.deepEqual(result.projects.projects.slice(1).map(project => project.id), ['unique_3', 'unique_4']);
});

for (const [name, change, expected] of [
  ['unknown schema', d => { d.projects.schema = 2; }, /E_WORKSPACE_SCHEMA/],
  ['cross-document project reference', d => { d.runs.runs[0].projectId = 'not_exported'; }, /E_WORKSPACE_INVALID/],
  ['unsafe property', d => { d.projects.projects[0].values = JSON.parse('{"__proto__":"bad"}'); }, /E_WORKSPACE_INVALID/],
  ['dangling selection', d => { d.runs.selectedByWorkflow[flow] = 'absent'; }, /E_WORKSPACE_INVALID/],
  ['too many projects', d => { d.projects.projects = Array.from({ length: 101 }, (_, i) => ({ ...d.projects.projects[0], id: 'p' + i })); d.projects.activeProjectId = null; d.runs.runs.forEach(run => { run.projectId = 'p0'; }); }, /E_PROJECT_LIMIT/],
  ['too many runs', d => { d.runs.runs = Array.from({ length: 1001 }, (_, i) => ({ ...d.runs.runs[0], id: 'r' + i })); d.runs.selectedByWorkflow = {}; }, /E_RUN_LIMIT/],
  ['invalid missing dependency details', d => { d.runs.runs[0].missingDependencies = [42]; }, /E_WORKSPACE_INVALID/]
]) test('portable validation rejects ' + name, () => { const api = subject(); const data = documents(); change(data); assert.throws(() => api.validatePortable(data), expected); });

for (const kind of ['projects', 'runs']) test('merged ' + kind + ' count is preflighted without truncating history', () => {
  const api = subject(); const current = documents('local', 1); const incoming = portable();
  if (kind === 'projects') { current.projects.projects = Array.from({ length: 99 }, (_, i) => ({ ...current.projects.projects[0], id: i ? 'extra' + i : 'local_p0' })); }
  else { current.runs.runs = Array.from({ length: 999 }, (_, i) => ({ ...current.runs.runs[0], id: i ? 'extra' + i : 'local_r0' })); }
  assert.throws(() => api.prepareImport(current, incoming, relMap(), freshId()), kind === 'projects' ? /E_PROJECT_LIMIT/ : /E_RUN_LIMIT/);
});

test('merged encoded business size is rejected before any store writes', () => {
  const api = subject(); const current = documents('local', 2); const incoming = documents('incoming', 3);
  const values = Object.fromEntries(Array.from({ length: 190 }, (_, i) => ['{{' + i + '}}', '界'.repeat(9000)]));
  for (const data of [current, incoming]) for (const project of data.projects.projects) project.values = values;
  assert.throws(() => api.prepareImport(current, incoming, relMap(), freshId()), /E_WORKSPACE_SIZE/);
});

test('old backups with neither document remain compatible and empty library pairs remain backups', () => {
  const api = subject(); const data = documents('empty', 0);
  assert.equal(api.readPortableEntries([]), null, 'legacy pair is optional');
  const summary = moduleFor('lib/backup-preview.js').summarizeBackupEntries(paired(documents()), () => false);
  assert.deepEqual([summary.mode, summary.files, summary.projects, summary.runs], ['backup', 0, 2, 2], 'empty library workspace counts');
  assert.deepEqual(moduleFor('lib/backup-preview.js').summarizeBackupEntries(paired(data), () => false).mode, 'backup', 'empty documents remain backup');
});

for (const [name, make] of [
  ['one missing document', d => paired(d).slice(0, 1)],
  ['duplicate exact entries', d => [...paired(d), paired(d)[0]]],
  ['invalid JSON', d => [...paired(d).slice(0, 1), { path: '.pfm/workflow-runs.json', content: '{bad' }]]
]) test('business entries reject ' + name, () => { const api = subject(); assert.throws(() => api.readPortableEntries(make(documents())), /E_WORKSPACE_INVALID/); });

async function makeZip(file, entries) {
  await new Promise((resolve, reject) => { const output = fs.createWriteStream(file); const archive = archiver('zip'); output.on('error', reject); output.on('close', resolve); archive.on('error', reject); archive.pipe(output); for (const [name, content] of entries) archive.append(content, { name }); archive.finalize().catch(reject); });
}
test('ZIP exact workspace opt-in admits 16 MiB documents without admitting unknown JSON or raising Markdown limits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-backup-limits-')); const file = path.join(dir, 'data.zip');
  try {
    await makeZip(file, [['.pfm/projects.json', ' '.repeat(16 * 1024 * 1024)], ['.pfm/workflow-runs.json', '{}'], ['.pfm/other.json', '{}'], ['nested/.pfm/projects.json', '{}'], ['prompts/large.md', 'x'.repeat(4 * 1024 * 1024 + 1)]]);
    const { readZipMarkdownEntries } = moduleFor('lib/zip-import.js');
    const parsed = await readZipMarkdownEntries(file, { includeWorkspace: true });
    assert.deepEqual({ paths: parsed.entries.map(e => e.path), skipped: parsed.skipped.map(e => e.name) }, { paths: ['.pfm/projects.json', '.pfm/workflow-runs.json'], skipped: ['prompts/large.md'] }, 'exact workspace opt-in paths and separate limits');
    assert.deepEqual((await readZipMarkdownEntries(file)).entries, [], 'default reader excludes business JSON');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ZIP workspace limit and 64 MiB combined limit reject a business backup, never partially import it', async () => {
  const api = subject(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-backup-overlimit-')); const file = path.join(dir, 'data.zip');
  try {
    await makeZip(file, [['.pfm/projects.json', 'x'.repeat(16 * 1024 * 1024 + 1)], ['.pfm/workflow-runs.json', '{}']]);
    const { readZipMarkdownEntries } = moduleFor('lib/zip-import.js');
    const oversized = await readZipMarkdownEntries(file, { includeWorkspace: true });
    assert.throws(() => api.readPortableEntries(oversized.entries, oversized.skipped), /E_WORKSPACE_SIZE/, 'overlimit document refuses entire backup');
    const data = documents('empty', 0);
    await makeZip(file, [...Array.from({ length: 16 }, (_, i) => ['prompts/' + i + '.md', 'x'.repeat(4 * 1024 * 1024)]), ...paired(data).map(e => [e.path, e.content])]);
    const overtotal = await readZipMarkdownEntries(file, { includeWorkspace: true });
    assert.throws(() => api.readPortableEntries(overtotal.entries, overtotal.skipped), /E_WORKSPACE_SIZE/, 'combined 64 MiB refuses entire backup');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function compile(relative, source, dependency) {
  const filename = path.resolve(__dirname, '..', relative); const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  if (dependency) mod.require = name => name === './workspace-data' ? dependency : original(name);
  mod._compile(source, filename); return mod.exports;
}
const remapCase = 'imports new identities, bound projects, both graphs and incoming selection without changing locals';
const contentCase = 'remaps only actual flow prompt and active include text, retaining unknown frontmatter, prose and code';
const legacyCase = 'old backups with neither document remain compatible and empty library pairs remain backups';
const zipCase = 'ZIP exact workspace opt-in admits 16 MiB documents without admitting unknown JSON or raising Markdown limits';
const overlimitCase = 'ZIP workspace limit and 64 MiB combined limit reject a business backup, never partially import it';
const controls = [
  ['Windows prompt normalization', 'Windows prompt paths execute imported collision copies', 'lib/workspace-backup.js', "rel.replace(/\\\\/g, '/')", 'rel', 'Windows references point at imported copies'],
  ['new IDs', remapCase, 'lib/workspace-backup.js', 'project.id = freshId();', 'project.id = original.id;', 'remapped state'],
  ['binding IDs', remapCase, 'lib/workspace-backup.js', 'run.projectId = projectIds.get(run.projectId) || null;', 'run.projectId = null;', 'remapped state'],
  ['original graph', remapCase, 'lib/workspace-backup.js', "for (const key of ['originGraphSnapshot', 'graphSnapshot'])", "for (const key of ['graphSnapshot'])", 'remapped state'],
  ['saved graph', remapCase, 'lib/workspace-backup.js', "for (const key of ['originGraphSnapshot', 'graphSnapshot'])", "for (const key of ['originGraphSnapshot'])", 'remapped state'],
  ['incoming selection', remapCase, 'lib/workspace-backup.js', 'after.runs.selectedByWorkflow[target] = runIds.get(id);', 'void 0;', 'remapped state'],
  ['local selection', remapCase, 'lib/workspace-backup.js', 'const projectIds = new Map();', 'after.projects.activeProjectId = null; const projectIds = new Map();', 'remapped state'],
  ['workflow rewrite', contentCase, 'lib/workspace-backup.js', "WORKFLOW_REFS.mapPromptLines(content, rel => mapped(relMap, rel.replace(/\\\\/g, '/')) || null).content", 'content', 'precise flow and active include rewrite'],
  ['include masking', contentCase, 'lib/workspace-backup.js', 'INCLUDES.extract(body).reverse()', "INCLUDES.extract(body.replaceAll('`', ' ')).reverse()", 'precise flow and active include rewrite'],
  ['prompt include', contentCase, 'lib/workspace-backup.js', 'function remapImportedContent(content, relMap) {', "function remapImportedContent(content, relMap) { if (content.includes('PACKAGE-PROMPT')) return content;", 'prompt frontmatter remains metadata'],
  ['CRLF include', contentCase, 'lib/workspace-backup.js', 'function remapImportedContent(content, relMap) {', "function remapImportedContent(content, relMap) { if (content.includes('\\r\\n')) return content;", 'nested CRLF content rewrite'],
  ['nested dependencies', 'nested unpackaged includes stay unresolved and list the original missing path', 'lib/workspace-backup.js', 'if (include.valid) pending.push(include.rel);', 'if (include.valid) continue;'],
  ['actual workflow dependencies', 'actual workflow dependencies outside saved graphs are checked before imported execution', 'lib/workspace-backup.js', 'if (rel === run.workflowRel)', 'if (false)'],
  ['persistent refusal', 'an unresolved imported run stays blocked through a second backup even if names now exist', 'lib/workspace-backup.js', 'new Set(run.missingDependencies || [])', 'new Set()'],
  ['identity collision', 'identity generation cannot reuse source or local IDs', 'lib/workspace-backup.js', 'if (usedIds.has(id)) continue;', 'void 0;'],
  ['schema', 'portable validation rejects unknown schema', 'lib/workspace-data.js', "if (document.schema !== 1) throw fail('E_WORKSPACE_SCHEMA', String(document.schema));", 'void 0;'],
  ['crossrefs', 'portable validation rejects cross-document project reference', 'lib/workspace-backup.js', "if (run.projectId !== null && !ids.has(run.projectId)) throw defaultError('E_WORKSPACE_INVALID', 'project reference');", 'void 0;'],
  ['unsafe keys', 'portable validation rejects unsafe property', 'lib/workspace-data.js', "if (DANGEROUS.has(key)) invalid('unsafe key');", 'void 0;'],
  ['selected references', 'portable validation rejects dangling selection', 'lib/workspace-data.js', "if (!run || run.workflowRel !== rel) invalid('selected run');", 'void 0;'],
  ['project cap', 'portable validation rejects too many projects', 'lib/workspace-data.js', 'document.projects.length > 100', 'document.projects.length > 10000'],
  ['run cap', 'portable validation rejects too many runs', 'lib/workspace-data.js', 'document.runs.length > 1000', 'document.runs.length > 10000'],
  ['dependency details', 'portable validation rejects invalid missing dependency details', 'lib/workspace-data.js', 'for (const dependency of run.missingDependencies) text(dependency, { max: 20000, required: true });', 'void 0;'],
  ['merged project cap', 'merged projects count is preflighted without truncating history', 'lib/workspace-backup.js', 'validatePortable(after);', 'void 0;'],
  ['merged run cap', 'merged runs count is preflighted without truncating history', 'lib/workspace-backup.js', 'validatePortable(after);', 'void 0;'],
  ['merged byte cap', 'merged encoded business size is rejected before any store writes', 'lib/workspace-backup.js', 'validatePortable(after);', 'void 0;'],
  ['legacy archives', legacyCase, 'lib/workspace-backup.js', 'return null;', 'return {};', 'legacy pair is optional'],
  ['empty library', legacyCase, 'lib/backup-preview.js', '(contentEntries.length > 0 || !!workspace)', '(contentEntries.length > 0)', 'empty library workspace counts'],
  ['empty workspace', legacyCase, 'lib/backup-preview.js', '(contentEntries.length > 0 || !!workspace)', '(contentEntries.length > 0 || !!workspace && workspace.runs.runs.length > 0)', 'empty documents remain backup'],
  ['incomplete pair', 'business entries reject one missing document', 'lib/workspace-backup.js', 'const data = {};', 'const data = {};', null, "if (workspace.length === 1) return null;\n"],
  ['duplicate pair', 'business entries reject duplicate exact entries', 'lib/workspace-backup.js', "if (workspace.length !== 2 || workspace.filter(entry => entry.path === PROJECTS_ENTRY).length !== 1\n      || workspace.filter(entry => entry.path === RUNS_ENTRY).length !== 1) throw defaultError('E_WORKSPACE_INVALID', 'workspace pair');", 'void 0;'],
  ['invalid JSON', 'business entries reject invalid JSON', 'lib/workspace-backup.js', "catch { throw defaultError('E_WORKSPACE_INVALID', entry.path); }", 'catch { return null; }'],
  ['workspace 16 MiB admission', zipCase, 'lib/zip-import.js', 'const entryLimit = isWorkspace ? MAX_WORKSPACE_BYTES : maxBytes;', 'const entryLimit = maxBytes;', 'exact workspace opt-in paths and separate limits'],
  ['JSON whitelist', zipCase, 'lib/zip-import.js', 'includeWorkspace && isWorkspaceEntry(entry.fileName)', "includeWorkspace && entry.fileName.endsWith('.json')", 'exact workspace opt-in paths and separate limits'],
  ['opt-in requirement', zipCase, 'lib/zip-import.js', 'const includeWorkspace = options.includeWorkspace === true;', 'const includeWorkspace = true;', 'default reader excludes business JSON'],
  ['oversized partial refusal', overlimitCase, 'lib/workspace-backup.js', "if (skipped.length) throw defaultError('E_WORKSPACE_SIZE', skipped.map(entry => entry.name).slice(0, 5).join(', '));", 'void 0;', 'overlimit document refuses entire backup'],
  ['combined byte cap', overlimitCase, 'lib/zip-import.js', 'const MAX_IMPORT_TOTAL_BYTES = 64 * 1024 * 1024;', 'const MAX_IMPORT_TOTAL_BYTES = 128 * 1024 * 1024;', 'combined 64 MiB refuses entire backup']
];
for (const [label, name, file, from, to, expectedMessage, prefix] of controls) nodeTest(label + ' [reverse control]', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  assert.ok(source.includes(from), 'mutation target exists: ' + label);
  let changed = source.replace(from, to);
  if (prefix) changed = changed.replace('const workspace = entries.filter(entry => isWorkspaceEntry(entry.path));', 'const workspace = entries.filter(entry => isWorkspaceEntry(entry.path));\n' + prefix);
  const mutant = compile(file, changed);
  if (file === 'lib/workspace-data.js') overrides.set('lib/workspace-backup.js', compile('lib/workspace-backup.js', fs.readFileSync(sourceFile, 'utf8'), mutant));
  else overrides.set(file, mutant);
  try { await assert.rejects(async () => cases.get(name)(), error => error instanceof assert.AssertionError && (!expectedMessage || error.message.includes(expectedMessage))); }
  finally { overrides.clear(); }
});
