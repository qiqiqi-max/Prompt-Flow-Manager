'use strict';

const { randomUUID } = require('node:crypto');
const { PROJECT_FIELDS, defaultError, validators, createWorkspaceFile } = require('./workspace-data');

function createProjectStore(options) {
  const { appError = defaultError, now = Date.now, newId = randomUUID } = options;
  const validate = validators(appError);
  const empty = () => ({ schema: 1, revision: 0, activeProjectId: null, projects: [] });
  const storage = createWorkspaceFile(options, validate.projects, empty);
  function lookup(document, id, revision) {
    validate.id(id); validate.revision(revision);
    const project = document.projects.find(project => project.id === id);
    if (!project) throw appError('E_PROJECT_NOT_FOUND', String(id));
    if (project.revision !== revision) throw appError('E_PROJECT_CONFLICT', String(id));
    return project;
  }
  async function save(document) { document.revision++; return storage.write(document); }
  async function create(fields) {
    const normalized = Object.fromEntries(PROJECT_FIELDS.map(field => [field, fields && fields[field] === undefined && field !== 'name' ? '' : fields && fields[field]]));
    validate.fields(fields, true); validate.fields(normalized);
    const document = await storage.read(); const stamp = now();
    document.projects.push({ id: newId(), ...normalized, values: {}, createdAt: stamp, updatedAt: stamp, revision: 1 });
    return save(document);
  }
  async function update(id, revision, fields) {
    validate.fields(fields, true);
    const document = await storage.read(); const project = lookup(document, id, revision);
    for (const field of PROJECT_FIELDS) if (Object.prototype.hasOwnProperty.call(fields, field)) project[field] = fields[field];
    project.revision++; project.updatedAt = now();
    return save(document);
  }
  async function duplicate(id, revision) {
    const document = await storage.read(); const project = lookup(document, id, revision); const stamp = now();
    document.projects.push({ ...project, id: newId(), values: { ...project.values }, revision: 1, createdAt: stamp, updatedAt: stamp });
    return save(document);
  }
  async function select(id, revision) {
    validate.revision(revision);
    if (id !== null) validate.id(id);
    const document = await storage.read();
    if (document.revision !== revision) throw appError('E_PROJECT_CONFLICT', String(id));
    if (id !== null && !document.projects.some(project => project.id === id)) throw appError('E_PROJECT_NOT_FOUND', String(id));
    document.activeProjectId = id;
    return save(document);
  }
  async function remove(id, revision) {
    const document = await storage.read(); lookup(document, id, revision);
    document.projects = document.projects.filter(project => project.id !== id);
    if (document.activeProjectId === id) document.activeProjectId = null;
    return save(document);
  }
  async function remember(id, revision, values) {
    validate.values(values);
    const document = await storage.read(); const project = lookup(document, id, revision);
    project.values = { ...project.values, ...values }; project.revision++; project.updatedAt = now();
    return save(document);
  }
  return { ...storage, create, update, duplicate, select, remove, remember };
}

module.exports = { createProjectStore };
