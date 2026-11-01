// tests/tree-selection.test.js
// 文件树多选的选择模型（src/tree-selection.js）：Ctrl 切换、Shift 按可见顺序选一段、
// 筛选/折叠之后剔掉看不见的条目。
//
// 失败方式是静默的：范围选择把夹在中间的隐藏行带上，批量删除就会删掉用户在屏幕上
// 根本看不见的文件，而界面上只显示"成功 N 个"。
//
// 反向对照在文件末尾：同一批断言拿"不看可见性"的朴素实现跑一遍，要求指定的那几条
// 必须红——那正是 CLAUDE.md 踩过的坑第 12 条的形状（按 style 字符串判可见性，
// 折叠目录里的行仍然留在序列里）。
//
// 运行：npm run test:tree-selection
const path = require('path');
const REAL = require(path.join(__dirname, '..', 'src', 'tree-selection.js'));

// 一棵树的文件行，按屏幕顺序。b、c 在折叠目录里，e 被筛选掉。
const rows = [
  { rel: 'prompts/x/a.md', visible: true },
  { rel: 'prompts/y/b.md', visible: false },
  { rel: 'prompts/y/c.md', visible: false },
  { rel: 'prompts/z/d.md', visible: true },
  { rel: 'prompts/z/e.md', visible: false },
  { rel: 'prompts/z/f.md', visible: true }
];
const [A, B, C, D, E, F] = rows.map(r => r.rel);
const list = (m) => [...m.selected].sort();

function runSuite(S) {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });

  // Ctrl+点击：切换
  let m = S.toggle(S.empty(), A, rows);
  m = S.toggle(m, D, rows);
  ok('Ctrl+点击两行后两行都选中', list(m).join() === [A, D].join(), list(m).join());
  m = S.toggle(m, A, rows);
  ok('再次 Ctrl+点击同一行取消选中', list(m).join() === D, list(m).join());
  ok('Ctrl+点击把锚点挪到这一行', m.anchor === A, String(m.anchor));

  // 单击打开 A 再 Ctrl+点 D：A 也并进来（资源管理器的行为）
  m = S.toggle(S.focusAnchor(A), D, rows);
  ok('单击后再 Ctrl+点击：两行都选中', list(m).join() === [A, D].join(), list(m).join());
  // 锚点已经看不见时不并进来
  m = S.toggle(S.focusAnchor(B), D, rows);
  ok('锚点看不见时 Ctrl+点击只选这一行', list(m).join() === D, list(m).join());

  // Shift+点击：只取看得见的行
  m = S.range(S.focusAnchor(A), F, rows, false);
  ok('Shift+点击按可见顺序选一段，跳过折叠和被筛掉的行',
    list(m).join() === [A, D, F].join(), list(m).join());
  ok('Shift+点击不移动锚点', m.anchor === A, String(m.anchor));
  m = S.range(S.focusAnchor(F), A, rows, false);
  ok('Shift+点击反向选择同样只取可见行', list(m).join() === [A, D, F].join(), list(m).join());
  m = S.range(S.focusAnchor(A), D, rows, false);
  m = S.range(m, A, rows, false);
  ok('连续 Shift+点击替换上一段，而不是累加', list(m).join() === A, list(m).join());
  // Ctrl+Shift 累加
  m = S.toggle(S.empty(), F, rows);
  m = S.range({ selected: m.selected, anchor: A }, D, rows, true);
  ok('Ctrl+Shift+点击并进已有选择', list(m).join() === [A, D, F].join(), list(m).join());
  // 没有锚点 / 锚点看不见：只选这一行，并把锚点设在这里
  m = S.range(S.empty(), D, rows, false);
  ok('没有锚点时 Shift+点击只选这一行', list(m).join() === D && m.anchor === D, list(m).join() + ' anchor=' + m.anchor);
  m = S.range(S.focusAnchor(C), F, rows, false);
  ok('锚点在折叠目录里时 Shift+点击不从看不见的地方起算', list(m).join() === F, list(m).join());
  // 点的是看不见的行（不该发生，但不能把它选上）
  m = S.range(S.focusAnchor(A), E, rows, false);
  ok('目标行看不见时不选中任何东西', m.selected.size === 0, list(m).join());

  // prune：筛选、折叠、重建之后
  m = { selected: new Set([A, B, D, 'prompts/gone.md']), anchor: B };
  m = S.prune(m, rows);
  ok('剔掉看不见的和已不存在的条目', list(m).join() === [A, D].join(), list(m).join());
  ok('看不见的锚点一起剔掉', m.anchor === null, String(m.anchor));

  // ordered：按树上的顺序，不按点选的先后
  m = S.toggle(S.toggle(S.empty(), F, rows), A, rows);
  ok('按树上的顺序列出选中项', S.ordered(m, rows).join() === [A, F].join(), S.ordered(m, rows).join());

  // 不改入参
  const before = S.toggle(S.empty(), A, rows);
  S.toggle(before, D, rows);
  S.range(before, F, rows, true);
  S.prune(before, []);
  ok('所有操作都不改入参', list(before).join() === A && before.anchor === A, list(before).join());
  return results;
}

// ---------- 真实实现 ----------
let failed = 0;
for (const r of runSuite(REAL)) {
  if (r.pass) console.log('[test:tree-selection] PASS ' + r.name);
  else { failed++; console.error('[test:tree-selection] FAIL ' + r.name + ' -> ' + r.detail); }
}

// ---------- 反向对照：不看可见性的朴素实现 ----------
// 只改"可见性"这一处：range / prune / toggle 的锚点判断都把所有行当成看得见。
const NAIVE = {
  ...REAL,
  range: (m, rel, rs, add) => REAL.range(m, rel, rs.map(r => ({ ...r, visible: true })), add),
  prune: (m, rs) => REAL.prune(m, rs.map(r => ({ ...r, visible: true }))),
  toggle: (m, rel, rs) => REAL.toggle(m, rel, (rs || []).map(r => ({ ...r, visible: true })))
};
const mustRed = [
  'Shift+点击按可见顺序选一段，跳过折叠和被筛掉的行',
  'Shift+点击反向选择同样只取可见行',
  '剔掉看不见的和已不存在的条目',
  '锚点在折叠目录里时 Shift+点击不从看不见的地方起算',
  '锚点看不见时 Ctrl+点击只选这一行'
];
const naive = runSuite(NAIVE);
const stillGreen = mustRed.filter(name => (naive.find(r => r.name === name) || { pass: true }).pass);
if (stillGreen.length) {
  failed++;
  console.error('[test:tree-selection] FAIL 反向对照：不看可见性的实现在这些断言上仍然是绿的，断言分辨不出来：' + stillGreen.join(' / '));
} else {
  console.log('[test:tree-selection] PASS 反向对照：不看可见性的实现在 ' + mustRed.length + ' 条目标断言上全部变红');
}

if (failed) {
  console.error('[test:tree-selection] ' + failed + ' 项失败');
  process.exit(1);
}
console.log('[test:tree-selection] 通过');
