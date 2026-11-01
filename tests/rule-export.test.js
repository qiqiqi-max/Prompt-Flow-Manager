// tests/rule-export.test.js
//
// 规则导出的落盘逻辑（lib/rule-export.js）和目标清单（src/rule-targets.js）。
//
// 自带反向对照（CONTRIBUTING.md 第一节）：同一批检查先对真实实现跑一遍，必须全绿；
// 再对每个"撤掉一处修复"的变异版本重跑，要求**指定的那一条**变红。只要求"出现了
// 失败"不够——变异可能恰好撞红隔壁那条，目标断言依然是空的。
// 变异的 find 串在源码里找不到时直接算失败，不静默跳过：用例和代码脱节必须看得见。
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB_PATH = path.join(__dirname, '..', 'lib', 'rule-export.js');
const TARGETS_PATH = path.join(__dirname, '..', 'src', 'rule-targets.js');
const LIB_SRC = fs.readFileSync(LIB_PATH, 'utf8');
const TARGETS_SRC = fs.readFileSync(TARGETS_PATH, 'utf8');

let failures = 0;
const report = (cond, msg, extra) => {
  if (cond) console.log('[test:rule-export] PASS ' + msg);
  else { failures++; console.error('[test:rule-export] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};

// 和主进程的 RULE_EXPORT_ALLOWED 同一组路径。直接从目标清单取，
// 两者一致由 npm test 的静态检查卡（主进程 require 不了，那里只能查源码文本）。
const ALLOWED = new Set(require(TARGETS_PATH).list.map(t => t.path));
const ALL_FILES = [...ALLOWED].map(name => ({ name, content: 'content of ' + name }));

const mutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-rule-export-mut-'));
let mutSeq = 0;
// 把（可能被改过的）源码写到临时目录再 require，每次都是新的模块实例。
// lib/rule-export.js 只用 node 内置模块，搬到别处 require 不受影响。
function loadFrom(src, base) {
  const file = path.join(mutDir, (mutSeq++) + '-' + base);
  fs.writeFileSync(file, src, 'utf8');
  return require(file);
}

async function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-rule-export-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// 读不到返回 null 而不是抛：变异版本可能根本没建出文件或目录，那应该让对应检查变红，
// 而不是让整个测试进程崩掉、后面的反向对照一条都跑不到。
const read = (...p) => { try { return fs.readFileSync(path.join(...p), 'utf8'); } catch { return null; } };
const exists = (...p) => fs.existsSync(path.join(...p));
const isRealDir = (...p) => { try { return fs.lstatSync(path.join(...p)).isDirectory(); } catch { return false; } };
// junction 不需要管理员权限（Windows 上 symlink 需要），lstat 也把它报成 isSymbolicLink。
// 非 Windows 上 'junction' 这个类型参数被忽略，建出来的是普通目录链接。
const junction = (target, link) => fs.symlinkSync(target, link, 'junction');
async function planError(ruleExport, ...args) {
  try { await ruleExport.plan(...args); return null; } catch (e) { return e; }
}

// 每条检查返回 [名字, 是否通过, 细节]；返回 null 表示本机条件不满足、明确跳过。
const C = {
  allTargets: '五个目标都写进去，并按需建出 .github 和 .cursor/rules',
  existing: '能找出已存在的规则文件（含子目录里的）',
  skipKeeps: '选择跳过时保留已有文件（含子目录里的）',
  skipWritesNew: '选择跳过时仍写入新文件',
  overwrite: '选择覆盖时写入新内容且不残留临时文件',
  whitelist: '白名单外的路径一律丢弃',
  secondGate: '白名单里混进越界路径也不会写出项目目录',
  junctionDir: '.github 是 junction 时整次拒绝且一个文件都不写',
  junctionDeep: '.cursor/rules 是 junction（深一级）时同样拒绝',
  linkAtFile: '目标文件位置是链接（junction）时拒绝',
  fileSymlink: '目标文件是 symlink 时拒绝',
  raceDir: '问完覆盖之后 .github 才被换成 junction，写入时仍拒绝',
  raceFile: '问完之后才冒出来的同名文件不会被静默覆盖'
};

async function runLibChecks(ruleExport) {
  const out = [];
  const add = (name, ok, detail) => out.push([name, !!ok, detail || '']);

  await withDir(async (dir) => {
    const plan = await ruleExport.plan(dir, ALL_FILES, ALLOWED);
    const res = await ruleExport.write(plan, 'skip');
    const contentOk = ALL_FILES.every(f => exists(dir, f.name) && read(dir, f.name) === f.content);
    const dirsOk = isRealDir(dir, '.github') && isRealDir(dir, '.cursor', 'rules');
    add(C.allTargets, contentOk && dirsOk && res.written.length === ALL_FILES.length, JSON.stringify(res));
  });

  await withDir(async (dir) => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'mine', 'utf8');
    fs.mkdirSync(path.join(dir, '.github'));
    fs.writeFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'mine', 'utf8');
    fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cursor', 'rules', 'project-rules.mdc'), 'mine', 'utf8');
    const kept = ['CLAUDE.md', '.github/copilot-instructions.md', '.cursor/rules/project-rules.mdc'];
    const plan = await ruleExport.plan(dir, ALL_FILES, ALLOWED);
    add(C.existing, JSON.stringify(plan.existing) === JSON.stringify(kept), JSON.stringify(plan.existing));
    const res = await ruleExport.write(plan, 'skip');
    add(C.skipKeeps, kept.every(n => read(dir, n) === 'mine') && JSON.stringify(res.skipped) === JSON.stringify(kept),
      JSON.stringify(res));
    add(C.skipWritesNew, read(dir, 'AGENTS.md') === 'content of AGENTS.md' && read(dir, '.cursorrules') === 'content of .cursorrules',
      JSON.stringify(res));
  });

  await withDir(async (dir) => {
    fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
    const rel = '.cursor/rules/project-rules.mdc';
    fs.writeFileSync(path.join(dir, rel), 'mine', 'utf8');
    const plan = await ruleExport.plan(dir, [{ name: rel, content: 'new' }], ALLOWED);
    const res = await ruleExport.write(plan, 'overwrite');
    const noPart = !fs.readdirSync(path.join(dir, '.cursor', 'rules')).some(n => n.endsWith('.part'));
    add(C.overwrite, read(dir, rel) === 'new' && noPart && JSON.stringify(res.written) === JSON.stringify([rel]),
      JSON.stringify(res));
  });

  await withDir(async (dir) => {
    const plan = await ruleExport.plan(dir, [
      { name: '../CLAUDE.md', content: 'bad' },
      { name: 'README.md', content: 'bad' },
      { name: '.cursor/rules/other.mdc', content: 'bad' },
      { name: '.github/workflows/ci.yml', content: 'bad' },
      { name: path.join(dir, 'CLAUDE.md'), content: 'bad' },
      { name: '.cursorrules', content: 'ok' }
    ], ALLOWED);
    add(C.whitelist, plan.items.map(i => i.name).join(',') === '.cursorrules', plan.items.map(i => i.name).join(','));
  });

  // 第二道闸：白名单本身被人写错时（手滑加了越界条目），也不能变成任意路径写入。
  await withDir(async (dir) => {
    const badAllowed = new Set(['../escape.md', 'sub\\..\\..\\x.md', 'C:/x.md', 'a.md:ads', './a.md', '.cursorrules']);
    const plan = await ruleExport.plan(dir, [...badAllowed].map(name => ({ name, content: 'x' })), badAllowed);
    add(C.secondGate, plan.items.map(i => i.name).join(',') === '.cursorrules', plan.items.map(i => i.name).join(','));
  });

  // 链接用例：项目目录和"外面"是两个兄弟目录，链接从项目里指向外面。
  // 判定看的是外面有没有被写进东西，而不只是 plan 有没有抛错。
  await withDir(async (root) => {
    const proj = path.join(root, 'proj');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(proj); fs.mkdirSync(outside);
    junction(outside, path.join(proj, '.github'));
    const err = await planError(ruleExport, proj, ALL_FILES, ALLOWED);
    const msg = err ? String(err.message) : '';
    add(C.junctionDir,
      /^E_RULE_EXPORT_UNSAFE\|/.test(msg) && msg.includes('.github/copilot-instructions.md')
        && !exists(outside, 'copilot-instructions.md') && !exists(proj, 'CLAUDE.md'),
      err ? msg : '没有拒绝；outside=' + fs.readdirSync(outside).join(','));
  });

  await withDir(async (root) => {
    const proj = path.join(root, 'proj');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(proj, '.cursor'), { recursive: true }); fs.mkdirSync(outside);
    junction(outside, path.join(proj, '.cursor', 'rules'));
    const err = await planError(ruleExport, proj, ALL_FILES, ALLOWED);
    const msg = err ? String(err.message) : '';
    add(C.junctionDeep,
      /^E_RULE_EXPORT_UNSAFE\|/.test(msg) && msg.includes('.cursor/rules/project-rules.mdc') && !exists(outside, 'project-rules.mdc'),
      err ? msg : '没有拒绝；outside=' + fs.readdirSync(outside).join(','));
  });

  await withDir(async (root) => {
    const proj = path.join(root, 'proj');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(proj); fs.mkdirSync(outside);
    junction(outside, path.join(proj, 'AGENTS.md'));
    const err = await planError(ruleExport, proj, ALL_FILES, ALLOWED);
    const msg = err ? String(err.message) : '';
    add(C.linkAtFile, /^E_RULE_EXPORT_UNSAFE\|AGENTS\.md$/.test(msg) && !exists(proj, 'CLAUDE.md'), err ? msg : '没有拒绝');
  });

  // 真 symlink 在 Windows 上要管理员或开发者模式。建不出来时明确 SKIP（记 null），
  // 不当作通过：上面 junction 那条已经盯住了"目标文件位置是链接"，这条是补真 symlink 的形状。
  await withDir(async (root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj);
    const real = path.join(root, 'real.md');
    fs.writeFileSync(real, 'outside', 'utf8');
    try { fs.symlinkSync(real, path.join(proj, 'CLAUDE.md'), 'file'); }
    catch (e) { out.push([C.fileSymlink, null, '本机建不了 symlink（' + e.code + '）']); return; }
    const err = await planError(ruleExport, proj, ALL_FILES, ALLOWED);
    const msg = err ? String(err.message) : '';
    add(C.fileSymlink, /^E_RULE_EXPORT_UNSAFE\|CLAUDE\.md$/.test(msg) && read(real) === 'outside', err ? msg : '没有拒绝');
  });

  // plan 和 write 之间隔着"要不要覆盖"的对话框。模拟用户停在对话框上时目录被换掉：
  // plan 时 .github 还不存在（安全），write 前才放进去一个指向外面的 junction。
  await withDir(async (root) => {
    const proj = path.join(root, 'proj');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(proj); fs.mkdirSync(outside);
    const plan = await ruleExport.plan(proj, ALL_FILES, ALLOWED);
    junction(outside, path.join(proj, '.github'));
    const logged = [];
    const res = await ruleExport.write(plan, 'overwrite', (name) => logged.push(name));
    add(C.raceDir,
      !exists(outside, 'copilot-instructions.md') && res.failed.includes('.github/copilot-instructions.md')
        && logged.includes('.github/copilot-instructions.md') && read(proj, 'CLAUDE.md') === 'content of CLAUDE.md',
      JSON.stringify(res) + ' outside=' + fs.readdirSync(outside).join(','));
  });

  // 没有已有文件时主进程不弹框、mode 直接是 overwrite。这期间冒出来的同名文件
  // 用户没被问过，必须按保留处理。
  await withDir(async (dir) => {
    const plan = await ruleExport.plan(dir, ALL_FILES, ALLOWED);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'appeared later', 'utf8');
    const res = await ruleExport.write(plan, 'overwrite');
    add(C.raceFile, read(dir, 'AGENTS.md') === 'appeared later' && res.skipped.includes('AGENTS.md')
      && read(dir, 'CLAUDE.md') === 'content of CLAUDE.md', JSON.stringify(res));
  });
  return out;
}

const T = {
  defaults: '没存过勾选状态的老用户照旧只导出 CLAUDE.md 和 .cursorrules',
  emptyKept: '用户全部取消勾选时不会被默认值盖回去',
  unknownDropped: '认不出的目标 id 丢弃，结果按清单顺序且不重复',
  mdc: 'Cursor .mdc 带 description / globs / alwaysApply 三字段的 frontmatter',
  mdcSafe: '项目名里的冒号和换行不会进入 .mdc 的 frontmatter',
  legacyContent: 'CLAUDE.md 和 .cursorrules 的内容格式和原来一致'
};

function runTargetChecks(targets) {
  const out = [];
  const add = (name, ok, detail) => out.push([name, !!ok, detail || '']);
  const names = (ids) => targets.build(ids, 'P', 'body').map(f => f.name);
  add(T.defaults, JSON.stringify(names(undefined)) === '["CLAUDE.md",".cursorrules"]', JSON.stringify(names(undefined)));
  add(T.emptyKept, names([]).length === 0, JSON.stringify(names([])));
  const mixed = targets.normalizeIds(['cursor-legacy', 'nope', 'claude', 'claude', 42, '__proto__']);
  add(T.unknownDropped, JSON.stringify(mixed) === '["claude","cursor-legacy"]', JSON.stringify(mixed));

  const mdc = targets.build(['cursor-mdc'], 'Demo', 'BODY')[0];
  const lines = mdc ? mdc.content.split('\n') : [];
  add(T.mdc, !!mdc && mdc.name === '.cursor/rules/project-rules.mdc'
    && lines[0] === '---' && /^description: \S/.test(lines[1]) && lines[2] === 'globs:'
    && lines[3] === 'alwaysApply: true' && lines[4] === '---' && mdc.content.endsWith('\nBODY'),
  mdc ? JSON.stringify(lines.slice(0, 6)) : '没有生成 .mdc');
  const nasty = targets.build(['cursor-mdc'], 'a: b\nalwaysApply: false', 'BODY')[0];
  const head = nasty ? nasty.content.split('\n---\n')[0] : '';
  add(T.mdcSafe, !!nasty && !head.includes('a: b') && (head.match(/alwaysApply/g) || []).length === 1, JSON.stringify(head));

  const legacy = targets.build(['claude', 'cursor-legacy'], 'P', 'body');
  add(T.legacyContent, legacy.length === 2
    && legacy[0].content === '# P - AI Engineering Guidelines\n\nbody'
    && legacy[1].content === '# Cursor Rules for P\n\nbody', JSON.stringify(legacy));
  return out;
}

// 每个变异只撤掉一处修复，expect 是必须变红的那一条。
const LIB_MUTANTS = [
  { name: '退回只认纯文件名（旧版的 basename 判定）', expect: C.allTargets,
    find: "    const segs = allowed.has(name) ? splitRel(name) : null;\n",
    repl: "    const segs = allowed.has(name) && path.basename(name) === name ? splitRel(name) : null;\n" },
  { name: '已有文件检测漏掉子目录里的', expect: C.existing,
    find: "    if (kind === 'file') existing.push(item.name);",
    repl: "    if (kind === 'file' && !item.name.includes('/')) existing.push(item.name);" },
  { name: '跳过模式不再保护已有文件', expect: C.skipKeeps,
    find: "    if (existing.has(item.name) && mode !== 'overwrite') {",
    repl: "    if (false) {" },
  { name: '跳过模式连新文件也跳过', expect: C.skipWritesNew,
    find: "    if (existing.has(item.name) && mode !== 'overwrite') {",
    repl: "    if (mode !== 'overwrite') {" },
  { name: '覆盖模式也不写已有文件', expect: C.overwrite,
    find: "    if (existing.has(item.name) && mode !== 'overwrite') {",
    repl: "    if (existing.has(item.name)) {" },
  { name: '去掉第二道闸（白名单条目不再逐段校验）', expect: C.secondGate,
    find: "    const segs = allowed.has(name) ? splitRel(name) : null;\n",
    repl: "    const segs = allowed.has(name) ? name.split('/') : null;\n" },
  { name: '去掉白名单判定', expect: C.whitelist,
    find: "    const segs = allowed.has(name) ? splitRel(name) : null;\n",
    repl: "    const segs = splitRel(name);\n" },
  { name: 'plan 用 stat（跟着链接走）代替 lstat', expect: C.junctionDir,
    find: "    const st = await lstatOrNull(cur);\n    if (!st) return 'missing';",
    repl: "    const st = await fsp.stat(cur).catch(() => null);\n    if (!st) return 'missing';" },
  { name: 'plan 用 stat 代替 lstat（深一级）', expect: C.junctionDeep,
    find: "    const st = await lstatOrNull(cur);\n    if (!st) return 'missing';",
    repl: "    const st = await fsp.stat(cur).catch(() => null);\n    if (!st) return 'missing';" },
  { name: '链接只查中间目录，不查目标文件那一级', expect: C.linkAtFile,
    find: "    if (st.isSymbolicLink()) return 'unsafe';\n    const last = i === segs.length - 1;\n    if (last ? !st.isFile() : !st.isDirectory()) return 'unsafe';",
    repl: "    const last = i === segs.length - 1;\n    if (last) return 'file';\n    if (st.isSymbolicLink() || !st.isDirectory()) return 'unsafe';" },
  // 本机没权限建 symlink 时目标检查被跳过，这条对照也跟着 SKIP（CI 的 Windows runner 能建）。
  { name: '链接只查中间目录（真 symlink）', expect: C.fileSymlink,
    find: "    if (st.isSymbolicLink()) return 'unsafe';\n    const last = i === segs.length - 1;\n    if (last ? !st.isFile() : !st.isDirectory()) return 'unsafe';",
    repl: "    const last = i === segs.length - 1;\n    if (last) return 'file';\n    if (st.isSymbolicLink() || !st.isDirectory()) return 'unsafe';" },
  { name: '写入前不再复查，直接 mkdir recursive', expect: C.raceDir,
    find: "      const now = await prepare(exportPlan.targetDir, item.segs);",
    repl: "      await fsp.mkdir(path.dirname(item.fullPath), { recursive: true });\n      const now = (await lstatOrNull(item.fullPath)) ? 'file' : 'missing';" },
  { name: '问完之后冒出来的文件照样覆盖', expect: C.raceFile,
    find: "      if (now === 'file' && !existing.has(item.name)) {",
    repl: "      if (false && now) {" }
];

const TARGET_MUTANTS = [
  { name: '默认目标多带一个 AGENTS.md', expect: T.defaults,
    find: "  defaultIds: ['claude', 'cursor-legacy'],", repl: "  defaultIds: ['claude', 'agents', 'cursor-legacy']," },
  { name: '空数组也回落默认值', expect: T.emptyKept,
    find: "    if (!Array.isArray(value)) return", repl: "    if (!Array.isArray(value) || !value.length) return" },
  { name: '不按清单过滤 id', expect: T.unknownDropped,
    find: "    return RULE_TARGETS.list.filter(t => wanted.has(t.id)).map(t => t.id);", repl: "    return [...wanted];" },
  { name: '.mdc 改成非 Always 规则', expect: T.mdc,
    find: "        'alwaysApply: true',", repl: "        'alwaysApply: false'," },
  { name: '.mdc 的 description 直接拼项目名', expect: T.mdcSafe,
    find: "        'description: Project engineering guidelines generated by Prompt Flow Manager',",
    repl: "        'description: ' + name," },
  { name: '.cursorrules 标题改了', expect: T.legacyContent,
    find: "['# Cursor Rules for ' + name", repl: "['# Rules for ' + name" }
];

function mutate(src, m) {
  if (src.split(m.find).length !== 2) return null;
  return src.replace(m.find, () => m.repl);
}

(async () => {
  try {
    const real = await runLibChecks(loadFrom(LIB_SRC, 'rule-export.js'));
    const realTargets = runTargetChecks(loadFrom(TARGETS_SRC, 'rule-targets.js'));
    for (const [name, okv, detail] of [...real, ...realTargets]) {
      if (okv === null) console.log('[test:rule-export] SKIP ' + name + ' -> ' + detail);
      else report(okv, name, detail);
    }
    const controls = [
      ...LIB_MUTANTS.map(m => [m, LIB_SRC, 'rule-export.js', runLibChecks]),
      ...TARGET_MUTANTS.map(m => [m, TARGETS_SRC, 'rule-targets.js', async (mod) => runTargetChecks(mod)])
    ];
    for (const [m, src, base, run] of controls) {
      const mutated = mutate(src, m);
      if (mutated == null) { report(false, '反向对照「' + m.name + '」', '要替换的代码没找到（或不唯一）：' + m.find); continue; }
      const res = await run(loadFrom(mutated, base));
      const hit = res.find(([name]) => name === m.expect);
      if (hit && hit[1] === null) { console.log('[test:rule-export] SKIP 反向对照「' + m.name + '」 -> ' + hit[2]); continue; }
      report(!!hit && hit[1] === false, '反向对照「' + m.name + '」让「' + m.expect + '」变红',
        hit ? '目标检查仍是绿的' : '没跑到目标检查');
    }
  } finally {
    fs.rmSync(mutDir, { recursive: true, force: true });
  }
  if (failures) process.exit(1);
  console.log('[test:rule-export] 通过');
})().catch((e) => { console.error(e); process.exit(1); });
