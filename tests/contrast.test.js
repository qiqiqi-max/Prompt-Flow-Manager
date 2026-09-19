// tests/contrast.test.js
// 对比度与焦点可见性：按 WCAG 2.1 的相对亮度公式算 src/styles.css 里真实用到的颜色对。
//
// 为什么要有这一层，而且必须是"算"而不是"看"：
// 配色是两套主题共用一批变量，同一个变量往往同时当**背景填充**和**前景文字**用
// （--primary 既是 .btn-primary 的底色、又是 .btn-link 的字色、又是焦点环的颜色）。
// 于是"把某个色调深一点修好按钮"这种改动会同时把另一处文字改坏，而改坏的表现是
// 纯视觉的——没有任何报错、任何测试都不会红，只有真的用眼睛在两套主题下逐个控件
// 看才发现。实测这套配色里有 24 对不达标，暗色 14 对、亮色 10 对，全都是这么积下来的。
//
// 这一层只管颜色数值，管不了"这个颜色到底有没有被用上"。所以下面还有一组源码断言
// 把 token 和用它的规则钉在一起：新 token 没被引用、或者旧的硬编码 #fff 还在，
// 都要红。少了这一半的话，token 改得再漂亮，页面上渲染的还是旧颜色，而测试全绿。
//
// 自带反向对照（照 tests/debounce.test.js 的模式）：用改动前的旧配色跑同一批断言，
// 要求它**必须失败**，否则说明这批断言分辨不出好坏配色，测试判定自己无效。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const CSS_PATH = path.join(root, 'src', 'styles.css');
const css = fs.readFileSync(CSS_PATH, 'utf8');

let failed = 0;
function check(ok, msg) {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + msg);
  if (!ok) failed++;
}

// ---------- WCAG 2.1 相对亮度 ----------
function srgbToLinear(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function parseHex(hex) {
  const h = hex.trim().replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error('不是六位十六进制颜色: ' + hex);
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
}
function ratio(fgHex, bgHex) {
  const a = luminance(parseHex(fgHex));
  const b = luminance(parseHex(bgHex));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
// opacity 淡化过的前景先和它真实的底色混合，否则算出来的是没人看得见的那个色。
function blend(fgHex, bgHex, alpha) {
  const f = parseHex(fgHex), b = parseHex(bgHex);
  const mixed = f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)));
  return '#' + mixed.map(v => v.toString(16).padStart(2, '0')).join('');
}

// ---------- 从 CSS 里读出两套主题的变量 ----------
function readTheme(name) {
  const at = css.indexOf('.' + name + ' {');
  if (at === -1) throw new Error('styles.css 里找不到 .' + name + ' 的定义块');
  const end = css.indexOf('}', at);
  const block = css.slice(at, end);
  const vars = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

// 变量值可能写成 var(--other)，解一层引用。
function resolve(vars, token) {
  let v = vars[token];
  for (let i = 0; i < 5 && v && /^var\(/.test(v); i++) {
    const inner = v.match(/^var\(\s*(--[\w-]+)\s*\)$/);
    if (!inner) break;
    v = vars[inner[1]];
  }
  return v;
}

// ---------- 要查的颜色对 ----------
// 每一项都对应 styles.css 里一条真实规则（注释里写的是行为，不是行号——行号会漂）。
// kind: 'text' 需要 4.5:1（正文都是 11–14px，没有大字豁免）；'ui' 需要 3:1。
const PAIRS = [
  // 正文与次要文字
  ['text', '--text', '--bg', '正文'],
  ['text', '--text', '--bg-alt', '正文（工具栏/标签栏）'],
  ['text', '--text', '--bg-sidebar', '正文（侧边栏）'],
  ['text', '--text', '--code-bg', '代码块正文'],
  ['text', '--text-muted', '--bg', '次要文字'],
  ['text', '--text-muted', '--bg-alt', '次要文字（状态栏/最近打开）'],
  ['text', '--text-muted', '--selection', '锁定文件名压在选中行上'],
  ['text', '--bg', '--text', 'toast 默认态'],

  // 链接类文字（.btn-link 会落在这四种底色上）
  ['text', '--primary', '--bg', '链接按钮'],
  ['text', '--primary', '--bg-alt', '链接按钮（工具栏里的高级筛选）'],
  ['text', '--primary', '--hover', '链接按钮（版本项 hover）'],
  // 菜单项里只会出现两种文字色：普通项的 --text 和危险项的 --danger-text
  // （.ctx-item 是个纯 div，标签经 escapeHtml 写进去，里面没有 .btn-link）。
  // 别在这里查 --primary on --ctx-hover：那个组合屏幕上不存在，为它调色
  // 会把菜单 hover 底色逼到和 --bg 分不开，修的是一个没人看得见的数字。
  ['text', '--text', '--ctx-hover', '菜单项 hover'],

  // 危险操作文字：删除、清空回收站、回滚
  ['text', '--danger-text', '--bg', '危险操作文字'],
  ['text', '--danger-text', '--bg-alt', '危险操作文字（工具栏）'],
  ['text', '--danger-text', '--hover', '危险操作文字（版本项 hover）'],
  ['text', '--danger-text', '--ctx-hover', '删除菜单项 hover'],

  // 实色填充上的文字
  ['text', '--on-solid', '--primary-solid', '主按钮文字（保存/复制/确定）'],
  ['text', '--on-solid', '--primary-solid-hover', '主按钮文字 hover'],
  ['text', '--on-solid', '--danger-solid', '危险按钮 hover / 错误 toast'],
  ['text', '--on-solid', '--success-solid', '成功 toast'],
  ['text', '--on-accent', '--accent', '搜索命中高亮（mark）'],

  // 强调色当文字用（工程类型 chip、星标）
  ['text', '--accent-text', '--bg', '工程类型 chip'],
  ['text', '--accent-text', '--bg-alt', '工程类型 chip（标签栏背景）'],

  // diff
  ['text', '--diff-add-text', '--diff-add-bg', 'diff 新增行'],
  ['text', '--diff-del-text', '--diff-del-bg', 'diff 删除行'],

  // 非文字：控件边界与焦点环（WCAG 1.4.11）
  ['ui', '--border-strong', '--bg', '输入框/按钮边界'],
  ['ui', '--border-strong', '--bg-alt', '输入框/按钮边界（工具栏）'],
  ['ui', '--focus-ring', '--bg', '焦点环'],
  ['ui', '--focus-ring', '--bg-alt', '焦点环（工具栏）'],
  ['ui', '--focus-ring', '--bg-sidebar', '焦点环（侧边栏）'],
  ['ui', '--focus-ring', '--selection', '焦点环压在选中行上'],
  ['ui', '--flow-edge', '--bg-alt', '流程图连线'],
];

// 经 opacity 淡化后仍然承载信息的图形：先混合再算。
const FADED = [
  ['ui', '--text-muted', '--bg-sidebar', 0.85, '锁定标记（opacity 后）'],
  ['ui', '--text-muted', '--bg', 0.85, '未星标的星号（opacity 后）'],
];

function runPalette(themeName, vars, label) {
  const reds = [];
  for (const [kind, fgTok, bgTok, what] of PAIRS) {
    const fg = resolve(vars, fgTok), bg = resolve(vars, bgTok);
    if (!fg || !bg) { reds.push(label + ' ' + what + '：变量缺失 ' + (fg ? bgTok : fgTok)); continue; }
    const need = kind === 'text' ? 4.5 : 3;
    const r = ratio(fg, bg);
    if (r < need) reds.push(label + ' ' + what + '：' + r.toFixed(2) + ':1 < ' + need + ':1 (' + fg + ' on ' + bg + ')');
  }
  for (const [kind, fgTok, bgTok, alpha, what] of FADED) {
    const fg = resolve(vars, fgTok), bg = resolve(vars, bgTok);
    if (!fg || !bg) { reds.push(label + ' ' + what + '：变量缺失'); continue; }
    const need = kind === 'text' ? 4.5 : 3;
    const r = ratio(blend(fg, bg, alpha), bg);
    if (r < need) reds.push(label + ' ' + what + '：' + r.toFixed(2) + ':1 < ' + need + ':1');
  }
  void themeName;
  return reds;
}

console.log('--- 配色对比度（WCAG 2.1） ---');
const themes = { 'theme-light': readTheme('theme-light'), 'theme-dark': readTheme('theme-dark') };
for (const [name, vars] of Object.entries(themes)) {
  const reds = runPalette(name, vars, name);
  check(reds.length === 0, name + ' 全部颜色对达标（共 ' + (PAIRS.length + FADED.length) + ' 对）');
  reds.forEach(r => console.log('      ' + r));
}

// 两套主题必须定义同一批变量。漏一个的表现是那一侧回退到继承值或干脆失效，
// 而对比度计算会在"变量缺失"上红——但如果两边都漏，上面那批断言会一起跳过，
// 所以这里单独比一次键集合。
{
  const l = Object.keys(themes['theme-light']).sort();
  const d = Object.keys(themes['theme-dark']).sort();
  const onlyL = l.filter(k => !d.includes(k));
  const onlyD = d.filter(k => !l.includes(k));
  check(onlyL.length === 0 && onlyD.length === 0,
    '两套主题定义了同一批颜色变量' +
    (onlyL.length ? '（仅亮色有：' + onlyL.join(', ') + '）' : '') +
    (onlyD.length ? '（仅暗色有：' + onlyD.join(', ') + '）' : ''));
}

// ---------- token 必须真的被用上 ----------
//
// 上面那批断言只证明"变量的数值是达标的"，证明不了"页面上渲染的就是这个变量"。
// 少了下面这半截，把 .btn-primary 的 color 改回 #fff 之后，数值断言照旧全绿。
console.log('--- 颜色 token 真的被规则引用 ---');
const stripped = css.split(/\r?\n/).filter(l => !/^\s*(\/\*|\*)/.test(l)).join('\n');
// 取某个选择器的规则体。必须锚到选择器边界，不能用 indexOf(sel + ' {')：
// 查 'mark {' 时 indexOf 会先命中 '.lock-mark {'，于是"mark 的文字色走
// --on-accent"这条断言实际查的是另一条规则的规则体——它在 .lock-mark 里
// 永远找不到 --on-accent，于是恒假。这条一开始就是这么红的，红的原因却和
// 被测代码无关。同理，.btn-icon 不能命中 '.btn-icon, .btn-primary, …' 那条
// 合并规则（逗号后面不是 {，下面的正则自然排除）。
const ruleOf = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = stripped.match(new RegExp('(?:^|[}\\n])\\s*' + esc + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : '';
};

check(/var\(--primary-solid\)/.test(ruleOf('.btn-primary')) &&
      /var\(--on-solid\)/.test(ruleOf('.btn-primary')),
  '.btn-primary 走 --primary-solid / --on-solid（不再是 #fff 压亮底）');
check(!/#fff\b|#ffffff\b/i.test(ruleOf('.btn-primary')), '.btn-primary 里没有硬编码的白色');
check(/var\(--on-accent\)/.test(ruleOf('mark')), 'mark 的文字色走 --on-accent');
check(/var\(--success-solid\)/.test(ruleOf('.toast.success')) &&
      /var\(--danger-solid\)/.test(ruleOf('.toast.error')),
  'toast 的成功/失败底色走 solid token');
check(!/#fff\b|#ffffff\b/i.test(ruleOf('.toast.success')) &&
      !/#fff\b|#ffffff\b/i.test(ruleOf('.toast.error')),
  'toast 里没有硬编码的白色');
check(/var\(--danger-text\)/.test(ruleOf('.btn-danger')) &&
      /var\(--danger-text\)/.test(ruleOf('.ctx-item.danger')),
  '危险操作文字走 --danger-text');
check(/var\(--accent-text\)/.test(ruleOf('.meta-chip.type')), '工程类型 chip 走 --accent-text');
check(/var\(--ctx-hover\)/.test(ruleOf('.ctx-item:hover')), '菜单 hover 底色走 --ctx-hover（不再复用选区色）');
check(/var\(--border-strong\)/.test(ruleOf('.btn-icon')) &&
      /var\(--border-strong\)/.test(ruleOf('.btn-secondary')) &&
      /var\(--border-strong\)/.test(ruleOf('#search-box')),
  '按钮与输入框的边界走 --border-strong');
{
  // 全站硬编码的白色只允许出现在 token 定义里（--on-solid: #ffffff 这种）。
  // 白名单式地查：任何规则体里再出现 #fff 都要红，而不是逐个点名已知的那几处。
  const bad = [];
  for (const m of stripped.matchAll(/#fff(?:fff)?\b/gi)) {
    const before = stripped.slice(Math.max(0, m.index - 80), m.index);
    if (/--[\w-]+\s*:\s*$/.test(before)) continue;   // token 定义，允许
    bad.push(stripped.slice(Math.max(0, m.index - 40), m.index + 8).replace(/\n/g, '\\n'));
  }
  check(bad.length === 0, '没有规则直接写 #fff（一律走 --on-solid / --on-accent）' +
    (bad.length ? '（发现 ' + bad.length + ' 处：' + bad.slice(0, 3).join(' | ') + '）' : ''));
}

// ---------- 焦点可见性 ----------
console.log('--- 焦点可见（WCAG 2.4.7） ---');

// 这一条是本节最该有的：原先 .tree-row.focused 想画焦点环，却被紧随其后的
// .tree-row[tabindex="-1"]:focus { outline: none } 盖掉——后者 (0,3,0) 比
// 前者 (0,2,0) 更特殊，还写在后面，所以树行的焦点环从来没渲染过一次。
// 键盘在树里上下移动时完全看不出焦点在哪，而 renderer.js 里加 .focused 类的代码
// 一直在跑，看代码只会觉得"有做"。
check(!/\.tree-row\[tabindex="-1"\]:focus\s*\{\s*outline:\s*none/.test(stripped),
  '树行的 :focus 没有被 outline: none 盖掉');
check(/\.tree-row:focus-visible|\.tree-row:focus\b/.test(stripped), '树行有 :focus-visible 焦点环');

// 五类按钮以前完全没有 :focus 规则，只靠 Chromium 默认环，而默认环的颜色不随主题走。
for (const cls of ['.btn-icon', '.btn-primary', '.btn-secondary', '.btn-danger', '.btn-link']) {
  check(new RegExp('\\' + cls + ':focus-visible').test(stripped), cls + ' 有 :focus-visible 焦点环');
}
// 筛选面板那两类控件原先设了 outline: none 却没有任何配套的 :focus 规则，
// 是全站唯一"零反馈"的输入控件。
check(/\.filter-row select:focus-visible|\.filter-row input:focus-visible/.test(stripped),
  '筛选面板的下拉/输入框有焦点样式');
{
  // 焦点环一律走 --focus-ring。以前四个输入框用 --selection 当环色，
  // 而那是给文本选区设计的浅色，对底色只有 1.15–1.96，等于没有环。
  const ringRules = [...stripped.matchAll(/:focus(?:-visible)?[^{]*\{([^}]*)\}/g)].map(m => m[1]);
  const usingSelection = ringRules.filter(b => /(outline|box-shadow)[^;]*var\(--selection\)/.test(b));
  check(usingSelection.length === 0, '焦点环不用 --selection 上色' +
    (usingSelection.length ? '（发现 ' + usingSelection.length + ' 处）' : ''));
  const withRing = ringRules.filter(b => /var\(--focus-ring\)/.test(b));
  check(withRing.length >= 8, '焦点样式统一引用 --focus-ring（' + withRing.length + ' 处）');
}
// 复制按钮平时 opacity: 0，只在鼠标 hover 时现身。键盘 Tab 进去时是"焦点在一个
// 看不见的按钮上"。
check(/\.code-copy-btn:focus-visible/.test(stripped), '代码复制按钮聚焦时可见');

// 没有这一行，两套主题下 Chromium 都按浅色方案画 UA 焦点环和表单控件，
// 暗色主题拿到的是一个 #101010 的环，压在 #1e1e1e 上只有 1.14:1。
check(/color-scheme\s*:/.test(stripped), '声明了 color-scheme（UA 控件跟随主题）');
check(/@media\s*\(prefers-reduced-motion/.test(stripped), '尊重 prefers-reduced-motion');

// ---------- 反向对照 ----------
//
// 用改动前的旧配色跑同一批颜色断言，要求它必须失败。否则这批断言分辨不出
// "修好的配色"和"没修的配色"，等于白绿着占位。
//
// 这里只还原颜色数值，不还原 CSS 规则——规则那半截由上面的源码断言负责，
// 而它们的反向对照是直接改 styles.css（见 CONTRIBUTING 第一节的手工流程）。
console.log('--- 反向对照：旧配色必须红 ---');
const LEGACY = {
  'theme-light': {
    '--border-strong': '#e1e4e8',   // 原先只有 --border，控件边界用的就是它
    '--focus-ring': '#dbeafe',      // 原先焦点环用 --selection
    '--on-solid': '#ffffff',
    '--primary-solid': '#2563eb',
    '--primary-solid-hover': '#1d4ed8',
    '--danger-solid': '#dc2626',
    '--success-solid': '#16a34a',
    '--danger-text': '#dc2626',
    '--accent-text': '#f59e0b',
    '--on-accent': '#ffffff',
    '--ctx-hover': '#dbeafe',
    '--flow-edge': '#93c0f9',        // --primary 在 opacity .5 下混出来的实色
    '--text-muted': '#636c76'
  },
  'theme-dark': {
    '--border-strong': '#3c3c3c',
    '--focus-ring': '#264f78',
    '--on-solid': '#ffffff',
    '--primary-solid': '#3b82f6',
    '--primary-solid-hover': '#60a5fa',
    '--danger-solid': '#ef4444',
    '--success-solid': '#22c55e',
    '--danger-text': '#ef4444',
    '--accent-text': '#f59e0b',
    '--on-accent': '#ffffff',
    '--ctx-hover': '#264f78',
    '--flow-edge': '#2c5049',
    '--text-muted': '#9d9d9d'
  }
};
let legacyReds = 0;
for (const [name, vars] of Object.entries(themes)) {
  const legacy = Object.assign({}, vars, LEGACY[name]);
  const reds = runPalette(name, legacy, name);
  legacyReds += reds.length;
  console.log('  ' + name + ' 旧配色不达标 ' + reds.length + ' 对');
}
check(legacyReds >= 10, '旧配色确实被判不达标（' + legacyReds + ' 对），这批断言不是空的');

console.log('');
if (failed) {
  console.error('[test:contrast] ' + failed + ' 项失败');
  process.exit(1);
}
console.log('[test:contrast] 全部通过 \u2713');
