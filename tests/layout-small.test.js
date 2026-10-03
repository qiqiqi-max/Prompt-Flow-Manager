// tests/layout-small.test.js
// 在应用允许的最小窗口尺寸下检查主要按钮没有超出窗口或被状态栏遮挡。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronBin = require(path.join(root, 'node_modules', 'electron'));
const cases = [
  { lang: 'zh', theme: 'light', zoom: 1 },
  { lang: 'en', theme: 'light', zoom: 1 },
  { lang: 'zh', theme: 'dark', zoom: 1 },
  { lang: 'en', theme: 'dark', zoom: 1 },
  { lang: 'zh', theme: 'light', zoom: 1.25 },
  { lang: 'en', theme: 'light', zoom: 1.25 },
  { lang: 'zh', theme: 'light', zoom: 1.5 },
  { lang: 'en', theme: 'light', zoom: 1.5 }
];
const rel = 'prompts/testing/small-layout-with-a-long-title.md';

function makeDataDir(c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-layout-small-'));
  fs.mkdirSync(path.join(dir, 'prompts', 'testing'), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), '---\ntitle: Small Layout With A Very Long Prompt Title For Overflow Checks\n---\nbody', 'utf8');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ lang: c.lang, theme: c.theme, windowBounds: { width: 800, height: 500 } }), 'utf8');
  return dir;
}
function scriptFor(c) {
  return `
  (async () => {
    await openFile(${JSON.stringify(rel)});
    await enterEditMode();
    await new Promise(resolve => setTimeout(resolve, 50));
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight) return true;
      const scroller = el.closest('.content-actions');
      if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return false;
      const box = scroller.getBoundingClientRect();
      const reachableX = el.offsetLeft >= 0 && el.offsetLeft + el.offsetWidth <= scroller.scrollWidth;
      return r.width > 0 && r.height > 0 && reachableX
        && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
        && r.top >= box.top && r.bottom <= box.bottom;
    };
    const ids = ['btn-new-prompt', 'btn-new-workflow', 'btn-composer', 'btn-import', 'btn-new-folder',
      'btn-export', 'btn-trash', 'btn-settings', 'btn-theme', 'btn-copy', 'btn-export-single', 'btn-edit',
      'btn-history', 'btn-rename', 'btn-move', 'btn-delete', 'btn-save', 'btn-cancel'];
    const responsiveIds = innerWidth <= 680 ? ids.filter(id => !['btn-history', 'btn-rename', 'btn-move', 'btn-delete'].includes(id)).concat('btn-content-more') : ids;
    const hidden = responsiveIds.filter(id => !visible($(id)));
    let menuItems = 0;
    if (innerWidth <= 680) {
      $('btn-content-more').click();
      menuItems = $('ctx-menu').querySelectorAll('[role=\"menuitem\"]').length;
      hideCtxMenu();
    }
    const actions = $('btn-copy').closest('.content-actions').getBoundingClientRect();
    const wrappedText = responsiveIds.filter(id => {
      const el = $(id);
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18;
      return el.getBoundingClientRect().height > lineHeight * 1.8;
    });
    const status = $('status-bar').getBoundingClientRect();
    const save = $('btn-save').getBoundingClientRect();
    const cancel = $('btn-cancel').getBoundingClientRect();
    const overflowX = document.documentElement.scrollWidth > innerWidth;
    const editorHeight = $('editor').getBoundingClientRect().height;
    const unnamed = [...responsiveIds, 'btn-filter-toggle'].filter(id => !($(id).getAttribute('aria-label') || $(id).textContent.trim()));
    const ok = (innerWidth > 680 || menuItems === 4) && hidden.length === 0 && wrappedText.length === 0 && unnamed.length === 0 && editorHeight >= ${c.zoom > 1.3 ? 70 : c.zoom > 1 ? 100 : 140}
      && save.bottom <= status.top && cancel.bottom <= status.top && !overflowX;
    console.log(ok ? '[layout-small] PASS 最小窗口下主要按钮都可见'
      : '[layout-small] FAIL ' + JSON.stringify({ zoom: ${c.zoom}, size: [innerWidth, innerHeight], actions: [actions.left, actions.right], hidden, menuItems, wrappedText, unnamed, editorHeight, save: save.bottom, status: status.top, overflowX }));
  })()`;
}

function runOnce(c) {
  const dataDir = makeDataDir(c);
  const shot = path.join(os.tmpdir(), 'pfm-layout-small-' + c.lang + '-' + c.theme + '-' + String(c.zoom).replace('.', '') + '.png');
  return new Promise((resolve) => {
    const child = spawn(electronBin, [root], {
      cwd: root,
      env: {
        ...process.env,
        PFM_SELFTEST: '1',
        PFM_DATA_DIR: dataDir,
        PFM_SELFTEST_EVAL: scriptFor(c),
        PFM_SELFTEST_ZOOM: String(c.zoom),
        PFM_SELFTEST_SHOT: shot,
        ELECTRON_ENABLE_LOGGING: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(d); });
    child.stderr.on('data', d => { out += d; process.stderr.write(d); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
    child.on('exit', code => {
      clearTimeout(timer);
      fs.rmSync(dataDir, { recursive: true, force: true });
      const passed = code === 0 && /\[layout-small\] PASS/.test(out) && !/\[layout-small\] FAIL/.test(out);
      console.log('[test:layout-small] ' + (passed ? 'PASS ' : 'FAIL ') + c.lang + ' / ' + c.theme + ' / ' + Math.round(c.zoom * 100) + '%'
        + (passed ? '' : ' exit=' + code + (timedOut ? ' timeout' : '')) + ' 截图: ' + shot);
      resolve({ passed, timedOut, code });
    });
  });
}

async function run(c) {
  return (await runOnce(c)).passed;
}

(async () => {
  const only = process.env.PFM_LAYOUT_CASE;
  const selected = only ? cases.filter(c => [c.lang, c.theme, c.zoom].join('-') === only) : cases;
  const results = [];
  for (const c of selected) results.push(await run(c));
  const passed = results.every(Boolean);
  console.log(passed ? '[test:layout-small] 通过' : '[test:layout-small] 失败');
  process.exit(passed ? 0 : 1);
})();
