// tests/save-conflict.test.js
// 真实 Electron：编辑期间磁盘文件被修改时，保存不能静默覆盖。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronBin = require(path.join(root, 'node_modules', 'electron'));
const REL = 'prompts/testing/save-conflict.md';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-save-conflict-'));
fs.mkdirSync(path.join(dataDir, 'prompts', 'testing'), { recursive: true });
fs.writeFileSync(path.join(dataDir, REL), '---\ntitle: Save Conflict\n---\noriginal', 'utf8');
const queue = path.join(dataDir, '__dialogs.json');
fs.writeFileSync(queue, JSON.stringify([{ kind: 'message', response: 2 }, { kind: 'message', response: 0 }]));

const script = `
  (async () => {
    await openFile(${JSON.stringify(REL)});
    await enterEditMode();
    $('editor').value = $('editor').value.replace('original', 'mine');
    $('editor').dispatchEvent(new Event('input'));
    const disk = await api.readFile(${JSON.stringify(REL)});
    await api.saveFile(${JSON.stringify(REL)}, disk.content.replace('original', 'theirs'));
    const canceled = await saveCurrent();
    const afterCancel = await api.readFile(${JSON.stringify(REL)});
    const forced = await saveCurrent();
    const afterForce = await api.readFile(${JSON.stringify(REL)});
    const versions = await api.listVersions(${JSON.stringify(REL)});
    const ok = canceled === false && state.editMode && afterCancel.content.includes('theirs')
      && forced === true && afterForce.content.includes('mine') && versions.length >= 2;
    console.log(ok ? '[save-conflict] PASS 编辑冲突时取消不覆盖，确认后覆盖并保留历史'
      : '[save-conflict] FAIL ' + JSON.stringify({ canceled, forced, afterCancel: afterCancel.content, afterForce: afterForce.content, versions: versions.length }));
  })()`;

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
child.on('exit', code => {
  clearTimeout(timer);
  fs.rmSync(dataDir, { recursive: true, force: true });
  const passed = code === 0 && /\[save-conflict\] PASS/.test(out) && !/\[save-conflict\] FAIL/.test(out);
  console.log(passed ? '[test:save-conflict] 通过' : '[test:save-conflict] 失败');
  process.exit(passed ? 0 : 1);
});
