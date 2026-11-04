// The two Electron processes share only files in a temporary data directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-workspace-restart-'));
const electron = require('electron');
const mustHave = {
  setup: ['setup creates two projects through controls', 'setup remembers values independently',
    'project remembering disables selection before IPC settles', 'setup flushes selected project and distinct runs', 'setup complete'],
  restore: ['new process restores selected project in UI', 'new process prefills selected project fields and memory',
    'new process keeps other project prefill independent', 'new process restores selected run and independent progress',
    'new process prefills first run snapshot and own values', 'new process prefills second run independently',
    'restore and cancelled fill keep both saved progress records', 'restore complete']
};
fs.mkdirSync(path.join(dataDir, 'prompts/testing'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'workflows'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'prompts/testing/restart.md'), '---\ntitle: Restart prompt\n---\n[Project name] [custom=default]');
fs.writeFileSync(path.join(dataDir, 'workflows/restart.md'), [
  '---', 'title: Restart flow', 'flow:',
  '  - id: a', '    prompt: prompts/testing/restart.md', '    next: b',
  '  - id: b', '    prompt: prompts/testing/restart.md', '    next: c',
  '  - id: c', '    prompt: prompts/testing/restart.md', '---', 'Flow'
].join('\n'));

function run(phase) {
  return new Promise(resolve => {
    const child = spawn(electron, [root], {
      cwd: root,
      env: { ...process.env, PFM_DATA_DIR: dataDir, PFM_SELFTEST: '1', PFM_UPDATE_CHECK: 'off', ELECTRON_ENABLE_LOGGING: '1',
        PFM_SELFTEST_EVAL: fs.readFileSync(path.join(root, 'src/selftest/workspace-restart-' + phase + '.js'), 'utf8') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let finished = false;
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const missing = mustHave[phase].filter(message => !output.includes('[workspace-restart] PASS ' + message));
      if (missing.length) output += '\n[workspace-restart] FAIL missing evidence: ' + missing.join(', ');
      resolve({ passed: code === 0 && missing.length === 0 && !output.includes('FAIL'), output });
    };
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => {
      output += '\n[workspace-restart] FAIL ' + phase + ' timeout';
      child.kill();
      finish(1);
    }, 60000);
    child.on('error', error => { output += '\n[workspace-restart] FAIL ' + error.stack; finish(1); });
    child.on('exit', finish);
  });
}

(async () => {
  try {
    for (const phase of ['setup', 'restore']) {
      const result = await run(phase);
      process.stdout.write(result.output);
      if (!result.passed) {
        process.exitCode = 1;
        return;
      }
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error('[workspace-restart] FAIL ' + error.stack); process.exitCode = 1; });
