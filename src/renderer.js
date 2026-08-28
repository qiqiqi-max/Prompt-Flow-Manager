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
function t(key) {
  const lang = (state.config && state.config.lang) || 'zh';
  const tbl = I18N[lang] || I18N.zh;
  return tbl[key] != null ? tbl[key] : (I18N.zh[key] != null ? I18N.zh[key] : key);
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
  currentRel: null,         // 当前打开的文件相对路径
  currentContent: '',      // 文件原始内容（含 frontmatter）
  currentMeta: {},
  editMode: false,
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
  } catch (e) { console.error('保存展开状态失败:', e); }
}, 600);

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const yaml = m[1];
  const body = m[2];
  const meta = {};
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
    else val = val.replace(/^["']|["']$/g, '');
    meta[key] = val;
  }
  return { meta, body };
}

function parseWorkflowFlow(content) {
  // 简单解析 frontmatter 中 flow 的线性步骤（支持 - id/prompt/label/next）
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const yaml = m[1];
  const flowMatch = yaml.match(/^flow:\s*\n([\s\S]*?)(?=^\S|\n\S|$)/m);
  if (!flowMatch) return [];
  const block = flowMatch[1];
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
function renderMarkdown(md) {
  const html = marked.parse(md || '', { breaks: true, gfm: true });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

// 给预览区代码块加复制按钮（后处理）
function enhanceCodeBlocks(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = '复制';
    btn.onclick = async () => {
      const code = pre.querySelector('code');
      const text = code ? code.textContent : pre.textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '复制'; }, 1200);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '复制'; }, 1200);
      }
    };
    pre.appendChild(btn);
  });
}

// ===== 文件树 =====
async function refreshTree() {
  state.tree = await api.listTree();
  renderTree();
  state.metaList = await api.getMetaList();
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
  const stageLabel = s => state.stageLabels[s] || s;
  const parts = [];
  for (const [stage, count] of Object.entries(stageCounts)) {
    parts.push(`<div class="stat-card"><span class="stat-num">${count}</span><span class="stat-label">${stageLabel(stage)}</span></div>`);
  }
  if (!parts.length) {
    parts.push(`<div class="stat-card"><span class="stat-num">0</span><span class="stat-label">暂无提示词</span></div>`);
  }
  panel.innerHTML = parts.join('');
}

// ===== 状态栏 =====
function updateStatusCounts() {
  const counts = $('status-counts');
  if (!counts) return;
  const prompts = state.metaList.filter(m => m.top === 'prompts').length;
  const workflows = state.metaList.filter(m => m.top === 'workflows').length;
  counts.textContent = `提示词 ${prompts} · 工作流 ${workflows}`;
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
    const m = state.metaList.find(x => x.rel === node.rel);
    name.textContent = (m && m.meta.title) ? m.meta.title : fileNameNoExt(node.name);
    row.append(caret, icon, name);
    row.__rel = node.rel;  // 供筛选过滤用
    // tooltip：完整路径 + 关键元信息
    const tipParts = [node.rel];
    if (m) {
      if (m.meta.projectType) tipParts.push('工程类型: ' + m.meta.projectType);
      if (Array.isArray(m.meta.tags) && m.meta.tags.length) tipParts.push('标签: ' + m.meta.tags.join(', '));
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
      lock.title = '已锁定（防误删）';
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
    'prompts': '提示词',
    'workflows': '工作流',
    'templates': '模板',
    'project-init': '项目初始化',
    'code-generation': '代码生成',
    'code-review': '代码审查',
    'testing': '测试',
    'deployment': '部署'
  };
  return map[node.name] || node.name;
}

// ===== 打开文件 =====
async function openFile(rel) {
  if (!rel) return;
  if (state.editMode && !(await exitEditMode(true))) return;
  try {
    // 多标签页：若已存在标签则激活，否则新建
    let tab = state.tabs.find(t => t.rel === rel);
    if (!tab) {
      const { content, meta } = await api.readFile(rel);
      tab = { rel, content, meta, scroll: 0 };
      state.tabs.push(tab);
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
    updateStatusInfo((state.currentMeta.title || rel) + ' · 已加载');
  } catch (e) {
    state.currentRel = null;
    toast('打开失败：' + e.message, 'error');
    updateStatusInfo('打开失败');
  }
}

// ===== 多标签页 =====
const saveTabsDebounced = debounce(async () => {
  try {
    await api.setConfig({
      tabs: state.tabs.map(t => t.rel),
      activeTab: state.activeTab
    });
  } catch (e) { console.error('保存标签状态失败:', e); }
}, 500);
function renderTabs() {
  const bar = $('tabs-bar');
  if (!bar) return;
  if (!state.tabs.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = state.tabs.map(t => {
    const title = (t.meta && t.meta.title) || fileNameNoExt(t.rel.split('/').pop());
    const active = t.rel === state.activeTab;
    return `<div class="tab ${active ? 'active' : ''}" data-rel="${escapeHtml(t.rel)}" title="${escapeHtml(t.rel)}">
      <span class="tab-title">${escapeHtml(title)}</span>
      <button class="tab-close" data-close="${escapeHtml(t.rel)}" title="关闭">✕</button>
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
  updateStatusInfo((tab.meta.title || rel) + ' · 已加载');
}

async function closeTab(rel) {
  const idx = state.tabs.findIndex(t => t.rel === rel);
  if (idx === -1) return;
  // 若关的是当前标签且在编辑，先退出
  if (rel === state.activeTab && state.editMode) { exitEditMode(false); }
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
  catch (e) { console.error('保存最近打开失败:', e); }
}, 500);
function renderRecent() {
  const panel = $('recent-panel');
  if (!panel) return;
  // 仅在空状态可见时渲染（实际显隐由空状态控制）
  const recent = state.recent
    .map(r => state.metaList.find(m => m.rel === r))
    .filter(Boolean);
  if (!recent.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const list = $('recent-list');
  list.innerHTML = recent.map(m => {
    const stage = stageOfRel(m.rel);
    const stageLabel = state.stageLabels[stage] || (m.top === 'workflows' ? '工作流' : m.top === 'templates' ? '模板' : '');
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
    const m = state.metaList.find(x => x.rel === state.currentRel);
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
  const stageLabel = state.stageLabels[stage] || stage;
  let html = '';
  if (stageLabel) html += `<span class="meta-chip stage">阶段：${escapeHtml(stageLabel)}</span>`;
  if (m.projectType) html += `<span class="meta-chip type">工程类型：${escapeHtml(m.projectType)}</span>`;
  if (Array.isArray(m.tags)) m.tags.forEach(t => html += `<span class="meta-chip tag">#${escapeHtml(t)}</span>`);
  if (m.description) html += `<span class="meta-chip">${escapeHtml(m.description)}</span>`;
  if (m.version != null) html += `<span class="meta-chip">v${escapeHtml(String(m.version))}</span>`;
  if (m.updatedAt) html += `<span class="meta-chip">更新：${escapeHtml(String(m.updatedAt).slice(0, 16).replace('T', ' '))}</span>`;
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
  // 层级 = 所有前驱层级最大值 + 1（最长前导路径）
  const level = new Map();
  const queue = steps.filter(s => (indeg.get(s.id) || 0) === 0).map(s => s.id);
  // 拓扑排序求最长路径
  const indeg2 = new Map(indeg);
  const sorted = [];
  while (queue.length) {
    const id = queue.shift();
    sorted.push(id);
    for (const n of byId.get(id).next) {
      if (!byId.has(n)) continue;
      indeg2.set(n, indeg2.get(n) - 1);
      if (indeg2.get(n) === 0) queue.push(n);
    }
  }
  for (const id of sorted) {
    const s = byId.get(id);
    let lv = 0;
    // 找所有指向 id 的前驱的最大 level
    for (const p of steps) {
      if (p.next.includes(id) && level.has(p.id)) lv = Math.max(lv, level.get(p.id) + 1);
    }
    level.set(id, lv);
  }
  // 无入边且未被分配（孤立）的放第 0 层
  const maxLevel = steps.length ? Math.max(...level.values()) : 0;
  // 分层
  const layers = Array.from({ length: maxLevel + 1 }, () => []);
  for (const s of steps) layers[level.get(s.id) || 0].push(s);
  // 渲染：逐层横向，层内节点等高排列；连线由 drawFlowEdges 绘制
  let html = `<div class="flow-diagram"><div class="flow-title">流程图${title ? '：' + escapeHtml(title) : ''}</div>`;
  html += `<div class="flow-canvas">`;
  html += `<svg class="flow-edges" xmlns="http://www.w3.org/2000/svg"></svg>`;
  for (let lv = 0; lv < layers.length; lv++) {
    html += `<div class="flow-layer" data-level="${lv}">`;
    for (const s of layers[lv]) {
      const label = s.label || s.id || '步骤';
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
async function enterEditMode() {
  if (!state.currentRel) return;
  state.editMode = true;
  $('preview-wrap').classList.add('hidden');
  $('editor-wrap').classList.remove('hidden');
  $('editor').value = state.currentContent;
  $('editor').focus();
  $('btn-edit').textContent = '编辑中…';
}

async function exitEditMode(save) {
  if (!state.editMode) return true;
  if (save) {
    const ok = await saveCurrent();
    if (!ok) return false;
  } else {
    state.editMode = false;
    $('preview-wrap').classList.remove('hidden');
    $('editor-wrap').classList.add('hidden');
    $('btn-edit').textContent = '编辑';
    renderContent();
    return true;
  }
  state.editMode = false;
  $('preview-wrap').classList.remove('hidden');
  $('editor-wrap').classList.add('hidden');
  $('btn-edit').textContent = '编辑';
  return true;
}

async function saveCurrent() {
  if (!state.currentRel) return false;
  const content = $('editor').value;
  try {
    const { content: saved, meta } = await api.saveFile(state.currentRel, content);
    state.currentContent = saved;
    state.currentMeta = meta;
    // 同步到标签
    const tab = state.tabs.find(t => t.rel === state.currentRel);
    if (tab) { tab.content = saved; tab.meta = meta; }
    toast(t('saved'), 'success');
    state.metaList = await api.getMetaList();
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
    updateStatusInfo((meta.title || state.currentRel) + ' · 已保存 v' + (meta.version || '?'));
    return true;
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
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
    toast('已复制', 'success');
  }
}

// ===== 新建 =====
async function pickProjectType() {
  const types = state.config.projectTypes || ['前端项目', '后端项目', '数据分析', '脚本工具', '其他'];
  const input = await promptInput('选择工程类型', types.join(' / '));
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
  const name = await promptInput('提示词名称', '如：需求分析');
  if (!name) return;
  const projectType = (await pickProjectType()) || '其他';
  const rel = `prompts/${stage}/${name}.md`;
  const stageLabel = state.stageLabels[stage];
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
    toast('已新建', 'success');
    await refreshTree();
    await openFile(rel);
    enterEditMode();
  } catch (e) {
    toast('新建失败：' + e.message, 'error');
  }
}

async function newWorkflow() {
  const name = await promptInput('工作流名称', '如：完整项目流程');
  if (!name) return;
  const rel = `workflows/${name}.md`;
  const content = `---
title: ${name}
flow:
  - id: step1
    prompt: project-init/需求分析.md
    label: 需求分析
    next: step2
  - id: step2
    prompt: code-generation/功能实现.md
    label: 功能实现
    next: step3
  - id: step3
    prompt: code-review/代码审查.md
    label: 代码审查
---

# ${name}

本工作流定义了 ${name} 的步骤顺序。点击上方流程图节点可跳转到对应提示词。
`;
  try {
    await api.createFile(rel, content);
    toast('已新建工作流', 'success');
    await refreshTree();
    await openFile(rel);
    enterEditMode();
  } catch (e) {
    toast('新建失败：' + e.message, 'error');
  }
}

async function newFolder() {
  const name = await promptInput('新建目录名（英文，将建在 prompts/ 下）', '如：refactor');
  if (!name) return;
  const safe = name.replace(/[\\/:*?"<>|]/g, '').trim();
  if (!safe) { toast('目录名无效', 'error'); return; }
  const rel = `prompts/${safe}`;
  try {
    await api.createFile(`${rel}/.gitkeep`, '');
    toast('已新建目录', 'success');
    await refreshTree();
  } catch (e) {
    toast('新建目录失败：' + e.message, 'error');
  }
}

async function pickStage(title = '选择阶段') {
  const opts = state.stages.map(s => state.stageLabels[s] || s).join(' / ');
  const input = await promptInput(title, opts);
  if (!input) return null;
  const found = state.stages.find(s => (state.stageLabels[s] || s) === input || s === input);
  return found || state.stages[0];
}

function promptInput(title, placeholder) {
  return new Promise(resolve => {
    const menu = $('ctx-menu');
    menu.innerHTML = `
      <div class="ctx-prompt-wrap">
        <div class="ctx-prompt-title">${escapeHtml(title)}</div>
        <input id="ctx-input" class="ctx-prompt-input" placeholder="${escapeHtml(placeholder || '')}">
        <div class="ctx-prompt-actions">
          <button class="btn-link" id="ctx-cancel">取消</button>
          <button class="btn-primary" id="ctx-ok">确定</button>
        </div>
      </div>`;
    menu.classList.remove('hidden');
    const inp = $('ctx-input');
    inp.focus();
    const done = (v) => { menu.classList.add('hidden'); menu.innerHTML = ''; resolve(v); };
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
  const newName = await promptInput('重命名（不含 .md）', oldName);
  if (!newName || newName === oldName) return;
  const newRel = segs.slice(0, -1).join('/') + '/' + newName + '.md';
  try {
    await api.rename(oldRel, newRel);
    migrateLock(oldRel, newRel);
    // 同步标签
    const tab = state.tabs.find(t => t.rel === oldRel);
    if (tab) tab.rel = newRel;
    if (state.activeTab === oldRel) state.activeTab = newRel;
    toast('已重命名', 'success');
    await refreshTree();
    await openFile(newRel);
  } catch (e) {
    toast('重命名失败：' + e.message, 'error');
  }
}

async function deleteCurrent() {
  if (!state.currentRel) return;
  if (state.lockedFiles.has(state.currentRel)) {
    toast(t('lockedCannotDelete'), 'error');
    return;
  }
  if (!(await confirmDialog(`删除「${state.currentMeta.title || state.currentRel}」？\n文件将移入回收站，可恢复。`))) return;
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
    toast('已移入回收站', 'success');
    await refreshTree();
  } catch (e) {
    toast('删除失败：' + e.message, 'error');
  }
}

async function moveCurrent() {
  if (!state.currentRel) return;
  if (!state.currentRel.startsWith('prompts/')) { toast('仅提示词可移动', 'error'); return; }
  const stage = await pickStage('移动到阶段');
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
    toast('已移动', 'success');
    await refreshTree();
    await openFile(newRel);
  } catch (e) {
    toast('移动失败：' + e.message, 'error');
  }
}

// 拖拽移动：把 srcRel 移动到目录 dirRel 下（保留文件名）
async function moveFileToDir(srcRel, dirRel) {
  if (!srcRel || !dirRel) return;
  // 不能拖到自己内部（父目录是自身或其祖先）
  if (dirRel === srcRel || srcRel.startsWith(dirRel + '/')) {
    toast('不能移动到自身或子目录', 'error'); return;
  }
  if (!dirRel.startsWith('prompts/')) { toast('只能移动到 prompts/ 下的目录', 'error'); return; }
  const fileName = srcRel.split('/').pop();
  const newRel = `${dirRel}/${fileName}`;
  if (newRel === srcRel) { toast('已在该目录', 'error'); return; }
  try {
    await api.rename(srcRel, newRel);
    migrateLock(srcRel, newRel);
    // 迁移标签
    const tab = state.tabs.find(t => t.rel === srcRel);
    if (tab) tab.rel = newRel;
    if (state.activeTab === srcRel) state.activeTab = newRel;
    toast('已移动', 'success');
    await refreshTree();
    if (state.currentRel === srcRel) await openFile(newRel);
  } catch (e) {
    toast('移动失败：' + e.message, 'error');
  }
}

async function duplicateCurrent() {
  if (!state.currentRel) return;
  const segs = state.currentRel.split('/');
  const baseName = fileNameNoExt(segs[segs.length - 1]);
  const dir = segs.slice(0, -1).join('/');
  const newName = await promptInput('副本名称（不含 .md）', baseName + '-副本');
  if (!newName) return;
  const newRel = dir + '/' + newName + '.md';
  try {
    await api.createFile(newRel, state.currentContent);
    toast('已创建副本', 'success');
    await refreshTree();
    await openFile(newRel);
  } catch (e) {
    toast('复制失败：' + e.message, 'error');
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
  catch (e) { console.error('保存锁定状态失败:', e); }
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
    items.push({ label: '打开', act: () => openFile(node.rel) });
    items.push({ label: '复制内容', act: async () => { await openFile(node.rel); copyContent(); } });
    items.push({ label: '创建副本', act: async () => { await openFile(node.rel); duplicateCurrent(); } });
    items.push({ label: '重命名', act: async () => { await openFile(node.rel); renameCurrent(); } });
    if (node.rel.startsWith('prompts/')) items.push({ label: '移动到…', act: async () => { await openFile(node.rel); moveCurrent(); } });
    const locked = state.lockedFiles.has(node.rel);
    items.push({ label: locked ? '🔒 解除锁定' : '🔓 锁定（防误删）', act: async () => { await openFile(node.rel); toggleLockFile(node.rel); } });
    items.push({ sep: true });
    items.push({ label: '删除', danger: true, act: async () => { await openFile(node.rel); deleteCurrent(); } });
  } else {
    items.push({ label: '在此新建提示词', act: () => newPromptInDir(node) });
  }
  menu.innerHTML = items.map((it, i) => it.sep
    ? `<div class="ctx-sep"></div>`
    : `<div class="ctx-item ${it.danger ? 'danger' : ''}" data-i="${i}">${escapeHtml(it.label)}</div>`
  ).join('');
  menu.classList.remove('hidden');
  menu.style.left = Math.min(x, window.innerWidth - 160) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 40) + 'px';
  menu.querySelectorAll('.ctx-item').forEach((el, i) => {
    el.onclick = () => { menu.classList.add('hidden'); items[i].act(); };
  });
}

async function newPromptInDir(dirNode) {
  // dirNode.rel 形如 prompts/project-init
  if (!dirNode.rel.startsWith('prompts/')) { toast('请选择 prompts 下的阶段目录', 'error'); return; }
  const stage = dirNode.rel.split('/')[1];
  const name = await promptInput('提示词名称', '如：需求分析');
  if (!name) return;
  const projectType = (await pickProjectType()) || '其他';
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
    toast('已新建', 'success');
    await refreshTree();
    await openFile(rel);
    enterEditMode();
  } catch (e) {
    toast('新建失败：' + e.message, 'error');
  }
}

document.addEventListener('click', (e) => {
  const menu = $('ctx-menu');
  if (!menu.contains(e.target)) menu.classList.add('hidden');
});

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
    box.innerHTML = '<div class="search-empty">未找到匹配的提示词</div>';
    return;
  }
  box.innerHTML = results.map(r => `
    <div class="search-item" data-rel="${escapeHtml(r.rel)}">
      <div class="si-title">${highlightTerm(escapeHtml(r.name), q)}</div>
      <div class="si-meta">${escapeHtml(state.stageLabels[r.stage] || r.stage || '')}${r.projectType ? ' · ' + escapeHtml(r.projectType) : ''}</div>
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
  stageSel.innerHTML = '<option value="">全部阶段</option>' + state.stages.map(s => `<option value="${s}">${escapeHtml(state.stageLabels[s] || s)}</option>`).join('');
  const types = [...new Set(state.metaList.map(m => m.meta.projectType).filter(Boolean))];
  typeSel.innerHTML = '<option value="">全部类型</option>' + types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  // 标签自动补全（收集所有提示词的标签）
  const tagSet = new Set();
  for (const m of state.metaList) {
    if (Array.isArray(m.meta.tags)) m.meta.tags.forEach(t => t && tagSet.add(String(t)));
  }
  const dl = $('tag-datalist');
  if (dl) dl.innerHTML = [...tagSet].sort().map(t => `<option value="${escapeHtml(t)}">`).join('');
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
    const m = state.metaList.find(x => x.rel === rel);
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
    vl.innerHTML = '<div class="search-empty">暂无历史版本</div>';
    return;
  }
  vl.innerHTML = list.map(v => `
    <div class="version-item" data-file="${escapeHtml(v.file)}">
      <span class="vi-time">${formatVersionTime(v.timestamp)}<small>${v.pinned ? '⭐ 已星标' : '第 ' + (list.length - list.indexOf(v)) + ' 个'}</small></span>
      <span class="vi-actions">
        <button class="pin-btn ${v.pinned ? 'pinned' : ''}" data-pin="${escapeHtml(v.file)}">${v.pinned ? '⭐' : '☆'}</button>
        <button class="btn-link" data-view="${escapeHtml(v.file)}">查看</button>
        <button class="btn-link" data-roll="${escapeHtml(v.file)}" style="color:var(--danger)">回滚</button>
      </span>
    </div>
  `).join('');
  vl.querySelectorAll('.version-item').forEach(item => {
    const file = item.dataset.file;
    item.querySelector('[data-view]').onclick = () => viewVersion(file);
    item.querySelector('[data-roll]').onclick = async () => {
      if (!(await confirmDialog('回滚到此版本？当前内容会另存为新版本（不会丢失）。'))) return;
      try {
        const { content, meta } = await api.rollbackVersion(state.historyRel, file);
        if (state.currentRel === state.historyRel) {
          state.currentContent = content;
          state.currentMeta = meta;
          renderBreadcrumb();
          renderMetaBar();
          renderContent();
        }
        toast('已回滚', 'success');
        openHistory();
      } catch (e) {
        toast('回滚失败：' + e.message, 'error');
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

function formatVersionTime(ts) {
  // 20260826-143000
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
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
  if (!html) html = '<div class="diff-empty">两个版本内容相同</div>';
  el.innerHTML = html;
}

// ===== 回收站 =====
async function openTrash() {
  const index = await api.listTrash();
  const drawer = $('trash-drawer');
  drawer.classList.remove('hidden');
  const list = $('trash-list');
  if (!index.items.length) {
    list.innerHTML = '<div class="search-empty">回收站为空</div>';
    return;
  }
  list.innerHTML = index.items.map(it => `
    <div class="version-item">
      <span class="vi-time">${escapeHtml(it.name)}<small>${escapeHtml(it.originalRel)} · ${String(it.trashedAt).slice(0, 16).replace('T', ' ')}</small></span>
      <span class="vi-actions">
        <button class="btn-link" data-restore="${escapeHtml(it.id)}">恢复</button>
      </span>
    </div>
  `).join('');
  list.querySelectorAll('[data-restore]').forEach(b => {
    b.onclick = async () => {
      try {
        await api.restore(b.dataset.restore);
        toast('已恢复', 'success');
        await refreshTree();
        openTrash();
      } catch (e) {
        toast('恢复失败：' + e.message, 'error');
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
  const types = state.config.projectTypes || ['前端项目', '后端项目', '数据分析', '脚本工具', '其他'];
  list.innerHTML = types.map(t => `
    <div class="type-tag">
      <span>${escapeHtml(t)}</span>
      <button class="btn-link" data-type="${escapeHtml(t)}" title="删除">✕</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-type]').forEach(b => {
    b.onclick = async () => {
      try {
        await api.removeProjectType(b.dataset.type);
        state.config.projectTypes = (await api.getConfig()).projectTypes;
        renderSettingsTypes();
        toast('已删除', 'success');
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
  if (!val) { toast('请输入类型名称', 'error'); return; }
  try {
    await api.addProjectType(val);
    state.config.projectTypes = (await api.getConfig()).projectTypes;
    renderSettingsTypes();
    populateFilters();
    inp.value = '';
    toast('已添加', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
};
$('new-type-input').onkeydown = (e) => {
  if (e.key === 'Enter') $('btn-add-type').click();
};

// ===== 导出 =====
async function exportZip() {
  const res = await api.exportZip();
   if (res.ok) toast('已导出到：' + res.path, 'success');
  else toast('已取消导出');
}
async function importSingle() {
  try {
    const res = await api.importSingle();
    if (res.ok) {
      toast('已导入：' + res.rel, 'success');
      await refreshTree();
    }
  } catch (e) { toast('导入失败：' + e.message, 'error'); }
}
async function importZip() {
  try {
    const res = await api.importZip();
    if (res.ok) {
      toast('已导入备份包', 'success');
      await refreshTree();
    }
  } catch (e) { toast('导入失败：' + e.message, 'error'); }
}
async function exportSingle() {
  if (!state.currentRel) return;
  const res = await api.exportSingle(state.currentRel);
  if (res.ok) toast('已导出到：' + res.path, 'success');
  else toast('已取消导出');
}

// ===== 主题 =====
async function toggleTheme() {
  const cur = state.config.theme === 'dark' ? 'light' : 'dark';
  state.config.theme = cur;
  document.body.className = 'theme-' + cur;
  await api.setConfig({ theme: cur });
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
  await api.setConfig({ lang });
  // 重建依赖文案的动态内容
  renderTree();
  populateFilters();
  renderTabs();
  renderStats();
  updateStatusInfo(t('ready'));
  toast(lang === 'en' ? 'Language: English' : '语言：中文', 'success');
}

// ===== 分隔条拖拽 =====
const saveSidebarWidthDebounced = debounce(async (w) => {
  try { await api.setConfig({ sidebarWidth: w }); }
  catch (e) { console.error('保存侧边栏宽度失败:', e); }
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
  // 加载标签页（仅存 rel，内容惰性加载）
  if (Array.isArray(state.config.tabs)) {
    state.tabs = state.config.tabs.map(rel => ({ rel, content: '', meta: {}, scroll: 0 }));
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
        <div class="ctx-prompt-title">选择导入方式</div>
        <div class="ctx-prompt-actions" style="flex-direction:column;align-items:stretch">
          <button class="btn-link" id="import-single-btn">导入单个 .md</button>
          <button class="btn-link" id="import-zip-btn">导入 ZIP 备份</button>
        </div>
      </div>`;
    menu.classList.remove('hidden');
    const done = () => { menu.classList.add('hidden'); menu.innerHTML = ''; };
    $('import-single-btn').onclick = async () => { done(); importSingle(); };
    $('import-zip-btn').onclick = async () => { done(); importZip(); };
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
    btn.textContent = '✓ 已复制';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
  };
  $('btn-export-single').onclick = exportSingle;
  $('btn-edit').onclick = async () => {
    if (state.editMode) { await exitEditMode(false); }
    else enterEditMode();
  };
  $('btn-save').onclick = () => saveCurrent().then(ok => { if (ok) exitEditMode(true); });
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
    if (await confirmDialog('永久清空回收站？此操作不可恢复。')) {
      await api.emptyTrash();
      openTrash();
      toast('已清空', 'success');
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
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (state.editMode) saveCurrent();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault();
      newPrompt();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search-box').focus();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
      e.preventDefault();
      exportZip();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
      e.preventDefault();
      $('btn-import').click();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
      // 用 Ctrl+Shift+L 切换主题，避免 Ctrl+T 拦截
      e.preventDefault();
      toggleTheme();
    } else if (e.key === 'Escape') {
      // Esc 依次关闭：上下文菜单 → 抽屉 → 退出编辑
      const ctx = $('ctx-menu');
      if (!ctx.classList.contains('hidden')) { ctx.classList.add('hidden'); ctx.innerHTML = ''; return; }
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
      confirmDialog('永久清空回收站？').then(ok => {
        if (ok) { api.emptyTrash().then(() => toast('已清空', 'success')); }
      });
    }
    else if (action === 'toggle-theme') toggleTheme();
  });

  initResizer();
}

// 启动
window.addEventListener('DOMContentLoaded', init);
