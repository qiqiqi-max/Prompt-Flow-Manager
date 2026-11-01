// tests/external-change.test.js
// 真实 Electron：内容目录在应用之外被改时，文件树和已打开的标签页要跟上；
// 正在编辑且有未保存改动时只挂提示条、不动编辑框；应用自己的写入不算外部改动。
//
// 渲染进程碰不到 fs，所以由页面里的脚本打一行 "[external-change] STEP <名字>"，
// 本进程看到后在磁盘上做对应的外部改动，页面再轮询界面等结果。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronBin = require(path.join(root, 'node_modules', 'electron'));
const REL = {
  a: 'prompts/testing/ext-a.md',
  b: 'prompts/testing/ext-b.md',
  c: 'prompts/testing/ext-c.md',
  d: 'prompts/testing/ext-d.md',
  other: 'prompts/project-init/ext-other.md',
  added: 'prompts/testing/ext-new.md'
};
const doc = (title, body) => `---\ntitle: ${title}\n---\n${body}\n`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-external-change-'));
const full = rel => path.join(dataDir, ...rel.split('/'));
for (const d of ['prompts/testing', 'prompts/project-init']) fs.mkdirSync(full(d), { recursive: true });
fs.writeFileSync(full(REL.a), doc('Ext A', 'original-a'), 'utf8');
fs.writeFileSync(full(REL.b), doc('Ext B', 'original-b'), 'utf8');
fs.writeFileSync(full(REL.c), doc('Ext C', 'original-c'), 'utf8');
fs.writeFileSync(full(REL.d), doc('Ext D', 'original-d'), 'utf8');
fs.writeFileSync(full(REL.other), doc('Ext Other', 'other'), 'utf8');
const queue = path.join(dataDir, '__dialogs.json');
fs.writeFileSync(queue, JSON.stringify([]));

// 本进程负责的外部改动。b 的第二次用"写临时文件再改名"，和多数外部编辑器的保存方式一样。
const actions = {
  'modify-clean': () => {
    fs.writeFileSync(full(REL.a), doc('Ext A', 'external-a'), 'utf8');
    fs.writeFileSync(full(REL.added), doc('Ext New', 'brand new'), 'utf8');
  },
  'modify-dirty': () => fs.writeFileSync(full(REL.b), doc('Ext B', 'theirs-b'), 'utf8'),
  'modify-dirty-2': () => {
    const tmp = full(REL.b) + '.tmp';
    fs.writeFileSync(tmp, doc('Ext B', 'theirs-b2'), 'utf8');
    fs.renameSync(tmp, full(REL.b));
  },
  'delete-c': () => fs.unlinkSync(full(REL.c))
};

const script = `
  (async () => {
    const R = ${JSON.stringify(REL)};
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // 按墙钟算截止时间，不按轮数：窗口在后台时 Chromium 把计时器节流到约 1 秒一次，
    // "160 轮 × 50ms" 实际要等两分多钟，红的用例会被整体超时杀掉，FAIL 行都打不出来。
    const waitFor = async (fn, ms = 8000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (await fn()) return true; await sleep(50); }
      return !!(await fn());
    };
    const step = (name) => console.log('[external-change] STEP ' + name);
    const check = (name, cond, detail) => console.log('[external-change] ' + (cond ? 'PASS ' : 'FAIL ') + name
      + (cond ? '' : ' ' + JSON.stringify(detail === undefined ? null : detail)));
    const events = [];
    api.onLibraryChanged(info => events.push(info));
    const notice = $('external-notice');
    const noticeMode = () => notice.classList.contains('hidden') ? '' : notice.dataset.mode;
    const fileRow = rel => Array.from(document.querySelectorAll('#tree .tree-row.file')).find(r => r.__rel === rel) || null;

    // 准备：展开 testing、按阶段筛选到 testing、开着 c 和 a
    for (const p of ['prompts', 'prompts/testing', 'prompts/project-init']) state.expandedPaths.add(p);
    await refreshTree();
    $('filter-stage').value = 'testing';
    applyFilter();
    await openFile(R.c);
    await openFile(R.a);

    // 1. 没有未保存改动的标签静默重载；文件树出现新文件，展开、筛选、选中都保留
    step('modify-clean');
    const cleanReloaded = await waitFor(() => $('preview').textContent.includes('external-a'));
    check('未改动的已打开标签静默重载', cleanReloaded && state.currentContent.includes('external-a'), $('preview').textContent.slice(0, 120));
    const added = await waitFor(() => !!fileRow(R.added));
    check('外部新增的文件出现在文件树里', added);
    const addedRow = fileRow(R.added);
    const otherRow = fileRow(R.other);
    check('重建文件树后展开状态和筛选都保留',
      $('filter-stage').value === 'testing' && !!addedRow && addedRow.offsetParent !== null
        && !!otherRow && otherRow.style.display === 'none',
      { filter: $('filter-stage').value, addedVisible: !!addedRow && addedRow.offsetParent !== null, otherDisplay: otherRow && otherRow.style.display });
    check('重建文件树后当前文件仍是选中行', !!fileRow(R.a) && fileRow(R.a).classList.contains('active'));
    check('静默重载不弹提示条', noticeMode() === '', noticeMode());

    // 2. 正在编辑且有未保存改动：挂提示条，编辑框不动
    await openFile(R.b);
    await enterEditMode();
    $('editor').value = $('editor').value.replace('original-b', 'mine-b');
    $('editor').dispatchEvent(new Event('input'));
    step('modify-dirty');
    const shown = await waitFor(() => noticeMode() === 'stale');
    check('编辑中被外部修改时出现提示条', shown && $('external-notice-text').textContent === t('externalModified'),
      { mode: noticeMode(), text: $('external-notice-text').textContent });
    check('提示条出现时编辑框里的改动原样保留', state.editMode && $('editor').value.includes('mine-b'), $('editor').value);
    check('提示条两个按钮是重新加载和保留我的版本',
      $('btn-external-primary').textContent === t('externalReload') && $('btn-external-secondary').textContent === t('externalKeepMine'));
    $('btn-external-secondary').click();
    check('保留我的版本：提示条收起、继续编辑', noticeMode() === '' && state.editMode && $('editor').value.includes('mine-b'));
    const saving = saveCurrent();
    const modal = await waitFor(() => !$('conflict-modal').classList.contains('hidden'), 3000);
    check('保留我的版本后保存仍由 E_SAVE_CONFLICT 兜底', modal);
    if (modal) $('btn-conflict-cancel').click();
    await saving;
    // 保存若没被冲突拦住而是直接成功了，编辑模式已经退出；回到"编辑中、有改动"再往下走
    if (!state.editMode) {
      await enterEditMode();
      $('editor').value = $('editor').value + '\\nmine again';
      $('editor').dispatchEvent(new Event('input'));
    }

    step('modify-dirty-2');
    const again = await waitFor(() => noticeMode() === 'stale');
    check('再次外部修改时提示条重新出现', again, noticeMode());
    $('btn-external-primary').click();
    const reloaded = await waitFor(() => !state.editMode && $('preview').textContent.includes('theirs-b2'));
    check('重新加载：丢弃改动并显示磁盘上的最新内容', reloaded && noticeMode() === '',
      { editMode: state.editMode, preview: $('preview').textContent.slice(0, 120), mode: noticeMode() });

    // 前面那段任何一步红了，状态都可能停在"编辑中、基准过期"上，下面的保存就会弹冲突框
    // 并一直挂着（测试只会在两分钟后被杀，中间的 FAIL 行也跟着丢）。所以先拉回已知状态，
    // 而且保存时冲突框一出现就点取消，让红的用例尽快结束、把失败原因打出来。
    if (state.editMode) await exitEditMode(false, { skipConfirm: true });
    {
      const fresh = await api.readFile(R.b);
      state.currentContent = fresh.content;
      const tb = state.tabs.find(x => x.rel === R.b);
      if (tb) tb.content = fresh.content;
    }
    const saveOrCancel = async () => {
      const p = saveCurrent();
      if (await waitFor(() => !$('conflict-modal').classList.contains('hidden'), 1500)) $('btn-conflict-cancel').click();
      return p;
    };

    // 3. 应用自己的写入（保存、新建、改名、删除）不算外部改动：一条推送都不该有
    await sleep(800);
    const before = events.length;
    await enterEditMode();
    $('editor').value = $('editor').value.replace(/theirs-b2|original-b|theirs-b/, 'self-saved-b');
    $('editor').dispatchEvent(new Event('input'));
    const saved = await saveOrCancel();
    // 存完继续改一笔，让编辑框保持"有未保存改动"：此时若有误报，就会挂出提示条
    $('editor').value = $('editor').value + '\\nstill typing';
    $('editor').dispatchEvent(new Event('input'));
    await api.createFile('prompts/testing/ext-self-created.md', '---\\ntitle: Self Created\\n---\\nself');
    await api.rename(R.d, 'prompts/testing/ext-d-renamed.md');
    await api.trash('prompts/testing/ext-d-renamed.md');
    await sleep(1500);
    check('应用自己保存/新建/改名/删除不产生外部改动推送', saved === true && events.length === before,
      { saved, pushes: events.slice(before) });
    check('应用自己保存后不弹提示条', noticeMode() === '', noticeMode());
    await exitEditMode(false, { skipConfirm: true });

    // 4. 已打开的文件被外部删除：标签不关，切过去有提示
    step('delete-c');
    const flagged = await waitFor(() => state.tabs.some(tb => tb.rel === R.c && tb.externalMissing));
    check('外部删除已打开的文件时标签页不被关掉', flagged && state.tabs.some(tb => tb.rel === R.c));
    check('外部删除的文件从文件树消失', !fileRow(R.c));
    await switchTab(R.c);
    check('切到被删文件的标签时出现提示条', noticeMode() === 'missing' && $('external-notice-text').textContent === t('externalRemoved'),
      { mode: noticeMode(), text: $('external-notice-text').textContent });
    check('被删文件的标签仍显示删除前的内容', $('preview').textContent.includes('original-c'));
    $('btn-external-secondary').click();
    check('被删文件的提示可以收起', noticeMode() === '');
    console.log('[external-change] DONE');
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
const done = new Set();
const onData = (d, stream) => {
  out += d;
  stream.write(d);
  for (const m of out.matchAll(/\[external-change\] STEP ([\w-]+)/g)) {
    if (done.has(m[1])) continue;
    done.add(m[1]);
    try { actions[m[1]](); } catch (e) { console.error('[test:external-change] 外部改动执行失败 ' + m[1] + ': ' + e.message); }
  }
};
child.stdout.on('data', d => onData(d, process.stdout));
child.stderr.on('data', d => onData(d, process.stderr));
const timer = setTimeout(() => child.kill(), 120000);
child.on('exit', code => {
  clearTimeout(timer);
  fs.rmSync(dataDir, { recursive: true, force: true });
  // 每条都要显式 PASS：被 if 跳过或者脚本中途抛错时，"没有 FAIL"证明不了它跑到了
  const mustHave = [
    '未改动的已打开标签静默重载',
    '外部新增的文件出现在文件树里',
    '重建文件树后展开状态和筛选都保留',
    '重建文件树后当前文件仍是选中行',
    '静默重载不弹提示条',
    '编辑中被外部修改时出现提示条',
    '提示条出现时编辑框里的改动原样保留',
    '提示条两个按钮是重新加载和保留我的版本',
    '保留我的版本：提示条收起、继续编辑',
    '保留我的版本后保存仍由 E_SAVE_CONFLICT 兜底',
    '再次外部修改时提示条重新出现',
    '重新加载：丢弃改动并显示磁盘上的最新内容',
    '应用自己保存/新建/改名/删除不产生外部改动推送',
    '应用自己保存后不弹提示条',
    '外部删除已打开的文件时标签页不被关掉',
    '外部删除的文件从文件树消失',
    '切到被删文件的标签时出现提示条',
    '被删文件的标签仍显示删除前的内容',
    '被删文件的提示可以收起'
  ];
  const missing = mustHave.filter(n => !out.includes('[external-change] PASS ' + n));
  const failed = /\[external-change\] FAIL/.test(out);
  const finished = out.includes('[external-change] DONE');
  if (missing.length) console.error('[test:external-change] 没有 PASS 的断言：' + missing.join('、'));
  const passed = code === 0 && finished && !failed && !missing.length;
  console.log(passed ? '[test:external-change] 通过' : '[test:external-change] 失败');
  process.exit(passed ? 0 : 1);
});
