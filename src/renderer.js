// renderer.js - 渲染进程逻辑
// 依赖全部由 index.html 以 <script> 引入，这里只取全局对象：
// contextIsolation: true 下渲染进程没有 require。
// 注意：I18N 已由 i18n.js 在全局声明，此处若再写 const I18N 会抛
// "Identifier 'I18N' has already been declared"，导致整个 renderer.js 都不执行。
const marked = window.marked.marked;
const DOMPurify = window.DOMPurify;
const DiffMatchPatch = window.diff_match_patch;

const api = window.promptFlowApi;

// ===== i18n =====
function t(key, params) {
  const lang = (state.config && state.config.lang) || 'zh';
  const tbl = I18N[lang] || I18N.zh;
  let s = tbl[key] != null ? tbl[key] : (I18N.zh[key] != null ? I18N.zh[key] : key);
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split('{' + k + '}').join(String(v));
  }
  return s;
}

// 失败提示统一格式：<本地化前缀><分隔符><底层错误信息>
// 说明：主进程抛出的 e.message 目前仍是中文，英文界面下这段会混中文，
// 属已知限制（要彻底解决需要给主进程的异常加错误码）。
// 主进程把错误码编进 message（`<CODE>|<细节>`），这里翻译成用户语言。
// Electron 会把它包装成 "Error invoking remote method 'x': Error: E_LOCKED|a.md"，
// 所以用搜索而不是从头匹配。认不出来的就原样显示，不吞掉信息。
function describeError(e) {
  const raw = e && e.message ? String(e.message) : String(e);
  const m = raw.match(/\b(E_[A-Z0-9_]+)(?:\|([\s\S]*))?$/);
  if (!m) return raw;
  const key = 'err_' + m[1];
  const detail = m[2] || '';
  const lang = (state.config && state.config.lang) || 'zh';
  const tbl = I18N[lang] || I18N.zh;
  if (tbl[key] == null && I18N.zh[key] == null) return raw; // 未知错误码：原样显示
  return t(key, { detail });
}

function tErr(key, e) {
  return t(key) + t('sep') + describeError(e);
}

// 阶段/顶层目录的显示名：优先用 i18n，回落到主进程给的 STAGE_LABELS，最后用原始键。
function dirLabel(key) {
  const map = { prompts: 'dirPrompts', workflows: 'dirWorkflows', templates: 'dirTemplates' };
  if (map[key]) return t(map[key]);
  const stageKey = 'stage_' + key;
  const lang = (state.config && state.config.lang) || 'zh';
  if (I18N[lang] && I18N[lang][stageKey] != null) return I18N[lang][stageKey];
  return (state.stageLabels && state.stageLabels[key]) || key;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}

// ===== 状态 =====
const state = {
  config: null,
  stages: [],
  stageLabels: {},
  tree: [],
  metaList: [],
  metaByRel: new Map(),      // rel -> metaList 条目，避免每行都线性 find（见 setMetaList）
  currentRel: null,         // 当前打开的文件相对路径
  currentContent: '',      // 文件原始内容（含 frontmatter）
  currentMeta: {},
  editMode: false,
  editBaseline: '',           // 进入编辑时的内容快照，用于脏判断（见 isDirty）
  historyRel: null,
  filter: { stage: '', type: '', tag: '' },
  expandedPaths: new Set(),  // 文件树展开状态记忆（存目录的 rel）
  sidebarWidth: 280,         // 侧边栏宽度持久化
  recent: [],                // 最近打开列表（存 rel，最多10条）
  lockedFiles: new Set(),     // 锁定文件集合（防止误删）
  tabs: [],                   // 多标签页：[{rel, content, meta, scroll}]
  activeTab: null             // 当前激活标签的 rel
};

// ===== 工具 =====
const $ = (id) => document.getElementById(id);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const escapeHtml = (s) => String(s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
// 保存展开状态（防抖）
const saveExpandedPathsDebounced = debounce(async () => {
  try {
    await api.setConfig({ expandedPaths: Array.from(state.expandedPaths) });
  } catch (e) { console.error('保存展开状态失败:', e); } // i18n-exempt: 开发日志
}, 600);

// frontmatter 解析由 src/frontmatter.js 提供（FRONTMATTER 全局，index.html 里先加载）。
// 主进程 require 的是同一个文件，所以两边的解析结果永远一致——
// 原先这里和 electron-main.js 各有一份逐字复制的实现，改一边不会同步到另一边。
function parseFrontmatter(content) {
  return FRONTMATTER.parse(content);
}

function parseWorkflowFlow(content) {
  // 解析 frontmatter 里 flow 的步骤（- id/prompt/label/next，next 支持数组）
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  // 按行取块，不要用惰性正则去截 flow 段。之前的写法在多行模式下会被行尾锚点
  // 提前截断，只解析出第一个步骤而且丢掉 prompt，导致流程图永远只有一个空节点。
  const startIdx = lines.findIndex(l => /^flow:\s*$/.test(l));
  if (startIdx === -1) return [];
  const blockLines = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { blockLines.push(line); continue; }
    if (/^\s/.test(line)) blockLines.push(line); // 缩进行 = 仍在 flow 段内
    else break;                                  // 顶格 = 下一个 frontmatter 字段
  }
  const block = blockLines.join('\n');
  const steps = [];
  let cur = null;
  for (const line of block.split(/\r?\n/)) {
    if (/^\s*-\s/.test(line)) {
      if (cur) steps.push(cur);
      cur = {};
      const rest = line.replace(/^\s*-\s*/, '');
      const kv = rest.match(/^(\w+):\s*(.*)$/);
      if (kv) cur[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    } else if (cur && /^\s+\w+:/.test(line)) {
      const kv = line.trim().match(/^(\w+):\s*(.*)$/);
      if (kv) cur[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  if (cur) steps.push(cur);
  // 归一化 next：字符串 → 单元素数组；YAML 数组 [a, b] → 数组
  for (const s of steps) {
    if (s.next == null || s.next === '') {
      s.next = [];
    } else if (Array.isArray(s.next)) {
      s.next = s.next.map(x => String(x).trim()).filter(Boolean);
    } else {
      // 形如 "[a, b]" 或 "a"
      let v = String(s.next).trim().replace(/^["']|["']$/g, '');
      if (v.startsWith('[') && v.endsWith(']')) {
        s.next = v.slice(1, -1).split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      } else {
        s.next = [v];
      }
    }
  }
  return steps;
}

function stageOfRel(rel) {
  if (!rel.startsWith('prompts/')) return null;
  const segs = rel.split('/');
  return segs.length > 2 ? segs[1] : null;
}

function fileNameNoExt(name) {
  return name.replace(/\.md$/i, '');
}

function toast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  setTimeout(() => t.classList.add('hidden'), 1800);
}

async function confirmDialog(msg) {
  return await api.confirm(msg);
}

// ===== Markdown 渲染 =====
// FORBID_ATTR 里的 id/name 是防 DOM clobbering，不是防 XSS：
// DOMPurify 默认放行 id，而它的 SANITIZE_DOM 只拦与 document/form 上已有属性
// 撞名的 id。提示词正文里写 `<div id="editor">` 会被原样保留，插进 #preview
// 之后 getElementById('editor') 按文档顺序命中的是这个 div（index.html 里
// #preview 排在真正的 <textarea id="editor"> 前面），保存逻辑读到的就是
// div.value === undefined。实测症状：编辑后点保存，写回磁盘的是渲染后的旧正文，
// 用户的改动无声消失，dirty 检查也因为读不到 value 而认为"没改过"。
// toast/其他按 id 取的节点同样可以被顶掉。
function renderMarkdown(md) {
  const html = marked.parse(md || '', { breaks: true, gfm: true });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_ATTR: ['id', 'name'] });
}

// 给预览区代码块加复制按钮（后处理）
function enhanceCodeBlocks(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = t('copy');
    btn.onclick = async () => {
      const code = pre.querySelector('code');
      const text = code ? code.textContent : pre.textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = t('copy'); }, 1200);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = t('copy'); }, 1200);
      }
    };
    pre.appendChild(btn);
  });
}

// metaList 与 metaByRel 必须同时更新：树、面包屑、筛选、最近打开都改成查 Map
// （原先每行做一次 metaList.find，1000 个文件就是约 50 万次比较，每次刷新都重来）。
function setMetaList(list) {
  state.metaList = list;
  state.metaByRel = new Map(list.map(m => [m.rel, m]));
}

// ===== 文件树 =====
async function refreshTree() {
  // 一次 IPC 拿全树 + 元数据。listTree 和 getMetaList 走同一套目录递归，
  // 分开调用等于把整库 readdir 两遍，而 refreshTree 在新建/删除/重命名/移动/
  // 保存后都会触发。
  // 顺序上也必须先拿到元数据再渲染树：树上每行显示名来自 meta.title，
  // 原先是先 renderTree() 再取 metaList，首次渲染只能退回文件名。
  const { tree, meta } = await api.listTreeAndMeta();
  state.tree = tree;
  setMetaList(meta);
  renderTree();
  populateFilters();
  updateStatusCounts();
  renderStats();
  renderRecent();
}

function renderStats() {
  const panel = $('stats-panel');
  if (!panel) return;
  // 按阶段统计
  const stageCounts = {};
  for (const m of state.metaList) {
    if (m.stage) stageCounts[m.stage] = (stageCounts[m.stage] || 0) + 1;
  }
  const stageLabel = s => dirLabel(s);
  const parts = [];
  for (const [stage, count] of Object.entries(stageCounts)) {
    parts.push(`<div class="stat-card"><span class="stat-num">${count}</span><span class="stat-label">${escapeHtml(stageLabel(stage))}</span></div>`);
  }
  if (!parts.length) {
    parts.push(`<div class="stat-card"><span class="stat-num">0</span><span class="stat-label">${escapeHtml(t('noPromptsYet'))}</span></div>`);
  }
  panel.innerHTML = parts.join('');
}

// ===== 状态栏 =====
function updateStatusCounts() {
  const counts = $('status-counts');
  if (!counts) return;
  const prompts = state.metaList.filter(m => m.top === 'prompts').length;
  const workflows = state.metaList.filter(m => m.top === 'workflows').length;
  counts.textContent = t('countsSummary', { prompts, workflows });
}

function updateStatusInfo(msg) {
  const el = $('status-info');
  if (el) el.textContent = msg;
}

function renderTree() {
  const root = $('tree');
  root.innerHTML = '';
  root.tabIndex = 0; // 允许键盘聚焦
  for (const node of state.tree) {
    root.appendChild(buildTreeNode(node, 0));
  }
  // 绑定键盘导航（事件委托）
  root.onkeydown = null; // 防止重复绑定
  root.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = Array.from(root.querySelectorAll('.tree-row.file:not([style*="display: none"])'));
      if (!rows.length) return;
      const current = root.querySelector('.tree-row.file.active') || root.querySelector('.tree-row.file:focus-within');
      let idx = current ? rows.indexOf(current) : -1;
      if (e.key === 'ArrowDown') idx = idx + 1 >= rows.length ? 0 : idx + 1;
      else idx = idx - 1 < 0 ? rows.length - 1 : idx - 1;
      rows[idx].focus();
      rows[idx].click();
    } else if (e.key === 'Enter') {
      // 已在 click 里处理
    }
  };
  // 聚焦状态样式（加到 CSS）
  root.onfocusin = (e) => {
    const r = e.target.closest('.tree-row.file');
    if (r) r.classList.add('focused');
  };
  root.onfocusout = (e) => {
    const r = e.target.closest('.tree-row.file');
    if (r) r.classList.remove('focused');
  };
}

function buildTreeNode(node, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row ' + node.type;
  row.style.paddingLeft = (4 + depth * 14) + 'px';
  if (node.type === 'dir') {
    const caret = document.createElement('span');
    caret.className = 'caret';
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '📁';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = labelForDir(node);
    row.append(caret, icon, name);
    const children = document.createElement('div');
    children.className = 'tree-children';
    for (const c of node.children) children.appendChild(buildTreeNode(c, depth + 1));
    wrap.append(row, children);
    const open = state.expandedPaths.has(node.rel);
    children.classList.toggle('hidden', !open);
    caret.textContent = open ? '▼' : '▶';
    row.addEventListener('click', () => {
      if (state.expandedPaths.has(node.rel)) {
        state.expandedPaths.delete(node.rel);
        children.classList.add('hidden');
        caret.textContent = '▶';
      } else {
        state.expandedPaths.add(node.rel);
        children.classList.remove('hidden');
        caret.textContent = '▼';
      }
      // 同步到 config（节流）
      saveExpandedPathsDebounced();
    });
    // 目录作为拖放目标：把拖入的文件移动到此目录
    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', async e => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const srcRel = e.dataTransfer.getData('text/plain');
      if (!srcRel) return;
      await moveFileToDir(srcRel, node.rel);
    });
  } else {
    const caret = document.createElement('span');
    caret.className = 'caret';
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = node.rel.startsWith('workflows') ? '🔀' : (node.rel.startsWith('templates') ? '📋' : '📄');
    const name = document.createElement('span');
    name.className = 'name';
    const m = state.metaByRel.get(node.rel);
    name.textContent = (m && m.meta.title) ? m.meta.title : fileNameNoExt(node.name);
    row.append(caret, icon, name);
    row.__rel = node.rel;  // 供筛选过滤用
    // tooltip：完整路径 + 关键元信息
    const tipParts = [node.rel];
    if (m) {
      if (m.meta.projectType) tipParts.push(t('projectType') + ': ' + m.meta.projectType);
      if (Array.isArray(m.meta.tags) && m.meta.tags.length) tipParts.push(t('tag') + ': ' + m.meta.tags.join(', '));
      if (m.meta.description) tipParts.push(m.meta.description);
    }
    row.title = tipParts.join('\n');
    row.addEventListener('click', () => openFile(node.rel));
    row.tabIndex = -1; // 允许聚焦但不参与 tab 导航
    if (state.currentRel === node.rel) row.classList.add('active');
    // 拖拽：文件可拖
    row.draggable = true;
    row.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', node.rel);
      e.dataTransfer.effectAllowed = 'move';
    });
    // 锁定标记（防误删）
    if (state.lockedFiles.has(node.rel)) {
      row.classList.add('locked');
      const lock = document.createElement('span');
      lock.className = 'lock-mark';
      lock.textContent = '🔒';
      lock.title = t('lockedTitle');
      row.append(lock);
    }
    wrap.appendChild(row);
  }
  // 右键菜单
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, node);
  });
  return wrap;
}

function labelForDir(node) {
  const map = {
    'prompts': dirLabel('prompts'),
    'workflows': dirLabel('workflows'),
    'templates': dirLabel('templates'),
    'project-init': dirLabel('project-init'),
    'code-generation': dirLabel('code-generation'),
    'code-review': dirLabel('code-review'),
    'testing': dirLabel('testing'),
    'deployment': dirLabel('deployment')
  };
  return map[node.name] || node.name;
}

// ===== 打开文件 =====
async function openFile(rel) {
  if (!rel) return;
  if (state.editMode && !(await exitEditMode(true))) return;
  try {
    // 多标签页：若已存在标签则激活，否则新建。
    // 注意判的是 loaded 而不是"标签存不存在"：启动时从 config 恢复的标签是
    // content:'' 的占位（见 init()），只判存在会让正文停留在空串——预览区空白，
    // 此时进编辑再保存就把文件正文清空了。
    let tab = state.tabs.find(t => t.rel === rel);
    if (!tab) {
      const { content, meta } = await api.readFile(rel);
      tab = { rel, content, meta, scroll: 0, loaded: true };
      state.tabs.push(tab);
    } else if (!tab.loaded) {
      const { content, meta } = await api.readFile(rel);
      tab.content = content;
      tab.meta = meta;
      tab.loaded = true;
    }
    state.activeTab = rel;
    state.currentRel = rel;
    state.currentContent = tab.content;
    state.currentMeta = tab.meta;
    $('empty-state').classList.add('hidden');
    $('content-area').classList.remove('hidden');
    renderBreadcrumb();
    renderMetaBar();
    renderContent();
    renderTabs();
    saveTabsDebounced();
    // 更新文件树激活状态（不重建树）
    document.querySelectorAll('.tree-row').forEach(r => {
      r.classList.toggle('active', r.__rel === rel);
    });
    // 记录到最近打开
    addRecent(rel);
    // 更新状态栏信息
    updateStatusInfo((state.currentMeta.title || rel) + ' · ' + t('loaded'));
  } catch (e) {
    state.currentRel = null;
    toast(tErr('openFailed', e), 'error');
    updateStatusInfo(t('openFailed'));
  }
}

// ===== 多标签页 =====
const saveTabsDebounced = debounce(async () => {
  try {
    await api.setConfig({
      tabs: state.tabs.map(t => t.rel),
      activeTab: state.activeTab
    });
  } catch (e) { console.error('保存标签状态失败:', e); } // i18n-exempt: 开发日志
}, 500);
function renderTabs() {
  const bar = $('tabs-bar');
  if (!bar) return;
  if (!state.tabs.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  const closeLabel = t('close');
  bar.innerHTML = state.tabs.map(tab => {
    const title = (tab.meta && tab.meta.title) || fileNameNoExt(tab.rel.split('/').pop());
    const active = tab.rel === state.activeTab;
    return `<div class="tab ${active ? 'active' : ''}" data-rel="${escapeHtml(tab.rel)}" title="${escapeHtml(tab.rel)}">
      <span class="tab-title">${escapeHtml(title)}</span>
      <button class="tab-close" data-close="${escapeHtml(tab.rel)}" title="${escapeHtml(closeLabel)}">✕</button>
    </div>`;
  }).join('');
  bar.querySelectorAll('.tab').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.tab-close')) return;
      switchTab(el.dataset.rel);
    });
    el.addEventListener('auxclick', e => {  // 中键关闭
      if (e.button === 1) { e.preventDefault(); closeTab(el.dataset.rel); }
    });
  });
  bar.querySelectorAll('.tab-close').forEach(b => {
    b.addEventListener('click', e => { e.stopPropagation(); closeTab(b.dataset.close); });
  });
}

async function switchTab(rel) {
  if (state.editMode && !(await exitEditMode(true))) return;
  const tab = state.tabs.find(t => t.rel === rel);
  if (!tab) return;
  // 恢复出来的占位标签还没有正文，切过去之前先补读（理由同 openFile）
  if (!tab.loaded) {
    try {
      const { content, meta } = await api.readFile(rel);
      tab.content = content;
      tab.meta = meta;
      tab.loaded = true;
    } catch (e) {
      toast(tErr('openFailed', e), 'error');
      return;
    }
  }
  state.activeTab = rel;
  state.currentRel = rel;
  state.currentContent = tab.content;
  state.currentMeta = tab.meta;
  renderBreadcrumb();
  renderMetaBar();
  renderContent();
  renderTabs();
  saveTabsDebounced();
  document.querySelectorAll('.tree-row').forEach(r => {
    r.classList.toggle('active', r.__rel === rel);
  });
  updateStatusInfo((tab.meta.title || rel) + ' · ' + t('loaded'));
}

async function closeTab(rel) {
  const idx = state.tabs.findIndex(t => t.rel === rel);
  if (idx === -1) return;
  // 若关的是当前标签且在编辑，先退出。
  // 必须 await 并尊重返回值：用户在"放弃未保存的修改？"里选取消时，
  // 标签不能继续关掉（否则确认框形同虚设，草稿照样丢）。
  if (rel === state.activeTab && state.editMode) {
    if (!(await exitEditMode(false))) return;
  }
  state.tabs.splice(idx, 1);
  if (state.activeTab === rel) {
    // 切到相邻标签
    const next = state.tabs[idx] || state.tabs[idx - 1] || null;
    if (next) {
      await switchTab(next.rel);
    } else {
      // 无标签：清空内容区
      state.activeTab = null;
      state.currentRel = null;
      state.currentContent = '';
      state.currentMeta = {};
      $('content-area').classList.add('hidden');
      $('empty-state').classList.remove('hidden');
      renderTabs();
      saveTabsDebounced();
      updateStatusInfo(t('ready'));
    }
  } else {
    renderTabs();
  }
  saveTabsDebounced();
}

// ===== 最近打开 =====
const MAX_RECENT = 10;
function addRecent(rel) {
  state.recent = [rel, ...state.recent.filter(r => r !== rel)].slice(0, MAX_RECENT);
  saveRecentDebounced();
  renderRecent();
}
const saveRecentDebounced = debounce(async () => {
  try { await api.setConfig({ recent: state.recent }); }
  catch (e) { console.error('保存最近打开失败:', e); } // i18n-exempt: 开发日志
}, 500);
function renderRecent() {
  const panel = $('recent-panel');
  if (!panel) return;
  // 仅在空状态可见时渲染（实际显隐由空状态控制）
  const recent = state.recent
    .map(r => state.metaByRel.get(r))
    .filter(Boolean);
  if (!recent.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const list = $('recent-list');
  list.innerHTML = recent.map(m => {
    const stage = stageOfRel(m.rel);
    const stageLabel = stage ? dirLabel(stage) : (m.top === 'workflows' ? dirLabel('workflows') : m.top === 'templates' ? dirLabel('templates') : '');
    const icon = m.rel.startsWith('workflows') ? '🔀' : (m.rel.startsWith('templates') ? '📋' : '📄');
    return `<div class="recent-item" data-rel="${escapeHtml(m.rel)}">
      <span class="ri-icon">${icon}</span>
      <span class="ri-name">${escapeHtml(m.meta.title || fileNameNoExt(m.name))}</span>
      ${stageLabel ? `<span class="ri-stage">${escapeHtml(stageLabel)}</span>` : ''}
    </div>`;
  }).join('');
  list.querySelectorAll('.recent-item').forEach(el => {
    el.onclick = () => openFile(el.dataset.rel);
  });
}

function renderBreadcrumb() {
  const bc = $('breadcrumb');
  const segs = state.currentRel.split('/');
  const labels = segs.map((s, i) => {
    if (i < segs.length - 1) return labelForDir({ name: s }) || s;
    const m = state.metaByRel.get(state.currentRel);
    return (m && m.meta.title) ? m.meta.title : fileNameNoExt(s);
  });
  bc.innerHTML = segs.map((s, i) => {
    const isLast = i === segs.length - 1;
    return `<span class="${isLast ? 'bc-current' : ''}">${escapeHtml(labels[i])}</span>${isLast ? '' : ' / '}`;
  }).join('');
}

function renderMetaBar() {
  const bar = $('meta-bar');
  const m = state.currentMeta;
  const stage = stageOfRel(state.currentRel);
  const stageLabel = stage ? dirLabel(stage) : stage;
  let html = '';
  if (stageLabel) html += `<span class="meta-chip stage">${escapeHtml(t('stage'))}${escapeHtml(t('sep'))}${escapeHtml(stageLabel)}</span>`;
  if (m.projectType) html += `<span class="meta-chip type">${escapeHtml(t('projectType'))}${escapeHtml(t('sep'))}${escapeHtml(m.projectType)}</span>`;
  if (Array.isArray(m.tags)) m.tags.forEach(t => html += `<span class="meta-chip tag">#${escapeHtml(t)}</span>`);
  if (m.description) html += `<span class="meta-chip">${escapeHtml(m.description)}</span>`;
  if (m.version != null) html += `<span class="meta-chip">v${escapeHtml(String(m.version))}</span>`;
  if (m.updatedAt) html += `<span class="meta-chip">${escapeHtml(t('chipUpdated'))}${escapeHtml(t('sep'))}${escapeHtml(String(m.updatedAt).slice(0, 16).replace('T', ' '))}</span>`;
  bar.innerHTML = html;
}

function renderContent() {
  const isWorkflow = state.currentRel.startsWith('workflows/');
  if (isWorkflow) {
    renderWorkflowPreview();
  } else {
    renderPromptPreview();
  }
}

function renderPromptPreview() {
  $('editor-wrap').classList.add('hidden');
  $('preview-wrap').classList.remove('hidden');
  const { body } = parseFrontmatter(state.currentContent);
  const preview = $('preview');
  preview.innerHTML = renderMarkdown(body);
  enhanceCodeBlocks(preview);
}

function renderWorkflowPreview() {
  $('editor-wrap').classList.add('hidden');
  $('preview-wrap').classList.remove('hidden');
  const { meta, body } = parseFrontmatter(state.currentContent);
  const steps = parseWorkflowFlow(state.currentContent);
  const preview = $('preview');
  let flowHtml = '';
  if (steps.length) {
    flowHtml = renderFlowDiagram(steps, meta.title);
  }
  preview.innerHTML = flowHtml + renderMarkdown(body);
  enhanceCodeBlocks(preview);
  // 绑定节点点击跳转
  preview.querySelectorAll('.flow-node').forEach(n => {
    n.addEventListener('click', () => {
      const p = n.dataset.prompt;
      if (p) openFile(p);
    });
  });
  // 布局后绘制连线（等一帧，确保 DOM 已布局出尺寸）
  requestAnimationFrame(drawFlowEdges);
}

// 分支流程图：拓扑分层 + SVG 连线
function renderFlowDiagram(steps, title) {
  const byId = new Map(steps.map(s => [s.id, s]));
  // 入度计算
  const indeg = new Map(steps.map(s => [s.id, 0]));
  for (const s of steps) {
    for (const n of s.next) {
      if (byId.has(n)) indeg.set(n, (indeg.get(n) || 0) + 1);
    }
  }
  // 层级 = 所有前驱层级最大值 + 1（最长前导路径）。
  // Kahn 拓扑排序：出队时直接把层级推给后继，一趟 O(V+E) 完成。
  // 原先的写法是"排序后再对每个节点回扫全部 steps 找前驱"，O(V·E)。
  const level = new Map();
  const indeg2 = new Map(indeg);
  const queue = steps.filter(s => (indeg.get(s.id) || 0) === 0).map(s => s.id);
  for (const id of queue) level.set(id, 0);
  let visited = 0;
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    visited++;
    const lv = level.get(id) || 0;
    for (const n of byId.get(id).next) {
      if (!byId.has(n)) continue;
      // 后继层级取所有前驱的最大值 + 1
      level.set(n, Math.max(level.get(n) == null ? 0 : level.get(n), lv + 1));
      indeg2.set(n, indeg2.get(n) - 1);
      if (indeg2.get(n) === 0) queue.push(n);
    }
  }
  // 环里的节点入度永远降不到 0，拿不到层级。
  // 不能放着不管：Math.max(...空) 是 -Infinity，Array.from({length:-Infinity})
  // 得到零长数组，下面 layers[...].push 就会抛错，而这个异常会被 openFile 的
  // catch 吞掉并把 currentRel 置空，留下"有标签页却没有当前文件"的坏状态，
  // 之后任何走到 renderBreadcrumb 的操作都会在 null 上再炸一次，只能重启。
  // 这里把成环的节点按原始顺序追加到末层，图仍然画得出来，用户也能看到它们。
  const hasCycle = visited < steps.length;
  if (hasCycle) {
    // 全图成环时没有任何入口节点，level 是空的，末层要从 -1 起算，
    // 否则所有节点都落到第 1 层、第 0 层空着，画出来是一条空白层。
    let tail = -1;
    for (const lv of level.values()) tail = Math.max(tail, lv);
    for (const s of steps) if (!level.has(s.id)) level.set(s.id, tail + 1);
  }
  const maxLevel = steps.length ? Math.max(0, ...level.values()) : 0;
  // 分层
  const layers = Array.from({ length: maxLevel + 1 }, () => []);
  for (const s of steps) layers[level.get(s.id) || 0].push(s);
  // 渲染：逐层横向，层内节点等高排列；连线由 drawFlowEdges 绘制
  let html = `<div class="flow-diagram"><div class="flow-title">${escapeHtml(t('flowDiagram'))}${title ? escapeHtml(t('sep')) + escapeHtml(title) : ''}</div>`;
  html += `<div class="flow-canvas">`;
  html += `<svg class="flow-edges" xmlns="http://www.w3.org/2000/svg"></svg>`;
  for (let lv = 0; lv < layers.length; lv++) {
    html += `<div class="flow-layer" data-level="${lv}">`;
    for (const s of layers[lv]) {
      const label = s.label || s.id || t('flowStep');
      html += `<div class="flow-node" data-id="${escapeHtml(s.id || '')}" data-prompt="${escapeHtml(s.prompt || '')}" data-label="${escapeHtml(label)}">${escapeHtml(label)}</div>`;
    }
    html += `</div>`;
  }
  html += `</div></div>`;
  // 计算 edges 并暂存到全局（drawFlowEdges 布局后读）
  flowEdges = [];
  for (const s of steps) {
    for (const n of s.next) {
      if (byId.has(n)) flowEdges.push({ from: s.id, to: n });
    }
  }
  return html;
}

let flowEdges = [];

// 在 flow-canvas 内根据节点位置绘制 SVG 贝塞尔连线（布局后调用）
function drawFlowEdges() {
  const canvas = document.querySelector('.flow-canvas');
  if (!canvas) return;
  const svg = canvas.querySelector('.flow-edges');
  if (!svg) return;
  const cRect = canvas.getBoundingClientRect();
  const nodes = new Map();
  canvas.querySelectorAll('.flow-node').forEach(n => {
    const r = n.getBoundingClientRect();
    nodes.set(n.dataset.id, {
      x: r.left - cRect.left + r.width / 2,
      bottomY: r.top - cRect.top + r.height,
      topY: r.top - cRect.top
    });
  });
  svg.innerHTML = '';
  svg.setAttribute('width', cRect.width);
  svg.setAttribute('height', cRect.height);
  for (const e of flowEdges) {
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (!from || !to) continue;
    const x1 = from.x, y1 = from.bottomY;
    const x2 = to.x, y2 = to.topY;
    const dy = Math.max(20, (y2 - y1) / 2);
    const path = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('d', path);
    el.setAttribute('class', 'flow-edge');
    svg.appendChild(el);
  }
}

// ===== 编辑模式 =====
// 脏状态：编辑器内容与进入编辑时的快照不一致就算脏。
// 原先完全没有这个概念，于是丢弃和保存两种相反行为都是静默的——
// 按 Esc / 点取消 / 关标签直接丢掉草稿，而点树里另一个文件或切标签
// 反而把未完成的草稿强制写进磁盘。i18n 里的 discardConfirm 文案
// （zh/en 都有）就是为这个确认框准备的，之前一直没接上。
function isDirty() {
  if (!state.editMode) return false;
  const ed = $('editor');
  return !!ed && ed.value !== state.editBaseline;
}

function markDirtyIndicator() {
  const btn = $('btn-edit');
  if (btn) btn.textContent = isDirty() ? t('editing') + ' *' : t('editing');
}

async function enterEditMode() {
  if (!state.currentRel) return;
  state.editMode = true;
  $('preview-wrap').classList.add('hidden');
  $('editor-wrap').classList.remove('hidden');
  $('editor').value = state.currentContent;
  state.editBaseline = state.currentContent; // 脏判断的基准
  $('editor').focus();
  $('btn-edit').textContent = t('editing');
}

// save=true 保存后退出；save=false 丢弃退出。
// 丢弃且有未保存改动时先确认，避免草稿无声消失。
// 返回 false = 用户取消，调用方必须中止自己的后续动作（切文件/切标签等）。
async function exitEditMode(save) {
  if (!state.editMode) return true;
  if (save) {
    const ok = await saveCurrent();
    if (!ok) return false;
  } else {
    if (isDirty() && !(await confirmDialog(t('discardConfirm')))) return false;
    state.editMode = false;
    state.editBaseline = '';
    $('preview-wrap').classList.remove('hidden');
    $('editor-wrap').classList.add('hidden');
    $('btn-edit').textContent = t('edit');
    renderContent();
    return true;
  }
  state.editMode = false;
  state.editBaseline = '';
  $('preview-wrap').classList.remove('hidden');
  $('editor-wrap').classList.add('hidden');
  $('btn-edit').textContent = t('edit');
  return true;
}

// 菜单里的"重新加载"走这里而不是 role:'reload'。
// 原先是 role:'reload'，Ctrl+R 直接重载，编辑中的草稿无声消失。
// 也不能靠 beforeunload：Electron 里它不会像浏览器那样弹原生确认，
// 而是静默取消这次重载——按下 Ctrl+R 什么都不发生，比丢草稿更让人困惑。
// 所以明确问一次，用户确认了才让主进程重载。
async function requestReload() {
  if (isDirty() && !(await confirmDialog(t('discardConfirm')))) return;
  await api.reloadWindow();
}

async function saveCurrent() {
  if (!state.currentRel) return false;
  const content = $('editor').value;
  try {
    const { content: saved, meta } = await api.saveFile(state.currentRel, content);
    state.currentContent = saved;
    state.currentMeta = meta;
    // 存盘成功即视为不脏。基准用编辑器里的原文而不是 saved：
    // 主进程会回写 version/updatedAt，saved 和输入框内容天生不同，
    // 拿 saved 当基准会让保存后立刻又显示未保存。
    state.editBaseline = content;
    // 同步到标签
    const tab = state.tabs.find(t => t.rel === state.currentRel);
    if (tab) { tab.content = saved; tab.meta = meta; tab.loaded = true; }
    toast(t('saved'), 'success');
    setMetaList(await api.getMetaList());
    renderBreadcrumb();
    renderMetaBar();
    renderContent();
    renderTabs();
    // 只更新当前行在文件树中的显示标题，不整树重建（保留滚动/展开状态）
    document.querySelectorAll('.tree-row.file').forEach(r => {
      if (r.__rel === state.currentRel) {
        const nameEl = r.querySelector('.name');
        if (nameEl) nameEl.textContent = meta.title || fileNameNoExt(r.__rel.split('/').pop());
      }
    });
    updateStatusCounts();
    renderStats();
    updateStatusInfo((meta.title || state.currentRel) + ' · ' + t('saved') + ' v' + (meta.version || '?'));
    return true;
  } catch (e) {
    toast(tErr('saveFailed', e), 'error');
    return false;
  }
}

// ===== 复制 =====
async function copyContent() {
  if (!state.currentRel) return;
  const { body } = parseFrontmatter(state.currentContent);
  try {
    await navigator.clipboard.writeText(body);
    toast(t('copySuccess'), 'success');
  } catch {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = body;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast(t('copied'), 'success');
  }
}

// ===== 新建 =====
async function pickProjectType() {
  const types = state.config.projectTypes || ['前端项目', '后端项目', '数据分析', '脚本工具', '其他']; // i18n-exempt: 用户数据，会写进 frontmatter，翻译会破坏已有文件
  const input = await promptInput(t('pickProjectType'), types.join(' / '));
  if (!input) return null;
  const found = types.find(t => t === input);
  if (found) return found;
  // 不在列表则自动添加（用户手写新类型）
  try {
    await api.addProjectType(input);
    state.config.projectTypes = (await api.getConfig()).projectTypes;
    populateFilters();
  } catch (e) { /* 已存在则忽略 */ }
  return input;
}

async function newPrompt() {
  const stage = await pickStage();
  if (!stage) return;
  const name = await promptInput(t('promptNameTitle'), t('promptNamePlaceholder'));
  if (!name) return;
  const projectType = (await pickProjectType()) || '其他'; // i18n-exempt: 用户数据默认值
  const rel = `prompts/${stage}/${name}.md`;
  const stageLabel = dirLabel(stage);
  const content = `---
title: ${name}
stage: ${stage}
projectType: ${projectType}
tags: []
description:
---

# ${name}

`;
  try {
    await api.createFile(rel, content);
    toast(t('created'), 'success');
    await refreshTree();
    await openFile(rel);
    enterEditMode();
  } catch (e) {
    toast(tErr('createFailed', e), 'error');
  }
}

async function newWorkflow() {
  const name = await promptInput(t('workflowNameTitle'), t('workflowNamePlaceholder'));
  if (!name) return;
  const rel = `workflows/${name}.md`;
  // i18n-exempt-start: 这是写入 .md 的文件内容，不是界面文案；
  // 且 prompt 路径指向种子提示词的中文文件名，翻译会让流程图节点全部失效。
  // prompt 必须是库根起算的完整相对路径（含 prompts/ 前缀）：
  // 节点点击走 openFile(rel) → 主进程 safeJoin(rel)，少了前缀就解析不到文件。
  const content = `---
title: ${name}
flow:
  - id: step1
    prompt: prompts/project-init/需求分析.md
    label: 需求分析
    next: step2
  - id: step2
    prompt: prompts/code-generation/功能实现.md
    label: 功能实现
    next: step3
  - id: step3
    prompt: prompts/code-review/代码审查.md
    label: 代码审查
---

# ${name}

本工作流定义了 ${name} 的步骤顺序。点击上方流程图节点可跳转到对应提示词。
`;
  // i18n-exempt-end
  try {
    await api.createFile(rel, content);
    toast(t('createdWorkflow'), 'success');
    await refreshTree();
    await openFile(rel);
    enterEditMode();
  } catch (e) {
    toast(tErr('createFailed', e), 'error');
  }
}

async function newFolder() {
  const name = await promptInput(t('newFolderTitle'), t('newFolderPlaceholder'));
  if (!name) return;
  const safe = name.replace(/[\\/:*?"<>|]/g, '').trim();
  if (!safe) { toast(t('invalidFolderName'), 'error'); return; }
  const rel = `prompts/${safe}`;
  try {
    await api.createFile(`${rel}/.gitkeep`, '');
    toast(t('createdFolder'), 'success');
    await refreshTree();
  } catch (e) {
    toast(tErr('createFolderFailed', e), 'error');
  }
}

async function pickStage(title = t('pickStageTitle')) {
  const opts = state.stages.map(s => dirLabel(s)).join(' / ');
  const input = await promptInput(title, opts);
  if (!input) return null;
  const found = state.stages.find(s => dirLabel(s) === input || s === input);
  return found || state.stages[0];
}

// 当前挂起的 promptInput 的 resolve 包装。
// 弹层有三条"正常"关闭路径（确定/取消/回车）和两条"外部"关闭路径
// （点弹层外面、按 Esc）。外部路径原先只是把弹层藏起来，Promise 永远不 settle，
// 于是 await promptInput 的 newPrompt/rename/duplicate/newFolder 全部永久卡死。
// 统一登记在这里，让 hideCtxMenu() 兜底 resolve(null)。
let pendingPromptDone = null;
function settlePendingPrompt() {
  if (!pendingPromptDone) return;
  const fn = pendingPromptDone;
  pendingPromptDone = null; // 先清空再调用，避免 done() 里的 hideCtxMenu 递归回来
  fn(null);
}

function promptInput(title, placeholder) {
  return new Promise(resolve => {
    const menu = $('ctx-menu');
    menu.innerHTML = `
      <div class="ctx-prompt-wrap">
        <div class="ctx-prompt-title">${escapeHtml(title)}</div>
        <input id="ctx-input" class="ctx-prompt-input" placeholder="${escapeHtml(placeholder || '')}">
        <div class="ctx-prompt-actions">
          <button class="btn-link" id="ctx-cancel">${escapeHtml(t('cancel_'))}</button>
          <button class="btn-primary" id="ctx-ok">${escapeHtml(t('ok'))}</button>
        </div>
      </div>`;
    showCenteredMenu();
    const inp = $('ctx-input');
    inp.focus();
    const done = (v) => {
      pendingPromptDone = null;
      hideCtxMenu();
      menu.innerHTML = '';
      resolve(v);
    };
    pendingPromptDone = done;
    $('ctx-ok').onclick = () => done(inp.value.trim());
    $('ctx-cancel').onclick = () => done(null);
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(inp.value.trim()); }
      if (e.key === 'Escape') done(null);
    };
  });
}

// ===== 重命名 / 删除 / 移动 =====
async function renameCurrent() {
  if (!state.currentRel) return;
  const oldRel = state.currentRel;
  const segs = oldRel.split('/');
  const oldName = fileNameNoExt(segs[segs.length - 1]);
  const newName = await promptInput(t('renameTitle'), oldName);
  if (!newName || newName === oldName) return;
  const newRel = segs.slice(0, -1).join('/') + '/' + newName + '.md';
  try {
    await api.rename(oldRel, newRel);
    migrateLock(oldRel, newRel);
    // 同步标签
    const tab = state.tabs.find(t => t.rel === oldRel);
    if (tab) tab.rel = newRel;
    if (state.activeTab === oldRel) state.activeTab = newRel;
    toast(t('renamed'), 'success');
    await refreshTree();
    await openFile(newRel);
  } catch (e) {
    toast(tErr('renameFailed', e), 'error');
  }
}

async function deleteCurrent() {
  if (!state.currentRel) return;
  if (state.lockedFiles.has(state.currentRel)) {
    toast(t('lockedCannotDelete'), 'error');
    return;
  }
  if (!(await confirmDialog(t('deleteConfirm', { name: state.currentMeta.title || state.currentRel })))) return;
  try {
    await api.trash(state.currentRel);
    const delRel = state.currentRel;
    // 从标签中移除并切换
    const idx = state.tabs.findIndex(t => t.rel === delRel);
    if (idx !== -1) state.tabs.splice(idx, 1);
    state.lockedFiles.delete(delRel);
    const next = state.tabs[idx] || state.tabs[idx - 1] || null;
    if (next) {
      await switchTab(next.rel);
    } else {
      state.activeTab = null;
      state.currentRel = null;
      state.currentContent = '';
      state.currentMeta = {};
      $('content-area').classList.add('hidden');
      $('empty-state').classList.remove('hidden');
      renderTabs();
    }
    toast(t('movedToTrash'), 'success');
    await refreshTree();
  } catch (e) {
    toast(tErr('deleteFailed', e), 'error');
  }
}

async function moveCurrent() {
  if (!state.currentRel) return;
  if (!state.currentRel.startsWith('prompts/')) { toast(t('onlyPromptsMovable'), 'error'); return; }
  const stage = await pickStage(t('moveToStage'));
  if (!stage) return;
  const segs = state.currentRel.split('/');
  const fileName = segs[segs.length - 1];
  const newRel = `prompts/${stage}/${fileName}`;
  if (newRel === state.currentRel) return;
  try {
    await api.rename(state.currentRel, newRel);
    migrateLock(state.currentRel, newRel);
    // 迁移标签
    const tab = state.tabs.find(t => t.rel === state.currentRel);
    if (tab) tab.rel = newRel;
    if (state.activeTab === state.currentRel) state.activeTab = newRel;
    toast(t('moved'), 'success');
    await refreshTree();
    await openFile(newRel);
  } catch (e) {
    toast(tErr('moveFailed', e), 'error');
  }
}

// 拖拽移动：把 srcRel 移动到目录 dirRel 下（保留文件名）
async function moveFileToDir(srcRel, dirRel) {
  if (!srcRel || !dirRel) return;
  // 不能拖到自己内部（父目录是自身或其祖先）
  if (dirRel === srcRel || srcRel.startsWith(dirRel + '/')) {
    toast(t('cannotMoveToSelf'), 'error'); return;
  }
  if (!dirRel.startsWith('prompts/')) { toast(t('onlyPromptsDir'), 'error'); return; }
  const fileName = srcRel.split('/').pop();
  const newRel = `${dirRel}/${fileName}`;
  if (newRel === srcRel) { toast(t('alreadyInDir'), 'error'); return; }
  try {
    await api.rename(srcRel, newRel);
    migrateLock(srcRel, newRel);
    // 迁移标签
    const tab = state.tabs.find(t => t.rel === srcRel);
    if (tab) tab.rel = newRel;
    if (state.activeTab === srcRel) state.activeTab = newRel;
    toast(t('moved'), 'success');
    await refreshTree();
    if (state.currentRel === srcRel) await openFile(newRel);
  } catch (e) {
    toast(tErr('moveFailed', e), 'error');
  }
}

async function duplicateCurrent() {
  if (!state.currentRel) return;
  const segs = state.currentRel.split('/');
  const baseName = fileNameNoExt(segs[segs.length - 1]);
  const dir = segs.slice(0, -1).join('/');
  const newName = await promptInput(t('duplicateTitle'), baseName + t('duplicateSuffix'));
  if (!newName) return;
  const newRel = dir + '/' + newName + '.md';
  try {
    await api.createFile(newRel, state.currentContent);
    toast(t('duplicated'), 'success');
    await refreshTree();
    await openFile(newRel);
  } catch (e) {
    toast(tErr('duplicateFailed', e), 'error');
  }
}

// ===== 锁定（防误删） =====
async function toggleLockFile(rel) {
  if (state.lockedFiles.has(rel)) {
    state.lockedFiles.delete(rel);
    toast(t('unlocked'), 'success');
  } else {
    state.lockedFiles.add(rel);
    toast(t('locked'), 'success');
  }
  await saveLockedDebounced();
  // 更新树上的锁定标记
  document.querySelectorAll('.tree-row.file').forEach(r => {
    r.classList.toggle('locked', state.lockedFiles.has(r.__rel));
  });
}
const saveLockedDebounced = debounce(async () => {
  try { await api.setConfig({ lockedFiles: Array.from(state.lockedFiles) }); }
  catch (e) { console.error('保存锁定状态失败:', e); } // i18n-exempt: 开发日志
}, 400);
// 重命名/移动时把锁定路径迁移到新路径
function migrateLock(oldRel, newRel) {
  if (state.lockedFiles.has(oldRel)) {
    state.lockedFiles.delete(oldRel);
    state.lockedFiles.add(newRel);
    saveLockedDebounced();
  }
}

// ===== 上下文菜单 =====
function showCtxMenu(x, y, node) {
  const menu = $('ctx-menu');
  const items = [];
  if (node.type === 'file') {
    items.push({ label: t('ctxOpen'), act: () => openFile(node.rel) });
    items.push({ label: t('ctxCopyContent'), act: async () => { await openFile(node.rel); copyContent(); } });
    items.push({ label: t('ctxDuplicate'), act: async () => { await openFile(node.rel); duplicateCurrent(); } });
    items.push({ label: t('rename'), act: async () => { await openFile(node.rel); renameCurrent(); } });
    if (node.rel.startsWith('prompts/')) items.push({ label: t('ctxMoveTo'), act: async () => { await openFile(node.rel); moveCurrent(); } });
    const locked = state.lockedFiles.has(node.rel);
    items.push({ label: locked ? t('unlock') : t('lock'), act: async () => { await openFile(node.rel); toggleLockFile(node.rel); } });
    items.push({ sep: true });
    items.push({ label: t('delete'), danger: true, act: async () => { await openFile(node.rel); deleteCurrent(); } });
  } else {
    items.push({ label: t('ctxNewPromptHere'), act: () => newPromptInDir(node) });
  }
  menu.innerHTML = items.map((it, i) => it.sep
    ? `<div class="ctx-sep"></div>`
    : `<div class="ctx-item ${it.danger ? 'danger' : ''}" data-i="${i}">${escapeHtml(it.label)}</div>`
  ).join('');
  menu.classList.remove('ctx-centered'); // 右键菜单按坐标定位，不居中
  menu.classList.remove('hidden');
  menu.style.left = Math.min(x, window.innerWidth - 160) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 40) + 'px';
  // 下标必须从 data-i 读回来。分隔符渲染成 .ctx-sep 而不是 .ctx-item，
  // 用 forEach 的序号会跳过它，导致分隔符之后的每一项都偏移一格
  // （表现是点"删除"实际拿到分隔符对象，抛 act is not a function）。
  menu.querySelectorAll('.ctx-item').forEach((el) => {
    const it = items[Number(el.dataset.i)];
    if (!it || typeof it.act !== 'function') return;
    el.onclick = () => { hideCtxMenu(); it.act(); };
  });
}

async function newPromptInDir(dirNode) {
  // dirNode.rel 形如 prompts/project-init
  if (!dirNode.rel.startsWith('prompts/')) { toast(t('selectStageDir'), 'error'); return; }
  const stage = dirNode.rel.split('/')[1];
  const name = await promptInput(t('promptNameTitle'), t('promptNamePlaceholder'));
  if (!name) return;
  const projectType = (await pickProjectType()) || '其他'; // i18n-exempt: 用户数据默认值
  const rel = `${dirNode.rel}/${name}.md`;
  const content = `---
title: ${name}
stage: ${stage}
projectType: ${projectType}
tags: []
description:
---

# ${name}

`;
  try {
    await api.createFile(rel, content);
    toast(t('created'), 'success');
    await refreshTree();
    await openFile(rel);
    enterEditMode();
  } catch (e) {
    toast(tErr('createFailed', e), 'error');
  }
}

// 点击弹层外部就关掉它。
// 必须用 mousedown 而不是 click：promptInput() 是在按钮的 click 里打开弹层的，
// 同一次 click 会继续冒泡到 document，如果这里监听 click，弹层刚打开就被关掉，
// 表现就是"点新建提示词没反应"。mousedown 在 click 之前触发，不会误杀。
document.addEventListener('mousedown', (e) => {
  const menu = $('ctx-menu');
  if (!menu.contains(e.target)) hideCtxMenu();
});

function hideCtxMenu() {
  const menu = $('ctx-menu');
  menu.classList.add('hidden');
  menu.classList.remove('ctx-centered');
  // 关闭弹层必须同时结算 promptInput 的 Promise，否则 await 它的
  // 新建/重命名/复制/新建目录流程会永久挂起（界面看着空闲，实际回不来了）。
  // done() 会先把 pendingPromptDone 置空再调用这里，所以不会递归。
  settlePendingPrompt();
}

// 居中显示弹层。showCtxMenu 会写内联 left/top，这里必须清掉，
// 否则弹层会跑到上一次右键的位置去（.ctx-menu 的 CSS 本身没有 left/top）。
function showCenteredMenu() {
  const menu = $('ctx-menu');
  menu.style.left = '';
  menu.style.top = '';
  menu.classList.add('ctx-centered');
  menu.classList.remove('hidden');
}

// ===== 搜索 =====
// 高亮文本中的关键词（结果已 escapeHtml，此处安全地包 <mark>）
function highlightTerm(text, q) {
  if (!q || !text) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const out = [];
  let i = 0;
  let idx = lower.indexOf(ql);
  while (idx !== -1) {
    out.push(text.slice(i, idx), '<mark>', text.slice(idx, idx + ql.length), '</mark>');
    i = idx + ql.length;
    idx = lower.indexOf(ql, i);
  }
  out.push(text.slice(i));
  return out.join('');
}
const doSearch = debounce(async (q) => {
  const box = $('search-results');
  if (!q) {
    box.classList.add('hidden');
    $('tree').classList.remove('hidden');
    return;
  }
  const results = await api.search(q);
  $('tree').classList.add('hidden');
  box.classList.remove('hidden');
  if (!results.length) {
    box.innerHTML = '<div class="search-empty">' + escapeHtml(t('noResults')) + '</div>';
    return;
  }
  box.innerHTML = results.map(r => `
    <div class="search-item" data-rel="${escapeHtml(r.rel)}">
      <div class="si-title">${highlightTerm(escapeHtml(r.name), q)}</div>
      <div class="si-meta">${escapeHtml(r.stage ? dirLabel(r.stage) : '')}${r.projectType ? ' · ' + escapeHtml(r.projectType) : ''}</div>
      ${r.snippet ? `<div class="si-snippet">${highlightTerm(escapeHtml(r.snippet), q)}</div>` : ''}
    </div>
  `).join('');
  box.querySelectorAll('.search-item').forEach(el => {
    el.onclick = () => openFile(el.dataset.rel);
  });
}, 250);

// ===== 筛选 =====
function populateFilters() {
  const stageSel = $('filter-stage');
  const typeSel = $('filter-type');
  stageSel.innerHTML = '<option value="">' + escapeHtml(t('allStagesOption')) + '</option>' + state.stages.map(s => `<option value="${s}">${escapeHtml(dirLabel(s))}</option>`).join('');
  const types = [...new Set(state.metaList.map(m => m.meta.projectType).filter(Boolean))];
  typeSel.innerHTML = '<option value="">' + escapeHtml(t('allTypes')) + '</option>' + types.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
  // 标签自动补全（收集所有提示词的标签）
  const tagSet = new Set();
  for (const m of state.metaList) {
    if (Array.isArray(m.meta.tags)) m.meta.tags.forEach(t => t && tagSet.add(String(t)));
  }
  const dl = $('tag-datalist');
  if (dl) dl.innerHTML = [...tagSet].sort().map(tagName => `<option value="${escapeHtml(tagName)}">`).join('');
}

function applyFilter() {
  const stage = $('filter-stage').value;
  const type = $('filter-type').value;
  const tag = $('filter-tag').value.trim().toLowerCase();
  const hasFilter = stage || type || tag;
  state.filter = { stage, type, tag };
  // 过滤文件树
  const allFileRows = document.querySelectorAll('.tree-row.file');
  allFileRows.forEach(row => {
    if (!hasFilter) { row.style.display = ''; return; }
    const rel = row.__rel;
    if (!rel) return;
    const m = state.metaByRel.get(rel);
    let show = true;
    if (stage && stageOfRel(rel) !== stage) show = false;
    if (type && (!m || m.meta.projectType !== type)) show = false;
    if (tag && (!m || !Array.isArray(m.meta.tags) || !m.meta.tags.some(t => String(t).toLowerCase().includes(tag)))) show = false;
    row.style.display = show ? '' : 'none';
  });
  // 隐藏无可见子项的目录行
  if (hasFilter) {
    document.querySelectorAll('.tree-node').forEach(node => {
      const dirRow = node.querySelector(':scope > .tree-row.dir');
      if (!dirRow) return;
      const childrenWrap = node.querySelector(':scope > .tree-children');
      const visible = childrenWrap ? Array.from(childrenWrap.querySelectorAll(':scope > .tree-node > .tree-row')).filter(r => r.style.display !== 'none').length : 0;
      dirRow.style.display = visible > 0 ? '' : 'none';
    });
  } else {
    document.querySelectorAll('.tree-row.dir').forEach(r => r.style.display = '');
  }
}

// 更可靠的方式：重建树时给每行打上 __rel —— 已在 buildTreeNode 中实现（row.__rel = node.rel）

// ===== 版本历史 =====
async function openHistory() {
  if (!state.currentRel) return;
  state.historyRel = state.currentRel;
  const list = await api.listVersions(state.historyRel);
  const drawer = $('history-drawer');
  drawer.classList.remove('hidden');
  $('version-detail').classList.add('hidden');
  $('version-list').classList.remove('hidden');
  const vl = $('version-list');
  if (!list.length) {
    vl.innerHTML = '<div class="search-empty">' + escapeHtml(t('noHistory')) + '</div>';
    return;
  }
  vl.innerHTML = list.map(v => `
    <div class="version-item" data-file="${escapeHtml(v.file)}">
      <span class="vi-time">${escapeHtml(formatVersionTime(v.timestamp))}<small>${escapeHtml(v.pinned ? t('pinned') : t('versionNth', { n: list.length - list.indexOf(v) }))}</small></span>
      <span class="vi-actions">
        <button class="pin-btn ${v.pinned ? 'pinned' : ''}" data-pin="${escapeHtml(v.file)}">${v.pinned ? '⭐' : '☆'}</button>
        <button class="btn-link" data-view="${escapeHtml(v.file)}">${escapeHtml(t('view'))}</button>
        <button class="btn-link danger" data-roll="${escapeHtml(v.file)}">${escapeHtml(t('rollback'))}</button>
      </span>
    </div>
  `).join('');
  vl.querySelectorAll('.version-item').forEach(item => {
    const file = item.dataset.file;
    item.querySelector('[data-view]').onclick = () => viewVersion(file);
    item.querySelector('[data-roll]').onclick = async () => {
      if (!(await confirmDialog(t('rollbackConfirm')))) return;
      try {
        const { content, meta } = await api.rollbackVersion(state.historyRel, file);
        if (state.currentRel === state.historyRel) {
          state.currentContent = content;
          state.currentMeta = meta;
          renderBreadcrumb();
          renderMetaBar();
          renderContent();
        }
        toast(t('rollbackSuccess'), 'success');
        openHistory();
      } catch (e) {
        toast(tErr('rollbackFailed', e), 'error');
      }
    };
    item.querySelector('[data-pin]').onclick = async (e) => {
      e.stopPropagation();
      const pinned = !e.target.classList.contains('pinned');
      await api.pinVersion(state.historyRel, file, pinned);
      openHistory();
    };
  });
}

// 版本文件名 → 可读时间。
// 形态有三种，必须都能吃下：
//   20260826-143000          早期快照（无毫秒）
//   20260826-143000-456      现在的快照（timestampName 总是带毫秒）
//   restored-123456-<上面任一>.md   从回收站并回来的快照
// 之前的正则只认第一种，结果版本列表显示的是原始串；viewVersion 还会把
// 带 .md 的文件名整个传进来，标题栏直接露出扩展名。
function formatVersionTime(ts) {
  const name = String(ts == null ? '' : ts)
    .replace(/\.md$/i, '')
    .replace(/^restored-\d+-/, '');
  const m = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{3}))?$/);
  if (!m) return ts;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

async function viewVersion(file) {
  const versionContent = await api.readVersion(state.historyRel, file);
  $('version-list').classList.add('hidden');
  $('version-detail').classList.remove('hidden');
  $('version-detail-title').textContent = formatVersionTime(file);
  const diffEl = $('version-diff');
  // 与当前版本对比
  const curBody = parseFrontmatter(state.currentContent).body;
  const verBody = parseFrontmatter(versionContent).body;
  renderDiff(diffEl, curBody, verBody);
}

function renderDiff(el, oldText, newText) {
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);
  let html = '';
  for (const [op, text] of diffs) {
    if (op === 0) {
      // 上下文，每行渲染占位；空行显示一个空格以保持行号对齐视觉
      const lines = text.split('\n');
      for (const line of lines) {
        const display = line === '' ? '&nbsp;' : escapeHtml(line);
        html += `<div class="diff-line diff-ctx">${display}</div>`;
      }
    } else if (op === 1) {
      for (const line of text.split('\n')) {
        const display = line === '' ? '&nbsp;' : escapeHtml(line);
        html += `<div class="diff-line diff-add">+ ${display}</div>`;
      }
    } else {
      for (const line of text.split('\n')) {
        const display = line === '' ? '&nbsp;' : escapeHtml(line);
        html += `<div class="diff-line diff-del">- ${display}</div>`;
      }
    }
  }
  if (!html) html = '<div class="diff-empty">' + escapeHtml(t('sameVersion')) + '</div>';
  el.innerHTML = html;
}

// ===== 回收站 =====
async function openTrash() {
  const index = await api.listTrash();
  const drawer = $('trash-drawer');
  drawer.classList.remove('hidden');
  const list = $('trash-list');
  if (!index.items.length) {
    list.innerHTML = '<div class="search-empty">' + escapeHtml(t('trashEmpty')) + '</div>';
    return;
  }
  list.innerHTML = index.items.map(it => `
    <div class="version-item">
      <span class="vi-time">${escapeHtml(it.name)}<small>${escapeHtml(it.originalRel)} · ${escapeHtml(String(it.trashedAt).slice(0, 16).replace('T', ' '))}</small></span>
      <span class="vi-actions">
        <button class="btn-link" data-restore="${escapeHtml(it.id)}">${escapeHtml(t('restore'))}</button>
      </span>
    </div>
  `).join('');
  list.querySelectorAll('[data-restore]').forEach(b => {
    b.onclick = async () => {
      try {
        await api.restore(b.dataset.restore);
        toast(t('restoreSuccess'), 'success');
        await refreshTree();
        openTrash();
      } catch (e) {
        toast(tErr('restoreFailed', e), 'error');
      }
    };
  });
}

// ===== 设置 =====
async function openSettings() {
  const drawer = $('settings-drawer');
  drawer.classList.remove('hidden');
  renderSettingsTypes();
}
function renderSettingsTypes() {
  const list = $('types-list');
  const types = state.config.projectTypes || ['前端项目', '后端项目', '数据分析', '脚本工具', '其他']; // i18n-exempt: 用户数据，会写进 frontmatter，翻译会破坏已有文件
  const deleteLabel = t('delete');
  list.innerHTML = types.map(type => `
    <div class="type-tag">
      <span>${escapeHtml(type)}</span>
      <button class="btn-link" data-type="${escapeHtml(type)}" title="${escapeHtml(deleteLabel)}">✕</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-type]').forEach(b => {
    b.onclick = async () => {
      try {
        await api.removeProjectType(b.dataset.type);
        state.config.projectTypes = (await api.getConfig()).projectTypes;
        renderSettingsTypes();
        toast(t('deleted'), 'success');
        populateFilters();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
}
$('btn-add-type').onclick = async () => {
  const inp = $('new-type-input');
  const val = inp.value.trim();
  if (!val) { toast(t('typeExistsOrRequired'), 'error'); return; }
  try {
    await api.addProjectType(val);
    state.config.projectTypes = (await api.getConfig()).projectTypes;
    renderSettingsTypes();
    populateFilters();
    inp.value = '';
    toast(t('added'), 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
};
$('new-type-input').onkeydown = (e) => {
  if (e.key === 'Enter') $('btn-add-type').click();
};

// ===== 导出 =====
async function exportZip() {
  // 必须有 try/catch：导出失败（目标不可写/磁盘满）时主进程现在会 reject，
  // 不接的话就是一个未处理 rejection，用户那边毫无反馈。
  try {
    const res = await api.exportZip();
    if (res.ok) toast(t('exportedTo') + t('sep') + res.path, 'success');
    else toast(t('exportCanceled'));
  } catch (e) {
    toast(tErr('exportFailed', e), 'error');
  }
}
async function importSingle() {
  try {
    const res = await api.importSingle();
    if (res.ok) {
      toast(t('imported') + t('sep') + res.rel, 'success');
      await refreshTree();
    }
  } catch (e) { toast(tErr('importFailed', e), 'error'); }
}
async function importZip() {
  try {
    const res = await api.importZip();
    if (res.ok) {
      toast(t('importedZip'), 'success');
      await refreshTree();
    }
  } catch (e) { toast(tErr('importFailed', e), 'error'); }
}
async function exportSingle() {
  if (!state.currentRel) return;
  const res = await api.exportSingle(state.currentRel);
  if (res.ok) toast(t('exportedTo') + t('sep') + res.path, 'success');
  else toast(t('exportCanceled'));
}

// ===== 主题 =====
// setConfig 现在会在写盘失败时 reject（主进程抛 E_CONFIG_WRITE）。不接住的话
// 是个 unhandled rejection：界面照常变色，用户以为存上了，重启后又变回来。
// 这里不回滚视觉效果——本次会话内切换是真的生效了，只是存不下来，
// 所以照常切换 + 明确告诉用户"没存住"。
async function toggleTheme() {
  const cur = state.config.theme === 'dark' ? 'light' : 'dark';
  state.config.theme = cur;
  document.body.className = 'theme-' + cur;
  try {
    await api.setConfig({ theme: cur });
  } catch (e) {
    toast(describeError(e), 'error');
  }
}

// ===== 语言切换 =====
function updateLangButtons() {
  const z = $('btn-lang-zh'), e = $('btn-lang-en');
  if (z) z.classList.toggle('active', state.config.lang === 'zh');
  if (e) e.classList.toggle('active', state.config.lang === 'en');
}
async function setLang(lang) {
  if (state.config.lang === lang) return;
  state.config.lang = lang;
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  applyI18n();
  updateLangButtons();
  // 写盘失败只提示，不 return：界面语言已经切了，中断会让后面那批重渲染漏掉，
  // 结果半个界面是新语言半个是旧的。落盘失败的后果只是重启后回到旧语言。
  let langSaveError = null;
  try {
    await api.setConfig({ lang });
  } catch (e) {
    langSaveError = e;
  }
  // 重建所有依赖文案的动态内容。漏掉任何一处，切换语言后该区域会残留旧语言，
  // 直到用户重新触发一次渲染才更新。
  renderTree();
  populateFilters();
  renderTabs();
  renderStats();
  renderRecent();
  updateStatusCounts();
  if (state.currentRel) {
    renderBreadcrumb();
    renderMetaBar();
    renderContent();
  }
  updateStatusInfo(t('ready'));
  if (langSaveError) toast(describeError(langSaveError), 'error');
  else toast(t('langSwitched'), 'success');
}

// ===== 分隔条拖拽 =====
const saveSidebarWidthDebounced = debounce(async (w) => {
  try { await api.setConfig({ sidebarWidth: w }); }
  catch (e) { console.error('保存侧边栏宽度失败:', e); } // i18n-exempt: 开发日志
}, 400);
function initResizer() {
  const resizer = $('resizer');
  const sidebar = document.querySelector('.sidebar');
  let dragging = false;
  resizer.addEventListener('mousedown', () => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(480, Math.max(180, e.clientX));
    sidebar.style.width = w + 'px';
    state.sidebarWidth = w;
    saveSidebarWidthDebounced(w);
  });
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
    }
  });
  // 双击重置侧边栏宽度
  resizer.addEventListener('dblclick', () => {
    const w = 280;
    sidebar.style.width = w + 'px';
    state.sidebarWidth = w;
    saveSidebarWidthDebounced(w);
  });
}

// ===== 初始化 =====
async function init() {
  state.config = await api.getConfig();
  // 加载展开状态，默认展开根节点
  if (Array.isArray(state.config.expandedPaths)) {
    state.expandedPaths = new Set(state.config.expandedPaths);
  } else {
    state.expandedPaths = new Set(['prompts', 'workflows', 'templates']);
  }
  // 恢复侧边栏宽度
  if (typeof state.config.sidebarWidth === 'number') {
    state.sidebarWidth = Math.min(480, Math.max(180, state.config.sidebarWidth));
    document.querySelector('.sidebar').style.width = state.sidebarWidth + 'px';
  }
  // 加载最近打开列表
  if (Array.isArray(state.config.recent)) state.recent = state.config.recent;
  // 加载锁定文件
  if (Array.isArray(state.config.lockedFiles)) state.lockedFiles = new Set(state.config.lockedFiles);
  // 加载标签页（config 里只存 rel，正文等首次切过去时再读）。
  // loaded:false 是关键标记——openFile/switchTab 靠它判断要不要补读，
  // 少了它正文会一直是空串，保存时反而把文件清空。
  if (Array.isArray(state.config.tabs)) {
    state.tabs = state.config.tabs.map(rel => ({ rel, content: '', meta: {}, scroll: 0, loaded: false }));
  }
  state.activeTab = state.config.activeTab || null;
  const stagesInfo = await api.getStages();
  state.stages = stagesInfo.stages;
  state.stageLabels = stagesInfo.labels;
  document.body.className = 'theme-' + state.config.theme;
  if (!state.config.lang) state.config.lang = 'zh';
  document.documentElement.lang = state.config.lang === 'en' ? 'en' : 'zh-CN';
  updateLangButtons();

  marked.setOptions({ breaks: true, gfm: true });
  applyI18n();

  await refreshTree();

  // 恢复上次打开的标签（过滤掉已不存在的文件）
  const allRels = new Set(state.metaList.map(m => m.rel));
  state.tabs = state.tabs.filter(t => allRels.has(t.rel));
  if (state.activeTab && !allRels.has(state.activeTab)) state.activeTab = null;
  if (state.tabs.length) {
    const target = state.activeTab && allRels.has(state.activeTab) ? state.activeTab : state.tabs[0].rel;
    renderTabs();
    await openFile(target);
  }
  saveTabsDebounced();

  // 工具栏
  $('btn-new-prompt').onclick = newPrompt;
  $('btn-new-workflow').onclick = newWorkflow;
  // 空状态按钮
  if ($('empty-new-prompt')) $('empty-new-prompt').onclick = newPrompt;
  if ($('empty-new-workflow')) $('empty-new-workflow').onclick = newWorkflow;
  $('btn-new-folder').onclick = newFolder;
  $('btn-export').onclick = exportZip;
  $('btn-import').onclick = async () => {
    const menu = $('ctx-menu');
    menu.innerHTML = `
      <div class="ctx-prompt-wrap">
        <div class="ctx-prompt-title">${escapeHtml(t('importPickTitle'))}</div>
        <div class="ctx-prompt-actions stacked">
          <button class="btn-link" id="import-single-btn">${escapeHtml(t('importSingleMd'))}</button>
          <button class="btn-link" id="import-zip-btn">${escapeHtml(t('importZipBackup'))}</button>
        </div>
      </div>`;
    showCenteredMenu();
    const done = () => { hideCtxMenu(); menu.innerHTML = ''; };
    $('import-single-btn').onclick = async () => { done(); importSingle(); };
    $('import-zip-btn').onclick = async () => { done(); importZip(); };
    $('import-single-btn').focus();
  };
  $('btn-trash').onclick = openTrash;
  $('btn-settings').onclick = openSettings;
  $('btn-theme').onclick = toggleTheme;
  // 语言切换
  if ($('btn-lang-zh')) $('btn-lang-zh').onclick = () => setLang('zh');
  if ($('btn-lang-en')) $('btn-lang-en').onclick = () => setLang('en');

  // 搜索
  $('search-box').addEventListener('input', (e) => doSearch(e.target.value));
  // 搜索框按 Esc 清空
  $('search-box').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.target.value = '';
      doSearch('');
      e.target.blur();
    }
  });
  $('btn-filter-toggle').onclick = () => $('filter-panel').classList.toggle('hidden');
  $('btn-filter-apply').onclick = applyFilter;
  $('btn-filter-clear').onclick = () => {
    $('filter-stage').value = '';
    $('filter-type').value = '';
    $('filter-tag').value = '';
    applyFilter();
  };

  // 内容区按钮
  $('btn-copy').onclick = async () => {
    await copyContent();
    const btn = $('btn-copy');
    const orig = btn.textContent;
    btn.textContent = t('copySuccess');
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
  };
  $('btn-export-single').onclick = exportSingle;
  // 脏标记：编辑器有输入就更新"编辑中 *"提示。
  // 这是 isDirty() 唯一的数据来源，少了它所有丢弃确认都不会触发。
  $('editor').addEventListener('input', markDirtyIndicator);
  $('btn-edit').onclick = async () => {
    if (state.editMode) { await exitEditMode(false); }
    else enterEditMode();
  };
  // saveCurrent() 已经落盘，这里必须传 false。传 true 会让 exitEditMode 再存一次：
  // 主进程每次 save-file 都生成版本快照并 bumpAutoFields，
  // 结果一次点击写两遍盘、多一条无差异快照、version 自增 2。
  $('btn-save').onclick = () => saveCurrent().then(ok => { if (ok) exitEditMode(false); });
  $('btn-cancel').onclick = () => exitEditMode(false);
  $('btn-history').onclick = openHistory;
  $('btn-rename').onclick = renameCurrent;
  $('btn-move').onclick = moveCurrent;
  $('btn-delete').onclick = deleteCurrent;

  // 抽屉关闭
  $('btn-history-close').onclick = () => $('history-drawer').classList.add('hidden');
  $('btn-trash-close').onclick = () => $('trash-drawer').classList.add('hidden');
  $('btn-version-close-detail').onclick = openHistory;
  $('btn-settings-close').onclick = () => $('settings-drawer').classList.add('hidden');
  $('btn-empty-trash').onclick = async () => {
    if (await confirmDialog(t('emptyTrashConfirm'))) {
      await api.emptyTrash();
      openTrash();
      toast(t('trashCleared'), 'success');
    }
  };

  // 快捷键
  document.addEventListener('keydown', (e) => {
    // 编辑器内 Tab 处理：插入两个空格
    if (state.editMode && e.key === 'Tab' && document.activeElement === $('editor')) {
      e.preventDefault();
      const editor = $('editor');
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const val = editor.value;
      editor.value = val.slice(0, start) + '  ' + val.slice(end);
      editor.selectionStart = editor.selectionEnd = start + 2;
      return;
    }
    // 快捷键归属：一个键只能有一个主人。
    // 原生菜单的 accelerator 在 Windows 上优先级高于渲染进程的 keydown，
    // 所以 Ctrl+N（新建提示词）和 Ctrl+E（导出）由菜单负责——它们经
    // menu-action IPC 回到这里的 onMenuAction，功能不变。
    // 之前这里也各写了一份，那两个分支实际永远不会执行，属于误导性死代码。
    // 菜单里没有的键才留在这边：Ctrl+S / Ctrl+Shift+F / Ctrl+I / Ctrl+Shift+L。
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (state.editMode) saveCurrent();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search-box').focus();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
      // index.html 的导入按钮 tooltip 写的就是 Ctrl+I，菜单里没有对应项，
      // 所以这个键归渲染进程。
      e.preventDefault();
      $('btn-import').click();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
      // 主题切换只有这一个键（菜单项已去掉 CmdOrCtrl+T），
      // 与 index.html 里 btn-theme 的 tooltip 一致。
      e.preventDefault();
      toggleTheme();
    } else if (e.key === 'Escape') {
      // Esc 依次关闭：上下文菜单 → 抽屉 → 退出编辑
      const ctx = $('ctx-menu');
      // 走 hideCtxMenu 而不是自己加 .hidden：它会结算 promptInput 挂起的 Promise。
      // 直接改 class + innerHTML 会让按 Esc 取消命名框的流程永久卡住。
      if (!ctx.classList.contains('hidden')) { hideCtxMenu(); ctx.innerHTML = ''; return; }
      const hd = $('history-drawer'), td = $('trash-drawer');
      if (!hd.classList.contains('hidden')) { hd.classList.add('hidden'); return; }
      if (!td.classList.contains('hidden')) { td.classList.add('hidden'); return; }
      if (state.editMode) { e.preventDefault(); exitEditMode(false); }
    }
  });

  // 菜单动作
  api.onMenuAction((action) => {
    if (action === 'new-prompt') newPrompt();
    else if (action === 'new-workflow') newWorkflow();
    else if (action === 'export') exportZip();
    else if (action === 'empty-trash') {
      confirmDialog(t('emptyTrashConfirmShort')).then(ok => {
        if (ok) { api.emptyTrash().then(() => toast(t('trashCleared'), 'success')); }
      });
    }
    else if (action === 'toggle-theme') toggleTheme();
    else if (action === 'request-reload') requestReload();
  });

  initResizer();
}

// 启动
window.addEventListener('DOMContentLoaded', init);
