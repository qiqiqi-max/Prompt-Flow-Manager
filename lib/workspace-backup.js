'use strict';

const { randomUUID } = require('node:crypto');
const { validators, defaultError, MAX_BYTES } = require('./workspace-data');
const WORKFLOW_REFS = require('../src/workflow-refs');
const FLOW_GRAPH = require('../src/flow-graph');
const INCLUDES = require('../src/includes');

const PROJECTS_ENTRY = '.pfm/projects.json';
const RUNS_ENTRY = '.pfm/workflow-runs.json';
const isWorkspaceEntry = name => name === PROJECTS_ENTRY || name === RUNS_ENTRY;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const copy = value => JSON.parse(JSON.stringify(value));
const mapped = (map, rel) => map instanceof Map ? map.get(rel) : own(map, rel) ? map[rel] : undefined;

function validatePortable(data) {
  if (!data || !data.projects || !data.runs) throw defaultError('E_WORKSPACE_INVALID', 'workspace pair');
  const validate = validators();
  validate.projects(data.projects);
  validate.runs(data.runs);
  const ids = new Set(data.projects.projects.map(project => project.id));
  for (const run of data.runs.runs) {
    if (run.projectId !== null && !ids.has(run.projectId)) throw defaultError('E_WORKSPACE_INVALID', 'project reference');
  }
  for (const key of ['projects', 'runs']) {
    if (Buffer.byteLength(JSON.stringify(data[key], null, 2) + '\n') > MAX_BYTES) throw defaultError('E_WORKSPACE_SIZE', key);
  }
  return data;
}

// Neither entry is the old format; a partial or repeated pair is never a partial success.
function readPortableEntries(entries, skipped = []) {
  const workspace = entries.filter(entry => isWorkspaceEntry(entry.path));
  if (!workspace.length && !skipped.some(entry => isWorkspaceEntry(entry.name))) return null;
  if (skipped.length) throw defaultError('E_WORKSPACE_SIZE', skipped.map(entry => entry.name).slice(0, 5).join(', '));
  if (workspace.length !== 2 || workspace.filter(entry => entry.path === PROJECTS_ENTRY).length !== 1
      || workspace.filter(entry => entry.path === RUNS_ENTRY).length !== 1) throw defaultError('E_WORKSPACE_INVALID', 'workspace pair');
  const data = {};
  for (const entry of workspace) {
    if (Buffer.byteLength(entry.content) > MAX_BYTES) throw defaultError('E_WORKSPACE_SIZE', entry.path);
    try { data[entry.path === PROJECTS_ENTRY ? 'projects' : 'runs'] = JSON.parse(entry.content); }
    catch { throw defaultError('E_WORKSPACE_INVALID', entry.path); }
  }
  validatePortable(data);
  data.contents = new Map(entries.filter(entry => /^(prompts|workflows|templates)\/.+\.md$/i.test(entry.path)).map(entry => [entry.path, entry.content]));
  return data;
}

function remapImportedContent(content, relMap) {
  const rewritten = WORKFLOW_REFS.mapPromptLines(content, rel => mapped(relMap, rel) || null).content;
  // Includes in frontmatter are metadata. Only the body is expanded when a prompt is copied.
  const body = INCLUDES.stripFrontmatter(rewritten);
  const prefix = rewritten.slice(0, rewritten.length - body.length);
  let nextBody = body;
  for (const item of INCLUDES.extract(body).reverse()) {
    const replacement = item.valid && mapped(relMap, item.rel);
    if (!replacement) continue;
    const instruction = item.raw.replace(/^(\{\{include:\s*)([\s\S]*?)(\s*\}\})$/, (_, head, value, tail) => head + replacement + tail);
    nextBody = nextBody.slice(0, item.index) + instruction + nextBody.slice(item.index + item.length);
  }
  return prefix + nextBody;
}

function missingDependencies(run, relMap, contents) {
  // An imported unresolved history cannot become executable merely because a later package has the same names.
  const missing = new Set(run.missingDependencies || []);
  const pending = [run.workflowRel, ...run.originGraphSnapshot.map(step => step.prompt), ...run.graphSnapshot.map(step => step.prompt)].filter(Boolean);
  const seen = new Set();
  for (let i = 0; i < pending.length; i++) {
    const rel = pending[i];
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!mapped(relMap, rel)) { missing.add(rel); continue; }
    if (!contents || !contents.has(rel)) continue;
    const content = contents.get(rel);
    if (rel === run.workflowRel) for (const step of FLOW_GRAPH.parseSteps(content)) if (step.prompt) pending.push(step.prompt);
    for (const include of INCLUDES.extract(INCLUDES.stripFrontmatter(content))) {
      if (include.valid) pending.push(include.rel);
      else missing.add(include.raw);
    }
  }
  return [...missing].sort();
}

function prepareImport(current, data, relMap, newId = randomUUID) {
  validatePortable(current);
  validatePortable(data);
  const after = { projects: copy(current.projects), runs: copy(current.runs) };
  const projectIds = new Map(); const runIds = new Map();
  const usedIds = new Set([current, data].flatMap(value => value.projects.projects.concat(value.runs.runs).map(item => item.id)));
  function freshId() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = newId(); validators().id(id);
      if (usedIds.has(id)) continue;
      usedIds.add(id); return id;
    }
    throw defaultError('E_WORKSPACE_INVALID', 'new identity');
  }
  for (const original of data.projects.projects) {
    const project = copy(original); project.id = freshId(); project.revision = 1;
    projectIds.set(original.id, project.id); after.projects.projects.push(project);
  }
  for (const original of data.runs.runs) {
    const run = copy(original); run.id = freshId(); run.revision = 1;
    runIds.set(original.id, run.id);
    run.projectId = projectIds.get(run.projectId) || null;
    run.missingDependencies = missingDependencies(original, relMap, data.contents);
    run.workflowRel = mapped(relMap, run.workflowRel) || run.workflowRel;
    for (const key of ['originGraphSnapshot', 'graphSnapshot']) for (const step of run[key]) {
      if (step.prompt) step.prompt = mapped(relMap, step.prompt) || step.prompt;
    }
    run.availability = run.missingDependencies.length ? 'unresolved' : original.availability;
    after.runs.runs.push(run);
  }
  for (const [rel, id] of Object.entries(data.runs.selectedByWorkflow)) {
    const target = mapped(relMap, rel);
    if (target && !own(after.runs.selectedByWorkflow, target)) after.runs.selectedByWorkflow[target] = runIds.get(id);
  }
  after.projects.revision++; after.runs.revision++;
  validatePortable(after);
  return after;
}

module.exports = { PROJECTS_ENTRY, RUNS_ENTRY, isWorkspaceEntry, validatePortable, readPortableEntries, remapImportedContent, prepareImport };
