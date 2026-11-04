(async () => {
  let failures = 0;
  const check = (condition, message) => {
    if (condition) console.log('[workspace-restart] PASS ' + message);
    else { failures++; console.error('[workspace-restart] FAIL ' + message); }
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
  const projectDoc = state.workspace.projects;
  const a = projectDoc.projects.find(project => project.name === 'Restart A');
  const b = projectDoc.projects.find(project => project.name === 'Restart B');
  check(a && b && projectDoc.activeProjectId === b.id && $('workspace-project').value === b.id,
    'new process restores selected project in UI');
  const before = JSON.stringify((await window.promptFlowApi.getWorkspace()).runs);
  await openFile('workflows/restart.md');
  const runs = state.workspace.runs.runs;
  const runA = runs.find(run => run.name === 'Restart run A');
  const runB = runs.find(run => run.name === 'Restart run B');
  check(runA && runB && runs.length === 2 && $('workspace-run').value === runA.id
    && state.workspace.runs.selectedByWorkflow['workflows/restart.md'] === runA.id
    && runA.projectId === a.id && runB.projectId === b.id
    && runA.progress.current === 'b' && JSON.stringify(runA.progress.done) === '["a"]'
    && runB.progress.current === 'c' && JSON.stringify(runB.progress.done) === '["a","b"]',
  'new process restores selected run and independent progress');
  const fill = async () => {
    $('btn-copy').click();
    await waitFor(() => !!$('fill-ok'), 'new process opens ordinary fill form');
  };
  await openFile('prompts/testing/restart.md');
  await fill();
  check($('fill-in-0').value === 'Restart B' && $('fill-in-1').value === 'B memory',
    'new process prefills selected project fields and memory');
  $('ctx-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  if (pendingPromptDone) pendingPromptDone(null);
  $('workspace-project').value = a.id;
  $('workspace-project').dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  await fill();
  check($('fill-in-0').value === 'Restart A' && $('fill-in-1').value === 'A memory',
    'new process keeps other project prefill independent');
  if (pendingPromptDone) pendingPromptDone(null);
  $('workspace-project').value = b.id;
  $('workspace-project').dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  await openFile('workflows/restart.md');
  const button = action => document.querySelector('#flow-run button[data-run-act="' + action + '"]');
  button('resume').click();
  await waitFor(() => !!document.querySelector('.flow-node[data-id="b"].run-current'), 'new process resumes first saved step');
  button('copy').click();
  await waitFor(() => !!$('fill-ok'), 'new process opens first run fill form');
  check($('workspace-project').value === b.id && $('fill-in-0').value === 'Restart A'
    && $('fill-in-1').value === 'A run value'
    && document.querySelector('[data-run-context]').textContent.includes('Restart A'),
  'new process prefills first run snapshot and own values');
  if (pendingPromptDone) pendingPromptDone(null);
  $('workspace-run').value = runB.id;
  $('workspace-run').dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  button('resume').click();
  await waitFor(() => !!document.querySelector('.flow-node[data-id="c"].run-current'), 'new process resumes other saved step');
  button('copy').click();
  await waitFor(() => !!$('fill-ok'), 'new process opens second run fill form');
  check($('fill-in-0').value === 'Restart B' && $('fill-in-1').value === 'B run value',
    'new process prefills second run independently');
  if (pendingPromptDone) pendingPromptDone(null);
  await settle();
  const afterRuns = (await window.promptFlowApi.getWorkspace()).runs.runs;
  const originalRuns = JSON.parse(before).runs;
  check(afterRuns.every(run => JSON.stringify(run.progress) === JSON.stringify(originalRuns.find(saved => saved.id === run.id).progress)),
    'restore and cancelled fill keep both saved progress records');
  if (failures) throw new Error('[workspace-restart] FAIL restore assertions: ' + failures);
  console.log('[workspace-restart] PASS restore complete');
})()
