'use strict';

const fields = { name: 'Portable project', description: 'A project', stack: 'Node', path: 'D:/private/project', constraints: 'Private constraints' };
const flow = 'workflows/portable.md';
const prompt = 'prompts/testing/portable.md';
const template = 'templates/portable.md';
const leaf = 'templates/leaf.md';
const bodies = [
  [flow, '---\ntitle: Portable workflow\ncustom: prompts/testing/portable.md\nflow:\n  - id: a\n    prompt: prompts/testing/portable.md\n    label: prompts/testing/portable.md\n    next: [b]\n  - id: b\n    prompt: prompts/testing/portable.md\n---\nWorkflow prose prompts/testing/portable.md\n'],
  [prompt, '---\ntitle: Portable prompt\ncustom: "{{include: templates/portable.md}}"\n---\nPACKAGE-PROMPT\n{{include: templates/portable.md}}\n'],
  [template, '---\ntitle: Portable template\n---\nPACKAGE-TEMPLATE\n{{include: templates/leaf.md}}\n'],
  [leaf, '---\ntitle: Portable leaf\n---\nPACKAGE-LEAF\n']
];
const clone = value => JSON.parse(JSON.stringify(value));
function documents(prefix = 'incoming', count = 2) {
  const projects = Array.from({ length: count }, (_, i) => ({ ...fields, id: prefix + '_p' + i, name: prefix + ' project ' + i, values: { '{{shared}}': prefix + ' project value ' + i }, revision: 1, createdAt: 1, updatedAt: 2 }));
  const graph = [{ id: 'a', prompt, label: prompt, next: ['b'] }, { id: 'b', prompt, label: '', next: [] }];
  const runs = projects.map((project, i) => ({ id: prefix + '_r' + i, workflowRel: flow, name: prefix + ' run ' + i, projectId: project.id,
    contextSnapshot: { ...fields, name: project.name, values: clone(project.values) }, originGraphSnapshot: clone(graph), graphSnapshot: clone(graph),
    progress: { v: 1, current: 'b', done: ['a'], skipped: [], history: ['a'], values: { '{{shared}}': prefix + ' run value ' + i }, updatedAt: 2 },
    revision: 1, createdAt: 1, updatedAt: 2, completedAt: null, availability: 'available' }));
  return { projects: { schema: 1, revision: 3, activeProjectId: projects[0]?.id || null, projects },
    runs: { schema: 1, revision: 4, legacyImported: true, selectedByWorkflow: runs.length ? { [flow]: runs[1]?.id || runs[0].id } : {}, runs } };
}
const relMap = () => new Map(bodies.map(([rel]) => [rel, rel.replace(/\.md$/, '-1.md')]));
module.exports = { documents, fields, flow, prompt, template, leaf, bodies, relMap, clone };
