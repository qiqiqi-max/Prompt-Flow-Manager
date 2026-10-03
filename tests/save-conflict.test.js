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
fs.writeFileSync(queue, JSON.stringify([]));

const script = `
  (async () => {
    await openFile(${JSON.stringify(REL)});
    await enterEditMode();
    $('editor').value = $('editor').value.replace('original', 'mine');
    $('editor').dispatchEvent(new Event('input'));
    const disk = await api.readFile(${JSON.stringify(REL)});
    await api.saveFile(${JSON.stringify(REL)}, disk.content.replace('original', 'theirs'));
    const waitConflict = async () => {
      for (let i = 0; i < 50; i++) {
        if (!$('conflict-modal').classList.contains('hidden')) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('conflict modal did not open');
    };
    const canceledPromise = saveCurrent();
    await waitConflict();
    const contentRect = $('content-area').getBoundingClientRect();
    const statusRect = $('status-bar').getBoundingClientRect();
    const saveRect = $('btn-save').getBoundingClientRect();
    const editorActionsVisible = saveRect.bottom <= statusRect.top && saveRect.top >= contentRect.top;
    const diffText = $('conflict-diff').textContent;
    const hasDiff = diffText.includes('theirs') && diffText.includes('mine');
    const modalRect = $('conflict-modal').querySelector('.conflict-dialog').getBoundingClientRect();
    const fitsViewport = modalRect.left >= 0 && modalRect.top >= 0
      && modalRect.right <= innerWidth && modalRect.bottom <= innerHeight;
    const firstFocus = document.activeElement && document.activeElement.id;
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    const shiftTabFocus = document.activeElement && document.activeElement.id;
    $('btn-conflict-overwrite').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    const wrapFocus = document.activeElement && document.activeElement.id;
    const focusTrapped = firstFocus === 'btn-conflict-cancel'
      && shiftTabFocus === 'btn-conflict-overwrite'
      && wrapFocus === 'btn-conflict-cancel';
    $('btn-conflict-cancel').click();
    const canceled = await canceledPromise;
    const afterCancel = await api.readFile(${JSON.stringify(REL)});
    const forcedPromise = saveCurrent();
    await waitConflict();
    $('btn-conflict-overwrite').click();
    const forced = await forcedPromise;
    const afterForce = await api.readFile(${JSON.stringify(REL)});
    const versions = await api.listVersions(${JSON.stringify(REL)});
    const ok = hasDiff && fitsViewport && focusTrapped && editorActionsVisible && canceled === false && state.editMode && afterCancel.content.includes('theirs')
      && forced === true && afterForce.content.includes('mine') && versions.length >= 2;
    console.log(ok ? '[save-conflict] PASS 编辑冲突时取消不覆盖，确认后覆盖并保留历史'
      : '[save-conflict] FAIL ' + JSON.stringify({ hasDiff, fitsViewport, focusTrapped, editorActionsVisible, firstFocus, shiftTabFocus, wrapFocus, diffText, canceled, forced, afterCancel: afterCancel.content, afterForce: afterForce.content, versions: versions.length }));
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
