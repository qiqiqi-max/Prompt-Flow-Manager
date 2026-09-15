// tests/render-guard.test.js
// 回归测试：预览渲染必须有成本上限，恶意 .md 不能把界面冻住。
//
// 背景（实测，仓库里这份 marked 11.2.0）：marked 的行内强调扫描在"一行里有大量
// 未闭合 * / _"时是二次复杂度。单行 2 万个分隔符 1.3 秒，4 万个 5.4 秒，
// 8 万个约 20 秒。渲染是同步的，期间界面完全冻住——没有 toast，也没法取消或关窗。
//
// 而 init() 结尾会自动打开上次的标签，所以这不只是一次卡顿：
// 导入恶意文件 → 打开 → 卡死 → 强杀进程 → 重启又自动打开同一个文件 → 再卡死。
// 普通用户唯一的出路是手动删 config.json，等于把应用变砖。
//
// 这个测试为什么不起 Electron：要测的是"守卫函数的判定 + marked 真的会慢"，
// 两者都不需要 DOM。marked 直接 require 仓库里 src/vendor 的那份副本——
// 渲染进程加载的就是它，测另一份就没意义了。
//
// 守卫函数从 src/renderer.js 原文截取后 eval，不抄副本：抄一份的话，
// 源码改了而副本没改，测试照旧全绿（tests/debounce.test.js 同样的做法）。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');

// marked 用仓库里签入的 vendor 副本（渲染进程加载的就是这一份）
const markedSrc = fs.readFileSync(path.join(root, 'src', 'vendor', 'marked.umd.js'), 'utf8');
const markedModule = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('module', 'exports', markedSrc)(markedModule, markedModule.exports);
const marked = markedModule.exports;
if (typeof marked.parse !== 'function') {
  console.error('[test:render] 无法从 src/vendor/marked.umd.js 取到 parse()');
  process.exit(1);
}

// ---- 从 renderer.js 原文截取守卫实现 ----
function extract(startMarker, endMarker) {
  const from = rendererSrc.indexOf(startMarker);
  if (from === -1) {
    console.error('[test:render] 在 src/renderer.js 里找不到锚点: ' + startMarker);
    process.exit(1);
  }
  const to = rendererSrc.indexOf(endMarker, from);
  if (to === -1) {
    console.error('[test:render] 找不到结束锚点: ' + endMarker);
    process.exit(1);
  }
  return rendererSrc.slice(from, to + endMarker.length);
}

const guardSrc = extract('const MAX_EMPHASIS_PER_LINE', '\n}\n');
// eslint-disable-next-line no-eval
const emphasisTooCostly = eval('(function(){' + guardSrc + '; return emphasisTooCostly; })()');
// eslint-disable-next-line no-eval
const limits = eval('(function(){' + guardSrc + '; return { perLine: MAX_EMPHASIS_PER_LINE, total: MAX_EMPHASIS_TOTAL }; })()');

const results = [];
function check(name, ok, detail) {
  results.push([name, ok, detail || '']);
}

function timeRender(md) {
  const t0 = Date.now();
  marked.parse(md, { breaks: true, gfm: true });
  return Date.now() - t0;
}

// ===== 1. 守卫的判定 =====
// 真实内容不能被误判。这一条是整个测试的前提：守卫如果把正常文件也降级，
// 那它就不是"防卡死"而是"把预览功能关掉了"。
const realFiles = ['templates/prompt-template.md', 'workflows/branch-flow-example.md', 'workflows/full-project-flow.md'];
let realWorst = 0;
let realFlagged = [];
for (const f of realFiles) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  const body = fs.readFileSync(p, 'utf8');
  const marks = (body.match(/[*_]/g) || []).length;
  if (marks > realWorst) realWorst = marks;
  if (emphasisTooCostly(body)) realFlagged.push(f);
}
check('仓库里的真实 .md 不被降级（最多 ' + realWorst + ' 个分隔符）',
  realFlagged.length === 0, realFlagged.join(', '));

// 一份"重格式但正常"的 markdown：2000 行，每行几个粗体斜体。
// 实测 104KB / 16000 个分隔符只要 57ms，属于必须放行的区间。
const heavyReal = Array.from({ length: 2000 },
  (_, i) => '- **item ' + i + '** with *emphasis* and _underscore_ text').join('\n');
check('重格式但正常的 markdown 不被降级（' + Math.round(heavyReal.length / 1024) + 'KB）',
  !emphasisTooCostly(heavyReal));

// 单行超标：这是真正的攻击形状
const evilLine = '_a'.repeat(limits.perLine + 1);
check('单行分隔符超上限时判定为降级（' + (limits.perLine + 1) + ' 个）',
  emphasisTooCostly(evilLine));

// 边界：正好等于上限不降级，上限 +1 降级。防止阈值写成 >= 而把合规输入也拦掉。
check('单行正好等于上限时不降级（' + limits.perLine + ' 个）',
  !emphasisTooCostly('_a'.repeat(limits.perLine / 2) + 'x'.repeat(10)));

// 总量超标：每行都合规但行数极多。实测 391KB / 40 万分隔符要 3.2 秒，
// 所以只卡单行是不够的。
const manyLines = Array.from({ length: 2000 }, () => '_a'.repeat(100)).join('\n');
const manyMarks = (manyLines.match(/[*_]/g) || []).length;
check('每行合规但总量超上限时判定为降级（总 ' + manyMarks + ' 个）',
  manyMarks > limits.total && emphasisTooCostly(manyLines),
  '总量=' + manyMarks + ' 上限=' + limits.total);

// 换行必须重置行内计数，否则总量正常的多行文件会被误判成单行超标
const resetOk = !emphasisTooCostly(Array.from({ length: 50 }, () => '_a'.repeat(200)).join('\n'));
check('换行重置行内计数（50 行各 400 个分隔符，总量在上限内）', resetOk);

// ===== 2. marked 真的会慢（守卫存在的理由）=====
// 这一条不测我们的代码，测的是"不加守卫会怎样"。没有它，前面那些判定断言
// 只是在测一个自己定义的函数，读者无从判断阈值定得对不对。
const evilBig = '_a'.repeat(20000);
const evilMs = timeRender(evilBig);
check('无守卫时 marked 渲染恶意输入确实很慢（' + Math.round(evilBig.length / 1024) + 'KB 单行 → ' + evilMs + 'ms）',
  evilMs > 300, evilMs + 'ms');

// 同等体积的正常内容必须快，否则慢的原因是"文件大"而不是"分隔符多"，
// 那按分隔符密度设阈值就站不住脚了。
const benignBig = 'x'.repeat(evilBig.length);
const benignMs = timeRender(benignBig);
check('同等体积的正常内容渲染很快（' + benignMs + 'ms）', benignMs < 100, benignMs + 'ms');
check('慢的原因是分隔符密度而不是体积（恶意 ' + evilMs + 'ms vs 同体积正常 ' + benignMs + 'ms）',
  evilMs > benignMs * 5, '恶意/正常 = ' + (benignMs ? (evilMs / benignMs).toFixed(1) : '∞') + 'x');

// 二次增长：输入翻倍，耗时应该涨到 3 倍以上。
// 这条说明问题不是"常数偏大"，而是复杂度本身——所以上限不能靠调优化解决。
const ms1 = timeRender('_a'.repeat(8000));
const ms2 = timeRender('_a'.repeat(16000));
check('耗时随输入二次增长（8000→' + ms1 + 'ms, 16000→' + ms2 + 'ms）',
  ms1 > 0 && ms2 > ms1 * 2.5, '倍数 = ' + (ms1 ? (ms2 / ms1).toFixed(1) : '∞') + 'x');

// ===== 3. 守卫本身必须便宜 =====
// 守卫要在每次渲染前跑，如果它自己就慢，等于换了个地方卡。
// 提前退出让它在恶意输入上尤其快——不必扫完整个 4MB。
const bigBenign = 'x'.repeat(4 * 1024 * 1024);
let t0 = Date.now();
emphasisTooCostly(bigBenign);
const guardBenignMs = Date.now() - t0;
check('守卫扫 4MB 正常内容够快（' + guardBenignMs + 'ms）', guardBenignMs < 200, guardBenignMs + 'ms');

t0 = Date.now();
emphasisTooCostly('_a'.repeat(2 * 1024 * 1024));
const guardEvilMs = Date.now() - t0;
check('守卫在恶意输入上提前退出（' + guardEvilMs + 'ms）', guardEvilMs < 50, guardEvilMs + 'ms');

// ===== 4. 接线检查 =====
// 前面测的都是摘出来的函数。这几条确认它真的被 renderMarkdown 用上了——
// 否则守卫写得再对，线没接上也白搭。
check('renderMarkdown 调用了 emphasisTooCostly',
  /function renderMarkdown\([\s\S]{0,400}?emphasisTooCostly\(/.test(rendererSrc));
check('降级分支不走 marked.parse（提前 return）',
  /emphasisTooCostly\(src\)\)\s*\{[\s\S]{0,300}?return[\s\S]{0,200}?render-plain/.test(rendererSrc));
check('降级输出对正文做了 HTML 转义',
  /render-plain[^]{0,40}escapeHtml\(src\)/.test(rendererSrc)
  || /escapeHtml\(src\)[\s\S]{0,80}render-plain/.test(rendererSrc));
check('降级提示文案走 i18n（t(\'renderDegraded\')）',
  /t\('renderDegraded'\)/.test(rendererSrc));

// 软砖循环：init() 里恢复标签的自动打开必须被隔离，
// 单个文件出问题不能让整个 init() 中断（否则工具栏都绑不上，界面全废）。
check('init() 恢复标签时自动打开被 try 包住（软砖循环已隔离）',
  /恢复上次打开的标签[\s\S]{0,900}?try\s*\{[\s\S]{0,300}?await openFile\(target\)/.test(rendererSrc));

let passed = true;
for (const [name, ok, detail] of results) {
  console.log('[test:render] ' + (ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' → ' + detail : ''));
  if (!ok) passed = false;
}
console.log('\n[test:render] ' + (passed ? '通过' : '失败'));
process.exit(passed ? 0 : 1);
