'use strict';
const { validators, createWorkspaceFile } = require('./workspace-data');

function createRunStore(options) {
  const validate = validators(options.appError);
  const empty = () => ({ schema: 1, revision: 0, legacyImported: false, selectedByWorkflow: {}, runs: [] });
  const storage = createWorkspaceFile(options, validate.runs, empty);
  return { read() { return storage.read(); }, write(document) { return storage.write(document); } };
}

module.exports = { createRunStore };
