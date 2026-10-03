// 生成保存冲突窗口截图，用于人工检查主题和布局。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronBin = require(path.join(root, 'node_modules', 'electron'));
const theme = process.argv[2] === 'dark' ? 'dark' : 'light';
const shot = path.resolve(process.argv[3] || path.join(os.tmpdir(), `pfm-conflict-${theme}.png`));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-conflict-shot-'));
const rel = 'prompts/testing/conflict-shot.md';
fs.mkdirSync(path.join(dataDir, 'prompts', 'testing'), { recursive: true });
fs.writeFileSync(path.join(dataDir, rel), '---\ntitle: Conflict Screenshot\n---\n# Release notes\n\nOriginal paragraph.\n\n- shared item\n- old item\n', 'utf8');
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ theme, lang: 'zh', windowBounds: { width: 1180, height: 760 } }), 'utf8');

const script = `
  (async () => {
    await openFile(${JSON.stringify(rel)});
    await enterEditMode();
    $('editor').value = $('editor').value.replace('Original paragraph.', 'My edited paragraph.').replace('- old item', '- my new item');
    $('editor').dispatchEvent(new Event('input'));
    const disk = await api.readFile(${JSON.stringify(rel)});
    await api.saveFile(${JSON.stringify(rel)}, disk.content.replace('Original paragraph.', 'Their latest paragraph.').replace('- old item', '- their new item'));
    window.__pfmConflictShotSave = saveCurrent();
    for (let i = 0; i < 50 && $('conflict-modal').classList.contains('hidden'); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if ($('conflict-modal').classList.contains('hidden')) throw new Error('conflict modal did not open');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`;

const child = spawn(electronBin, [root], {
  cwd: root,
  env: {
    ...process.env,
    PFM_SELFTEST: '1',
    PFM_DATA_DIR: dataDir,
    PFM_SELFTEST_EVAL: script,
    PFM_SELFTEST_SHOT: shot,
    ELECTRON_ENABLE_LOGGING: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('exit', code => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(shot);
  process.exit(code || (fs.existsSync(shot) ? 0 : 1));
});
