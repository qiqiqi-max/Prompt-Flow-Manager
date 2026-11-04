(async () => {
  const check = (condition, message, detail = '') => {
    if (!condition) throw new Error('[workspace-restart] FAIL ' + message + (detail ? ': ' + detail : ''));
    console.log('[workspace-restart] PASS ' + message);
  };
  const waitFor = async (condition, message) => {
    const until = Date.now() + 5000;
    while (!condition() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    if (!condition()) throw new Error('[workspace-restart] FAIL ' + message);
  };
  const settle = async () => {
    await window.__pfmFlushPending();
    await new Promise(resolve => setTimeout(resolve, 40));
  };
  const selectProject = async id => {
    $('workspace-project').value = id;
    $('workspace-project').dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await waitFor(() => state.workspace.projects.activeProjectId === id && !state.workspaceBusy, 'setup selects project through UI');
  };
  const createProject = async (name, description) => {
    $('workspace-manage').click();
    $('project-new').click();
    $('project-name').value = name;
    $('project-description').value = description;
    $('project-save').click();
    await settle();
    $('workspace-close').click();
    return state.workspace.projects.projects.find(project => project.name === name);
  };
  const button = action => document.querySelector('#flow-run button[data-run-act="' + action + '"]');
  const current = id => !!document.querySelector('#preview .flow-node[data-id="' + id + '"].run-current');
  const copyForm = async (trigger, value) => {
    if (!trigger) throw new Error('[workspace-restart] FAIL missing copy selector: #btn-copy or #flow-run [data-run-act="copy"]');
    await waitFor(() => !trigger.disabled, 'setup copy button becomes ready');
    const run = trigger.dataset.runAct ? selectedWorkspaceRun() : null;
    const projectId = state.workspace.projects.activeProjectId;
    trigger.click();
    await waitFor(() => !!$('fill-ok'), 'setup opens real fill form');
    $('fill-in-1').value = value;
    $('fill-in-1').dispatchEvent(new Event('input', { bubbles: true }));
    $('fill-ok').click();
    await waitFor(() => run
      ? state.workspace.runs.runs.find(saved => saved.id === run.id).progress.current !== run.progress.current
      : state.workspace.projects.projects.find(project => project.id === projectId).values['[custom=default]'] === value,
    run ? 'setup settles run copy before next action' : 'setup persists project copy before switching');
    await settle();
  };
  const createRun = async (name, projectId) => {
    if (button('exit')) button('exit').click();
    const start = button('start') || button('restart');
    if (!start) throw new Error('[workspace-restart] FAIL missing new run selector: #flow-run [data-run-act="start"], #flow-run [data-run-act="restart"]');
    start.click();
    await waitFor(() => !!$('run-save'), 'setup opens run creation dialog');
    $('run-name').value = name;
    $('run-project').value = projectId;
    $('run-save').click();
    await settle();
    return selectedWorkspaceRun();
  };
  const originalWrite = navigator.clipboard.writeText;
  navigator.clipboard.writeText = async () => {};
  try {
    const a = await createProject('Restart A', 'Description A');
    const b = await createProject('Restart B', 'Description B');
    check(!!a && !!b && a.id !== b.id, 'setup creates two projects through controls');
    await openFile('prompts/testing/restart.md');
    await selectProject(a.id);
    await copyForm($('btn-copy'), 'A memory');
    const remembered = state.workspace.projects.projects.find(project => project.id === a.id);
    const saving = workspaceProjectAction('remember', { id: a.id, revision: remembered.revision, values: { '[custom=default]': 'A memory' } });
    check(state.workspaceBusy > 0 && $('workspace-project').disabled, 'project remembering disables selection before IPC settles');
    await saving;
    await selectProject(b.id);
    await copyForm($('btn-copy'), 'B memory');
    check(state.workspace.projects.projects.find(project => project.id === a.id).values['[custom=default]'] === 'A memory'
      && state.workspace.projects.projects.find(project => project.id === b.id).values['[custom=default]'] === 'B memory',
    'setup remembers values independently', JSON.stringify(state.workspace.projects.projects.map(project => ({ name: project.name, values: project.values }))));
    await openFile('workflows/restart.md');
    const runA = await createRun('Restart run A', a.id);
    await copyForm(button('copy'), 'A run value');
    await waitFor(() => current('b'), 'setup advances first run to b');
    const runB = await createRun('Restart run B', b.id);
    await copyForm(button('copy'), 'B run value');
    await waitFor(() => current('b'), 'setup advances second run to b');
    await copyForm(button('copy'), 'B run value');
    await waitFor(() => current('c'), 'setup advances second run independently to c');
    $('workspace-run').value = runA.id;
    $('workspace-run').dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await selectProject(b.id);
    await openFile('prompts/testing/restart.md');
    await settle();
    const workspace = await window.promptFlowApi.getWorkspace();
    const savedA = workspace.runs.runs.find(run => run.id === runA.id);
    const savedB = workspace.runs.runs.find(run => run.id === runB.id);
    check(workspace.projects.activeProjectId === b.id
      && workspace.runs.selectedByWorkflow['workflows/restart.md'] === runA.id
      && savedA.progress.current === 'b' && savedB.progress.current === 'c',
    'setup flushes selected project and distinct runs');
    console.log('[workspace-restart] PASS setup complete');
  } finally {
    navigator.clipboard.writeText = originalWrite;
    if (pendingPromptDone) pendingPromptDone(null);
  }
})()
