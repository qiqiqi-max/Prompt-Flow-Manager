// tests/layout-small.test.js
// 在应用允许的最小窗口尺寸下检查主要按钮没有超出窗口或被状态栏遮挡。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronBin = require(path.join(root, 'node_modules', 'electron'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-layout-small-'));
const shot = path.join(os.tmpdir(), 'pfm-layout-small.png');
const rel = 'prompts/testing/small-layout-with-a-long-title.md';
fs.mkdirSync(path.join(dataDir, 'prompts', 'testing'), { recursive: true });
fs.writeFileSync(path.join(dataDir, rel), '---\ntitle: Small Layout With A Very Long Prompt Title For Overflow Checks\n---\nbody', 'utf8');
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ lang: 'zh', theme: 'light', windowBounds: { width: 800, height: 500 } }), 'utf8');

const script = `
  (async () => {
    await openFile(${JSON.stringify(rel)});
    await enterEditMode();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    };
    const ids = ['btn-new-prompt', 'btn-new-workflow', 'btn-composer', 'btn-import', 'btn-new-folder',
      'btn-export', 'btn-trash', 'btn-settings', 'btn-theme', 'btn-copy', 'btn-export-single', 'btn-edit',
      'btn-history', 'btn-rename', 'btn-move', 'btn-delete', 'btn-save', 'btn-cancel'];
    const hidden = ids.filter(id => !visible($(id)));
    const wrappedText = ids.filter(id => {
      const el = $(id);
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18;
      return el.getBoundingClientRect().height > lineHeight * 1.8;
    });
    const status = $('status-bar').getBoundingClientRect();
    const save = $('btn-save').getBoundingClientRect();
    const cancel = $('btn-cancel').getBoundingClientRect();
    const overflowX = document.documentElement.scrollWidth > innerWidth;
    const editorHeight = $('editor').getBoundingClientRect().height;
    const unnamed = [...ids, 'btn-filter-toggle'].filter(id => !($(id).getAttribute('aria-label') || $(id).textContent.trim()));
    const ok = hidden.length === 0 && wrappedText.length === 0 && unnamed.length === 0 && editorHeight >= 140
      && save.bottom <= status.top && cancel.bottom <= status.top && !overflowX;
    console.log(ok ? '[layout-small] PASS 最小窗口下主要按钮都可见'
      : '[layout-small] FAIL ' + JSON.stringify({ size: [innerWidth, innerHeight], hidden, wrappedText, unnamed, editorHeight, save: save.bottom, status: status.top, overflowX }));
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
let out = '';
child.stdout.on('data', d => { out += d; process.stdout.write(d); });
child.stderr.on('data', d => { out += d; process.stderr.write(d); });
const timer = setTimeout(() => child.kill(), 60000);
child.on('exit', code => {
  clearTimeout(timer);
  fs.rmSync(dataDir, { recursive: true, force: true });
  const passed = code === 0 && /\[layout-small\] PASS/.test(out) && !/\[layout-small\] FAIL/.test(out);
  console.log(passed ? '[test:layout-small] 通过' : '[test:layout-small] 失败');
  console.log('[test:layout-small] 截图: ' + shot);
  process.exit(passed ? 0 : 1);
});
