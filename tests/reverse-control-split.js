// tests/reverse-control-split.js
// 反向对照：证明「自检模块拆分（注入契约）」那一节的每条断言撤掉修复就必然变红。
//
// 为什么拆分这件事特别需要反向对照：
// 把 1354 行搬进 lib/selftest.js，功能上"跑得通"很容易验证（test:fn / test:ui 会
// 真的把它跑起来）。真正危险的是**契约漂移**——三份清单（模块的 REQUIRED、init
// 的解构、主进程调用点的传参）必须逐字一致，而它们分居两个文件、靠人眼同步。
// 少一项的后果不是启动就炸：init 的校验能抓住 null，但"三份清单顺序/内容不一致"
// 这种漂移只会让某个自检项在几百行之后拿到 undefined。
//
// 还有一类更隐蔽的：四个跨边界的可变绑定（fileReadCount / cacheHits /
// cacheMisses / CONTENT_CACHE_MAX）。按值注入的话，压测清零写的是模块内的副本，
// 主进程热路径继续加在自己的变量上，于是压测**永远报 0 次读、0 命中**，
// 而且所有测试照旧全绿——这正是"改坏了却没人红"的典型形状，所以专门有用例盯它。
//
// 做法与 tests/reverse-control-update.js 完全一致（那个文件头部写了安全性设计）：
// 每个用例施加一次最小反向改动，跑真实的 tests/smoke.test.js，要求**指定的那条
// 断言**出现在失败列表里。只要求"有失败"不够——可能恰好撞红了别的断言，
// 那说明目标断言依然是空的。
//
// 这里单列一个脚本而不是塞进 reverse-control-update.js：两者的还原文件集不同
// （这个要管 lib/selftest.js），而且改坏的是两块互不相干的修复区域，
// 混在一起的话失败信息会很难定位到底是哪一块的契约破了。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const FILES = ['electron-main.js', 'lib/selftest.js'];
const BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-rc-split-'));
const original = new Map();
for (const rel of FILES) {
  const p = path.join(root, rel);
  const text = fs.readFileSync(p, 'utf8');
  const backup = path.join(BACKUP_DIR, rel.replace(/[\\/]/g, '__'));
  fs.writeFileSync(backup, text);
  original.set(rel, { path: p, text, hash: md5(text), backup });
}

function restoreAll() {
  let bad = 0;
  for (const [rel, o] of original) {
    fs.writeFileSync(o.path, o.text);
    const now = md5(fs.readFileSync(o.path, 'utf8'));
    if (now !== o.hash) {
      console.error('!! 还原失败: ' + rel + ' (期望 ' + o.hash + ' 实得 ' + now + ')');
      console.error('   磁盘备份在: ' + o.backup);
      bad++;
    }
  }
  return bad === 0;
}

// node 默认的 SIGINT 动作是直接终止进程，finally 不会跑。不接管信号的话，
// Ctrl-C 就会把改坏的源文件留在工作区里。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error('\n收到 ' + sig + '，正在还原源文件…');
    const ok = restoreAll();
    console.error(ok ? '已还原 ✓' : '还原失败，备份目录: ' + BACKUP_DIR);
    process.exit(ok ? 130 : 2);
  });
}

// 施加一个用例的全部改动。edits 可以跨文件、同一文件多处。
//
// 为什么要支持多处：有些断言只有在"改动做得够完整"时才是唯一的那道红线。
// 比如把 win 注入进来——只往主进程的调用点加一项，先撞红的是"三份清单必须一致"
// 那条，于是永远验证不到"win 不在注入契约里"这条本身有没有用。真实的错误做法
// 是三处一起加（那才是一个人决定注入 win 之后会写出来的样子），那时候清单是
// 一致的、只有这一条该红。
//
// 返回没找到的那条 find（全部命中返回 null）。没找到不是"跳过"，是用例和代码
// 脱节了，必须当失败处理。
function mutate(edits) {
  const staged = new Map();  // rel -> text
  for (const e of edits) {
    const o = original.get(e.rel);
    const cur = staged.has(e.rel) ? staged.get(e.rel) : o.text;
    if (!cur.includes(e.find)) return e;
    staged.set(e.rel, cur.split(e.find).join(e.replace));
  }
  for (const [rel, text] of staged) fs.writeFileSync(original.get(rel).path, text);
  return null;
}

// 用例可以写成单处（rel/find/replace）或多处（edits 数组）。
const editsOf = (c) => c.edits || [{ rel: c.rel, find: c.find, replace: c.replace }];

// 整块 selftest.init({...}); 的原文。从真实文件里切出来，而不是抄一份字面量：
// 注入清单以后一定还会变（加/删依赖），抄的那份会静默脱节，而脱节的表现是
// "find 没找到"——那时候要去改的是这个脚本，不是代码，很容易误判成代码坏了。
const INIT_BLOCK = (() => {
  const text = original.get('electron-main.js').text;
  const at = text.indexOf('selftest.init({');
  const end = at === -1 ? -1 : text.indexOf('});', at);
  if (at === -1 || end === -1) {
    console.error('!! 在 electron-main.js 里找不到 selftest.init({ … }); 整块，反向对照无法构造"挪位置"的改动');
    restoreAll();
    process.exit(2);
  }
  return text.slice(at, end + 3);
})();

function runSmoke() {
  const r = spawnSync(process.execPath, [path.join(root, 'tests/smoke.test.js')], {
    cwd: root, encoding: 'utf8'
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const reds = out.split(/\r?\n/).filter(l => l.includes('✗')).map(l => l.trim());
  return { code: r.status, reds, out };
}

const CASES = [
  // ---- 搬走 vs 抄一份 ----
  // 最容易犯的错：为了让旧调用点继续工作，在主进程里留一份同名函数。
  // 那样两份实现会各自演化，而测试只盯着其中一份。
  {
    name: '主进程里又留了一份 attachSelfTest（抄一份而不是搬走）',
    rel: 'electron-main.js',
    find: 'function attachNavigationGuard(targetWin) {',
    replace: 'function attachSelfTest(targetWin) { return null; }\nfunction attachNavigationGuard(targetWin) {',
    expect: /不再有 attachSelfTest 的定义/
  },
  {
    name: '主进程里又留了一份 runSearchBench',
    rel: 'electron-main.js',
    find: 'function attachNavigationGuard(targetWin) {',
    replace: 'async function runSearchBench(count) { return count; }\nfunction attachNavigationGuard(targetWin) {',
    expect: /不再有 runSearchBench 的定义/
  },
  {
    name: '模块把内部实现也导出了（边界变宽）',
    rel: 'lib/selftest.js',
    find: 'module.exports = { init, runSearchBench, installSelfTestDialogStubs, attachSelfTest };',
    replace: 'module.exports = { init, runSearchBench, installSelfTestDialogStubs, attachSelfTest, runSecurityRegression, loadSelfTestScript };',
    expect: /不导出内部实现/
  },

  // ---- 三份清单必须一致 ----
  {
    name: 'REQUIRED 少列一项（init 的校验就漏掉这一项）',
    rel: 'lib/selftest.js',
    find: "  'createFileAt', 'importMarkdown'\n];",
    replace: "  'createFileAt'\n];",
    expect: /REQUIRED 与 init 解构完全一致/
  },
  {
    name: 'init 的解构少接一项（模块里那个名字永远是 undefined）',
    rel: 'lib/selftest.js',
    find: '    createFileAt, importMarkdown\n  } = ctx);',
    replace: '    createFileAt\n  } = ctx);',
    expect: /REQUIRED 与 init 解构完全一致/
  },
  {
    name: '主进程调用点少传一项（自检跑到那里才 undefined is not a function）',
    rel: 'electron-main.js',
    find: '  createFileAt, importMarkdown\n});',
    replace: '  createFileAt\n});',
    expect: /主进程传的和模块要的完全一致/
  },
  {
    // 只替换那一行 throw。第一版把"算 missing"和"抛"当成相邻两行一起替换，
    // 但它们之间隔着三行注释（在解释为什么这里的文案是英文），find 匹配不到，
    // 于是这个用例报的是"和代码脱节"而不是它要证明的事。
    name: 'init 不再校验漏传（漏传从"启动报名字"退化成"几百行后才炸"）',
    rel: 'lib/selftest.js',
    find: "  if (missing.length) throw new Error('lib/selftest.js: init() missing deps: ' + missing.join(', '));",
    replace: '  void missing;',
    expect: /init 自己校验漏传/
  },
  {
    // 守卫被掏空：四处 requireInit( 的文本一个没少，只是那个函数不再抛了。
    // 断言的第一版是"数 requireInit( 出现几次"，正好被这个改动全绿地穿过去。
    name: 'requireInit 被掏空（调用点都在，但不再抛）',
    rel: 'lib/selftest.js',
    find: "function requireInit(who) {\n  if (!initialized) throw new Error('lib/selftest.js: ' + who + ' called before init()');",
    replace: 'function requireInit(who) {\n  void who;',
    expect: /requireInit 未初始化时真的抛/
  },
  {
    // 守卫还在、也真的抛，但挪到了函数体后面——前面那几行已经在没注入依赖的
    // 状态下跑过了，守卫只剩装饰作用。
    name: 'requireInit 不再是入口的第一条语句（挪到干活之后）',
    rel: 'lib/selftest.js',
    find: "function attachSelfTest(targetWin) {\n  requireInit('attachSelfTest');\n  const consoleErrors = [];",
    replace: "function attachSelfTest(targetWin) {\n  const consoleErrors = [];\n  requireInit('attachSelfTest');",
    expect: /第一条语句就是 requireInit 守卫/
  },

  // ---- 四个可变绑定：按值注入会写进死副本 ----
  // 这一组是整次拆分里最容易"全绿地坏掉"的地方。
  {
    name: '改成按值注入 fileReadCount（压测清零写进死副本）',
    rel: 'lib/selftest.js',
    find: "  'cacheStats', 'contentCache', 'readParsedCached', 'dropFromCache',",
    replace: "  'cacheStats', 'contentCache', 'readParsedCached', 'dropFromCache', 'fileReadCount',",
    expect: /fileReadCount 不单独注入/
  },
  {
    name: '模块里自己声明 cacheHits 影子变量（热路径的增量看不见）',
    rel: 'lib/selftest.js',
    find: 'let initialized = false;',
    replace: 'let cacheHits = 0;\nlet initialized = false;',
    expect: /没有自己声明 cacheHits/
  },
  {
    name: '主进程又恢复成模块级 CONTENT_CACHE_MAX（自检调小的是另一个变量）',
    rel: 'electron-main.js',
    find: 'function countedReadFile(fullPath) {',
    replace: 'let CONTENT_CACHE_MAX = 5000;\nfunction countedReadFile(fullPath) {',
    expect: /不再有模块级 CONTENT_CACHE_MAX/
  },
  {
    name: '压测清零写到别处（不是共享对象）',
    rel: 'lib/selftest.js',
    find: '    cacheStats.fileReadCount = 0;',
    replace: '    let shadowReadCount = 0; shadowReadCount = 0; void shadowReadCount;',
    expect: /压测清零写的是 cacheStats/
  },
  {
    name: 'LRU 自检调小的不是共享对象',
    rel: 'lib/selftest.js',
    find: '    cacheStats.CONTENT_CACHE_MAX = 3;',
    replace: '    let shadowMax = 3; void shadowMax;',
    expect: /LRU 自检调小的也是 cacheStats/
  },
  {
    name: '主进程的读计数不加在共享对象上',
    rel: 'electron-main.js',
    find: '  cacheStats.fileReadCount++;',
    replace: '  void 0;',
    expect: /主进程的读计数加在 cacheStats 上/
  },
  {
    name: 'LRU 上限判断读的不是共享对象',
    rel: 'electron-main.js',
    find: '  while (contentCache.size > cacheStats.CONTENT_CACHE_MAX) {',
    replace: '  while (contentCache.size > 5000) {',
    expect: /LRU 上限判断读 cacheStats/
  },

  // ---- win 不能注入（重建窗口会换实例）----
  {
    // 第一版只往主进程调用点加 win。那样红的是"传了但模块没声明"——也就是三份清单
    // 的一致性断言，而不是"win 不该注入"这一条，等于没证明目标断言在干活。
    // 真要注入 win 的人会四处一起改：REQUIRED、模块级 let、init 解构、调用点。
    // 所以这个用例照着那个形状改，目标断言才是真正被触发的那条。
    name: 'win 被塞进注入契约（重建窗口后模块持有已销毁的旧实例）',
    edits: [
      { rel: 'lib/selftest.js',
        find: "  'cacheStats', 'contentCache', 'readParsedCached', 'dropFromCache',",
        replace: "  'win', 'cacheStats', 'contentCache', 'readParsedCached', 'dropFromCache'," },
      { rel: 'lib/selftest.js',
        find: 'let cacheStats, contentCache, readParsedCached, dropFromCache;',
        replace: 'let win, cacheStats, contentCache, readParsedCached, dropFromCache;' },
      { rel: 'lib/selftest.js',
        find: '    cacheStats, contentCache, readParsedCached, dropFromCache,',
        replace: '    win, cacheStats, contentCache, readParsedCached, dropFromCache,' },
      { rel: 'electron-main.js',
        find: '  cacheStats, contentCache, readParsedCached, dropFromCache,',
        replace: '  win, cacheStats, contentCache, readParsedCached, dropFromCache,' }
    ],
    expect: /win 不在注入契约里/
  },
  {
    // 这两条原先是一条，盯的是"函数签名里没有 win"。反向对照证明那样是空的：
    // 签名不用动，模块里另起一个 win 再兜底替换掉传进来的窗口就绕过去了。
    // 拆成两条：一条盯"模块里不许有裸的 win 标识符"，一条盯"传进来的窗口不被替换"。
    name: '模块里又出现模块级 win（重建窗口后它指向已销毁的实例）',
    rel: 'lib/selftest.js',
    find: 'let initialized = false;',
    replace: 'let win = null;\nlet initialized = false;',
    expect: /没有裸的 win 引用/
  },
  {
    name: '传进来的窗口被兜底替换（调用方传的那个不一定生效）',
    rel: 'lib/selftest.js',
    find: "function attachSelfTest(targetWin) {\n  requireInit('attachSelfTest');",
    replace: "function attachSelfTest(targetWin) {\n  requireInit('attachSelfTest');\n  targetWin = targetWin || null;",
    expect: /targetWin 不做兜底替换/
  },

  // ---- console-message 的两套签名 ----
  // 这一组是升 Electron 时最阴的一类：28 → 38 把事件签名从 (e, level, message)
  // 改成单个 details 对象，level 也从整数变字符串。只认旧签名的话，新版里
  // `level >= 2` 恒为 false，"渲染进程报错就让自检失败"这道唯一入口静默失效，
  // 而所有测试照旧全绿——全绿恰好是症状本身。实测过：往 probe.js 里注一条
  // console.error，修好之后自检确实 FAIL 并点出那条错误，退出码 1。
  {
    name: '只认旧签名的整数 level（新版里 level 是对象，恒不成立）',
    rel: 'lib/selftest.js',
    find: "    const d = args[0];\n    if (d && typeof d === 'object' && 'level' in d && typeof d.level === 'string') {\n      if (d.level === 'warning' || d.level === 'error') consoleErrors.push(d.message);\n      return;\n    }",
    replace: '',
    expect: /认新签名的字符串 level/
  },
  {
    name: '只认新签名（在旧版 Electron 上又收不到报错）',
    rel: 'lib/selftest.js',
    find: "    const [, level, message] = args;\n    if (typeof level === 'number' && level >= 2) consoleErrors.push(message);",
    replace: '    void args;',
    expect: /同时认旧签名的整数 level/
  },
  {
    name: '监听器整个删掉（渲染进程报错再也进不了 consoleErrors）',
    rel: 'lib/selftest.js',
    find: "  targetWin.webContents.on('console-message', (...args) => {",
    replace: "  targetWin.webContents.on('console-message-DISABLED', (...args) => {",
    expect: /找到 console-message 监听/
  },

  // ---- 模块必须保持 electron-free / 不自己算路径 ----
  {
    name: '模块自己 require electron（拿到的不是主进程那份状态）',
    rel: 'lib/selftest.js',
    find: 'let initialized = false;',
    replace: "const { app: _a } = require('electron');\nvoid _a;\nlet initialized = false;",
    expect: /不自己 require electron/
  },
  {
    name: '模块自己 app.getPath 解析数据目录（DATA_ROOT 出现第二处真值来源）',
    rel: 'lib/selftest.js',
    find: 'let initialized = false;',
    replace: "const _d = app.getPath('userData');\nvoid _d;\nlet initialized = false;",
    expect: /不自己解析数据目录/
  },
  {
    name: '模块自己判断打包状态（路径分支出现第二处）',
    rel: 'lib/selftest.js',
    find: 'let initialized = false;',
    replace: 'const _p = app.isPackaged;\nvoid _p;\nlet initialized = false;',
    expect: /不自己判断打包状态/
  },
  {
    // 上面两条查的是 app.* 那两个入口。这一条盯的是绕开它们的写法：
    // 直接拿 PFM_DATA_DIR 兜底推导出一个路径根。原先那条只查 app.getPath(，
    // 反向对照就是用这个形状证明它是空的。
    name: '模块拿 PFM_DATA_DIR 兜底推导路径根（绕开 app.getPath）',
    rel: 'lib/selftest.js',
    find: 'let initialized = false;',
    replace: "const _d = process.env.PFM_DATA_DIR || 'C:/fallback';\nvoid _d;\nlet initialized = false;",
    expect: /PFM_DATA_DIR 只用于判断是否隔离/
  },

  // ---- 调用点与时序 ----
  {
    name: '主进程直接裸调 attachSelfTest（绕开模块前缀）',
    rel: 'electron-main.js',
    find: "process.env.PFM_SELFTEST === '1' ? selftest.attachSelfTest(win) : null",
    replace: "process.env.PFM_SELFTEST === '1' ? (0, selftest['attachSelfTest'])(win) : null",
    expect: /主进程调 selftest\.attachSelfTest/
  },
  {
    // 第一版是在对象字面量里插一句 `/* moved-marker */` 假装"挪过了"。那不是这条
    // 断言防的事，而且更糟：解析传参清单用的是 /[A-Za-z_$][\w$]*/g，注释里的
    // moved / marker 被当成了两个依赖名，红的于是是"传了但模块没声明"。
    // 真正的反向改动就是把整块挪到 SELF_URL 定义之前——那正是会把 undefined
    // 冻进模块的那个错误。所以这里真搬：先删掉原处，再插到 SELF_URL 之前。
    name: 'init 挪到 SELF_URL 之前（把 undefined 冻进模块）',
    edits: [
      { rel: 'electron-main.js', find: INIT_BLOCK, replace: '' },
      { rel: 'electron-main.js', find: 'const SELF_URL =',
        replace: INIT_BLOCK + '\nconst SELF_URL =' }
    ],
    expect: /在它注入的所有东西都定义之后才调用/
  },
  // 自检脚本仍然必须是真实文件、从 CODE_ROOT 读。这两条原先盯的是
  // electron-main.js，拆分后必须跟着指向模块——否则它们会在一个不再包含
  // 这些代码的文件上恒真（本仓库踩过完全同样的坑）。
  {
    name: '自检脚本改从 DATA_ROOT 读（打包后那里没有这些文件）',
    rel: 'lib/selftest.js',
    find: "  const p = path.join(CODE_ROOT, 'src', 'selftest', name);",
    replace: "  const p = path.join(DATA_ROOT, 'src', 'selftest', name);",
    expect: /自检脚本从 CODE_ROOT 读/
  },
  {
    name: '把自检脚本塞回模块里的模板字符串（又变成检查盲区）',
    rel: 'lib/selftest.js',
    find: 'function attachSelfTest(targetWin) {',
    replace: 'const inlineScript = `\n' + Array.from({ length: 14 }, (_, i) => '  const x' + i + ' = ' + i + ';').join('\n') + '\n`;\nvoid inlineScript;\nfunction attachSelfTest(targetWin) {',
    expect: /没有超过 10 行的内联脚本模板字符串/
  }
];

(function main() {
  console.log('反向对照：自检模块拆分（共 ' + CASES.length + ' 个用例）');
  console.log('');

  const base = runSmoke();
  if (base.code !== 0) {
    console.error('基线就不是全绿，先修好再跑反向对照。失败项：');
    base.reds.forEach(l => console.error('  ' + l));
    process.exit(1);
  }
  console.log('基线全绿 ✓');
  console.log('');

  let bad = 0;
  try {
    for (const c of CASES) {
      const missed = mutate(editsOf(c));
      if (missed) {
        console.error('✗ ' + c.name);
        console.error('    要替换的代码没找到（这个对照用例和代码脱节了，需要更新）');
        console.error('    ' + missed.rel + ' 里找不到: ' + JSON.stringify(missed.find.slice(0, 90)));
        bad++;
        restoreAll();
        continue;
      }
      const r = runSmoke();
      restoreAll();

      const hit = r.reds.find(l => c.expect.test(l));
      if (hit) {
        console.log('✓ ' + c.name);
        console.log('    → ' + hit);
      } else if (r.code === 0) {
        console.error('✗ ' + c.name);
        console.error('    改坏了却全绿：这条断言是空的（恒真），必须重写');
        bad++;
      } else {
        console.error('✗ ' + c.name);
        console.error('    变红了，但红的不是目标断言（目标 ' + c.expect + '）：');
        r.reds.forEach(l => console.error('      ' + l));
        bad++;
      }
    }
  } finally {
    if (!restoreAll()) {
      console.error('');
      console.error('!! 文件没能还原干净，立刻检查 git status / git diff');
      process.exit(2);
    }
  }

  const after = runSmoke();
  console.log('');
  if (after.code !== 0) {
    console.error('还原后冒烟测试不再全绿，检查 git diff：');
    after.reds.forEach(l => console.error('  ' + l));
    process.exit(2);
  }
  console.log('还原后基线仍全绿 ✓');

  if (bad === 0) {
    try { fs.rmSync(BACKUP_DIR, { recursive: true, force: true }); }
    catch { console.log('（备份目录没能删掉，可手动清理: ' + BACKUP_DIR + '）'); }
    console.log('[reverse-control:split] 通过（' + CASES.length + ' 个修复点全部证明「撤掉就变红」）');
    process.exit(0);
  }
  console.error('[reverse-control:split] ' + bad + ' 个修复点没能证明变红');
  console.error('（源文件已还原，备份留在 ' + BACKUP_DIR + '）');
  process.exit(1);
})();
