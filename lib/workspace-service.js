'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { validators, defaultError, PROJECT_FIELDS } = require('./workspace-data');
const FLOW_GRAPH = require('../src/flow-graph');
const FLOW_RUN = require('../src/flow-run');
const PROJECT_CONTEXT = require('../src/project-context');
const copy = raw => JSON.parse(JSON.stringify(raw));
const own = (raw, key) => Object.prototype.hasOwnProperty.call(raw, key);

function createWorkspaceService({ projects, runs, queue, loadConfig, readWorkflow, appError = defaultError, now = Date.now, newId = randomUUID, notify = () => {} }) {
  const validate = validators(appError); let initialized = false;
  function payloadCheck(payload, allowed) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !allowed.includes(key))) throw appError('E_WORKSPACE_INVALID', 'payload');
    validate.revision(payload.revision);
  }
  async function readDocuments() { const [p, r] = await Promise.all([projects.read(), runs.read()]); return { projects: p, runs: r, warnings: [] }; }
  async function changed(extra = {}) { const state = { ...await readDocuments(), ...extra }; try { notify(state); } catch { /* Notification cannot revoke a durable write. */ } return state; }
  async function workflowAt(rel) {
    validate.relative(rel, 'workflows'); const workflow = await readWorkflow(rel);
    if (!workflow || typeof workflow.hash !== 'string' || !workflow.hash) throw appError('E_WORKSPACE_INVALID', 'workflow hash');
    const steps = workflow.steps.map(step => ({ id: step.id, prompt: step.prompt || '', label: step.label || '', next: step.next || [] }));
    validate.graph(steps);
    if (!steps.length) throw appError('E_RUN_EMPTY_GRAPH', rel);
    return { steps, hash: workflow.hash };
  }
  const graphEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function serializeProgress(progress, values = progress.values) { return { ...FLOW_RUN.serialize(progress, now()), values: copy(values) }; }
  function result(run, workflow) { return { runId: run.id, workflowRel: run.workflowRel, workflowHash: workflow ? workflow.hash : null, runStatus: FLOW_RUN.status(FLOW_GRAPH.analyze(run.graphSnapshot), run.progress) }; }
  async function initializeLocked() {
    // Both documents must be readable before migration becomes live; migration itself is one run-file replacement.
    const state = await readDocuments(); if (state.runs.legacyImported) { initialized = true; return state; }
    const config = await loadConfig(); const document = state.runs;
    const legacy = config.flowRuns && typeof config.flowRuns === 'object' && !Array.isArray(config.flowRuns) ? config.flowRuns : {};
    for (const rel of Object.keys(legacy).sort()) {
      try { validate.relative(rel, 'workflows'); } catch { continue; }
      const id = 'legacy_' + createHash('sha256').update(rel).digest('hex').slice(0, 32);
      if (document.runs.some(run => run.id === id)) continue;
      const raw = legacy[rel]; if (!raw || raw.v !== 1) continue;
      let workflow = null;
      try { workflow = await workflowAt(rel); } catch (error) { if (error.code !== 'ENOENT' && !/^E_NOT_FOUND[|$]/.test(error.message)) throw error; }
      let progress;
      if (workflow) { progress = FLOW_RUN.restore(FLOW_GRAPH.analyze(workflow.steps), raw); if (!progress) continue; progress.values = PROJECT_CONTEXT.cleanValues(raw.values); }
      else { progress = { v: 1, current: raw.current == null ? null : raw.current, done: raw.done, skipped: raw.skipped, history: raw.history, values: PROJECT_CONTEXT.cleanValues(raw.values), updatedAt: Number.isSafeInteger(raw.updatedAt) && raw.updatedAt >= 0 ? raw.updatedAt : 0 }; try { validate.progress(progress); } catch { continue; } }
      const stamp = now(); const graph = workflow ? workflow.steps : [];
      document.runs.push({ id, workflowRel: rel, name: rel.slice('workflows/'.length, -3).slice(0, 200) || 'Legacy', projectId: null, contextSnapshot: PROJECT_CONTEXT.snapshot(null, config.fillMemory), originGraphSnapshot: copy(graph), graphSnapshot: copy(graph), progress: serializeProgress(progress), revision: 1, createdAt: stamp, updatedAt: stamp, completedAt: workflow && FLOW_RUN.status(FLOW_GRAPH.analyze(graph), progress).mode === 'finished' ? stamp : null, availability: workflow ? 'available' : 'missing' });
      if (workflow && !own(document.selectedByWorkflow, rel)) document.selectedByWorkflow[rel] = id;
    }
    const migrated = { ...document, revision: document.revision + 1, legacyImported: true };
    await runs.write(migrated); initialized = true; return changed();
  }
  async function readyLocked() { if (!initialized) await initializeLocked(); }
  const initialize = () => queue.run(['workspace', 'config'], initializeLocked);
  const getState = () => queue.run(['workspace', 'config'], async () => { await readyLocked(); return readDocuments(); });
  function projectAction(action, payload) {
    return queue.run(['workspace', 'config'], async () => {
      await readyLocked(); payloadCheck(payload, ['id', 'revision', ...PROJECT_FIELDS, 'values']);
      const document = await projects.read();
      const fields = Object.fromEntries(PROJECT_FIELDS.filter(field => own(payload, field)).map(field => [field, payload[field]]));
      if (action === 'create') { if (document.revision !== payload.revision) throw appError('E_PROJECT_CONFLICT', 'document'); await projects.create(fields); }
      else if (action === 'select') await projects.select(payload.id, payload.revision);
      else if (action === 'update') await projects.update(payload.id, payload.revision, fields);
      else if (action === 'duplicate') await projects.duplicate(payload.id, payload.revision);
      else if (action === 'remember') await projects.remember(payload.id, payload.revision, payload.values);
      else if (action === 'remove') {
        validate.id(payload.id); const runDocument = await runs.read();
        if (runDocument.runs.some(run => run.projectId === payload.id)) throw appError('E_PROJECT_BOUND', payload.id);
        await projects.remove(payload.id, payload.revision);
      } else throw appError('E_WORKSPACE_INVALID', 'project action');
      return changed();
    });
  }
  function runAction(action, payload) {
    // Reserve the workflow version key before entering shared, so rename/save cannot interleave with settlement.
    // Existing runs require a read to discover their rel; workspace then rechecks their identity and rel under the reservation.
    return runActionReserved(action, payload);
  }
  async function runActionReserved(action, payload) {
    payloadCheck(payload, ['id', 'revision', 'workflowRel', 'name', 'projectId', 'values', 'workflowHash', 'confirmGraphUpdate', 'stepId']);
    let rel = payload.workflowRel;
    if (action !== 'create') { validate.id(payload.id); const document = await runs.read(); const existing = document.runs.find(run => run.id === payload.id); if (!existing) throw appError('E_RUN_NOT_FOUND', payload.id); rel = existing.workflowRel; }
    validate.relative(rel, 'workflows');
    return queue.run(['ver:' + rel, 'workspace', 'config'], async () => {
      await readyLocked(); const document = await runs.read(); let run; let workflow = null;
      if (action === 'create') {
        if (document.revision !== payload.revision) throw appError('E_RUN_CONFLICT', 'document');
        const projectDocument = await projects.read(); const projectId = own(payload, 'projectId') ? payload.projectId : projectDocument.activeProjectId;
        if (projectId !== null) validate.id(projectId);
        const bound = projectId === null ? null : projectDocument.projects.find(project => project.id === projectId);
        if (projectId !== null && !bound) throw appError('E_PROJECT_NOT_FOUND', projectId);
        workflow = await workflowAt(rel); const config = await loadConfig(); const stamp = now();
        run = { id: newId(), workflowRel: rel, name: payload.name, projectId, contextSnapshot: PROJECT_CONTEXT.snapshot(bound, config.fillMemory), originGraphSnapshot: copy(workflow.steps), graphSnapshot: copy(workflow.steps), progress: serializeProgress(FLOW_RUN.start(FLOW_GRAPH.analyze(workflow.steps))), revision: 1, createdAt: stamp, updatedAt: stamp, completedAt: null, availability: 'available' };
        document.runs.push(run); document.selectedByWorkflow[rel] = run.id;
      } else {
        run = document.runs.find(candidate => candidate.id === payload.id);
        if (!run) throw appError('E_RUN_NOT_FOUND', payload.id);
        if (run.workflowRel !== rel) throw appError('E_RUN_CONFLICT', payload.id);
        if (action === 'select') {
          if (document.revision !== payload.revision) throw appError('E_RUN_CONFLICT', payload.id);
          document.selectedByWorkflow[run.workflowRel] = run.id;
          // Selection browses saved history, including missing workflows; it never repairs progress.
          try { workflow = await readWorkflow(rel); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        } else {
          if (run.revision !== payload.revision) throw appError('E_RUN_CONFLICT', payload.id);
          if (action === 'detach') { run.projectId = null; }
          else if (action === 'remove') {
            document.runs = document.runs.filter(candidate => candidate.id !== run.id);
            if (document.selectedByWorkflow[run.workflowRel] === run.id) {
              delete document.selectedByWorkflow[run.workflowRel];
              const replacement = document.runs.filter(candidate => candidate.workflowRel === rel && candidate.availability === 'available').sort((a, b) => b.updatedAt - a.updatedAt)[0];
              if (replacement) document.selectedByWorkflow[run.workflowRel] = replacement.id;
            }
          } else {
            if (run.availability === 'unresolved' || (action !== 'resume' && run.availability !== 'available')) throw appError('E_RUN_UNAVAILABLE', rel);
            workflow = await workflowAt(rel);
            if ((action === 'complete' || payload.confirmGraphUpdate === true) && payload.workflowHash !== workflow.hash) throw appError('E_RUN_WORKFLOW_CHANGED', rel);
            if (!graphEqual(run.graphSnapshot, workflow.steps)) {
              if (action !== 'resume' || payload.confirmGraphUpdate !== true) throw appError('E_RUN_GRAPH_CHANGED', rel);
              run.graphSnapshot = workflow.steps;
              const values = run.progress.values;
              run.progress = serializeProgress(FLOW_RUN.restore(FLOW_GRAPH.analyze(workflow.steps), run.progress) || FLOW_RUN.start(FLOW_GRAPH.analyze(workflow.steps)), values);
            }
            const graph = FLOW_GRAPH.analyze(run.graphSnapshot);
            if (action === 'resume') { run.availability = 'available'; document.selectedByWorkflow[rel] = run.id; }
            else {
              if (document.selectedByWorkflow[rel] !== run.id) throw appError('E_RUN_CONFLICT', run.id);
              let progress;
              if (action === 'complete') { if (!run.progress.current) throw appError('E_RUN_ACTION', action); validate.values(payload.values); progress = FLOW_RUN.complete(graph, run.progress); progress = { ...progress, values: { ...run.progress.values, ...payload.values } }; validate.values(progress.values); }
              else if (action === 'skip') progress = FLOW_RUN.skip(graph, run.progress);
              else if (action === 'back') progress = FLOW_RUN.back(graph, run.progress);
              else if (action === 'choose') progress = FLOW_RUN.choose(graph, run.progress, payload.stepId);
              else throw appError('E_WORKSPACE_INVALID', 'run action');
              if (progress === run.progress) throw appError('E_RUN_ACTION', action);
              run.progress = serializeProgress(progress);
            }
            run.completedAt = FLOW_RUN.status(graph, run.progress).mode === 'finished' ? (run.completedAt || now()) : null;
          }
          if (action !== 'remove') { run.revision++; run.updatedAt = now(); }
        }
      }
      document.revision++; await runs.write(document); return changed(result(run, workflow));
    });
  }
  async function relocateWorkflowLocked(oldRel, newRel) {
    if (!oldRel.startsWith('workflows/') || oldRel === newRel) return;
    await readyLocked(); const document = await runs.read(); let touched = false;
    const inside = newRel.startsWith('workflows/'); if (inside) validate.relative(newRel, 'workflows');
    // Dependency refusal must survive file lifecycle changes; resume may repair missing/moved files, never unmapped dependencies.
    for (const run of document.runs) if (run.workflowRel === oldRel) { if (inside) { run.workflowRel = newRel; } else { if (run.availability !== 'unresolved') run.availability = 'moved'; } run.revision++; run.updatedAt = now(); touched = true; }
    if (own(document.selectedByWorkflow, oldRel)) { if (inside) document.selectedByWorkflow[newRel] = document.selectedByWorkflow[oldRel]; delete document.selectedByWorkflow[oldRel]; }
    if (touched) { document.revision++; await runs.write(document); return changed(); }
  }
  async function removeWorkflowLocked(rel) {
    if (!rel.startsWith('workflows/')) return;
    await readyLocked(); const document = await runs.read(); let touched = false;
    for (const run of document.runs) if (run.workflowRel === rel) { if (run.availability !== 'unresolved') run.availability = 'missing'; run.revision++; run.updatedAt = now(); touched = true; }
    delete document.selectedByWorkflow[rel];
    if (touched) { document.revision++; await runs.write(document); return changed(); }
  }
  async function exportDataLocked() { await readyLocked(); const state = await readDocuments(); return { projects: state.projects, runs: state.runs }; }
  async function persistPairLocked(before, after) {
    await projects.write(after.projects);
    try { await runs.write(after.runs); }
    catch (error) { try { await projects.write(before.projects); } catch (rollback) { throw appError('E_WORKSPACE_ROLLBACK', 'projects.json; ' + rollback.message + '; ' + error.message); } throw error; }
  }
  async function importDataLocked(data, relMap = {}) {
    await readyLocked(); if (!data || !data.projects || !data.runs) throw appError('E_WORKSPACE_INVALID', 'import');
    validate.projects(data.projects); validate.runs(data.runs); const before = await readDocuments(); const after = copy(before); const projectIds = new Map();
    const mapped = rel => relMap instanceof Map ? relMap.get(rel) : own(relMap, rel) ? relMap[rel] : undefined;
    for (const original of data.projects.projects) { const project = copy(original); project.id = newId(); projectIds.set(original.id, project.id); project.revision = 1; after.projects.projects.push(project); }
    for (const original of data.runs.runs) {
      const run = copy(original); run.id = newId(); run.projectId = projectIds.get(run.projectId) || null; run.revision = 1;
      let unresolved = !mapped(run.workflowRel); if (mapped(run.workflowRel)) run.workflowRel = mapped(run.workflowRel);
      for (const key of ['originGraphSnapshot', 'graphSnapshot']) for (const step of run[key]) if (step.prompt) { if (mapped(step.prompt)) step.prompt = mapped(step.prompt); else unresolved = true; }
      run.availability = unresolved ? 'unresolved' : original.availability;
      after.runs.runs.push(run);
    }
    after.projects.revision++; after.runs.revision++;
    validate.projects(after.projects); validate.runs(after.runs); await persistPairLocked(before, after); return changed();
  }
  // Lifecycle/import rollback restores complete validated snapshots under the caller's existing reservation.
  async function restoreDataLocked(data) { validate.projects(data.projects); validate.runs(data.runs); const before = await readDocuments(); await persistPairLocked(before, data); initialized = data.runs.legacyImported; return changed(); }
  return { initialize, getState, projectAction, runAction, relocateWorkflowLocked, removeWorkflowLocked, exportDataLocked, importDataLocked, restoreDataLocked, invalidate() { initialized = false; } };
}
module.exports = { createWorkspaceService };
