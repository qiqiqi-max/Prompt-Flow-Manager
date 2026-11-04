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
// 执行面板的夹具：分支两侧用长标签，验证"选择下一步"那排按钮在窄窗口里能折行而不是撑出横向滚动。
const wfRel = 'workflows/small-layout-run.md';
const longLabel = 'A Rather Long Step Label That Has To Wrap In The Run Panel';

function makeDataDir(c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-layout-small-'));
  fs.mkdirSync(path.join(dir, 'prompts', 'testing'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), '---\ntitle: Small Layout With A Very Long Prompt Title For Overflow Checks\n---\nbody', 'utf8');
  // 侧边栏收藏区塞满：15 条收藏、每条都有统计。收藏区没封顶的话，800x500 下
  // 它会把文件树挤到 0 高（.tree 是 flex: 1，会被让到一点不剩）。
  const favs = [];
  const items = {};
  for (let i = 0; i < 15; i++) {
    const r = 'prompts/testing/favorite-with-a-fairly-long-name-' + i + '.md';
    fs.writeFileSync(path.join(dir, r), '---\ntitle: Favorite With A Fairly Long Name ' + i + '\n---\nbody', 'utf8');
    favs.push(r);
    items[r] = { count: 15 - i, lastUsedAt: Date.now() };
  }
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ schema: 1, items, favorites: favs }), 'utf8');
  fs.writeFileSync(path.join(dir, wfRel), [
    '---', 'title: Small Layout Run', 'flow:',
    '  - id: a', '    prompt: ' + rel, '    label: ' + longLabel, '    next: [b, c]',
    '  - id: b', '    prompt: ' + rel, '    label: ' + longLabel + ' B',
    '  - id: c', '    prompt: ' + rel, '    label: ' + longLabel + ' C',
    '---', 'body', ''
  ].join('\n'), 'utf8');
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
    // 侧边栏：收藏区真的显示出来了（前提，否则下面几条在空面板上恒真），
    // 文件树仍留着至少几行的高度，收藏区和两个标签都在侧边栏里、没溢出窗口。
    const usage = $('usage-panel').getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    const tree = $('tree').getBoundingClientRect();
    const usageShown = !$('usage-panel').classList.contains('hidden') && document.querySelectorAll('#usage-list .usage-item').length >= 10;
    const tabsInside = Array.from(document.querySelectorAll('#usage-panel .usage-tab')).every(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.left >= sidebar.left - 1 && r.right <= sidebar.right + 1;
    });
    const sidebarOk = usageShown && tabsInside && tree.height >= 80
      && usage.bottom <= tree.top + 1 && usage.right <= sidebar.right + 1 && sidebar.bottom <= innerHeight + 1;
    const ok = (innerWidth > 680 || menuItems === 4) && hidden.length === 0 && wrappedText.length === 0 && unnamed.length === 0 && editorHeight >= ${c.zoom > 1.3 ? 70 : c.zoom > 1 ? 100 : 140}
      && save.bottom <= status.top && cancel.bottom <= status.top && !overflowX && sidebarOk;
    console.log(ok ? '[layout-small] PASS 最小窗口下主要按钮都可见'
      : '[layout-small] FAIL ' + JSON.stringify({ zoom: ${c.zoom}, size: [innerWidth, innerHeight], actions: [actions.left, actions.right], hidden, menuItems, wrappedText, unnamed, editorHeight, save: save.bottom, status: status.top, overflowX, sidebar: { usageShown, tabsInside, tree: tree.height, usage: [usage.top, usage.bottom], sidebar: [sidebar.top, sidebar.bottom] } }));

    // ---- 工作流执行面板：每档界面字号下，当前步骤和"选择下一步"两种状态都要放得下 ----
    // 判定：面板里每个按钮滚进视野后整块落在预览区和窗口之内；预览区和整页都没有横向溢出；
    // 主操作那排按钮里没有单个按钮被挤成多行。
    await exitEditMode(false, { skipConfirm: true });
    await openFile(${JSON.stringify(wfRel)});
    await new Promise(resolve => setTimeout(resolve, 100));
    const wrap = $('preview-wrap');
    const measure = (scale, mode) => {
      const bad = [];
      const buttons = Array.from(document.querySelectorAll('#flow-run button'));
      if (!buttons.length) bad.push('no buttons');
      for (const b of buttons) {
        b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = b.getBoundingClientRect();
        const w = wrap.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0 && r.left >= w.left - 1 && r.right <= w.right + 1 && r.top >= w.top - 1
          && r.bottom <= w.bottom + 1 && r.right <= innerWidth && r.bottom <= innerHeight)) bad.push('out:' + b.textContent);
        // 按钮是 nowrap，被挤窄时表现为文字溢出按钮框，而不是折行。
        // （不按 line-height 倍数判高度：.btn-* 没写 line-height，算出来是 normal，
        // 125% 档下单行按钮加上内边距就超过了那个阈值，判出来全是假阳性。）
        if (!b.closest('.flow-run-choices') && b.scrollWidth > b.clientWidth + 1) bad.push('clipped:' + b.textContent);
      }
      // 同一排的按钮必须等高：哪个被挤成两行，它就比同排的高出一截。
      for (const row of document.querySelectorAll('#flow-run .flow-run-actions:not(.flow-run-choices), #flow-run .flow-run-bar')) {
        const hs = Array.from(row.querySelectorAll('button')).map(b => b.getBoundingClientRect().height);
        if (hs.length && Math.max(...hs) > Math.min(...hs) * 1.5) bad.push('uneven:' + hs.map(Math.round).join('/'));
      }
      if (wrap.scrollWidth > wrap.clientWidth + 1) bad.push('wrap overflowX ' + wrap.scrollWidth + '>' + wrap.clientWidth);
      if (document.documentElement.scrollWidth > innerWidth) bad.push('page overflowX');
      return bad.length ? { scale, mode, bad } : null;
    };
    const runIssues = [];
    const origScale = state.config.fontScale;
    $('flow-run').querySelector('button[data-run-act="start"]').click();
    $('run-name').value='Layout run';
    $('run-save').click();
    for(let i=0;i<100 && !$('flow-run').querySelector('button[data-run-act="skip"]');i++) await new Promise(resolve=>setTimeout(resolve,20));
    await new Promise(resolve => setTimeout(resolve, 150));
    for (const scale of FONT_SCALES) {
      applyFontScale(scale);
      await new Promise(resolve => setTimeout(resolve, 60));
      const m = measure(scale, 'step');
      if (m) runIssues.push(m);
    }
    $('flow-run').querySelector('button[data-run-act="skip"]').click();
    await new Promise(resolve => setTimeout(resolve, 150));
    const choosing = document.querySelectorAll('#flow-run button[data-run-act="choose"]').length === 2;
    for (const scale of FONT_SCALES) {
      applyFontScale(scale);
      await new Promise(resolve => setTimeout(resolve, 60));
      const m = measure(scale, 'choose');
      if (m) runIssues.push(m);
    }
    applyFontScale(origScale);
    console.log(choosing && !runIssues.length ? '[layout-small] PASS 执行面板在各档字号下都放得下'
      : '[layout-small] FAIL 执行面板 ' + JSON.stringify({ zoom: ${c.zoom}, size: [innerWidth, innerHeight], choosing, runIssues }));
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
      // 两条 PASS 分别点名：只认"有一条 PASS"的话，执行面板那段中途抛错没打出任何一行时
      // 前一条 PASS 照样让这个用例绿。
      const passed = code === 0 && /\[layout-small\] PASS 最小窗口下主要按钮都可见/.test(out)
        && /\[layout-small\] PASS 执行面板在各档字号下都放得下/.test(out) && !/\[layout-small\] FAIL/.test(out);
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
