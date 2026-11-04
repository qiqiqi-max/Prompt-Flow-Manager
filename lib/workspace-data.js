'use strict';

const fs = require('node:fs');
const path = require('node:path');
const MAX_BYTES = 16 * 1024 * 1024;
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);
const PROJECT_FIELDS = ['name', 'description', 'stack', 'path', 'constraints'];
const defaultError = (code, detail) => Object.assign(new Error(code + (detail ? '|' + detail : '')), { code });
const object = raw => !!raw && typeof raw === 'object' && !Array.isArray(raw);
const own = (raw, key) => Object.prototype.hasOwnProperty.call(raw, key);

function validators(appError = defaultError) {
  const fail = appError;
  const invalid = detail => { throw fail('E_WORKSPACE_INVALID', detail); };
  function safeKeys(raw, seen = new Set()) {
    if (!raw || typeof raw !== 'object') return;
    if (seen.has(raw)) invalid('cyclic data');
    seen.add(raw);
    for (const key of Object.keys(raw)) {
      if (DANGEROUS.has(key)) invalid('unsafe key');
      safeKeys(raw[key], seen);
    }
    seen.delete(raw);
  }
  function text(value, { max = 500, required = false } = {}) {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid('text');
  }
  function revision(value) { if (!Number.isSafeInteger(value) || value < 0) invalid('revision'); }
  function timestamp(value) { if (!Number.isSafeInteger(value) || value < 0) invalid('timestamp'); }
  function id(value) { text(value, { required: true }); if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid('id'); }
  function values(raw) {
    if (!object(raw) || Object.keys(raw).length > 200) invalid('values count');
    safeKeys(raw);
    for (const [key, value] of Object.entries(raw)) {
      text(key, { required: true });
      if (typeof value !== 'string' || value.length > 20000) invalid('value length');
    }
  }
  function fields(raw, partial = false, context = false) {
    if (!object(raw)) invalid('fields');
    safeKeys(raw);
    for (const field of PROJECT_FIELDS) {
      if (partial && !own(raw, field)) continue;
      if (field === 'name' && !context) text(raw[field], { max: 200, required: true });
      else if (field === 'name') text(raw[field], { max: 200 });
      else text(raw[field], { max: 20000 });
    }
  }
  function relative(value, directory) {
    text(value, { required: true });
    const parts = value.split('/');
    const directories = Array.isArray(directory) ? directory : [directory];
    if (parts.some(part => !part || part === '.' || part === '..') || /[\\:\0]/.test(value)
      || !directories.some(root => value.startsWith(root + '/')) || !/\.md$/i.test(value)) invalid('relative path');
  }
  function graph(graph) {
    if (!Array.isArray(graph) || graph.length > 500) invalid('graph size');
    const ids = new Set();
    for (const step of graph) {
      if (!object(step)) invalid('step');
      text(step.id, { required: true });
      if (ids.has(step.id)) invalid('duplicate step');
      ids.add(step.id);
      text(step.prompt);
      if (step.prompt) relative(step.prompt, ['prompts', 'templates', 'workflows']);
      text(step.label, { max: 20000 });
      if (!Array.isArray(step.next) || step.next.length > 500) invalid('next');
      for (const next of step.next) text(next, { required: true });
    }
  }
  function progress(raw) {
    if (!object(raw) || raw.v !== 1) invalid('progress');
    if (raw.current !== null) text(raw.current, { required: true });
    const settled = new Set();
    for (const kind of ['done', 'skipped', 'history']) {
      if (!Array.isArray(raw[kind]) || raw[kind].length > 500 || new Set(raw[kind]).size !== raw[kind].length) invalid('progress steps');
      for (const step of raw[kind]) {
        text(step, { required: true });
        if (kind !== 'history') { if (settled.has(step)) invalid('overlapping progress'); settled.add(step); }
      }
    }
    values(raw.values); timestamp(raw.updatedAt);
  }
  function common(document) {
    if (!object(document)) invalid('document');
    if (document.schema !== 1) throw fail('E_WORKSPACE_SCHEMA', String(document.schema));
    safeKeys(document); revision(document.revision);
  }
  function projects(document) {
    common(document);
    if (!Array.isArray(document.projects)) invalid('projects');
    if (document.projects.length > 100) throw fail('E_PROJECT_LIMIT', '100');
    const ids = new Set();
    for (const project of document.projects) {
      if (!object(project)) invalid('project');
      id(project.id); if (ids.has(project.id)) invalid('duplicate project'); ids.add(project.id);
      fields(project); values(project.values); revision(project.revision); timestamp(project.createdAt); timestamp(project.updatedAt);
    }
    if (document.activeProjectId !== null && !ids.has(document.activeProjectId)) invalid('active project');
    return document;
  }
  function runs(document) {
    common(document);
    if (!Array.isArray(document.runs) || !object(document.selectedByWorkflow) || typeof document.legacyImported !== 'boolean') invalid('runs');
    if (document.runs.length > 1000) throw fail('E_RUN_LIMIT', '1000');
    const byId = new Map();
    for (const run of document.runs) {
      if (!object(run)) invalid('run');
      id(run.id); if (byId.has(run.id)) invalid('duplicate run'); byId.set(run.id, run);
      relative(run.workflowRel, 'workflows'); text(run.name, { max: 200, required: true });
      if (run.projectId !== null) id(run.projectId);
      fields(run.contextSnapshot, false, true); values(run.contextSnapshot.values);
      graph(run.originGraphSnapshot); graph(run.graphSnapshot); progress(run.progress);
      revision(run.revision); timestamp(run.createdAt); timestamp(run.updatedAt);
      if (run.completedAt !== null) timestamp(run.completedAt);
      if (!['available', 'missing', 'moved', 'unresolved'].includes(run.availability)) invalid('availability');
      if (own(run, 'missingDependencies')) {
        if (!Array.isArray(run.missingDependencies) || run.missingDependencies.length > 5000) invalid('missing dependencies');
        for (const dependency of run.missingDependencies) text(dependency, { max: 20000, required: true });
      }
    }
    for (const [rel, runId] of Object.entries(document.selectedByWorkflow)) {
      relative(rel, 'workflows'); const run = byId.get(runId);
      if (!run || run.workflowRel !== rel) invalid('selected run');
    }
    return document;
  }
  return { projects, runs, fields, values, relative, graph, progress, revision, id };
}

function createWorkspaceFile({ file, writeFileAtomic, appError = defaultError, fsp = fs.promises, now = Date.now }, validate, empty) {
  const fail = appError;
  const absolute = path.resolve(file);
  async function checkLinks() {
    let target = absolute; let fileStat = null;
    while (true) {
      try {
        const stat = await fsp.lstat(target);
        if (stat.isSymbolicLink() || (target === absolute && stat.nlink > 1)) throw fail('E_WORKSPACE_LINK', target);
        if (target === absolute) {
          if (!stat.isFile()) throw fail('E_WORKSPACE_INVALID', 'business file');
          fileStat = stat;
        } else if (!stat.isDirectory()) throw fail('E_WORKSPACE_INVALID', 'parent directory');
      } catch (error) {
        if (error.code === 'ENOENT') { /* Missing store is valid, linked ancestors still are not. */ }
        else if (/^E_WORKSPACE_/.test(error.code || error.message)) throw error;
        else throw fail('E_WORKSPACE_READ', error.message);
      }
      const parent = path.dirname(target);
      if (parent === target) break;
      target = parent;
    }
    return fileStat;
  }
  async function preserve() {
    const stamp = now();
    for (let attempt = 0; attempt < 100; attempt++) {
      const backup = file + '.corrupt-' + stamp + (attempt ? '-' + attempt : '');
      try {
        await fsp.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
        throw fail('E_WORKSPACE_RECOVERY', backup);
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        if (/^E_WORKSPACE_RECOVERY[|$]/.test(error.message) || error.code === 'E_WORKSPACE_RECOVERY') throw error;
        throw fail('E_WORKSPACE_RECOVERY_FAILED', backup);
      }
    }
    throw fail('E_WORKSPACE_RECOVERY_FAILED', file);
  }
  async function read() {
    const stat = await checkLinks();
    if (!stat) return empty();
    if (stat.size > MAX_BYTES) throw fail('E_WORKSPACE_SIZE', file);
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); }
    catch (error) { throw fail('E_WORKSPACE_READ', error.message); }
    if (Buffer.byteLength(raw) > MAX_BYTES) throw fail('E_WORKSPACE_SIZE', file);
    let document;
    try { document = JSON.parse(raw); }
    catch { return preserve(); }
    try { return validate(document); }
    catch (error) {
      if (error.code === 'E_WORKSPACE_SCHEMA' || /^E_WORKSPACE_SCHEMA[|$]/.test(error.message)) throw error;
      return preserve();
    }
  }
  async function write(document) {
    validate(document);
    let raw;
    try { raw = JSON.stringify(document, null, 2) + '\n'; }
    catch { throw fail('E_WORKSPACE_INVALID', 'encoding'); }
    if (Buffer.byteLength(raw) > MAX_BYTES) throw fail('E_WORKSPACE_SIZE', file);
    // Re-read existing evidence before every write; no successful state is cached before atomic replacement.
    await read();
    await checkLinks();
    try { await writeFileAtomic(file, raw); }
    catch (error) { throw fail('E_WORKSPACE_WRITE', error.message); }
    return document;
  }
  return { read, write };
}

module.exports = { MAX_BYTES, PROJECT_FIELDS, defaultError, validators, createWorkspaceFile,
  validateProjectsDocument: (document, appError) => validators(appError).projects(document),
  validateRunsDocument: (document, appError) => validators(appError).runs(document) };
