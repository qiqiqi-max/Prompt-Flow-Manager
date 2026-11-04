'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const archiver = require('archiver');
const { createHash } = require('node:crypto');
const { documents, flow, leaf, bodies } = require('./workspace-backup-fixtures');
const { readZipMarkdownEntries } = require('../lib/zip-import');
const root = path.resolve(__dirname, '..');
const electron = require('electron');
const digest = value => createHash('sha256').update(value).digest('hex');
let controlFailures = null;
const check = (name, value) => {
  if (!value && controlFailures) { controlFailures.push(name); console.log('[workspace-backup] FAIL ' + name); return; }
  assert.ok(value, name); console.log('[workspace-backup] PASS ' + name);
};
const jsCheck = `const failures=[];const check=(name,value)=>{if(!value)failures.push(name);console.log('[workspace-backup] '+(value?'PASS ':'FAIL ')+name);};`;
const temp = label => fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-workspace-backup-' + label + '-'));
const write = (dir, rel, value) => { const file = path.join(dir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
function seed(dir, docs = documents(), library = bodies) {
  write(dir, 'projects.json', JSON.stringify(docs.projects, null, 3) + '\n');
  write(dir, 'workflow-runs.json', JSON.stringify(docs.runs, null, 3) + '\n');
  write(dir, 'config.json', JSON.stringify({ lang: 'en', updateCheck: false, flowRuns: {}, sidebarWidth: 240, fillMemory: { '{{shared}}': 'local global' } }));
  for (const [rel, content] of library) write(dir, rel, content);
}
function launch(dir, script, dialogs = [], options = {}) {
  const queue = path.join(dir, '__backup-dialogs.json'); fs.writeFileSync(queue, JSON.stringify(dialogs));
  const spec = path.join(dir, '__backup-main.json'); fs.writeFileSync(spec, JSON.stringify({ root, ...options }));
  const args = [path.join(root, 'tests/helpers/workspace-backup-electron.cjs'), spec];
  const result = spawnSync(electron, args, { cwd: root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PFM_SELFTEST: '1', PFM_DATA_DIR: dir, PFM_UPDATE_CHECK: 'off', ELECTRON_ENABLE_LOGGING: '1',
      PFM_SELFTEST_DIALOGS: queue, PFM_SELFTEST_EVAL: '(async()=>{' + jsCheck + script + ";if(failures.length)throw new Error('Backup assertions: '+failures.join(', '));})()" } });
  const output = String(result.stdout || '') + String(result.stderr || '');
  console.log(output.split(/\r?\n/).filter(line => /workspace-backup|sandbox|沙箱/.test(line)).join('\n'));
  if (controlFailures) {
    const failures = [...output.matchAll(/\[workspace-backup\] FAIL ([^\r\n"]+)/g)].map(match => match[1].trim());
    controlFailures.push(...failures);
    if (failures.length) return output;
  }
  if (result.status !== 0 || output.includes('[workspace-backup] FAIL ') || !output.includes('[workspace-backup] PASS complete')) throw new Error('Electron backup test failed: ' + result.status + '\n' + output.slice(-16000));
  return output;
}
async function archive(file, entries) {
  const all = entries.map(([name, content]) => [name, Buffer.isBuffer(content) ? content : Buffer.from(content)]);
  const manifest = { schema: 1, app: 'prompt-flow-manager', files: all.map(([name, content]) => ({ path: name, size: content.length, sha256: digest(content) })) };
  await new Promise((resolve, reject) => { const stream = fs.createWriteStream(file); const zip = archiver('zip'); stream.on('close', resolve); stream.on('error', reject); zip.on('error', reject); zip.pipe(stream); for (const [name, content] of all) zip.append(content, { name }); zip.append(JSON.stringify(manifest), { name: '.pfm/manifest.json' }); zip.finalize().catch(reject); });
}
const openZip = file => [{ canceled: false, filePaths: [file] }, { kind: 'message', response: 1 }];
const readZip = file => readZipMarkdownEntries(file, { includeWorkspace: true, includeManifest: true, includePortableConfig: true, includeTrash: true, includeVersionIndexes: true });

async function roundtrip(base, options = {}) {
  const source = path.join(base, 'source'); const target = path.join(base, 'target'); const exported = options.exported || path.join(base, 'roundtrip.zip');
  seed(source); seed(target, documents('local', 1), bodies.map(([rel, content]) => [rel, content.replaceAll('PACKAGE-', 'LOCAL-')]));
  write(source, '.versions/' + flow + '/index.json', JSON.stringify({ current: { note: 'portable current workflow note', sha256: digest(bodies[0][1]) } }));
  write(source, '.trash/index.json', JSON.stringify({ items: [{ id: 'trash', name: 'discarded.md', originalRel: 'prompts/testing/discarded.md', store: 'discarded.md', trashedAt: 1 }] }));
  write(source, '.trash/discarded.md', 'PACKAGE-TRASH');
  if (!options.exported) launch(source, `const result=await api.exportZip();check('export succeeds',result.ok);check('complete',true);`, [{ canceled: false, filePath: exported }], options.source || {});
  const zip = await readZip(exported); const byPath = new Map(zip.entries.map(e => [e.path, e]));
  check('export contains both workspace documents', byPath.has('.pfm/projects.json') && byPath.has('.pfm/workflow-runs.json'));
  const manifest = JSON.parse(byPath.get('.pfm/manifest.json').content);
  check('manifest hashes raw exported workspace bytes', ['.pfm/projects.json', '.pfm/workflow-runs.json'].every(rel => manifest.files.some(item => item.path === rel && item.sha256 === byPath.get(rel).sha256 && item.size === byPath.get(rel).size)));
  const locals = new Map(bodies.map(([rel]) => [rel, fs.readFileSync(path.join(target, rel))]));
  const script = `
    const before=await api.getWorkspace();
    const result=await api.importZip();
    check('import restores project and run counts',result.ok&&result.restoredProjects===2&&result.restoredRuns===2&&result.imported===4);
    const after=await api.getWorkspace();
    check('current project and run selections survive',after.projects.activeProjectId===before.projects.activeProjectId&&after.runs.selectedByWorkflow['${flow}']===before.runs.selectedByWorkflow['${flow}']);
    const imported=after.runs.runs.filter(run=>!run.id.startsWith('local_'));
    check('all imported identities and project bindings are new',imported.length===2&&imported.every(run=>!run.id.startsWith('incoming_')&&!run.projectId.startsWith('incoming_')&&after.projects.projects.some(project=>project.id===run.projectId)));
    check('incoming selected run follows the imported workflow copy',after.runs.selectedByWorkflow['workflows/portable-1.md']===imported[1].id);
    const body=(await api.readFile('workflows/portable-1.md')).content;
    check('actual workflow prompt points at imported copy',FLOW_GRAPH.parseSteps(body).every(step=>step.prompt==='prompts/testing/portable-1.md'));
    check('both saved graphs follow the imported copy',imported.every(run=>[run.originGraphSnapshot,run.graphSnapshot].every(graph=>graph.every(step=>step.prompt==='prompts/testing/portable-1.md'))));
    const prompt=(await api.readFile('prompts/testing/portable-1.md')).content;
    const expanded=await INCLUDES.resolveAsync(INCLUDES.stripFrontmatter(prompt),async rel=>(await api.readFile(rel)).content);
    check('nested includes execute imported contents',expanded.includes('PACKAGE-TEMPLATE')&&expanded.includes('PACKAGE-LEAF')&&!expanded.includes('LOCAL-'));
    check('unknown frontmatter and prose remain unchanged',body.includes('custom: prompts/testing/portable.md')&&body.includes('label: prompts/testing/portable.md')&&body.includes('Workflow prose prompts/testing/portable.md'));
    await refreshWorkspace();await openFile('workflows/portable-1.md');
    check('reopened imported workflow offers resume',!!document.querySelector('[data-run-act="resume"]'));
    const resumed=await api.runAction('resume',{id:imported[1].id,revision:imported[1].revision});
    const rawHash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body));
    const hash=Array.from(new Uint8Array(rawHash),b=>b.toString(16).padStart(2,'0')).join('');
    check('resumed run hash matches transformed workflow',resumed.workflowHash===hash);
    check('complete',true);`;
  launch(target, script, openZip(exported), options);
  const preview = JSON.parse(fs.readFileSync(path.join(target, '__backup-preview.json'), 'utf8')).detail;
  check('preview discloses workspace counts and sensitive fields', /2 project/.test(preview) && /2 (workflow )?run/.test(preview) && /paths/.test(preview) && /filled values/.test(preview));
  check('local content copies remain byte identical', [...locals].every(([rel, raw]) => fs.readFileSync(path.join(target, rel)).equals(raw)));
  const version = JSON.parse(fs.readFileSync(path.join(target, '.versions/' + flow.replace('.md', '-1.md') + '/index.json'), 'utf8'));
  check('current version note hashes transformed content', version.current?.note === 'portable current workflow note' && version.current.sha256 === digest(fs.readFileSync(path.join(target, 'workflows/portable-1.md'))));
  return exported;
}

async function rollback(base, exported, hook, options = {}) {
  const dir = path.join(base, hook); seed(dir, documents('local', 1));
  write(dir, '.trash/index.json', '{ "items": [] }\n');
  const script = `
    const before=await api.getWorkspace();let message='';let settled=false;
    const importing=api.importZip().catch(error=>{message=String(error.message);});
    const wait=async (predicate,label='phase')=>{const start=Date.now();while(!predicate()){if(Date.now()-start>3000)throw new Error('[workspace-backup] FAIL '+label);await new Promise(r=>setTimeout(r,10));}};
    await wait(()=>window.__backupPhase==='${hook}');
    await refreshTree();
    check('${hook} observes imported tree before rollback',state.metaList.some(item=>item.rel.endsWith('-1.md')));
    const queued=[api.projectAction('select',{id:before.projects.activeProjectId,revision:before.projects.revision}),api.setConfig({sidebarWidth:333}),api.runAction('select',{id:before.runs.runs[0].id,revision:before.runs.revision})];
    const mutations=Promise.allSettled(queued).then(results=>{settled=true;return results;});
    await new Promise(r=>setTimeout(r,25));
    check('queued mutations wait for ${hook} transaction',!settled);
    window.__backupQueued=true;
    await importing;const results=await mutations;
    check('${hook} queued mutations settle successfully',results.every(result=>result.status==='fulfilled'));
    check('${hook} failure reports rollback',message.includes('E_IMPORT_ROLLED_BACK')&&message.includes('injected after ${hook} writes'));
    const after=await api.getWorkspace();
    check('${hook} rollback preserves local workspace',after.projects.projects.length===1&&after.runs.runs.length===1&&after.projects.activeProjectId===before.projects.activeProjectId&&after.runs.runs[0].id===before.runs.runs[0].id);
    check('${hook} queued config mutation persists',(await api.getConfig()).sidebarWidth===333);
    check('${hook} rollback removes imported body cache',!(await api.getMetaList()).some(item=>item.rel.endsWith('-1.md')));
    await wait(()=>!state.metaList.some(item=>item.rel.endsWith('-1.md')),'${hook} renderer refresh removes transient imported tree');
    check('${hook} renderer refresh removes transient imported tree',!state.metaList.some(item=>item.rel.endsWith('-1.md')));
    check('${hook} renderer reload has no imported history',state.workspace.runs.runs.length===1);
    check('complete',true);`;
  launch(dir, script, openZip(exported), { hook, ...options });
  const restored = JSON.parse(fs.readFileSync(path.join(dir, '__backup-rollback.json'), 'utf8'));
  check(hook + ' all transaction snapshots restore exact bytes before queued writes', restored.every(item => item.equal) && ['projects.json', 'workflow-runs.json'].every(file => restored.some(item => item.file === file)));
}

async function compatibility(base, options = {}) {
  for (const kind of options.kinds || ['legacy', 'empty', 'missing']) {
    const dir = path.join(base, kind); seed(dir, documents('local', 1)); const file = path.join(base, kind + '.zip');
    const data = documents('history', kind === 'empty' ? 1 : 2);
    let content = kind === 'legacy' ? [['prompts/testing/legacy.md', 'LEGACY']] : [];
    if (kind === 'missing') content = bodies.filter(([rel]) => rel !== leaf);
    if (kind !== 'legacy') content.push(['.pfm/projects.json', JSON.stringify(data.projects)], ['.pfm/workflow-runs.json', JSON.stringify(data.runs)]);
    await archive(file, content);
    const script = `let result;try{result=await api.importZip();}catch(error){result={ok:false};}const after=await api.getWorkspace();
      check('${kind} backup succeeds',result.ok);
      ${kind === 'legacy' ? "check('legacy archive leaves workspace intact',after.projects.projects.length===1&&after.runs.runs.length===1);" : `const imported=after.runs.runs.find(run=>run.name==='history run 0');check('${kind} history remains available for browsing',!!imported&&imported.availability==='unresolved');let refused=false;try{await api.runAction('resume',{id:imported.id,revision:1});}catch(error){refused=String(error.message).includes('E_RUN_UNAVAILABLE');}check('${kind} cannot bind local names on resume',refused);check('${kind} missing paths are visible',imported.missingDependencies.includes('${kind === 'missing' ? leaf : flow}'));
        await refreshWorkspace();openRunHistory();const detail=document.querySelector('[data-history-detail="'+imported.id+'"]');detail.open=true;await new Promise(r=>setTimeout(r,40));check('${kind} history shows missing dependency details',detail.textContent.includes('${kind === 'missing' ? leaf : flow}'));`}
      check('complete',true);`;
    launch(dir, script, openZip(file), options);
  }
}

async function preflight(base, options = {}) {
  const dir = path.join(base, 'preflight'); const local = documents('local', 99); seed(dir, local);
  const incoming = documents(); const pair = data => [['.pfm/projects.json', JSON.stringify(data.projects)], ['.pfm/workflow-runs.json', JSON.stringify(data.runs)]];
  const malformed = structuredClone(incoming); malformed.runs.runs[0].projectId = 'absent';
  const newer = structuredClone(incoming); newer.projects.schema = 2;
  const variants = [
    ['schema', pair(newer), 'E_WORKSPACE_SCHEMA'], ['crossrefs', pair(malformed), 'E_WORKSPACE_INVALID'],
    ['partial', pair(incoming).slice(0, 1), 'E_WORKSPACE_INVALID'], ['duplicate', [...pair(incoming), pair(incoming)[0]], 'E_WORKSPACE_INVALID'],
    ['capacity', pair(incoming), 'E_PROJECT_LIMIT'],
    ['entry-size', [['.pfm/projects.json', ' '.repeat(16 * 1024 * 1024 + 1)], pair(incoming)[1]], 'E_BACKUP_MANIFEST_MISMATCH']
  ];
  const queue = [];
  for (const [name, entries] of variants) { const file = path.join(base, 'invalid-' + name + '.zip'); await archive(file, [['prompts/testing/preflight.md', 'MUST-NOT-APPEAR'], ...entries]); queue.push(...openZip(file)); }
  launch(dir, `const before=JSON.stringify(await api.getWorkspace());const variants=${JSON.stringify(variants.map(([name,,code]) => [name, code]))};
    for(const [name,code] of variants){let error='';try{await api.importZip();}catch(e){error=String(e.message);}
      check(name+' rejected before partial success',error.includes(code));
      check(name+' preflight preserves all workspace data',JSON.stringify(await api.getWorkspace())===before);
      check(name+' preflight creates no content',!(await api.getMetaList()).some(item=>item.rel.includes('preflight')));
    }check('complete',true);`, queue, { observePreflight: true, ...options });
  check('capacity preflight never creates even a rolled-back content file', !fs.existsSync(path.join(dir, '__preflight-write')));
}

async function rawBytes(base, options = {}) {
  const dir = path.join(base, 'raw'); seed(dir, documents('local', 1)); const file = path.join(base, 'raw.zip');
  const rel = 'prompts/testing/raw.md'; const body = Buffer.concat([Buffer.from('---\ntitle: Raw\n---\n'), Buffer.from([0xff]), Buffer.from('\n')]);
  await archive(file, [[rel, body], ['.versions/' + rel + '/index.json', JSON.stringify({ current: { note: 'raw byte note', sha256: digest(body) } })]]);
  launch(dir, `let result;try{result=await api.importZip();}catch(error){result={ok:false};}check('raw manifest verified before decoding transforms',result.ok);check('complete',true);`, openZip(file), options);
  const index = JSON.parse(fs.readFileSync(path.join(dir, '.versions/' + rel + '/index.json'), 'utf8'));
  check('raw current note binds transformed imported bytes', index.current?.note === 'raw byte note' && index.current.sha256 === digest(fs.readFileSync(path.join(dir, rel))));
}

async function snapshot(base, options = {}) {
  const dir = path.join(base, 'snapshot'); seed(dir, documents('local', 1)); const exported = path.join(base, 'snapshot.zip');
  const single = path.join(base, 'single.md'); fs.writeFileSync(single, '---\ntitle: SingleAfterSnapshot\n---\nAFTER-SNAPSHOT');
  launch(dir, `
    const exporting=api.exportZip();
    const start=Date.now();while(window.__backupPhase!=='export'){if(Date.now()-start>8000)throw new Error('export phase timed out');await new Promise(r=>setTimeout(r,10));}
    let bodyDone=false;let projectDone=false;let singleDone=false;
    const creating=api.createFile('prompts/testing/after-snapshot.md','AFTER-SNAPSHOT').then(()=>{bodyDone=true;});
    const updating=api.projectAction('update',{id:'local_p0',revision:1,name:'AFTER-SNAPSHOT'}).then(()=>{projectDone=true;});
    const importing=api.importSingle().then(()=>{singleDone=true;});
    await Promise.race([Promise.all([creating,updating,importing]),new Promise(r=>setTimeout(r,100))]);
    check('snapshot blocks body creation',!bodyDone);
    check('snapshot blocks project updates',!projectDone);
    check('snapshot blocks single file import',!singleDone);
    window.__backupQueued=true;
    await exporting;await Promise.all([creating,updating,importing]);
    check('queued snapshot mutations finish',bodyDone&&projectDone&&singleDone);
    check('complete',true);`, [{ canceled: false, filePath: exported }, { canceled: false, filePaths: [single] }], { hook: 'export', ...options });
  const zip = await readZip(exported); const projects = JSON.parse(zip.entries.find(e => e.path === '.pfm/projects.json').content);
  check('export snapshot keeps matching body and workspace state', !zip.entries.some(e => e.path === 'prompts/testing/after-snapshot.md' || e.path.includes('SingleAfterSnapshot')) && projects.projects[0].name === 'local project 0');
}

async function dialogsOutsideGate(base, exported, options = {}) {
  const exporting = options.exporting !== false; const dir = path.join(base, 'dialogs');
  seed(dir, documents('local', exporting ? 1 : 98)); const target = path.join(base, 'dialog-export.zip');
  launch(dir, `
    let outcome='';const operation=${exporting ? 'api.exportZip()' : 'api.importZip()'}.then(result=>{outcome=result.ok?'ok':'cancel';},error=>{outcome=String(error.message);});
    let revision=3;
    for(const phase of ${JSON.stringify(exporting ? ['export-dialog'] : ['open-dialog', 'preview-dialog'])}){
      const started=Date.now();while(window.__backupPhase!==phase){if(Date.now()-started>3000)throw new Error('dialog handshake timed out');await new Promise(r=>setTimeout(r,10));}
      let completed=false;const changing=api.projectAction('create',{revision:revision++,name:phase}).then(()=>{completed=true;});
      await Promise.race([changing,new Promise(r=>setTimeout(r,700))]);
      check(phase+' permits workspace mutation',completed);window.__backupQueued=true;
      if(!completed)throw new Error('dialog held write gate');
    }
    await operation;
    check('${exporting ? 'export dialog snapshot includes completed mutation' : 'import preflight uses capacity after preview'}',${exporting ? "outcome==='ok'" : "outcome.includes('E_PROJECT_LIMIT')"});
    ${exporting ? '' : "check('preview mutations persist after capacity refusal',(await api.getWorkspace()).projects.projects.length===100);check('capacity refusal creates no imported body',!(await api.getMetaList()).some(item=>item.rel.endsWith('-1.md')));"}
    check('complete',true);`, exporting ? [{ canceled: false, filePath: target }] : openZip(exported), { hook: exporting ? 'dialog-export' : 'dialog-import', ...options });
  if (exporting) {
    const zip = await readZip(target); const projects = JSON.parse(zip.entries.find(e => e.path === '.pfm/projects.json').content);
    check('export snapshot is captured after dialog consent', projects.projects.some(project => project.name === 'export-dialog'));
  }
}

async function reverse(name, targets, run) {
  const selected = process.env.PFM_BACKUP_CONTROL;
  if (selected && !name.includes(selected)) return;
  controlFailures = []; let thrown = '';
  try { await run(); } catch (error) { thrown = String(error.message); }
  const failed = controlFailures; controlFailures = null;
  for (const target of targets) assert.ok(failed.includes(target) || thrown.includes('[workspace-backup] FAIL ' + target), 'Reverse ' + name + ' must fail target: ' + target + '\n' + thrown.slice(-1800));
  console.log('[workspace-backup] PASS reverse ' + name + ': ' + targets.join('; '));
}
const mutation = (file, from, to) => ({ file, from, to });
async function reverseControls(base, exported) {
  const folder = name => { const dir = path.join(base, 'control-' + name); fs.mkdirSync(dir, { recursive: true }); return dir; };
  const options = (...mutations) => ({ mutations });
  const main = (from, to) => mutation('electron-main.js', from, to);
  const portable = (from, to) => mutation('lib/workspace-backup.js', from, to);
  await reverse('workspace ZIP participation', ['export contains both workspace documents'], () => roundtrip(folder('zip-pair'), { source: options(main('[[workspaceBackup.PROJECTS_ENTRY, workspace.projects], [workspaceBackup.RUNS_ENTRY, workspace.runs]]', '[[workspaceBackup.RUNS_ENTRY, workspace.runs]]')) }));
  await reverse('workspace manifest participation', ['manifest hashes raw exported workspace bytes'], () => roundtrip(folder('manifest'), { source: options(mutation('lib/backup-manifest.js', 'sha256: entry.sha256', "sha256: '0'.repeat(64)")) }));
  await reverse('snapshot ownership', ['snapshot blocks body creation', 'snapshot blocks project updates', 'export snapshot keeps matching body and workspace state'], () => snapshot(folder('snapshot'), options(main('const backupFiles = await writeGate.exclusive(async () => {', 'const backupFiles = await Promise.resolve().then(async () => {'))));
  await reverse('new file gate', ['snapshot blocks body creation'], () => snapshot(folder('create'), options(main("queueWrite('ver:' + String(rel), () => createFileAt(rel, content))", 'createFileAt(rel, content)'))));
  await reverse('single import gate', ['snapshot blocks single file import'], () => snapshot(folder('single'), options(main('writeGate.shared(() => importMarkdown(path.basename(srcPath), content))', 'importMarkdown(path.basename(srcPath), content)'))));
  const round = (name, patches) => roundtrip(folder(name), { exported, ...options(...patches) });
  await reverse('incoming identities', ['all imported identities and project bindings are new'], () => round('identities', [portable('project.id = freshId();', 'project.id = original.id;')]));
  await reverse('incoming selection and reopen', ['incoming selected run follows the imported workflow copy', 'reopened imported workflow offers resume'], () => round('selection', [portable('after.runs.selectedByWorkflow[target] = runIds.get(id);', 'void 0;')]));
  await reverse('local project selection', ['current project and run selections survive'], () => round('local-selection', [portable('after.projects.revision++;', 'after.projects.activeProjectId = after.projects.projects.at(-1).id; after.projects.revision++;')]));
  await reverse('actual workflow', ['actual workflow prompt points at imported copy'], () => round('workflow', [portable("WORKFLOW_REFS.mapPromptLines(content, rel => mapped(relMap, rel.replace(/\\\\/g, '/')) || null).content", 'content')]));
  await reverse('original graph', ['both saved graphs follow the imported copy'], () => round('graphs', [portable("for (const key of ['originGraphSnapshot', 'graphSnapshot'])", "for (const key of ['graphSnapshot'])")]));
  await reverse('nested includes', ['nested includes execute imported contents'], () => round('includes', [portable('if (!replacement) continue;', 'if (true) continue;')]));
  await reverse('ordinary prose', ['unknown frontmatter and prose remain unchanged'], () => round('prose', [portable('return prefix + nextBody;', "return (prefix + nextBody).replaceAll('prompts/testing/portable.md', 'prompts/testing/portable-1.md');")]));
  await reverse('local original copies', ['local content copies remain byte identical'], () => round('local-files', [main("const full = safeJoin(rel); const content = await fsp.readFile(full, 'utf8');", "const full = safeJoin(original); const content = await fsp.readFile(full, 'utf8');")]));
  await reverse('restored counts', ['import restores project and run counts'], () => round('counts', [main('restoredProjects = portableWorkspace.projects.projects.length;', 'restoredProjects = 0;')]));
  await reverse('preview privacy', ['preview discloses workspace counts and sensitive fields'], () => round('privacy', [main("(portableWorkspace ? '\\n\\n' + mt('importWorkspacePrivacy') : '')", "''")]));
  await reverse('current note content', ['current version note hashes transformed content'], () => round('version-note', [main('sha256: contentHash(written)', 'sha256: bodyEntry.sha256')]));
  await reverse('resumed hash', ['resumed run hash matches transformed workflow'], () => round('run-hash', [main('hash: contentHash(content) }; },', "hash: 'stale-hash' }; },")]));
  await reverse('raw byte current note', ['raw current note binds transformed imported bytes'], () => rawBytes(folder('raw'), options(main('bodyEntry.sha256 === index.current.sha256', 'contentHash(bodyEntry.content) === index.current.sha256'))));
  await reverse('capacity before content writes', ['capacity preflight never creates even a rolled-back content file'], () => preflight(folder('preflight'), options(main('const preparedWorkspace = portableWorkspace ? await workspaceService.prepareImportLocked(portableWorkspace, plannedRels) : null;', 'const preparedWorkspace = null;'))));
  await reverse('missing dependency refusal', ['missing history remains available for browsing', 'missing cannot bind local names on resume', 'missing missing paths are visible', 'missing history shows missing dependency details'], () => compatibility(folder('missing'), { kinds: ['missing'], ...options(portable('run.missingDependencies = missingDependencies(original, relMap, data.contents);', 'run.missingDependencies = [];')) }));
  await reverse('empty library classification', ['empty backup succeeds', 'empty history remains available for browsing'], () => compatibility(folder('empty'), { kinds: ['empty'], ...options(mutation('lib/backup-preview.js', '(contentEntries.length > 0 || !!workspace)', '(contentEntries.length > 0)')) }));
  for (const hook of ['business', 'trash']) {
    await reverse(hook + ' exact rollback bytes', [hook + ' all transaction snapshots restore exact bytes before queued writes'], () => rollback(folder(hook + '-bytes'), exported, hook, options(mutation('lib/import-transaction.js', 'await fsp.writeFile(file, data);', 'await fsp.writeFile(file, JSON.stringify(JSON.parse(data)));'))));
    await reverse(hook + ' workspace rollback', [hook + ' rollback preserves local workspace'], () => rollback(folder(hook + '-workspace'), exported, hook, options(main('await transaction.snapshot(PROJECTS_PATH);', 'void 0;'))));
  }
  await reverse('queued import mutations', ['queued mutations wait for business transaction', 'business queued mutations settle successfully', 'business queued config mutation persists'], () => rollback(folder('import-gate'), exported, 'business', options(main("return writeGate.exclusive(async () => {\n  const configEntry", "return Promise.resolve().then(async () => {\n  const configEntry"))));
  await reverse('body rollback', ['business rollback removes imported body cache', 'business renderer refresh removes transient imported tree'], () => rollback(folder('body-rollback'), exported, 'business', options(mutation('lib/import-transaction.js', 'for (const file of [...files].reverse())', 'for (const file of [])'))));
  await reverse('renderer rollback notification', ['business renderer refresh removes transient imported tree'], () => rollback(folder('notification'), exported, 'business', options(main("if (win && !win.isDestroyed()) win.webContents.send('library-changed', { changes: imported.map(rel => ({ rel, type: 'removed' })).slice(0, LIBRARY_CHANGE_MAX), truncated: imported.length > LIBRARY_CHANGE_MAX });", 'void 0;'))));
}

(async () => {
  const base = temp('integration');
  try {
    await snapshot(base); const exported = await roundtrip(base);
    await rollback(base, exported, 'business'); await rollback(base, exported, 'trash');
    await compatibility(base); await preflight(base); await rawBytes(base);
    await dialogsOutsideGate(path.join(base, 'export-dialog'), exported);
    await dialogsOutsideGate(path.join(base, 'import-dialog'), exported, { exporting: false });
    await reverseControls(base, exported);
  }
  finally { fs.rmSync(base, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
