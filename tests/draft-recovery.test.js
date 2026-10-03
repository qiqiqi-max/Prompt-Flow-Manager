// tests/draft-recovery.test.js
// 真实 Electron：编辑后不保存直接退出，再次启动时可以恢复草稿。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronBin = require(path.join(root, 'node_modules', 'electron'));
const REL = 'prompts/testing/draft-recovery.md';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-draft-recovery-'));
fs.mkdirSync(path.join(dataDir, 'prompts', 'testing'), { recursive: true });
fs.writeFileSync(path.join(dataDir, REL), '---\ntitle: Draft Recovery\n---\noriginal', 'utf8');

function run(script, dialogs) {
  const queue = path.join(dataDir, '__dialogs-' + Date.now() + '.json');
  fs.writeFileSync(queue, JSON.stringify(dialogs || []));
  return new Promise((resolve) => {
    const child = spawn(electronBin, [root], {
      cwd: root,
      env: {
        ...process.env,
        PFM_SELFTEST: '1',
        PFM_DATA_DIR: dataDir,
        PFM_SELFTEST_DIALOGS: queue,
        PFM_SELFTEST_EVAL: script,
        ELECTRON_ENABLE_LOGGING: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(d); });
    child.stderr.on('data', d => { out += d; process.stderr.write(d); });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

(async () => {
  const first = await run(`
    (async () => {
      await openFile(${JSON.stringify(REL)});
      await enterEditMode();
      $('editor').value = $('editor').value.replace('original', 'recover me');
      $('editor').dispatchEvent(new Event('input'));
      await saveDraftDebounced.flush();
      console.log('[draft-recovery] PASS 草稿已保存');
    })()`);
  const disk = fs.readFileSync(path.join(dataDir, REL), 'utf8');
  const second = await run(`
    (async () => {
      await openFile(${JSON.stringify(REL)});
      const ok = state.editMode && $('editor').value.includes('recover me') && isDirty();
      console.log(ok ? '[draft-recovery] PASS 再次打开时恢复草稿' : '[draft-recovery] FAIL ' + JSON.stringify({ edit: state.editMode, value: $('editor').value }));
    })()`, [{ kind: 'message', response: 1 }]);
  fs.rmSync(dataDir, { recursive: true, force: true });
  const checks = [
    ['第一次启动保存了草稿', first.code === 0 && /\[draft-recovery\] PASS 草稿已保存/.test(first.out)],
    ['未保存草稿不会写入正文', disk.includes('original') && !disk.includes('recover me')],
    ['第二次启动可以恢复草稿', second.code === 0 && /\[draft-recovery\] PASS 再次打开时恢复草稿/.test(second.out)]
  ];
  let passed = true;
  for (const [name, ok] of checks) {
    console.log('[test:draft-recovery] ' + (ok ? 'PASS ' : 'FAIL ') + name);
    if (!ok) passed = false;
  }
  console.log('[test:draft-recovery] ' + (passed ? '通过' : '失败'));
  process.exit(passed ? 0 : 1);
})();
