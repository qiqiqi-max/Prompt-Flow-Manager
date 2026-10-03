// tests/close-unsaved.test.js
// 真实关窗：有未保存草稿时，取消必须留住窗口，保存必须把草稿写入磁盘。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronBin = require(path.join(root, 'node_modules', 'electron'));
const REL = 'prompts/testing/close-unsaved.md';

function makeDataDir(responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-close-unsaved-'));
  fs.mkdirSync(path.join(dir, 'prompts', 'testing'), { recursive: true });
  fs.writeFileSync(path.join(dir, REL), '---\ntitle: Close Unsaved\n---\noriginal', 'utf8');
  fs.writeFileSync(path.join(dir, '__dialogs.json'), JSON.stringify(responses.map(response => ({ kind: 'message', response }))));
  return dir;
}

function run(responses) {
  const dataDir = makeDataDir(responses);
  const script = `
    (async () => {
      await openFile(${JSON.stringify(REL)});
      await enterEditMode();
      $('editor').value = $('editor').value.replace('original', 'saved on close');
      $('editor').dispatchEvent(new Event('input'));
      window.__pfmCloseTestReady = true;
    })()`;
  return new Promise((resolve) => {
    const child = spawn(electronBin, [root], {
      cwd: root,
      env: {
        ...process.env,
        PFM_SELFTEST: '1',
        PFM_DATA_DIR: dataDir,
        PFM_SELFTEST_DIALOGS: path.join(dataDir, '__dialogs.json'),
        PFM_SELFTEST_EVAL: script,
        PFM_SELFTEST_CLOSE_UNSAVED: '1',
        ELECTRON_ENABLE_LOGGING: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { child.kill(); finish(1, out + '\n[超时]'); }, 60000);
    function finish(code, output) {
      clearTimeout(timer);
      const content = fs.readFileSync(path.join(dataDir, REL), 'utf8');
      fs.rmSync(dataDir, { recursive: true, force: true });
      resolve({ code, out: output, content });
    }
    child.on('exit', code => finish(code, out));
  });
}

(async () => {
  const canceled = await run([2, 1]);
  const saved = await run([0]);
  const checks = [
    ['关窗时取消会留住窗口', canceled.code === 0 && /\[close-unsaved\] PASS 取消后窗口仍然存在/.test(canceled.out)],
    ['取消关窗不写入草稿', canceled.content.includes('original') && !canceled.content.includes('saved on close')],
    ['关窗时选择保存会写入草稿', saved.code === 0 && saved.content.includes('saved on close')]
  ];
  let ok = true;
  for (const [name, passed] of checks) {
    console.log('[test:close-unsaved] ' + (passed ? 'PASS ' : 'FAIL ') + name);
    if (!passed) ok = false;
  }
  if (!ok) console.log(canceled.out.slice(-1200) + '\n' + saved.out.slice(-1200));
  console.log('[test:close-unsaved] ' + (ok ? '通过' : '失败'));
  process.exit(ok ? 0 : 1);
})();
