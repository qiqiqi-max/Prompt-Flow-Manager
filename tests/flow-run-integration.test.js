// 真实启动两次 Electron：防止只合入状态机，却漏掉界面、配置落盘或与其他功能的接线。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronBin = require(path.join(root, 'node_modules', 'electron'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-flow-integration-'));
const workflow = 'workflows/run.md';
const prompt = 'prompts/testing/run.md';
fs.mkdirSync(path.join(dataDir, 'workflows'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'prompts/testing'), { recursive: true });
fs.writeFileSync(path.join(dataDir, prompt), '---\ntitle: Run prompt\n---\nBuild [项目] in [语言=Go|Python|Go].\n');
fs.writeFileSync(path.join(dataDir, workflow), [
  '---', 'title: Run integration', 'flow:',
  '  - id: first', '    prompt: ' + prompt, '    next: second',
  '  - id: second', '    prompt: ' + prompt, '---', 'Workflow'
].join('\n'));

const helpers = `
  const check = (condition, message) => {
    if (!condition) throw new Error('[flow-integration] FAIL ' + message);
    console.log('[flow-integration] PASS ' + message);
  };
  const waitFor = async (condition, message) => {
    const end = Date.now() + 5000;
    while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
    check(condition(), message);
  };
  const button = act => document.querySelector('#flow-run button[data-run-act="' + act + '"]');
  const current = id => !!document.querySelector('#preview .flow-node[data-id="' + id + '"].run-current');
`;

function run(body) {
  return new Promise(resolve => {
    const child = spawn(electronBin, [root], {
      cwd: root,
      env: { ...process.env, PFM_DATA_DIR: dataDir, PFM_SELFTEST: '1', PFM_UPDATE_CHECK: 'off', ELECTRON_ENABLE_LOGGING: '1',
        PFM_SELFTEST_EVAL: '(async () => {' + helpers + body + '})()' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => { output += '\n[flow-integration] FAIL timeout'; child.kill(); }, 60000);
    child.on('error', error => { clearTimeout(timer); resolve({ passed: false, output: String(error) }); });
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ passed: code === 0 && output.includes('[flow-integration] PASS phase complete') && !output.includes('FAIL'), output });
    });
  });
}

(async () => {
  try {
    const first = await run(`
      await openFile(${JSON.stringify(workflow)});
      check(!!button('start'), 'workflow exposes start action');
      button('start').click();
      await waitFor(() => current('first'), 'start highlights first step');
      let copied = '';
      const originalWrite = navigator.clipboard.writeText;
      navigator.clipboard.writeText = async text => { copied = text; };
      try {
        button('copy').click();
        await waitFor(() => !!document.getElementById('fill-ok'), 'step opens placeholder form');
        check(document.getElementById('fill-in-1').value === 'Go', 'step preserves placeholder defaults');
        document.getElementById('fill-in-0').value = 'demo';
        document.getElementById('fill-ok').click();
        await waitFor(() => current('second'), 'successful copy advances step');
        check(copied.trim() === 'Build demo in Go.', 'step copies resolved body');
        const usage = await window.promptFlowApi.getUsage();
        check(usage.frequent.some(item => item.rel === ${JSON.stringify(prompt)} && item.count === 1), 'step counts prompt usage once');
        check(!usage.frequent.some(item => item.rel === ${JSON.stringify(workflow)}), 'step does not count workflow as prompt');
        await window.__pfmFlushPending();
        const saved = ((await window.promptFlowApi.getConfig()).flowRuns || {})[${JSON.stringify(workflow)}];
        check(saved && saved.current === 'second' && JSON.stringify(saved.done) === '["first"]', 'flush persists current step');
        await openFile(${JSON.stringify(prompt)});
        state.previewFills[${JSON.stringify(prompt)}] = { '[项目]': 'inline' };
        await copyContent();
        check(copied.trim() === 'Build inline in Go.', 'main copy retains inline values and defaults');
        check((await window.promptFlowApi.getUsage()).frequent.some(item => item.rel === ${JSON.stringify(prompt)} && item.count === 2), 'main copy counts usage once');
      } finally { navigator.clipboard.writeText = originalWrite; }
      const movedWorkflow = 'workflows/moved.md';
      await window.promptFlowApi.createFile(movedWorkflow, (await window.promptFlowApi.readFile(${JSON.stringify(workflow)})).content);
      await refreshTree();
      await openFile(movedWorkflow);
      button('start').click();
      await waitFor(() => current('first'), 'separate workflow starts independently');
      await moveFileToDir(movedWorkflow, 'prompts/testing');
      await window.__pfmFlushPending();
      check(!state.flowRuns[movedWorkflow], 'moving out of workflows clears in-memory run');
      check(!(await window.promptFlowApi.getConfig()).flowRuns[movedWorkflow], 'moving out of workflows clears persisted run');
      await window.promptFlowApi.createFile('workflows/multiple.md', [
        '---', 'title: Multiple entries', 'flow:', '  - id: a', '    next: c',
        '  - id: b', '    next: c', '  - id: c', '---', 'Multiple entries'
      ].join('\\n'));
      await refreshTree();
      await openFile('workflows/multiple.md');
      button('start').click();
      await waitFor(() => document.querySelectorAll('#flow-run button[data-run-act="choose"]').length === 2, 'multiple entries offer both starting steps');
      await window.__pfmFlushPending();
      console.log('[flow-integration] PASS phase complete');
    `);
    console.log(first.output.split('\n').filter(line => /flow-integration|FAIL/.test(line)).join('\n'));
    if (!first.passed) { console.error(first.output.slice(-2500)); process.exitCode = 1; return; }
    const second = await run(`
      await openFile(${JSON.stringify(workflow)});
      check(!!button('resume') && !button('start'), 'new process offers resume');
      button('resume').click();
      await waitFor(() => current('second'), 'new process resumes second step');
      check(!!document.querySelector('.flow-node[data-id="first"].run-done'), 'new process retains completed step');
      state.fillMemory = {};
      button('copy').click();
      await waitFor(() => !!document.getElementById('fill-ok'), 'resumed step opens placeholder form');
      check(document.getElementById('fill-in-0').value === 'demo', 'run values survive restart independently of fill memory');
      pendingPromptDone(null);
      await new Promise(resolve => setTimeout(resolve, 50));
      check(current('second'), 'cancel keeps current step');
      check((await window.promptFlowApi.getUsage()).frequent.some(item => item.rel === ${JSON.stringify(prompt)} && item.count === 2), 'cancel does not increment usage');
      const removed = await window.promptFlowApi.batchTrash([${JSON.stringify(workflow)}]);
      await closeTrashedTabs(removed.ok.map(item => item.rel));
      await window.__pfmFlushPending();
      check(!state.flowRuns[${JSON.stringify(workflow)}], 'batch deletion clears in-memory run');
      check(!(await window.promptFlowApi.getConfig()).flowRuns[${JSON.stringify(workflow)}], 'flush does not restore deleted run');
      await openFile('workflows/multiple.md');
      check(!!button('resume'), 'multiple-entry choice survives restart');
      button('resume').click();
      document.querySelector('#flow-run button[data-run-id="b"]').click();
      await waitFor(() => current('b'), 'resumed multiple-entry workflow can select its start');
      console.log('[flow-integration] PASS phase complete');
    `);
    console.log(second.output.split('\n').filter(line => /flow-integration|FAIL/.test(line)).join('\n'));
    if (!second.passed) { console.error(second.output.slice(-2500)); process.exitCode = 1; }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
