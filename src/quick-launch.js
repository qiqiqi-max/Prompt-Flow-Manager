// quick-launch.js - 快速搜索面板的页面逻辑
//
// 依赖由 quick-launch.html 以 <script> 引入：I18N / FRONTMATTER / PLACEHOLDERS / INCLUDES
// 四个全局。能力只有 quick-launch-preload.js 暴露的 window.quickLaunchApi。
//
// 整个文件包在 IIFE 里，不留任何顶层声明：这几个脚本共享同一个全局词法作用域，
// 顶层写一个 const t / const state 就可能和别的脚本撞名，撞上的那个脚本整段不执行
// （CLAUDE.md 踩过的坑第 2、3 条，两次都是"界面全白、只有一行控制台报错"）。
//
// 文案一律走 I18N，这个文件里不许出现中文字面量（tests/smoke.test.js 有断言）。
(function () {
  const qlApi = window.quickLaunchApi;
  const view = {
    lang: 'zh',
    fillMemory: {},
    contextSnapshot: null,
    copyToken: null,
    mode: 'list',      // 'list' 搜索列表 | 'fill' 填占位符
    results: [],
    resultsFor: null,  // 当前 results 对应的查询词；和输入框不一致说明结果是旧的
    active: 0,
    busy: false
  };
  // 两个序号守卫。
  // searchSeq 同 renderer.js 的 doSearch：debounce 只合并输入，挡不住上一次 IPC 还在路上。
  // 大库里旧查询慢、新查询快时，旧结果后到会把新结果盖掉，于是列表显示的不是输入框里那个词，
  // 按 Enter 复制出去的是另一条提示词——在这个面板上这是直接的错误输出，不只是闪一下。
  // showSeq 是每次呼出加一：上一次呼出时发起的读文件 / 复制在隐藏之后才返回的话，
  // 不能把旧的填空表单弹到新的一次呼出上。
  let searchSeq = 0;
  let showSeq = 0;
  let searchTimer = null;
  const SEARCH_DEBOUNCE_MS = 120;

  const $ = (id) => document.getElementById(id);

  function t(key, params) {
    const tbl = I18N[view.lang] || I18N.zh;
    let s = tbl[key] != null ? tbl[key] : (I18N.zh[key] != null ? I18N.zh[key] : key);
    if (params) {
      for (const [k, v] of Object.entries(params)) s = s.split('{' + k + '}').join(String(v));
    }
    return s;
  }
  // 同 renderer.js 的 describeError：主进程把错误码编进 message，这里翻成当前语言。
  function describeError(e) {
    const raw = e && e.message ? String(e.message) : String(e);
    const m = raw.match(/\b(E_[A-Z0-9_]+)(?:\|([\s\S]*))?$/);
    if (!m) return raw;
    const key = 'err_' + m[1];
    if ((I18N[view.lang] || I18N.zh)[key] == null && I18N.zh[key] == null) return raw;
    return t(key, { detail: m[2] || '' });
  }
  function dirLabel(key) {
    const map = { prompts: 'dirPrompts', workflows: 'dirWorkflows', templates: 'dirTemplates' };
    if (map[key]) return t(map[key]);
    const tbl = I18N[view.lang] || I18N.zh;
    return tbl['stage_' + key] != null ? tbl['stage_' + key] : key;
  }

  function applyI18n() {
    document.documentElement.lang = view.lang === 'en' ? 'en' : 'zh-CN';
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  }
  // 档位白名单和 renderer.js 的 FONT_SCALES 同一组。配置可能被手改坏，
  // 不在白名单里就用默认值，不把 NaN 塞进 calc()。
  function applyLook(info) {
    view.lang = info && info.lang === 'en' ? 'en' : 'zh';
    document.body.className = 'theme-' + (info && info.theme === 'dark' ? 'dark' : 'light');
    const n = Number(info && info.fontScale);
    const scale = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25].includes(n) ? n : 0.9;
    document.documentElement.style.setProperty('--font-scale', String(scale));
    applyI18n();
  }

  function setStatus(msg, isError) {
    const el = $('ql-status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  // ===== 搜索 =====
  async function runSearch() {
    const q = $('ql-input').value.trim();
    const seq = ++searchSeq;
    if (!q) {
      view.results = [];
      view.resultsFor = q;
      view.active = 0;
      renderList();
      return;
    }
    let results = [];
    try {
      results = await qlApi.search(q);
    } catch (e) {
      if (seq !== searchSeq) return;
      setStatus(describeError(e), true);
      return;
    }
    if (seq !== searchSeq) return;
    view.results = Array.isArray(results) ? results : [];
    view.resultsFor = q;
    view.active = 0;
    renderList();
  }
  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
  }
  // 按 Enter 时列表可能还是上一个词的结果（还在防抖窗口里，或者 IPC 还没回来）。
  // 这时直接取选中项，复制出去的就是另一条提示词。先把这一次搜完再取。
  async function ensureFresh() {
    if (view.resultsFor === $('ql-input').value.trim()) return;
    clearTimeout(searchTimer);
    await runSearch();
  }

  function renderList() {
    const list = $('ql-list');
    list.textContent = '';
    if (!view.results.length) {
      if (view.resultsFor) {
        const empty = document.createElement('div');
        empty.className = 'ql-empty';
        empty.textContent = t('noResults');
        list.appendChild(empty);
      }
      return;
    }
    // 全部用 textContent 拼，不用 innerHTML：标题和片段来自库里的文件，
    // 外部导入的 .md 也在其中，这里没有 DOMPurify。
    view.results.forEach((r, i) => {
      const item = document.createElement('div');
      item.className = 'ql-item';
      item.setAttribute('role', 'option');
      item.dataset.rel = r.rel;
      const title = document.createElement('div');
      title.className = 'ql-title';
      title.textContent = r.name || r.rel;
      const meta = document.createElement('div');
      meta.className = 'ql-meta';
      meta.textContent = [r.stage ? dirLabel(r.stage) : '', r.projectType || ''].filter(Boolean).join(' · ');
      item.appendChild(title);
      item.appendChild(meta);
      if (r.snippet) {
        const sn = document.createElement('div');
        sn.className = 'ql-snippet';
        sn.textContent = r.snippet;
        item.appendChild(sn);
      }
      // mousemove 而不是 mouseenter：面板弹出来时鼠标可能正好停在某一行上，
      // mouseenter 会立刻把选中项抢过去，用户按 Enter 复制的就不是第一条了。
      item.addEventListener('mousemove', () => { if (view.active !== i) { view.active = i; updateActive(); } });
      item.addEventListener('click', () => { view.active = i; updateActive(); copySelected(); });
      list.appendChild(item);
    });
    updateActive();
  }
  function updateActive() {
    const items = $('ql-list').querySelectorAll('.ql-item');
    items.forEach((el, i) => {
      const on = i === view.active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  }
  function moveActive(delta) {
    const n = view.results.length;
    if (!n) return;
    view.active = (view.active + delta + n) % n;
    updateActive();
  }

  // ===== 复制 =====
  // 流程和主窗口的 copyContent 一致：先剥 frontmatter，再展开 {{include:}}，
  // 最后看有没有占位符。顺序不能换——PLACEHOLDERS 不认 yaml（见 src/placeholders.js
  // 文件头），include 进来的片段里也可能有占位符。
  async function copySelected() {
    if (view.busy || view.mode !== 'list') return;
    view.busy = true;
    const mySeq = showSeq;
    const capturedToken=view.copyToken;
    const capturedContext=view.contextSnapshot;
    const capturedMemory=view.fillMemory;
    try {
      await ensureFresh();
      const r = view.results[view.active];
      if (!r || mySeq !== showSeq) return;
      const res = await qlApi.readFile(r.rel);
      let body = FRONTMATTER.parse(res && res.content ? res.content : '').body;
      if (INCLUDES.hasInclude(body)) {
        body = await INCLUDES.resolveAsync(body, async (rel) => {
          try {
            const inc = await qlApi.readFile(rel);
            return inc ? inc.content : null;
          } catch {
            return null;
          }
        });
      }
      if (mySeq !== showSeq) return;
      const tokens = PLACEHOLDERS.extract(body);
      if (!tokens.length) {
        await finishCopy(body, r.rel, capturedToken);
        return;
      }
      openFillForm(r, body, tokens, capturedToken, capturedContext, capturedMemory);
    } catch (e) {
      setStatus(describeError(e), true);
    } finally {
      view.busy = false;
    }
  }

  // 复制成功的唯一出口。主进程写剪贴板并隐藏面板（同样是那边的单一出口），
  // 这里不另写一份 navigator.clipboard：面板失焦就会被隐藏，而 navigator.clipboard
  // 在页面没有焦点时会直接拒绝。
  async function finishCopy(text, rel, token) {
    await qlApi.copy(text, rel, token);
  }

  function openFillForm(r, body, tokens, token, context, globalValues) {
    view.mode = 'fill';
    const box = $('ql-fill');
    box.textContent = '';
    const title = document.createElement('div');
    title.className = 'ql-fill-title';
    title.textContent = t('fillTitle') + ' · ' + (r.name || r.rel);
    const hint = document.createElement('div');
    hint.className = 'ql-fill-hint';
    hint.textContent = t('qlFillHint');
    box.appendChild(title);
    box.appendChild(hint);
    const inputs = tokens.map((it, i) => {
      const row = document.createElement('div');
      row.className = 'ql-fill-row';
      const label = document.createElement('label');
      label.htmlFor = 'ql-fill-' + i;
      label.textContent = it.hint || it.token;
      const input = document.createElement('textarea');
      input.rows = 2;
      input.maxLength = 20000;
      input.id = 'ql-fill-' + i;
      input.dataset.token = it.token;
      input.placeholder = it.token;
      input.autocomplete = 'off';
      // 主窗口记住的值预填，和主窗口填充面板同一份记忆。
      // 这里只读不写：两个窗口各自防抖写同一个 fillMemory 键会互相覆盖（各自读的是
      // 旧快照），而主窗口那份是有上限和淘汰顺序的，交给它一处维护。
      input.value = PROJECT_CONTEXT.resolve(it,{context,globalValues});
      row.appendChild(label);
      const resize = () => {
        input.style.height = 'auto';
        input.style.height = Math.min(160, input.scrollHeight) + 'px';
      };
      input.addEventListener('input', resize);
      if (it.options && it.options.length) {
        const select = document.createElement('select');
        select.setAttribute('aria-label', t('fillOptionsLabel') + ' · ' + (it.hint || it.token));
        for (const [value, text] of [['', t('fillCustomOption')], ...it.options.map(value => [value, value])]) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = text;
          select.appendChild(option);
        }
        const sync = () => { select.value = it.options.includes(input.value) ? input.value : ''; };
        sync();
        select.addEventListener('change', () => {
          if (select.value) input.value = select.value;
          resize();
          input.focus();
        });
        input.addEventListener('input', sync);
        row.appendChild(select);
      }
      row.appendChild(input);
      box.appendChild(row);
      requestAnimationFrame(resize);
      return input;
    });
    const actions = document.createElement('div');
    actions.className = 'ql-fill-actions';
    const raw = document.createElement('button');
    raw.type = 'button';
    raw.textContent = t('fillCopyRaw');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary';
    ok.textContent = t('fillAndCopy');
    actions.appendChild(raw);
    actions.appendChild(ok);
    box.appendChild(actions);

    const collect = () => {
      const values = {};
      for (const inp of inputs) values[inp.dataset.token] = inp.value;
      return values;
    };
    const submit = async (values) => {
      if (view.busy) return;
      view.busy = true;
      try {
        // 没填的 token 原样保留，这条语义在 PLACEHOLDERS.fill 里，面板不另写一套
        await finishCopy(PLACEHOLDERS.fill(body, values), r.rel, token);
      } catch (e) {
        setStatus(describeError(e), true);
      } finally {
        view.busy = false;
      }
    };
    ok.addEventListener('click', () => submit(collect()));
    raw.addEventListener('click', () => submit({}));
    inputs.forEach((inp, i) => {
      inp.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;   // 输入法正在选词
        if (e.key !== 'Enter') return;
        if (e.shiftKey && !e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        // Ctrl+Enter 提交，和主窗口填充面板一致。裸 Enter 跳下一项、最后一项落到
        // 「填好并复制」按钮上：这里通常有好几个空，拿裸 Enter 提交会填到一半就送出去。
        if (e.ctrlKey || e.metaKey) { submit(collect()); return; }
        if (i + 1 < inputs.length) inputs[i + 1].focus();
        else ok.focus();
      });
    });
    $('ql-list').classList.add('hidden');
    box.classList.remove('hidden');
    $('ql-hint').textContent = t('qlFillHint');
    if (inputs.length) { inputs[0].focus(); inputs[0].select(); }
  }

  function backToList() {
    view.mode = 'list';
    $('ql-fill').classList.add('hidden');
    $('ql-fill').textContent = '';
    $('ql-list').classList.remove('hidden');
    $('ql-hint').textContent = t('qlHint');
  }

  // ===== 键盘 =====
  $('ql-input').addEventListener('input', () => {
    if (view.mode !== 'list') backToList();
    setStatus('');
    scheduleSearch();
  });
  $('ql-input').addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); copySelected(); }
  });
  // Esc 挂在 document 上：填空表单里的输入框、按钮上按 Esc 也要能收起面板
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    qlApi.hide();
  });

  // ===== 呼出 =====
  // 面板是复用的同一个窗口，隐藏而不销毁。所以每次呼出都要把上一次留下的状态收拾掉：
  // 停在填空表单上的话，用户看到的是上一次那条提示词的输入框。
  // 搜索词保留并全选——连着找同一条提示词时不用重打，想搜别的直接打字就覆盖了。
  qlApi.onShow((info) => {
    showSeq++;
    view.copyToken={showGeneration:info.showGeneration,workspaceRevision:info.workspaceRevision};
    view.contextSnapshot=info.contextSnapshot || null;
    applyLook(info);
    view.fillMemory = info && info.fillMemory && typeof info.fillMemory === 'object' ? info.fillMemory : {};
    backToList();
    setStatus('');
    const input = $('ql-input');
    input.focus();
    input.select();
    // 库可能在两次呼出之间变过（主窗口刚保存、刚删了一条），结果要重新搜
    clearTimeout(searchTimer);
    view.resultsFor = null;
    runSearch();
  });
  applyLook({ lang: 'zh', theme: 'light' });
})();
