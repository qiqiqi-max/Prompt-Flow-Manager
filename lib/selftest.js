// 自检 / 压测 / 安全回归。
//
// 这一整块都是**测试专用**代码：靠 PFM_SELFTEST / PFM_SELFTEST_BENCH /
// PFM_SELFTEST_DIALOGS 三个环境变量触发，正常启动一行都不跑。它原先住在
// electron-main.js 里，占了那个文件的 35%（1354 行），于是"主进程在干什么"
// 这个问题要翻过一千多行测试脚手架才能回答。搬出来之后主文件只剩生产路径。
//
// 为什么是 init(ctx) 而不是 createSelfTest(ctx) 工厂：
// 这段代码里有若干多行模板字符串，原样交给 webContents.executeJavaScript 执行。
// 包进工厂函数就得整体缩进一层，而缩进会改掉模板字符串的内容本身——
// 那不再是"搬代码"，是改代码。用模块级 let + init 赋值，1354 行可以逐字节不动地
// 搬过来，diff 也还能看。
//
// 依赖一律注入，模块自己不 require electron、也不自己算路径：
// 主进程里的 DATA_ROOT / contentCache / win 这些都是运行期才定下来的，
// 模块里重新 require 一份只会拿到另一个实例（尤其是 contentCache 这种
// 进程内唯一的 Map），自检就测不到真实对象了。

let app, dialog, fs, fsp, path, pathToFileURL;
let CODE_ROOT, DATA_ROOT, DATA_ROOT_NORM, PROMPTS_DIR, CONFIG_PATH, TRASH_DIR, TRASH_DIR_NORM;
let SELF_URL, DEFAULT_PROJECT_TYPES, I18N_TABLE;
let cacheStats, contentCache, readParsedCached, dropFromCache;
let safeJoin, safeJoinWritable, isSelfUrl;
let ensureDir, queueWrite, queueWriteMulti;
let loadConfig, getMetaList, searchAll, saveVersion;
let versionDirFor, timestampName, trashStorePath, readTrashIndex, writeTrashIndex;
let createFileAt, importMarkdown;

// 注入契约。逐个列出来而不是 Object.assign 一把梭，是为了让 init 能校验：
// 少传一个键，现在会在启动时就报出名字，而不是等自检跑到第 300 行才
// "undefined is not a function"——那时候离根因已经很远了。
//
// 这份清单不是手写猜出来的：把这 1354 行搬进 lib/ 之后，eslint 的 no-undef
// 会把每一个自由变量原原本本点出来（本仓库的 eslint 配置刻意把三种运行环境
// 分开配，就是为了让 no-undef 在这种场合真的能用）。清单少一项，lint 就红。
const REQUIRED = [
  'app', 'dialog', 'fs', 'fsp', 'path', 'pathToFileURL',
  'CODE_ROOT', 'DATA_ROOT', 'DATA_ROOT_NORM', 'PROMPTS_DIR', 'CONFIG_PATH',
  'TRASH_DIR', 'TRASH_DIR_NORM',
  'SELF_URL', 'DEFAULT_PROJECT_TYPES', 'I18N_TABLE',
  'cacheStats', 'contentCache', 'readParsedCached', 'dropFromCache',
  'safeJoin', 'safeJoinWritable', 'isSelfUrl',
  'ensureDir', 'queueWrite', 'queueWriteMulti',
  'loadConfig', 'getMetaList', 'searchAll', 'saveVersion',
  'versionDirFor', 'timestampName', 'trashStorePath', 'readTrashIndex', 'writeTrashIndex',
  'createFileAt', 'importMarkdown'
];

let initialized = false;

function init(ctx) {
  const missing = REQUIRED.filter(k => ctx == null || ctx[k] == null);
  // 英文文案是故意的：这是接线错误（漏传依赖），只会在启动时当场炸，永远到不了
  // 渲染进程，所以不该占用 err_* 的用户文案。主进程那条"不许抛中文字面量"的规则
  // 针对的是会经 IPC 翻译给用户看的错误，这里不是。
  if (missing.length) throw new Error('lib/selftest.js: init() missing deps: ' + missing.join(', '));
  ({
    app, dialog, fs, fsp, path, pathToFileURL,
    CODE_ROOT, DATA_ROOT, DATA_ROOT_NORM, PROMPTS_DIR, CONFIG_PATH, TRASH_DIR, TRASH_DIR_NORM,
    SELF_URL, DEFAULT_PROJECT_TYPES, I18N_TABLE,
    cacheStats, contentCache, readParsedCached, dropFromCache,
    safeJoin, safeJoinWritable, isSelfUrl,
    ensureDir, queueWrite, queueWriteMulti,
    loadConfig, getMetaList, searchAll, saveVersion,
    versionDirFor, timestampName, trashStorePath, readTrashIndex, writeTrashIndex,
    createFileAt, importMarkdown
  } = ctx);
  initialized = true;
}

// 三个入口各自挡一道。自检是"验证正确性"的代码，它自己在没注入依赖的情况下
// 跑起来只会产出一堆无意义的失败项，那比直接炸掉更难查。
function requireInit(who) {
  if (!initialized) throw new Error('lib/selftest.js: ' + who + ' called before init()');
}

// ---------- 搜索压测（PFM_SELFTEST_BENCH=<条数>） ----------
// 搜索会遍历整个库，是唯一随规模线性变差的操作。这里生成指定条数的提示词，
// 量化耗时与读文件次数，避免"感觉快了"这种没有依据的结论。
// 必须配 PFM_DATA_DIR，否则会往真实库里灌垃圾数据。
async function runSearchBench(count) {
  requireInit('runSearchBench');
  const stage = 'testing';
  const dir = path.join(PROMPTS_DIR, stage);
  await ensureDir(dir);
  for (let i = 0; i < count; i++) {
    const body = 'lorem ipsum '.repeat(40) + (i === count - 1 ? ' NEEDLE_AT_END ' : '') + 'dolor sit amet';
    await fsp.writeFile(path.join(dir, `bench-${i}.md`),
      `---\ntitle: Bench ${i}\nstage: ${stage}\ntags: [bench]\n---\n${body}`, 'utf8');
  }
  const time = async (label, fn) => {
    cacheStats.fileReadCount = 0;
    cacheStats.cacheHits = 0;
    cacheStats.cacheMisses = 0;
    const t0 = Date.now();
    const r = await fn();
    const ms = Date.now() - t0;
    console.log(`[bench] ${label}: ${ms}ms, 读文件 ${cacheStats.fileReadCount} 次, 缓存命中 ${cacheStats.cacheHits}/${cacheStats.cacheHits + cacheStats.cacheMisses}, 结果 ${Array.isArray(r) ? r.length : '-'} 条`);
    return { ms, reads: cacheStats.fileReadCount };
  };
  console.log(`[bench] 库规模: ${count} 条提示词`);
  await time('getMetaList', () => getMetaList());
  await time('search 命中正文末尾', () => searchAll('NEEDLE_AT_END'));
  await time('search 命中标签', () => searchAll('bench'));
  await time('search 无命中', () => searchAll('zzz_nothing_matches_zzz'));
}

// ---------- 自检用的系统对话框桩 ----------
// 导出/导入四个流程都要弹系统对话框，正常跑不了自动化测试。
// 这里在自检模式下把 dialog 换成"按队列返回预设结果"的桩，队列放在
// PFM_SELFTEST_DIALOGS 指向的 JSON 文件里（每次取走一项，写回剩余项）。
// 两个开关都不设时这段完全不生效，生产行为不受影响。
//
// 队列按 kind 分流而不是一条流水线：文件对话框（save/open）和消息框
// （confirm / confirm-unsaved）的调用时机互不相干，混在一条队列里的话，
// 往中间插一个消息框应答就会把后面四个导出/导入的应答全错位一格。
// 不带 kind 的条目算文件对话框，保持既有队列不用改。
const selfTestDialogCalls = { file: 0, messageBox: 0 };
// 最近一次消息框的实际参数。原生对话框不在 DOM 里，渲染进程那段"切到英文后
// clone body 查残留中文"根本看不到它，所以主进程留一份给自检断言用——
// 否则"按钮写死中文"这类缺陷在自动化里是完全不可见的。
let selfTestLastMessageBox = null;
// 同理留一份文件对话框的标题（导出备份 / 导出提示词 / 导入提示词 / 导入备份包）。
let selfTestLastFileDialog = null;
function installSelfTestDialogStubs() {
  requireInit('installSelfTestDialogStubs');
  const queuePath = process.env.PFM_SELFTEST_DIALOGS;
  const takeNext = (kind, fallback) => {
    try {
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      const at = queue.findIndex(q => (q && q.kind ? q.kind : 'file') === kind);
      const item = at === -1 ? null : queue.splice(at, 1)[0];
      fs.writeFileSync(queuePath, JSON.stringify(queue), 'utf8');
      if (item) console.log('[selftest] 对话框桩返回(' + kind + '): ' + JSON.stringify(item));
      // 队列里没有对应条目说明测试没料到这次弹框。不能静默放行：
      // 走 fallback（取消）才不会让"多弹了一个框"看起来像成功。
      else console.error('[selftest] 对话框桩：' + kind + ' 队列已空，按取消处理');
      return item || fallback;
    } catch (e) {
      console.error('[selftest] 读取对话框队列失败:', e.message);
      return fallback;
    }
  };
  const recordFile = (args) => {
    const opts = (args.length > 1 ? args[1] : args[0]) || {};
    selfTestLastFileDialog = { title: opts.title == null ? '' : String(opts.title) };
  };
  dialog.showSaveDialog = async (...args) => {
    selfTestDialogCalls.file++;
    recordFile(args);
    return takeNext('file', { canceled: true });
  };
  dialog.showOpenDialog = async (...args) => {
    selfTestDialogCalls.file++;
    recordFile(args);
    return takeNext('file', { canceled: true, filePaths: [] });
  };
  // 消息框（确认 / 三选一的未保存提示）。回退值取调用方自己声明的 cancelId，
  // 这样"队列没料到的弹框"一律等于用户按了取消——对 confirm-unsaved 就是
  // 保住草稿、中止切换，是最安全的那个分支。
  dialog.showMessageBox = async (...args) => {
    const opts = (args.length > 1 ? args[1] : args[0]) || {};
    selfTestDialogCalls.messageBox++;
    selfTestLastMessageBox = {
      buttons: Array.isArray(opts.buttons) ? opts.buttons.slice() : [],
      message: opts.message == null ? '' : String(opts.message),
      detail: opts.detail == null ? '' : String(opts.detail)
    };
    return takeNext('message', { response: Number.isInteger(opts.cancelId) ? opts.cancelId : 0 });
  };
  console.log('[selftest] 已启用对话框桩，队列文件: ' + queuePath);
}

// ---------- 安全回归（跟着功能自检一起跑） ----------
// 这几条都要先把磁盘弄成"坏状态"才能测：伪造被改坏的 .trash/index.json、
// 把 config.json 占成目录让原子写必然失败。渲染进程没有 fs，构造不出前置条件，
// 所以放在主进程。全程只动 PFM_DATA_DIR 指向的临时目录。
async function runSecurityRegression(targetWin) {
  const out = [];
  const check = (name, ok, detail) => out.push([name, !!ok, detail == null ? '' : String(detail)]);
  // 从渲染进程发起 IPC：这样走的是和用户操作完全相同的链路，
  // 而不是在主进程里直接调 handler 内部函数（那样测不到 ipcMain 层）。
  const viaIpc = (expr) => targetWin.webContents.executeJavaScript(
    `(async () => { try { const r = await ${expr}; return { ok: true, value: r }; }
      catch (e) { return { ok: false, message: String(e && e.message || e) }; } })()`, true);

  // ---- 1. 回收站索引被改坏时不能删到 .trash 外面 ----
  // .trash/index.json 是普通 JSON 文件，同步盘冲突、外部编辑器、上次崩溃写坏
  // 都会让 store 变成 "../XXX"。empty-trash 对它调 rm(recursive, force)，
  // force 连"不存在"都不报错，删错了不留任何痕迹。
  const outsideDir = path.join(DATA_ROOT, 'SEC-MUST-SURVIVE');
  const outsideFile = path.join(outsideDir, 'keep.txt');
  try {
    await ensureDir(outsideDir);
    await fsp.writeFile(outsideFile, 'must survive', 'utf8');
    await ensureDir(TRASH_DIR);
    // 直接写坏索引，绕过所有正常入口
    await fsp.writeFile(path.join(TRASH_DIR, 'index.json'), JSON.stringify({
      items: [
        { id: 'sec-escape-1', originalRel: 'prompts/x.md', name: 'x.md',
          trashedAt: new Date().toISOString(), store: '../SEC-MUST-SURVIVE', versionStore: null },
        { id: 'sec-escape-2', originalRel: 'prompts/y.md', name: 'y.md',
          trashedAt: new Date().toISOString(), store: 'nested/../../SEC-MUST-SURVIVE', versionStore: null }
      ]
    }, null, 2), 'utf8');

    const emptied = await viaIpc('window.promptFlowApi.emptyTrash()');
    check('清空回收站在索引被改坏时仍返回成功', emptied.ok === true, emptied.message);
    check('越界的 store 没有删到 .trash 之外的目录', fs.existsSync(outsideDir));
    check('越界的 store 没有删到 .trash 之外的文件', fs.existsSync(outsideFile));

    // restore 走的是同一批 store 字段，同样要挡住
    await fsp.writeFile(path.join(TRASH_DIR, 'index.json'), JSON.stringify({
      items: [{ id: 'sec-escape-3', originalRel: 'prompts/z.md', name: 'z.md',
        trashedAt: new Date().toISOString(), store: '../SEC-MUST-SURVIVE', versionStore: null }]
    }, null, 2), 'utf8');
    const restored = await viaIpc(`window.promptFlowApi.restore('sec-escape-3')`);
    check('恢复越界条目会被拒绝而不是照做', restored.ok === false, JSON.stringify(restored));
    check('恢复失败后越界目录依然完好', fs.existsSync(outsideFile));
  } catch (e) {
    check('回收站越界防护用例执行完成', false, e && e.message);
  } finally {
    try { await fsp.writeFile(path.join(TRASH_DIR, 'index.json'), JSON.stringify({ items: [] }, null, 2), 'utf8'); } catch {}
    try { await fsp.rm(outsideDir, { recursive: true, force: true }); } catch {}
  }

  // ---- 2. 配置写盘失败必须传到渲染进程 ----
  // saveConfig 把写盘异常吞成 return false。原先 updateConfig 扔掉这个返回值，
  // set-config 照常 resolve，渲染进程把内存值当成已落盘——改完当场生效、重启全丢。
  // 这里把 config.json 换成目录：writeFileAtomic 最后那步 rename 必然 EPERM/EISDIR。
  let cfgBackup = null;
  try {
    try { cfgBackup = await fsp.readFile(CONFIG_PATH, 'utf8'); } catch { cfgBackup = null; }
    const before = await viaIpc('window.promptFlowApi.getConfig()');
    const themeBefore = before.ok ? before.value.theme : null;

    try { await fsp.unlink(CONFIG_PATH); } catch {}
    await fsp.mkdir(CONFIG_PATH, { recursive: true });
    const blocked = await viaIpc(`window.promptFlowApi.setConfig({ theme: 'sec-probe-theme' })`);
    check('配置写盘失败时 setConfig 抛错而不是假装成功', blocked.ok === false, JSON.stringify(blocked));
    check('失败信息带 E_CONFIG_WRITE 错误码',
      blocked.ok === false && /E_CONFIG_WRITE/.test(blocked.message || ''), blocked.message);

    // 复原后必须能正常写，且刚才那次失败的值没有残留在磁盘上
    await fsp.rm(CONFIG_PATH, { recursive: true, force: true });
    if (cfgBackup != null) await fsp.writeFile(CONFIG_PATH, cfgBackup, 'utf8');
    const after = await viaIpc(`window.promptFlowApi.setConfig({ theme: ${JSON.stringify(themeBefore || 'light')} })`);
    check('恢复可写后 setConfig 重新正常工作', after.ok === true, JSON.stringify(after));
    let onDisk = null;
    try { onDisk = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8')); } catch {}
    check('写盘失败的值没有留在 config.json 里',
      !onDisk || onDisk.theme !== 'sec-probe-theme', onDisk && onDisk.theme);
  } catch (e) {
    check('配置写失败用例执行完成', false, e && e.message);
  } finally {
    try {
      const st = fs.existsSync(CONFIG_PATH) ? await fsp.stat(CONFIG_PATH) : null;
      if (st && st.isDirectory()) await fsp.rm(CONFIG_PATH, { recursive: true, force: true });
      if (cfgBackup != null && !fs.existsSync(CONFIG_PATH)) await fsp.writeFile(CONFIG_PATH, cfgBackup, 'utf8');
    } catch {}
  }

  // ---- 3. 回收站里的文件只能还原回三个内容目录 ----
  // restore 原先用 safeJoin 决定写到哪，只挡住"跳出 DATA_ROOT"，
  // 挡不住 originalRel 指向 config.json 或 .versions/**。而删除入口用的是
  // safeJoinWritable，进得来的位置和出得去的位置标准不一致。
  try {
    await ensureDir(TRASH_DIR);
    const payload = path.join(TRASH_DIR, 'sec-payload.md');
    await fsp.writeFile(payload, 'payload', 'utf8');
    await fsp.writeFile(path.join(TRASH_DIR, 'index.json'), JSON.stringify({
      items: [{ id: 'sec-target', originalRel: 'config.json', name: 'config.json',
        trashedAt: new Date().toISOString(), store: 'sec-payload.md', versionStore: null }]
    }, null, 2), 'utf8');
    const res = await viaIpc(`window.promptFlowApi.restore('sec-target')`);
    check('还原到 config.json 被写入白名单拦住', res.ok === false, JSON.stringify(res));
    let cfgIntact = true;
    try {
      const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
      cfgIntact = raw !== 'payload';
    } catch { cfgIntact = true; }
    check('config.json 没被回收站里的文件覆盖', cfgIntact);
  } catch (e) {
    check('还原白名单用例执行完成', false, e && e.message);
  } finally {
    try { await fsp.writeFile(path.join(TRASH_DIR, 'index.json'), JSON.stringify({ items: [] }, null, 2), 'utf8'); } catch {}
    try { await fsp.unlink(path.join(TRASH_DIR, 'sec-payload.md')); } catch {}
  }

  // ---- 4. 并发保存不能丢自增、不能丢快照 ----
  // save-file 是 read-modify-write：读磁盘上的 prev → 存快照 → 用 prev 算新 version → 写回。
  // 原先它不排队，几路并发都读到同一份 prev，算出同一个 version，后写的整个盖掉前面的。
  // 实测连发 5 次：version 只从 1 涨到 2（丢 4 次自增），5 条快照只落 3 条，
  // 还有一次因为同毫秒快照撞名直接抛 EPERM 给用户。
  // 触发不需要手快：Ctrl+S 和保存按钮都没防重入，按住就连发；退出编辑态时也会再走一次。
  const J = (v) => JSON.stringify(v);
  const mkDoc = (body) => ['---', 'title: sec-concurrency', '---', body].join('\n');
  const relC = 'prompts/testing/sec-concurrency.md';
  const relS = 'prompts/testing/sec-timestamp.md';
  try {
    const created = await viaIpc(`window.promptFlowApi.createFile(${J(relC)}, ${J(mkDoc('base'))})`);
    if (!created.ok) {
      check('并发用例前置：创建文件', false, created.message);
    } else {
      const before = await viaIpc(`window.promptFlowApi.readFile(${J(relC)})`);
      const v0 = before.ok ? Number(before.value.meta.version) : null;

      // 同时发 N 个内容各不相同的保存，每个都该让 version +1
      const N = 5;
      const calls = [];
      for (let i = 0; i < N; i++) calls.push(`window.promptFlowApi.saveFile(${J(relC)}, ${J(mkDoc('body-' + i))})`);
      const settled = await targetWin.webContents.executeJavaScript(
        `(async () => { const rs = await Promise.allSettled([${calls.join(',')}]);
           return rs.map(r => r.status === 'fulfilled' ? 'ok' : String(r.reason && r.reason.message || r.reason)); })()`, true);
      check('并发保存全部成功（没有同毫秒撞名抛 EPERM）',
        settled.every(s => s === 'ok'), JSON.stringify(settled));

      const after = await viaIpc(`window.promptFlowApi.readFile(${J(relC)})`);
      const vN = after.ok ? Number(after.value.meta.version) : null;
      check(`并发 ${N} 次保存后 version 应为 ${v0 + N}`, vN === v0 + N,
        `实际 version=${vN}（起始 ${v0}，丢失 ${v0 + N - vN} 次自增）`);

      // 注意这条测的是 writeFileAtomic，不是队列：临时文件 + rename 保证任何时刻
      // 读到的都是某一次写入的完整内容。做反向对照时撤掉队列它依然是绿的（实测过），
      // 所以别把它算成并发覆盖——并发覆盖靠上面 version 和下面快照数那两条。
      const finalBody = after.ok ? String(after.value.content) : '';
      const hits = [];
      for (let i = 0; i < N; i++) if (finalBody.includes('body-' + i)) hits.push(i);
      check('原子写：磁盘正文是某一次保存的完整内容（不是半截或交错）', hits.length === 1,
        `命中 ${JSON.stringify(hits)}`);

      // N 次内容不同的保存，前 N-1 次的旧内容 + 初始内容 = N 条快照
      let snaps = [];
      try { snaps = (await fsp.readdir(versionDirFor(relC))).filter(f => f.endsWith('.md')); } catch {}
      check(`并发保存应产生 ${N} 条版本快照`, snaps.length === N,
        `实际 ${snaps.length} 条: ${JSON.stringify(snaps)}`);
    }

    // 快照撞名：saveVersion 必须往后挪毫秒，不能覆盖已存在的快照。
    //
    // 不能用"连发几次保存"来测：每次 IPC 往返实测约 12ms，永远撞不到同一毫秒，
    // 那样写出来的断言在修复被撤掉时依然是绿的（第一版就是这么写的，
    // 分离对照里证实了它测不到东西）。
    // 所以这里直接在主进程调 saveVersion，并预先把它接下来几毫秒会用到的名字
    // 全部占掉——这样它必然进入挪名分支，行为完全可判定：
    //   修复在  → 占位文件全部原样保留，快照落在一个新名字上
    //   修复不在 → 快照直接 rename 到占位名上，把它覆盖掉（Windows 上还可能抛 EPERM）
    const dirT = versionDirFor(relS);
    await ensureDir(dirT);
    // 占名窗口要同时满足两头：
    //   够宽——写这批占位文件本身要花时间，窗口必须宽到把这段耗时盖住，否则
    //         saveVersion 起手那一毫秒已经漂到窗口外面，根本不会撞名，
    //         断言就又变成"永远为真"；
    //   够窄——总数必须低于 MAX_UNPINNED_VERSIONS（30），否则 saveVersion 里的
    //         pruneVersions 会把最旧的占位文件裁掉，看起来像"被覆盖"。
    // 窗口起点是自适应的：写 25 个文件在 CI 机器上可能要三四十毫秒，比窗口本身还宽，
    // 固定从"现在"起算就会整段错过——CI 上真红过一次（窗口 ..666 .. ..690，
    // 而 saveVersion 要用 ..691）。所以每轮量一次实际耗时，下一轮把窗口整体后移到
    // "写完之后"再开始，这样不依赖机器快慢，也不用把窗口撑到触发 pruneVersions。
    const DECOY_MS = 25;
    let decoyNames = [];
    let wouldPick = null;
    let occupied = false;
    let offset = 0;
    for (let attempt = 0; attempt < 12 && !occupied; attempt++) {
      // 上一轮的占位文件必须清掉，否则累计超过 30 个会触发 pruneVersions
      for (const n of decoyNames) { try { fs.unlinkSync(path.join(dirT, n)); } catch {} }
      decoyNames = [];
      const t0 = Date.now();
      for (let i = 0; i < DECOY_MS; i++) decoyNames.push(timestampName(new Date(t0 + offset + i)) + '.md');
      for (const n of decoyNames) fs.writeFileSync(path.join(dirT, n), 'DECOY', 'utf8');
      wouldPick = timestampName(new Date()) + '.md';
      occupied = decoyNames.includes(wouldPick);
      if (!occupied) offset = (Date.now() - t0) + 2; // 下一轮从"写完"之后再开始占
    }

    // 前置断言：saveVersion 此刻会算出的名字必须已经被占掉，否则这个用例什么都没测到。
    check('撞名用例前置：目标快照名确实已被占用', occupied,
      `将要使用 ${wouldPick}，占名窗口 ${decoyNames[0]} .. ${decoyNames[decoyNames.length - 1]}`);

    await saveVersion(relS, 'SNAPSHOT-CONTENT');

    const survived = [];
    for (const n of decoyNames) {
      let raw = null;
      try { raw = await fsp.readFile(path.join(dirT, n), 'utf8'); } catch {}
      if (raw !== 'DECOY') survived.push(n + '=' + JSON.stringify(raw));
    }
    check('快照撞名时没有覆盖已存在的版本', survived.length === 0,
      `被改写/丢失的占位文件: ${JSON.stringify(survived)}`);

    const allT = (await fsp.readdir(dirT)).filter(f => f.endsWith('.md'));
    const fresh = allT.filter(f => !decoyNames.includes(f));
    check('快照撞名时改用新文件名落盘', fresh.length === 1, `新增文件: ${JSON.stringify(fresh)}`);
    if (fresh.length === 1) {
      const body = await fsp.readFile(path.join(dirT, fresh[0]), 'utf8');
      check('挪名后的快照内容正确', body === 'SNAPSHOT-CONTENT', JSON.stringify(body).slice(0, 80));
    }
  } catch (e) {
    check('并发保存用例执行完成', false, e && e.message);
  } finally {
    // 这几个文件是用例自己造的，留着会污染后续只读体检和搜索用例的计数
    for (const r of [relC, relS]) {
      try { await fsp.rm(path.join(DATA_ROOT, r), { force: true }); } catch {}
      try { await fsp.rm(versionDirFor(r), { recursive: true, force: true }); } catch {}
    }
  }

  // ---- 5. 项目类型增删不能互相覆盖（读必须在队列内） ----
  // add/remove-project-type 也是 read-modify-write。原先读在队列外：
  // loadConfig() 拿快照 → 改数组 → 交给 updateConfig，而 updateConfig 只把
  // "合并 patch + 写盘"排进队列。几路并发各自基于同一份旧快照算结果，
  // 后写的整个盖掉前面的，落盘只剩最后一个。每次调用都正常 resolve、
  // 界面上类型也都出现了，重启才发现少了——和丢锁定标记是同一个坑。
  const origCfg = await loadConfig();
  const origTypes = Array.isArray(origCfg.projectTypes) ? [...origCfg.projectTypes] : [...DEFAULT_PROJECT_TYPES];
  try {
    const baseTypes = ['sec-base-a', 'sec-base-b'];
    await viaIpc(`window.promptFlowApi.setConfig(${J({ projectTypes: baseTypes })})`);

    // 并发新增 5 个互不相同的类型，5 个都必须留在磁盘上
    const addNames = [];
    for (let i = 0; i < 5; i++) addNames.push('sec-add-' + i);
    const addCalls = addNames.map(n => `window.promptFlowApi.addProjectType(${J(n)})`);
    const addRes = await targetWin.webContents.executeJavaScript(
      `(async () => { const rs = await Promise.allSettled([${addCalls.join(',')}]);
         return rs.map(r => r.status === 'fulfilled' ? 'ok' : String(r.reason && r.reason.message || r.reason)); })()`, true);
    check('并发新增项目类型全部成功', addRes.every(s => s === 'ok'), JSON.stringify(addRes));

    const listAdd = (await loadConfig()).projectTypes || [];
    const missing = addNames.filter(n => !listAdd.includes(n));
    check('并发新增的 5 个项目类型都落盘了', missing.length === 0,
      `丢失 ${JSON.stringify(missing)}，磁盘上是 ${JSON.stringify(listAdd)}`);
    check('并发新增没有冲掉原有类型', baseTypes.every(n => listAdd.includes(n)), JSON.stringify(listAdd));

    // 删除阶段必须自己用 setConfig 铺前置，不能拿上面新增的结果当输入。
    // 第一版就是 addNames.slice(0, 4)，反向对照时发现它测不到东西：撤掉修复后
    // 新增阶段本来就丢了 4 个，删除的目标全都不在磁盘上，于是全走"不存在→静默成功"
    // 分支，"都消失了"自然为真。前置被上一步破坏，断言就变成永远为真。
    const delNames = [];
    for (let i = 0; i < 4; i++) delNames.push('sec-del-' + i);
    await viaIpc(`window.promptFlowApi.setConfig(${J({ projectTypes: [...baseTypes, ...delNames] })})`);
    const listPre = (await loadConfig()).projectTypes || [];
    check('并发删除用例前置：4 个待删类型都已在磁盘上',
      delNames.every(n => listPre.includes(n)), JSON.stringify(listPre));

    const delCalls = delNames.map(n => `window.promptFlowApi.removeProjectType(${J(n)})`);
    const delRes = await targetWin.webContents.executeJavaScript(
      `(async () => { const rs = await Promise.allSettled([${delCalls.join(',')}]);
         return rs.map(r => r.status === 'fulfilled' ? 'ok' : String(r.reason && r.reason.message || r.reason)); })()`, true);
    check('并发删除项目类型全部成功', delRes.every(s => s === 'ok'), JSON.stringify(delRes));

    const listDel = (await loadConfig()).projectTypes || [];
    const leftover = delNames.filter(n => listDel.includes(n));
    check('并发删除的 4 个项目类型都从磁盘上消失了', leftover.length === 0,
      `残留 ${JSON.stringify(leftover)}，磁盘上是 ${JSON.stringify(listDel)}`);
    check('并发删除没有连带删掉别的类型', baseTypes.every(n => listDel.includes(n)),
      JSON.stringify(listDel));

    // 上面的修复把两个 handler 改成了共用 mutate 回调，几条校验分支的语义必须保持不变
    const dup = await viaIpc(`window.promptFlowApi.addProjectType(${J(baseTypes[0])})`);
    check('新增重名类型仍然报 E_TYPE_EXISTS',
      dup.ok === false && /E_TYPE_EXISTS/.test(dup.message), JSON.stringify(dup));
    const blank = await viaIpc(`window.promptFlowApi.addProjectType("   ")`);
    check('新增空白类型仍然报 E_TYPE_EMPTY',
      blank.ok === false && /E_TYPE_EMPTY/.test(blank.message), JSON.stringify(blank));
    const noSuch = await viaIpc(`window.promptFlowApi.removeProjectType("sec-not-there")`);
    check('删除不存在的类型仍然静默成功', noSuch.ok === true, JSON.stringify(noSuch));

    await viaIpc(`window.promptFlowApi.setConfig(${J({ projectTypes: ['sec-only-one'] })})`);
    const lastOne = await viaIpc(`window.promptFlowApi.removeProjectType("sec-only-one")`);
    check('删到只剩一个时仍然报 E_TYPE_MIN_ONE',
      lastOne.ok === false && /E_TYPE_MIN_ONE/.test(lastOne.message), JSON.stringify(lastOne));
  } catch (e) {
    check('项目类型并发用例执行完成', false, e && e.message);
  } finally {
    // 后面还有只读体检在用这份 config，必须还原成用例开始前的样子
    try { await viaIpc(`window.promptFlowApi.setConfig(${J({ projectTypes: origTypes })})`); } catch {}
  }


  // ---- 6. contentCache 按 LRU 封顶，只读浏览也不会让它无限增长 ----
  // 原先只在文件被删/移/存时清对应条目：只读浏览过、从没变动的文件会永久留在
  // Map 里，每条还存了正文 + 一份全小写副本。长会话里反复浏览大库，常驻内存只增
  // 不减。这里把上限临时调小到 3，塞进 5 个文件，验证四件事：大小被压在上限内、
  // 最久未访问的被淘汰、命中会把条目挪回队尾（保护最近用的）、被淘汰的重读能重新入缓存。
  const savedCacheMax = cacheStats.CONTENT_CACHE_MAX;
  const cacheTestDir = path.join(DATA_ROOT, '.cache-lru-test');
  try {
    await fsp.mkdir(cacheTestDir, { recursive: true });
    cacheStats.CONTENT_CACHE_MAX = 3;
    const cf = [];
    for (let i = 0; i < 5; i++) {
      const fp = path.join(cacheTestDir, 'c' + i + '.md');
      await fsp.writeFile(fp, '# cache ' + i + '\nbody ' + i, 'utf8');
      cf.push(fp);
    }
    // 依次读入（都是 miss），c0..c4 顺序进队；上限 3，读到 c3、c4 时各淘汰一次队首
    for (const fp of cf) await readParsedCached(fp);
    check('LRU 淘汰后缓存大小压在上限内',
      contentCache.size === 3, 'size=' + contentCache.size + ', max=' + cacheStats.CONTENT_CACHE_MAX);
    check('最久未访问的文件被淘汰',
      !contentCache.has(cf[0]) && !contentCache.has(cf[1]),
      'c0在=' + contentCache.has(cf[0]) + ', c1在=' + contentCache.has(cf[1]));
    check('最近访问的三个文件留在缓存',
      contentCache.has(cf[2]) && contentCache.has(cf[3]) && contentCache.has(cf[4]),
      'c2=' + contentCache.has(cf[2]) + ', c3=' + contentCache.has(cf[3]) + ', c4=' + contentCache.has(cf[4]));

    // 队首此刻是 c2。命中 c2 应把它挪到队尾，于是下一个新文件进来时淘汰的是 c3 而非 c2。
    await readParsedCached(cf[2]);
    const c5path = path.join(cacheTestDir, 'c5.md');
    await fsp.writeFile(c5path, '# cache 5\nbody 5', 'utf8');
    await readParsedCached(c5path);
    check('命中会把条目挪回队尾，保护最近使用的项',
      contentCache.has(cf[2]) && !contentCache.has(cf[3]),
      'c2在=' + contentCache.has(cf[2]) + '（应在）, c3在=' + contentCache.has(cf[3]) + '（应被淘汰）');

    // 被淘汰的 c0 文件还在磁盘上，重读应重新入缓存并记一次 miss
    const missBefore = cacheStats.cacheMisses;
    await readParsedCached(cf[0]);
    check('被淘汰的文件重读会重新入缓存并计一次未命中',
      contentCache.has(cf[0]) && cacheStats.cacheMisses === missBefore + 1,
      'c0在=' + contentCache.has(cf[0]) + ', miss增量=' + (cacheStats.cacheMisses - missBefore));
  } catch (e) {
    check('contentCache LRU 用例执行完成', false, e && e.message);
  } finally {
    cacheStats.CONTENT_CACHE_MAX = savedCacheMax;
    for (let i = 0; i < 6; i++) contentCache.delete(path.join(cacheTestDir, 'c' + i + '.md'));
    try { await fsp.rm(cacheTestDir, { recursive: true, force: true }); } catch {}
  }

  // ---- 7. 新建/导入不能因为 check-then-write 静默覆盖 ----
  // createFileAt 原先是"fs.existsSync 判重 → writeFileAtomic"。两步之间有窗口，
  // 而 writeFileAtomic 结尾的 rename 会无条件覆盖目标，所以并发新建同名文件时
  // 几路都通过判重、几路都 rename，后一次把前一次的正文整个盖掉，且每一路都
  // 返回成功——用户看到"导入成功 5 条"，磁盘上其实只剩最后一条。
  // importMarkdown 更糟：它到第一个 await 之前全是同步的，几路必然都跑完
  // uniqueRel 才有人落盘，于是全都挑中同一个名字，不是窄窗口而是稳定复现。
  const exRel = 'prompts/project-init/sec-excl-dup.md';
  const imTitle = 'sec-imp-dup';
  const cleanupRels = [exRel];
  try {
    try { await fsp.rm(safeJoin(exRel), { force: true }); } catch {}

    // 5 路并发新建同一个 rel，各写不同正文
    const exRes = await Promise.allSettled(
      [0, 1, 2, 3, 4].map(i => createFileAt(exRel, '# excl ' + i + '\n\nEXCL-BODY-' + i))
    );
    const exOk = exRes.filter(r => r.status === 'fulfilled');
    const exFail = exRes.filter(r => r.status === 'rejected');
    // 这条才是真正能抓到缺陷的断言：修复前 5 路全部 fulfilled。
    check('并发新建同名文件只有一路成功',
      exOk.length === 1, '成功 ' + exOk.length + ' 路，失败 ' + exFail.length + ' 路');
    check('失败的各路都报 E_FILE_EXISTS',
      exFail.length === 4 && exFail.every(r =>
        String(r.reason && r.reason.message).split('|')[0] === 'E_FILE_EXISTS'),
      JSON.stringify(exFail.map(r => String(r.reason && r.reason.message))));

    // 注意：下面这条单独拿出来是抓不到缺陷的——rename 本身是原子的，
    // 修复前磁盘上也只会有某一路的完整正文。它的作用是守住"没有半截/混写正文"，
    // 真正的检测靠上面的成功路数。
    const exDisk = await fsp.readFile(safeJoin(exRel), 'utf8');
    const exMarkers = [0, 1, 2, 3, 4].filter(i => exDisk.includes('EXCL-BODY-' + i));
    check('磁盘上只有一路的完整正文，没有混写',
      exMarkers.length === 1, '匹配到标记 ' + JSON.stringify(exMarkers));

    // 5 路并发导入同一个标题：既有语义是"自动改名，不覆盖"，所以 5 路都该成功，
    // 但必须落到 5 个不同的文件上，5 份正文一份都不能丢。
    const imRes = await Promise.allSettled([0, 1, 2, 3, 4].map(i => importMarkdown(
      imTitle + '.md',
      '---\ntitle: ' + imTitle + '\nstage: project-init\n---\n\nIMP-BODY-' + i
    )));
    const imOk = imRes.filter(r => r.status === 'fulfilled').map(r => r.value);
    for (const r of imOk) cleanupRels.push(r);
    check('并发导入全部成功', imOk.length === 5,
      JSON.stringify(imRes.map(r => r.status === 'fulfilled' ? r.value
        : String(r.reason && r.reason.message))));

    const imUniq = [...new Set(imOk)];
    check('并发导入分配到的路径互不相同',
      imUniq.length === imOk.length, JSON.stringify(imOk));

    const imFound = new Set();
    for (const rel of imUniq) {
      let c = '';
      try { c = await fsp.readFile(safeJoin(rel), 'utf8'); } catch {}
      for (let i = 0; i < 5; i++) if (c.includes('IMP-BODY-' + i)) imFound.add(i);
    }
    check('并发导入的 5 份正文都完整落盘',
      imFound.size === 5, '只找到 ' + JSON.stringify([...imFound]) + '，落盘路径 ' + JSON.stringify(imUniq));
  } catch (e) {
    check('新建/导入独占创建用例执行完成', false, e && e.message);
  } finally {
    // 顺带把 uniqueRel 可能挑出的 -1..-9 变体一起清掉，别留给后面的用例
    for (let n = 1; n <= 9; n++) cleanupRels.push('prompts/project-init/' + imTitle + '-' + n + '.md');
    cleanupRels.push('prompts/project-init/' + imTitle + '.md');
    for (const rel of new Set(cleanupRels)) {
      const f = safeJoin(rel);
      try { await fsp.rm(f, { force: true }); } catch {}
      dropFromCache(f);
    }
  }



  // ---- 8. 路径校验不能被跨盘符绕过，窗口内导航只放行界面自身 ----
  // safeJoin 原先只判 path.relative(...).startsWith('..')。Windows 上跨盘符时
  // path.relative 返回的是绝对路径而不是一串 ..（实测
  // path.relative('D:\\a', 'C:\\Windows') === 'C:\\Windows'），startsWith('..')
  // 为假，于是整个包含性检查被绕过。versionDirFor 漏的是同一条。
  // 可达路径不需要 XSS：工作流 frontmatter 的 flow[].prompt 被渲染成流程节点的
  // data-prompt，用户点一下就走 read-file，库外文件的正文直接显示在预览区。
  try {
    // 另一个盘的盘符要按 DATA_ROOT 实际所在盘算，否则在 CI 上（临时目录在 C 盘）
    // 拿 C: 去测会走"同盘 .. 逃逸"分支，测不到跨盘符这条。
    const myDrive = String(path.parse(DATA_ROOT_NORM).root || 'C:\\').slice(0, 1).toUpperCase();
    const other = myDrive === 'C' ? 'D' : 'C';
    check('用例前置：构造的盘符与 DATA_ROOT 不同盘', other !== myDrive, `DATA_ROOT 在 ${myDrive}:，用 ${other}:`);

    const crossCases = [
      other + ':\\Windows\\win.ini',
      other + ':/Windows/win.ini',
      other + ':x.txt'           // 盘符相对形态
    ];
    const notBlocked = [];
    for (const c of crossCases) {
      let blocked = false;
      try { safeJoin(c); } catch (err) {
        blocked = String(err && err.message).split('|')[0] === 'E_PATH_ESCAPE';
      }
      if (!blocked) notBlocked.push(c);
    }
    check('safeJoin 拦住跨盘符绝对路径', notBlocked.length === 0, `放行了 ${JSON.stringify(notBlocked)}`);

    const notBlockedV = [];
    for (const c of crossCases) {
      let blocked = false;
      try { versionDirFor(c); } catch (err) {
        blocked = String(err && err.message).split('|')[0] === 'E_PATH_ESCAPE';
      }
      if (!blocked) notBlockedV.push(c);
    }
    check('versionDirFor 拦住跨盘符绝对路径', notBlockedV.length === 0, `放行了 ${JSON.stringify(notBlockedV)}`);

    // 走真实 IPC：这才是攻击者实际能碰到的入口（流程节点点击 → read-file）
    const ipcEsc = await viaIpc(`window.promptFlowApi.readFile(${J(other + ':\\\\Windows\\\\win.ini')})`);
    check('read-file 对跨盘符路径报 E_PATH_ESCAPE',
      ipcEsc.ok === false && /E_PATH_ESCAPE/.test(ipcEsc.message), JSON.stringify(ipcEsc));

    // 正常路径不能被误伤。自己造文件，不依赖种子数据：
    // PFM_DATA_DIR 指向的临时库里没有 templates/ 的随包内容，
    // 第一版直接读 templates/prompt-template.md，结果是 ENOENT 而不是校验通过，
    // 断言红得毫无意义（测的是文件在不在，不是路径校验放不放行）。
    const okRel = 'prompts/project-init/sec-crossdrive-ok.md';
    await viaIpc(`window.promptFlowApi.createFile(${J(okRel)}, ${J('---\ntitle: ok\n---\nBODY-OK')})`);
    const okRead = await viaIpc(`window.promptFlowApi.readFile(${J(okRel)})`);
    check('库内正常路径仍然可读', okRead.ok === true && /BODY-OK/.test(String(okRead.value && okRead.value.content)),
      JSON.stringify(okRead).slice(0, 160));
    try { await fsp.rm(safeJoin(okRel), { force: true }); } catch {}

    // ---- 导航守卫 ----
    // 原先是 url.startsWith('file://') 就放行。marked 默认不给链接加 target，
    // 所以正文里的相对链接（../../evil.html、//host/share/evil.html）不走
    // setWindowOpenHandler，正好落进这个放行分支；导航过去后 preload 会重新注入，
    // promptFlowApi 原样暴露给攻击者页面，而 CSP 只对 index.html 那一个文档生效。
    //
    // 这条前置断言很关键：SELF_URL 是用 pathToFileURL 拼的，必须和 Electron 实际
    // 加载的 URL 完全一致，否则 reload 会被自己的守卫拦掉。拿真实窗口的 URL 来验。
    const liveUrl = targetWin.webContents.getURL();
    check('用例前置：界面实际 URL 被 isSelfUrl 认可（reload 不会被误拦）',
      isSelfUrl(liveUrl), `实际 ${liveUrl}，SELF_URL ${SELF_URL}`);

    check('带 query/hash 的自身 URL 仍算自身（reload 容错）',
      isSelfUrl(SELF_URL + '?x=1') && isSelfUrl(SELF_URL + '#top'), 'query/hash 变体被拦了');

    // 审计里逐条验证过能通过 DOMPurify 的载荷形态
    const evilUrls = [
      'file:///C:/evil.html',
      pathToFileURL(path.join(CODE_ROOT, 'src', 'evil.html')).href, // 同目录旁路
      'file://attacker.example/share/evil.html',                     // UNC → 远端 SMB
      'file:///' + DATA_ROOT_NORM.replace(/\\/g, '/') + '/prompts/x.md'
    ];
    const leaked = evilUrls.filter(u => isSelfUrl(u));
    check('其余 file:// URL 一律不算自身', leaked.length === 0, `被当成自身: ${JSON.stringify(leaked)}`);

    // 上面几条只测 isSelfUrl 这个纯函数，测不到它有没有真的接到 will-navigate 上：
    // 把守卫改回 startsWith('file://') 时它们全是绿的（分离对照实测过）。
    // 所以这里真的让页面去导航一次，看拦没拦住——这才是攻击者实际走的那条路。
    const probePath = path.join(CODE_ROOT, 'src', 'evil-probe.html');
    try {
      fs.writeFileSync(probePath, '<html><body>PROBE</body></html>', 'utf8');
      const probeUrl = pathToFileURL(probePath).href;
      const urlBefore = targetWin.webContents.getURL();
      // 用正文里普通链接的等价形态发起窗口内导航（不是 window.open）
      await targetWin.webContents.executeJavaScript(
        `(() => { window.location.href = ${JSON.stringify(probeUrl)}; return 1; })()`, true);
      // 导航是异步的，给它足够时间真的发生
      await new Promise(r => setTimeout(r, 600));
      const urlAfter = targetWin.webContents.getURL();
      check('窗口内导航到其他 file:// 被真的拦住了（守卫已接线）',
        urlAfter === urlBefore,
        `导航前 ${urlBefore}，导航后 ${urlAfter}`);
      // 拦住之后界面必须还是活的，否则等于把应用弄坏了
      const stillAlive = await targetWin.webContents.executeJavaScript(
        `(() => typeof window.promptFlowApi === 'object' && !!document.getElementById('tree'))()`, true);
      check('拦下导航后页面依然正常（bridge 与 DOM 都在）', stillAlive === true, String(stillAlive));
    } finally {
      try { fs.unlinkSync(probePath); } catch {}
    }
  } catch (e) {
    check('路径与导航用例执行完成', false, e && e.message);
  }


  // ---- 9. 读旧正文失败时必须放弃保存，不能静默覆盖 ----
  // save-file / rollback-version 原先都是 try { prev = await readFile(...) } catch {}。
  // 只有 ENOENT 才该被吞掉（文件本来就不存在）；EBUSY/EACCES/EMFILE/EIO 落进同一个
  // 空 catch 之后，prev 停在 null，saveVersion 被跳过（旧正文没有留下快照），
  // 紧接着 writeFileAtomic 把这个刚刚读不到的文件整个盖掉。保存返回成功，正文没了。
  //
  // 用桩把 readFile 对这一个路径改成抛 EBUSY，是因为真去占用文件在 CI 上不可靠：
  // Linux 的 flock 是劝告锁，fs.readFile 照样读得到，构造不出前置条件。
  // 桩只拦目标路径，队列、快照、原子写全部走真实实现。
  const relPrev = 'prompts/testing/sec-prevread.md';
  const relPrevNew = 'prompts/testing/sec-prevread-new.md';
  const fullPrev = safeJoinWritable(relPrev);
  const mkPrevDoc = (body) => ['---', 'title: sec-prevread', '---', body].join('\n');
  const realReadFile = fsp.readFile;
  // 只对 fullPrev 抛指定错误码，其他读一律放行。返回命中计数器，
  // 前置断言要靠它确认桩真的被走到了（否则用例什么都没测到）。
  const stubReadFailure = (code, msg) => {
    const hits = { n: 0 };
    fsp.readFile = function (p, ...rest) {
      let same = false;
      try { same = path.resolve(String(p)) === path.resolve(fullPrev); } catch {}
      if (same) {
        hits.n++;
        const err = new Error(code + ': ' + msg + ', open ' + String(p));
        err.code = code;
        return Promise.reject(err);
      }
      return realReadFile.call(this, p, ...rest);
    };
    return hits;
  };
  try {
    const madePrev = await viaIpc('window.promptFlowApi.createFile(' + J(relPrev) + ', ' + J(mkPrevDoc('ORIGINAL-BODY')) + ')');
    check('读失败用例前置：创建文件', madePrev.ok === true, JSON.stringify(madePrev).slice(0, 160));

    // 再存一次，让 version 涨到 2 并留下一条快照，这样"快照数没变"才有对照价值
    await viaIpc('window.promptFlowApi.saveFile(' + J(relPrev) + ', ' + J(mkPrevDoc('ORIGINAL-BODY-v2')) + ')');
    const onDiskBefore = await realReadFile.call(fsp, fullPrev, 'utf8');
    let snapsBefore = [];
    try { snapsBefore = (await fsp.readdir(versionDirFor(relPrev))).filter(f => f.endsWith('.md')); } catch {}
    check('读失败用例前置：已有快照可作对照', snapsBefore.length >= 1, '快照 ' + snapsBefore.length + ' 条');

    const hitsSave = stubReadFailure('EBUSY', 'resource busy or locked');
    const saved = await viaIpc('window.promptFlowApi.saveFile(' + J(relPrev) + ', ' + J(mkPrevDoc('OVERWRITTEN-BODY')) + ')');
    fsp.readFile = realReadFile;

    check('读失败用例前置：桩真的被调用到了', hitsSave.n > 0, '命中 ' + hitsSave.n + ' 次');
    check('读旧正文失败时 save-file 报 E_PREV_READ 而不是返回成功',
      saved.ok === false && /E_PREV_READ/.test(String(saved.message)),
      JSON.stringify(saved).slice(0, 200));
    check('E_PREV_READ 带上真实系统错误码，用户能看出是被占用',
      /EBUSY/.test(String(saved.message)), String(saved.message).slice(0, 200));

    // 最关键的一条：磁盘上的旧正文必须还在
    const onDiskAfter = await realReadFile.call(fsp, fullPrev, 'utf8');
    check('读旧正文失败后磁盘正文没有被覆盖',
      onDiskAfter === onDiskBefore && !/OVERWRITTEN-BODY/.test(onDiskAfter),
      '盘上现在是 ' + JSON.stringify(onDiskAfter.slice(0, 120)));

    let snapsAfter = [];
    try { snapsAfter = (await fsp.readdir(versionDirFor(relPrev))).filter(f => f.endsWith('.md')); } catch {}
    check('保存被拒后不该留下半途的快照',
      snapsAfter.length === snapsBefore.length,
      '之前 ' + snapsBefore.length + ' 条，现在 ' + snapsAfter.length + ' 条');

    // 另一半同样重要：ENOENT 仍要当成"新文件"放行，不能把新建路径一起堵死
    const newSaved = await viaIpc('window.promptFlowApi.saveFile(' + J(relPrevNew) + ', ' + J(mkPrevDoc('BRAND-NEW')) + ')');
    check('文件不存在（ENOENT）时保存照旧成功，没有被误拦',
      newSaved.ok === true && /BRAND-NEW/.test(String(newSaved.value && newSaved.value.content)),
      JSON.stringify(newSaved).slice(0, 200));

    // rollback-version 走同一个 helper，一起验一遍
    const versions = await viaIpc('window.promptFlowApi.listVersions(' + J(relPrev) + ')');
    const vList = versions.ok && Array.isArray(versions.value) ? versions.value : [];
    const vFile = vList.length ? (typeof vList[0] === 'string' ? vList[0] : vList[0].file) : null;
    check('回滚用例前置：拿到一个可回滚的快照名',
      typeof vFile === 'string' && /\.md$/.test(vFile), JSON.stringify(versions).slice(0, 200));
    if (typeof vFile === 'string') {
      const hitsRoll = stubReadFailure('EACCES', 'permission denied');
      const rolled = await viaIpc('window.promptFlowApi.rollbackVersion(' + J(relPrev) + ', ' + J(vFile) + ')');
      fsp.readFile = realReadFile;
      check('读旧正文失败时 rollback-version 同样报 E_PREV_READ',
        rolled.ok === false && /E_PREV_READ/.test(String(rolled.message)) && hitsRoll.n > 0,
        JSON.stringify(rolled).slice(0, 200) + ' 桩命中 ' + hitsRoll.n);
      const afterRollback = await realReadFile.call(fsp, fullPrev, 'utf8');
      check('回滚被拒后磁盘正文没有被覆盖', afterRollback === onDiskBefore,
        '盘上现在是 ' + JSON.stringify(afterRollback.slice(0, 120)));
    }
  } catch (e) {
    check('读旧正文失败用例执行完成', false, e && e.message);
  } finally {
    fsp.readFile = realReadFile;
    for (const r of [relPrev, relPrevNew]) {
      try { await fsp.rm(path.join(DATA_ROOT, r), { force: true }); } catch {}
      try { await fsp.rm(versionDirFor(r), { recursive: true, force: true }); } catch {}
    }
  }

  // ---- 10. 回收站的写锁缺口与静默失败 ----
  // 三个独立问题，共用一批构造手法，所以放在同一节里：
  //   a) trash / restore 只占 trash 键，没占 ver:<rel>。这两个 handler 都在搬库里的
  //      正文和版本目录，而 save-file 只占 ver:<rel>——同一个文件上两边完全不互斥。
  //   b) empty-trash 删不掉某一条时只记日志，然后无条件把索引清空：文件还在 .trash
  //      里占着磁盘，索引条目却没了，UI 再也看不到它，下次清空也不会再碰它。
  //   c) trash 写索引失败时直接抛错，而正文已经躺在 .trash 里了：索引没有条目，
  //      文件树看不到、回收站列不出，等于永久丢失，而用户只看到一句"删除失败"。
  //
  // 并发那两条靠"把窗口撑宽"来做成可判定的：给关键那一次 fsp.rename 前面塞一段
  // 固定延时，再在延时中间发起 save-file。修复在 → save-file 被锁挡在外面，等
  // 前一个操作做完才跑，内容完好；修复不在 → save-file 必然落进窗口里，写完的正文
  // 被随后的 rename 搬走或覆盖，而两边都返回成功。延时只影响耗时，不改变任何语义。
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const realRename = fsp.rename;
  const realRm = fsp.rm;
  const realWriteFile = fsp.writeFile;
  // 只延迟指定的那一次 rename（按源/目标全路径精确匹配），其余 rename 原样放行。
  // 尤其不能误伤 writeFileAtomic 写 index.json 的 tmp→正式名那一次，
  // 否则测的就不是同一件事了。
  const stubRenameDelay = (matchFn, ms) => {
    const hits = { n: 0 };
    fsp.rename = async function (src, dst, ...rest) {
      let hit = false;
      try { hit = matchFn(path.resolve(String(src)), path.resolve(String(dst))); } catch {}
      if (hit) { hits.n++; await sleep(ms); }
      return realRename.call(this, src, dst, ...rest);
    };
    return hits;
  };
  const mkTrashDoc = (body) => ['---', 'title: sec-trashlock', '---', body].join('\n');

  // ---- 10a. 删除进行中的保存不能被一起卷进回收站 ----
  const relRace = 'prompts/testing/sec-trash-race.md';
  const fullRace = safeJoinWritable(relRace);
  try {
    const made = await viaIpc('window.promptFlowApi.createFile(' + J(relRace) + ', ' + J(mkTrashDoc('OLD-BODY')) + ')');
    check('删除并发用例前置：创建文件', made.ok === true, JSON.stringify(made).slice(0, 160));

    // 只拦"把这个文件搬进 .trash"那一次 rename
    const hits = stubRenameDelay(
      (src, dst) => src === path.resolve(fullRace) && path.dirname(dst) === path.resolve(TRASH_DIR_NORM),
      500
    );
    const both = await targetWin.webContents.executeJavaScript(
      '(async () => { const api = window.promptFlowApi;' +
      '  const settle = (p) => p.then(v => ({ ok: true, value: v }), e => ({ ok: false, message: String(e && e.message || e) }));' +
      '  const pTrash = settle(api.trash(' + J(relRace) + '));' +
      '  await new Promise(r => setTimeout(r, 80));' +
      '  const pSave = settle(api.saveFile(' + J(relRace) + ', ' + J(mkTrashDoc('SAVED-BODY')) + '));' +
      '  return { trash: await pTrash, save: await pSave }; })()', true);
    fsp.rename = realRename;

    check('删除并发用例前置：延时窗口真的生效了', hits.n > 0, '命中 ' + hits.n + ' 次');
    check('删除并发用例前置：删除本身成功', both.trash.ok === true, JSON.stringify(both.trash).slice(0, 160));
    // 保存报成功是这个 bug 之所以危险的原因：失败会被用户看见，成功不会。
    check('删除并发用例前置：保存也报成功', both.save.ok === true, JSON.stringify(both.save).slice(0, 160));

    // 核心断言：那次保存的正文必须仍然在库里，而不是被 rename 一起搬进 .trash。
    // 修复在 → save-file 排在 trash 后面执行，把文件重新建出来；
    // 修复不在 → save-file 写完的正文被 trash 的 rename 搬走，这里读不到任何东西。
    let onDisk = null;
    try { onDisk = await fsp.readFile(fullRace, 'utf8'); } catch {}
    check('删除进行中完成的保存没有被一起搬进回收站',
      onDisk != null && /SAVED-BODY/.test(onDisk),
      onDisk == null ? '文件已不在库里（正文只剩 .trash 里那份）' : JSON.stringify(onDisk.slice(0, 120)));

    // 另一头的对照：回收站里那份应该是删除时刻的旧正文。
    // 若它变成了 SAVED-BODY，说明保存插进了 rename 之前，两边确实交叉了。
    const idx = await readTrashIndex();
    const it = idx.items.find(i => i.originalRel === relRace);
    check('删除并发用例前置：回收站有对应条目', !!it, JSON.stringify(idx.items).slice(0, 160));
    if (it) {
      let stored = null;
      try { stored = await fsp.readFile(trashStorePath(it.store), 'utf8'); } catch {}
      check('回收站里存的是删除时刻的旧正文，不是并发保存的新正文',
        stored != null && /OLD-BODY/.test(stored) && !/SAVED-BODY/.test(stored),
        stored == null ? 'store 读不到' : JSON.stringify(stored.slice(0, 120)));
    }
  } catch (e) {
    check('删除并发用例执行完成', false, e && e.message);
  } finally {
    fsp.rename = realRename;
    try { await fsp.rm(fullRace, { force: true }); } catch {}
    try { await fsp.rm(versionDirFor(relRace), { recursive: true, force: true }); } catch {}
    try { await writeTrashIndex({ items: [] }); } catch {}
    try { for (const f of await fsp.readdir(TRASH_DIR)) if (f !== 'index.json') await fsp.rm(path.join(TRASH_DIR, f), { recursive: true, force: true }); } catch {}
  }

  // ---- 10b. 恢复进行中的保存不能被 rename 无声覆盖 ----
  // restore 先 existsSync 判断目标在不在，再 rename。判断和 rename 之间插进一次
  // save-file，那次保存会写出文件、返回成功，紧接着被 rename 覆盖掉（rename 不看
  // 目标存不存在）。占上 ver:<originalRel> 之后 save-file 只能排在后面。
  const relRestore = 'prompts/testing/sec-restore-race.md';
  const fullRestore = safeJoinWritable(relRestore);
  try {
    const made = await viaIpc('window.promptFlowApi.createFile(' + J(relRestore) + ', ' + J(mkTrashDoc('TRASHED-BODY')) + ')');
    check('恢复并发用例前置：创建文件', made.ok === true, JSON.stringify(made).slice(0, 160));
    const trashed = await viaIpc('window.promptFlowApi.trash(' + J(relRestore) + ')');
    check('恢复并发用例前置：文件已进回收站', trashed.ok === true, JSON.stringify(trashed).slice(0, 160));
    const idx0 = await readTrashIndex();
    const item0 = idx0.items.find(i => i.originalRel === relRestore);
    check('恢复并发用例前置：拿到回收站条目', !!item0, JSON.stringify(idx0.items).slice(0, 160));

    if (item0) {
      // 只拦"从 .trash 搬回原位置"那一次 rename
      const hits = stubRenameDelay(
        (src, dst) => dst === path.resolve(fullRestore) && path.dirname(src) === path.resolve(TRASH_DIR_NORM),
        500
      );
      const both = await targetWin.webContents.executeJavaScript(
        '(async () => { const api = window.promptFlowApi;' +
        '  const settle = (p) => p.then(v => ({ ok: true, value: v }), e => ({ ok: false, message: String(e && e.message || e) }));' +
        '  const pRestore = settle(api.restore(' + J(item0.id) + '));' +
        '  await new Promise(r => setTimeout(r, 80));' +
        '  const pSave = settle(api.saveFile(' + J(relRestore) + ', ' + J(mkTrashDoc('RESTORE-SAVED-BODY')) + '));' +
        '  return { restore: await pRestore, save: await pSave }; })()', true);
      fsp.rename = realRename;

      check('恢复并发用例前置：延时窗口真的生效了', hits.n > 0, '命中 ' + hits.n + ' 次');
      check('恢复并发用例前置：恢复本身成功', both.restore.ok === true, JSON.stringify(both.restore).slice(0, 160));
      check('恢复并发用例前置：保存也报成功', both.save.ok === true, JSON.stringify(both.save).slice(0, 160));

      // 核心断言：保存是后发的，它的正文必须是最终结果。
      // 修复不在 → 盘上留下的是 TRASHED-BODY，那次成功的保存被 rename 悄悄吃掉。
      let onDisk = null;
      try { onDisk = await fsp.readFile(fullRestore, 'utf8'); } catch {}
      check('恢复进行中完成的保存没有被 rename 覆盖',
        onDisk != null && /RESTORE-SAVED-BODY/.test(onDisk),
        onDisk == null ? '文件不存在' : JSON.stringify(onDisk.slice(0, 120)));
    }
  } catch (e) {
    check('恢复并发用例执行完成', false, e && e.message);
  } finally {
    fsp.rename = realRename;
    try { await fsp.rm(fullRestore, { force: true }); } catch {}
    try { await fsp.rm(versionDirFor(relRestore), { recursive: true, force: true }); } catch {}
    try { await writeTrashIndex({ items: [] }); } catch {}
    try { for (const f of await fsp.readdir(TRASH_DIR)) if (f !== 'index.json') await fsp.rm(path.join(TRASH_DIR, f), { recursive: true, force: true }); } catch {}
  }

  // ---- 10c. 清空回收站删不掉的条目必须留在索引里并报错 ----
  // 用桩让某一条的 rm 失败，是因为真构造一个"删不掉的文件"在 CI 上不可靠：
  // Linux 下把 .trash 设成只读会连 index.json 都写不了，测的就不是同一件事了。
  // 桩只拦那一个 store 路径，索引读写、其余条目全走真实实现。
  const relKeep = 'prompts/testing/sec-empty-keep.md';
  try {
    const made = await viaIpc('window.promptFlowApi.createFile(' + J(relKeep) + ', ' + J(mkTrashDoc('KEEP-BODY')) + ')');
    check('清空失败用例前置：创建文件', made.ok === true, JSON.stringify(made).slice(0, 160));
    const trashed = await viaIpc('window.promptFlowApi.trash(' + J(relKeep) + ')');
    check('清空失败用例前置：文件已进回收站', trashed.ok === true, JSON.stringify(trashed).slice(0, 160));
    const idx0 = await readTrashIndex();
    const item0 = idx0.items.find(i => i.originalRel === relKeep);
    check('清空失败用例前置：拿到回收站条目', !!item0, JSON.stringify(idx0.items).slice(0, 160));

    if (item0) {
      const storeFull = trashStorePath(item0.store);
      const hits = { n: 0 };
      fsp.rm = function (p, ...rest) {
        let same = false;
        try { same = path.resolve(String(p)) === path.resolve(storeFull); } catch {}
        if (same) {
          hits.n++;
          const err = new Error('EPERM: operation not permitted, rm ' + String(p));
          err.code = 'EPERM';
          return Promise.reject(err);
        }
        return realRm.call(this, p, ...rest);
      };
      const emptied = await viaIpc('window.promptFlowApi.emptyTrash()');
      fsp.rm = realRm;

      check('清空失败用例前置：桩真的被调用到了', hits.n > 0, '命中 ' + hits.n + ' 次');
      check('清空回收站删不掉条目时报错而不是返回成功',
        emptied.ok === false && /E_TRASH_EMPTY_PARTIAL/.test(String(emptied.message)),
        JSON.stringify(emptied).slice(0, 200));

      // 最关键的一条：文件还在 .trash 里，索引条目就必须留着，否则它彻底失去入口。
      const idx1 = await readTrashIndex();
      check('删不掉的条目留在索引里，回收站还能看到它',
        idx1.items.some(i => i.id === item0.id),
        '索引现在有 ' + idx1.items.length + ' 条: ' + JSON.stringify(idx1.items.map(i => i.originalRel)));
      check('删不掉的条目对应的文件确实还占着磁盘', fs.existsSync(storeFull), storeFull);

      // 另一半：rm 恢复正常后必须能真的清干净，不能因为上面那次失败卡住
      const again = await viaIpc('window.promptFlowApi.emptyTrash()');
      check('恢复可删后再清空一次能成功', again.ok === true, JSON.stringify(again).slice(0, 200));
      check('第二次清空后索引真的空了', (await readTrashIndex()).items.length === 0);
      check('第二次清空后文件也真的删掉了', !fs.existsSync(storeFull), storeFull);
    }
  } catch (e) {
    check('清空回收站失败用例执行完成', false, e && e.message);
  } finally {
    fsp.rm = realRm;
    try { await realRm.call(fsp, path.join(DATA_ROOT, relKeep), { force: true }); } catch {}
    try { await writeTrashIndex({ items: [] }); } catch {}
  }

  // ---- 10d. 删除时索引写失败必须把文件搬回原处 ----
  // 桩只拦 writeFileAtomic 给 .trash/index.json 用的那个临时文件，
  // 回滚要用的 rename 完全没被动过。
  const relRollback = 'prompts/testing/sec-trash-rollback.md';
  const fullRollback = safeJoinWritable(relRollback);
  try {
    const made = await viaIpc('window.promptFlowApi.createFile(' + J(relRollback) + ', ' + J(mkTrashDoc('ROLLBACK-BODY')) + ')');
    check('删除回滚用例前置：创建文件', made.ok === true, JSON.stringify(made).slice(0, 160));
    // 再存一次，让它有版本目录，这样"版本目录也搬回来了"才有对照价值
    await viaIpc('window.promptFlowApi.saveFile(' + J(relRollback) + ', ' + J(mkTrashDoc('ROLLBACK-BODY-v2')) + ')');
    const bodyBefore = await fsp.readFile(fullRollback, 'utf8');
    let snapsBefore = [];
    try { snapsBefore = (await fsp.readdir(versionDirFor(relRollback))).filter(f => f.endsWith('.md')); } catch {}
    check('删除回滚用例前置：已有版本目录可作对照', snapsBefore.length >= 1, '快照 ' + snapsBefore.length + ' 条');

    const hits = { n: 0 };
    fsp.writeFile = function (p, ...rest) {
      let hit = false;
      try {
        const rp = path.resolve(String(p));
        hit = path.dirname(rp) === path.resolve(TRASH_DIR_NORM) && /^\.tmp-.*-index\.json\.part$/.test(path.basename(rp));
      } catch {}
      if (hit) {
        hits.n++;
        const err = new Error('EACCES: permission denied, open ' + String(p));
        err.code = 'EACCES';
        return Promise.reject(err);
      }
      return realWriteFile.call(this, p, ...rest);
    };
    const res = await viaIpc('window.promptFlowApi.trash(' + J(relRollback) + ')');
    fsp.writeFile = realWriteFile;

    check('删除回滚用例前置：桩真的被调用到了', hits.n > 0, '命中 ' + hits.n + ' 次');
    check('索引写失败时删除报 E_TRASH_INDEX_WRITE 而不是裸系统错误',
      res.ok === false && /E_TRASH_INDEX_WRITE/.test(String(res.message)),
      JSON.stringify(res).slice(0, 200));

    // 核心断言：文件必须回到原处。修复不在 → 正文留在 .trash 里而索引没有条目，
    // 文件树、回收站、下次清空都碰不到它，等于永久丢失。
    let bodyAfter = null;
    try { bodyAfter = await fsp.readFile(fullRollback, 'utf8'); } catch {}
    check('索引写失败后正文回到原位置且内容未变',
      bodyAfter === bodyBefore,
      bodyAfter == null ? '文件不在原位置（只剩 .trash 里那份孤儿）' : JSON.stringify(bodyAfter.slice(0, 120)));

    let snapsAfter = [];
    try { snapsAfter = (await fsp.readdir(versionDirFor(relRollback))).filter(f => f.endsWith('.md')); } catch {}
    check('索引写失败后版本目录也搬回了原处',
      snapsAfter.length === snapsBefore.length,
      '之前 ' + snapsBefore.length + ' 条，现在 ' + snapsAfter.length + ' 条');

    check('索引里没有留下半条记录', !(await readTrashIndex()).items.some(i => i.originalRel === relRollback));
    let leftover = [];
    try { leftover = (await fsp.readdir(TRASH_DIR)).filter(f => f !== 'index.json' && !f.startsWith('.tmp-')); } catch {}
    check('.trash 里没有留下孤儿文件', leftover.length === 0, JSON.stringify(leftover));

    // 复原后照旧能正常删除，证明上面那次失败没把状态弄坏
    const ok2 = await viaIpc('window.promptFlowApi.trash(' + J(relRollback) + ')');
    check('恢复可写后删除重新正常工作', ok2.ok === true, JSON.stringify(ok2).slice(0, 200));
  } catch (e) {
    check('删除回滚用例执行完成', false, e && e.message);
  } finally {
    fsp.writeFile = realWriteFile;
    try { await fsp.rm(fullRollback, { force: true }); } catch {}
    try { await fsp.rm(versionDirFor(relRollback), { recursive: true, force: true }); } catch {}
    try { await writeTrashIndex({ items: [] }); } catch {}
    try { for (const f of await fsp.readdir(TRASH_DIR)) if (f !== 'index.json') await fsp.rm(path.join(TRASH_DIR, f), { recursive: true, force: true }); } catch {}
  }

  // ---- 10e. 多 key 获取顺序必须是 ver:* → trash → config ----
  // trash/restore 现在同时占 ver:<rel> 和 trash，而 trash handler 内部还会再占
  // config。queueWriteMulti 原先用裸 sort()，而字典序是 config < trash < ver:*，
  // 正好和真实获取顺序相反——一旦有第二处按 ver → trash 的方向拿锁（比如以后给
  // save-file 加一次回收站查重），两边就构成环，双方都不会释放。
  // 这一条测的是那个不变量本身：先占住 trash，再发一个 ['ver:probe','trash'] 的
  // 多 key 请求，然后看 ver:probe 有没有被它先占走。
  //   顺序正确（ver 先） → 探针排在后面，此刻跑不了
  //   顺序反了（trash 先）→ 多 key 请求还卡在 trash 上，ver:probe 是空的，探针立刻跑
  try {
    let releaseTrash;
    const gate = new Promise(r => { releaseTrash = r; });
    const holder = queueWrite('trash', () => gate);
    await sleep(30);

    let multiDone = false;
    const multi = queueWriteMulti(['ver:sec-lock-probe', 'trash'], async () => { multiDone = true; });
    await sleep(30);
    check('锁顺序用例前置：多 key 请求此刻确实被 trash 挡住', multiDone === false);

    let probeRan = false;
    const probe = queueWrite('ver:sec-lock-probe', async () => { probeRan = true; });
    await sleep(30);
    check('多 key 请求先占 ver:*，再等 trash（顺序没被字典序倒过来）',
      probeRan === false,
      probeRan ? 'ver:sec-lock-probe 还是空的，说明先去抢 trash 了' : '');

    releaseTrash();
    await holder;
    await multi;
    await probe;
    check('放开 trash 后多 key 请求和探针都能跑完（没有死锁）', multiDone === true && probeRan === true,
      'multi=' + multiDone + ' probe=' + probeRan);
  } catch (e) {
    check('锁顺序用例执行完成', false, e && e.message);
  }

  return out;
}

// ---------- 自检（PFM_SELFTEST=1） ----------
// 存在的理由：这个应用出过两类"进程能起来但界面是白的"的故障
//   1) renderer.js 顶层与其他脚本重名，整段脚本不执行；
//   2) 打包后 preload / index.html 路径指向了数据目录。
// 这两种问题只有真正把页面加载起来才暴露得出来，纯静态检查测不到，
// 所以提供一个无人工干预的自检入口供 CI / 冒烟测试调用。
// 自检脚本从 src/selftest/*.js 读，而不是写成主进程里的模板字符串。
// 为什么要拆出去：这三段一共 415 行真代码，写成 `...` 之后对所有静态检查
// 都是不透明的——实测在里面塞一个 `const const x = 1`，node --check、eslint、
// 冒烟测试三层全绿，而它一运行必炸。拆成真实 .js 文件后 eslint 才看得见。
//
// 用 CODE_ROOT 而不是 DATA_ROOT：这是代码资源，打包后在 asar 内（只读），
// 数据目录里没有这些文件。build.files 里的 src/**/* 已经覆盖了这个子目录。
//
// 同步读：自检是一次性启动流程，没有并发压力；而且读不到就该立刻炸掉，
// 不能让自检"少跑了一段"却仍然报全部通过。
function loadSelfTestScript(name) {
  const p = path.join(CODE_ROOT, 'src', 'selftest', name);
  const code = fs.readFileSync(p, 'utf8');
  // executeJavaScript 要的是一个表达式。文件本身就是 (async () => {...})()，
  // 但结尾可能带换行/BOM，去掉以免拼接后变成语句序列。
  return code.replace(/^\uFEFF/, '').trim();
}

function attachSelfTest(targetWin) {
  requireInit('attachSelfTest');
  const consoleErrors = [];
  targetWin.webContents.on('console-message', (e, level, message) => {
    if (level >= 2) consoleErrors.push(message); // 2=warning 以上，3=error
  });
  const loaded = new Promise((resolve, reject) => {
    targetWin.webContents.once('did-finish-load', () => resolve());
    targetWin.webContents.once('did-fail-load', (e, code, desc, url) =>
      reject(new Error(`页面加载失败 code=${code} desc=${desc} url=${url}`)));
  });

  const probeScript = loadSelfTestScript('probe.js');

  // 在页面里跑，直接调 contextBridge 暴露的 API → 真实经过 IPC 与主进程逻辑。
  const functionalScript = loadSelfTestScript('functional.js');

  // 在页面里模拟真实点击。只依赖 DOM 与真实事件，不走任何测试专用后门。
  const uiScript = loadSelfTestScript('ui.js');

  return {
    run: async () => {
      const fail = (msg) => { console.error('[selftest] FAIL ' + msg); process.exitCode = 1; };
      // PFM_SELFTEST_CLOSE=flush|destroy：验证关窗时还挂在防抖窗口里的配置写入
      // 会被真的落盘（见 win.on('close') 与渲染进程的 __pfmFlushPending）。
      //
      // 成败不在这里判：进程退出之后由 tests/close-flush.test.js 读 config.json 定论。
      // "落盘"要等关窗流程整个走完才算数，在进程里自己断言等于自己发毕业证。
      //
      // destroy 是反向对照：win.destroy() 不触发 'close'，握手根本不会跑，那次改动
      // 就该跟着窗口一起没了。两组结果不同，才说明 flush 组测到的是握手本身，
      // 而不是"这个值反正总会被写进去"。
      //
      // 关键一步是把防抖的自然计时器挪到 10 分钟以后（下面临时改 setTimeout 的延时）。
      // 不这么做的话，flush 组即使握手完全失效，400ms 的计时器自己也可能把值写进去，
      // 于是测试照样绿——这就是个空断言。挪走之后，只有 flush() 能让这次写入完成。
      //
      // 这段不能放进下面的 try/finally：那里的 finally 会调 app.exit()，
      // 而 app.exit() 不走窗口关闭流程，会把正在进行的 flush 直接掐断。
      if (process.env.PFM_SELFTEST_CLOSE) {
        await loaded;
        if (!process.env.PFM_DATA_DIR) {
          fail('关窗落盘自检必须设置 PFM_DATA_DIR，拒绝在真实数据目录上跑');
          app.exit(1);
          return;
        }
        const mode = process.env.PFM_SELFTEST_CLOSE;
        const markWidth = 377;
        // 直接调防抖函数，不经过 toggleLockFile：后者现在会立刻 flush（锁定要尽快变成
        // 磁盘事实），那就没有"待写入"状态可测了。这里要的正是挂着还没落盘的状态。
        const sched = await targetWin.webContents.executeJavaScript(
          '(() => {'
          + ' const origST = window.setTimeout;'
          + ' window.setTimeout = function (fn, ms) { return origST.call(window, fn, 600000); };'
          + ' try {'
          + '   saveSidebarWidthDebounced(' + markWidth + ');'
          + '   saveTabsDebounced();'
          + ' } finally { window.setTimeout = origST; }'
          + ' return { hasFlush: typeof window.__pfmFlushPending === "function" };'
          + ' })()', true);
        if (!sched.hasFlush) fail('渲染进程没有暴露 __pfmFlushPending，关窗握手无从谈起');
        else console.log('[selftest:close] PASS 渲染进程暴露了 __pfmFlushPending');
        // 前置条件：此刻必须还没落盘。若这时磁盘上已经是新值，说明它是别的路径写进去的，
        // 后面无论看到什么都证明不了 flush 起了作用。
        let before = {};
        try { before = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
        if (before.sidebarWidth === markWidth) {
          fail('前置条件不成立：待写入的值在关窗之前就已经落盘了');
        } else {
          console.log('[selftest:close] PASS 关窗前该值还挂在防抖里（磁盘上是 '
            + JSON.stringify(before.sidebarWidth) + '）');
        }
        console.log('[selftest:close] 模式=' + mode);
        if (mode === 'destroy') targetWin.destroy();
        else targetWin.close();
        // 故意不调 app.exit()：让关窗流程自己走完（close → 异步收尾 → 真的关 →
        // window-all-closed → app.quit()），进程退出后由测试脚本读 config.json。
        return;
      }
      try {
        await loaded;
        const r = await targetWin.webContents.executeJavaScript(probeScript, true);
        const checks = [
          ['contextBridge 已注入 window.promptFlowApi', r.bridgeReady],
          ['渲染进程无 Node 能力泄漏（require/module 不可见）', !r.nodeLeak],
          ['marked 已加载', r.markedReady],
          ['DOMPurify 已加载', r.purifyReady],
          ['diff-match-patch 已加载', r.dmpReady],
          ['I18N 全局可用', r.i18nReady],
          ['文件树已渲染出节点（' + r.treeNodes + ' 个）', r.treeNodes > 0]
        ];
        for (const [name, ok] of checks) {
          if (ok) console.log('[selftest] PASS ' + name);
          else fail(name);
        }
        if (consoleErrors.length) fail('渲染进程报错: ' + consoleErrors.join(' | '));
        // 功能自检：真正走一遍 IPC（新建→保存→版本→回滚→锁定→删除→恢复→搜索）。
        // 必须配合 PFM_DATA_DIR 指向临时目录，否则会动到真实提示词库。
        if (process.env.PFM_SELFTEST_FUNCTIONAL === '1') {
          if (!process.env.PFM_DATA_DIR) {
            fail('功能自检必须设置 PFM_DATA_DIR，拒绝在真实数据目录上跑');
          } else {
            // 告诉页面对话框桩是否可用（可用时才跑导出/导入往返）
            await targetWin.webContents.executeJavaScript(
              'window.__pfmDialogStubs = ' + JSON.stringify(process.env.PFM_SELFTEST_DIALOGS || null) + ';', true);
            const fnResults = await targetWin.webContents.executeJavaScript(functionalScript, true);
            for (const [name, ok, detail] of fnResults) {
              if (ok) console.log('[selftest:fn] PASS ' + name);
              else fail('[fn] ' + name + (detail ? ' → ' + detail : ''));
            }
            // 安全回归：这几条必须在主进程里跑，因为要先用 fs 把磁盘弄成坏状态
            // （伪造损坏的回收站索引、把 config.json 占成目录），再走真实 IPC 看行为。
            // 渲染进程没有 fs，构造不出这些前置条件。
            const secResults = await runSecurityRegression(targetWin);
            for (const [name, ok, detail] of secResults) {
              if (ok) console.log('[selftest:sec] PASS ' + name);
              else fail('[sec] ' + name + (detail ? ' → ' + detail : ''));
            }
          }
        }
        // PFM_SELFTEST_READONLY=1：对当前库做只读体检。
        // 把每个文件都读出来、解析 frontmatter、渲染 Markdown、解析流程图、跑搜索，
        // 全程不写文件，所以可以安全地对着真实数据跑（用来回答"我的库能正常用吗"）。
        if (process.env.PFM_SELFTEST_READONLY === '1') {
          const ro = await targetWin.webContents.executeJavaScript(loadSelfTestScript('readonly.js'), true);
          console.log('[readonly] 库内文件 ' + ro.files.length + ' 个');
          for (const f of ro.files) {
            console.log('[readonly]   ' + f.rel + '  ' + f.bytes + ' 字节, title=' + f.title +
              ', version=' + f.version + ', 渲染 HTML ' + f.htmlLen + ' 字符' +
              (f.flowSteps == null ? '' : ', 流程步骤 ' + f.flowSteps));
          }
          for (const s of ro.searches) console.log('[readonly] 搜索 "' + s.q + '" → ' + s.hits + ' 条');
          const emptyRender = ro.files.filter(f => f.htmlLen === 0);
          const noTitle = ro.files.filter(f => !f.title);
          const badFlow = ro.flows.filter(f => f.steps === 0 || f.missing > 0);
          if (ro.errors.length) fail('只读体检有报错: ' + ro.errors.join(' | '));
          else console.log('[readonly] PASS 所有文件都能读取并解析，无异常');
          if (emptyRender.length) fail('这些文件渲染结果为空: ' + emptyRender.map(f => f.rel).join(', '));
          else console.log('[readonly] PASS 所有文件的 Markdown 都渲染出内容');
          if (noTitle.length) console.log('[readonly] 注意：这些文件的 frontmatter 缺 title: ' + noTitle.map(f => f.rel).join(', '));
          else console.log('[readonly] PASS 所有文件都有 title');
          if (badFlow.length) fail('这些工作流的 flow 解析异常: ' + JSON.stringify(badFlow));
          else console.log('[readonly] PASS 工作流的流程图步骤都解析正常（' + ro.flows.length + ' 个工作流）');
          for (const f of ro.flows) {
            console.log('[readonly]   ' + f.rel + ': ' + f.steps + ' 步 → 流程图 ' + f.nodes + ' 个节点');
          }
          const noNodes = ro.flows.filter(f => f.nodes === 0);
          if (noNodes.length) fail('这些工作流渲染不出流程图节点: ' + noNodes.map(f => f.rel).join(', '));
          else if (ro.flows.length) console.log('[readonly] PASS 流程图都能渲染出节点');
          const broken = ro.flows.filter(f => f.brokenLinks && f.brokenLinks.length);
          if (broken.length) fail('流程图里有指向不存在文件的节点: ' + JSON.stringify(broken.map(f => ({ rel: f.rel, links: f.brokenLinks }))));
          else if (ro.flows.length) console.log('[readonly] PASS 流程图每个节点都指向存在的提示词');
        }

        // PFM_SELFTEST_LANG=en 时切到英文再检查，用于核对 i18n 覆盖。
        // 走真实的 setLang() 路径，所以必须配 PFM_DATA_DIR 隔离配置文件。
        if (process.env.PFM_SELFTEST_LANG) {
          if (!process.env.PFM_DATA_DIR) {
            fail('语言自检必须设置 PFM_DATA_DIR，拒绝改写用户真实配置');
          } else {
            const lang = process.env.PFM_SELFTEST_LANG === 'en' ? 'en' : 'zh';
            // split/join 而不是 replace：lang.js 里有两处 __LANG__（setLang 的实参
            // 和返回值里的回显），而 replace(字符串, ...) 只换第一处，
            // 第二处会原样留成字面量 '__LANG__'，让返回的 res.lang 变成假值。
            const res = await targetWin.webContents.executeJavaScript(
              loadSelfTestScript('lang.js').split('__LANG__').join(lang), true);
            // 占位符替换必须全部生效。lang.js 把替换后的 lang 回显在返回值里，
            // 所以只要这里 res.lang 还等于字面量 '__LANG__'，就说明漏替了一处。
            // 这条不能省：漏替的那处在 setLang() 之后，页面语言照样切对了，
            // "无残留中文"依旧全绿——缺陷只体现在这个回显值上。
            if (res.lang !== lang) {
              fail('lang.js 里的 __LANG__ 没被全部替换（回显 lang=' + res.lang + '，期望 ' + lang + '）');
            } else {
              console.log('[selftest] PASS lang.js 的 __LANG__ 占位符全部替换成 ' + lang);
            }
            if (lang === 'en') {
              const ok = res.total === 0;
              if (ok) console.log('[selftest] PASS 切换到英文后界面外壳无残留中文');
              else fail('切换到英文后界面外壳仍有中文（' + res.total + ' 处）: ' + res.chunks.join(' | '));
            } else {
              console.log('[selftest] 语言已切到 ' + res.lang);
            }
            // 原生对话框（系统弹的确认框 / 文件选择框）不在 DOM 里，上面那段
            // clone body 查中文的检查根本看不到它们。而主进程原先把按钮和标题
            // 写死成中文，英文用户看到的是"提示是英文、按钮是取消/确定"的混排框——
            // 这个缺陷在自动化里一直是完全不可见的。
            //
            // 这里真的走一遍 IPC 让对话框弹出来（桩会拦下并记下实际参数），
            // 再断言参数里没有中文。不能只静态查源码有没有 mt()：
            // 传错键、mt() 查不到键回退成中文，源码看着都是对的。
            if (lang === 'en' && process.env.PFM_SELFTEST_DIALOGS) {
              const cjk = /[\u4e00-\u9fa5]/;
              await targetWin.webContents.executeJavaScript(
                'window.promptFlowApi.confirm("probe")', true);
              const mb = selfTestLastMessageBox;
              if (!mb) {
                fail('英文界面下没能捕获到确认框的实际参数');
              } else {
                // 同样不能只查中文：键名里没有中文，弹成 'cancel_' 也会过。
                // 直接和表里的英文原文逐个比对。
                const wantButtons = [I18N_TABLE.en.cancel_, I18N_TABLE.en.ok];
                const wantMessage = I18N_TABLE.en.confirm;
                const sameButtons = mb.buttons.length === wantButtons.length
                  && mb.buttons.every((b, i) => b === wantButtons[i]);
                if (sameButtons && mb.message === wantMessage) {
                  console.log('[selftest] PASS 英文界面下原生确认框走了 i18n（按钮: ' + mb.buttons.join(' / ') + '）');
                } else {
                  fail('英文界面下原生确认框文案不等于表里的英文原文（中文残留或在弹键名）：'
                    + '按钮 ' + JSON.stringify(mb.buttons) + ' 应为 ' + JSON.stringify(wantButtons)
                    + '，标题 ' + JSON.stringify(mb.message) + ' 应为 ' + JSON.stringify(wantMessage));
                }
              }
              await targetWin.webContents.executeJavaScript(
                'window.promptFlowApi.exportZip()', true);
              const fd = selfTestLastFileDialog;
              // 只查"有没有中文"是不够的：mt() 查不到键时会回退成键名本身，
              // 而 'dlgExportZip' 这种键名里一个中文都没有，照样过。
              // 实测就是这么漏的——四个标题一度全在弹键名，断言还是绿的。
              // 所以这里直接和表里的英文原文比对。
              const wantTitle = I18N_TABLE.en.dlgExportZip;
              if (!fd) {
                fail('英文界面下没能捕获到文件对话框的实际参数');
              } else if (cjk.test(fd.title)) {
                fail('英文界面下文件对话框标题仍是中文: ' + fd.title);
              } else if (fd.title !== wantTitle) {
                fail('文件对话框标题不等于表里的英文原文（可能在弹键名）: 实际 ' + JSON.stringify(fd.title) + '，应为 ' + JSON.stringify(wantTitle));
              } else {
                console.log('[selftest] PASS 英文界面下文件对话框标题走了 i18n（' + fd.title + '）');
              }
            }
          }
        }
        // PFM_SELFTEST_UI=1：真的用鼠标点一遍界面。
        // 为什么必须有这层：功能自检是直接调 IPC 的，绕过了所有 UI；
        // 结果"点新建提示词没反应"这种全量阻塞的 bug 一路没被发现——
        // 打开弹层的那次 click 冒泡到 document 后把弹层自己关掉了。
        // 会新建文件，所以必须配 PFM_DATA_DIR。
        if (process.env.PFM_SELFTEST_UI === '1') {
          if (!process.env.PFM_DATA_DIR) {
            fail('UI 点击自检必须设置 PFM_DATA_DIR，拒绝在真实库上点');
          } else {
            const uiResults = await targetWin.webContents.executeJavaScript(uiScript, true);
            for (const [name, ok, detail] of uiResults) {
              if (ok) console.log('[selftest:ui] PASS ' + name);
              else fail('[ui] ' + name + (detail ? ' → ' + detail : ''));
            }
          }
        }
        // PFM_SELFTEST_OPEN=<相对路径> 时先打开该文件，让截图能拍到正文/流程图。
        // 会写入"最近打开"（和用户点一下的效果一样），所以配合 PFM_DATA_DIR 用。
        if (process.env.PFM_SELFTEST_OPEN) {
          const rel = process.env.PFM_SELFTEST_OPEN;
          const info = await targetWin.webContents.executeJavaScript(
            '(async () => { await openFile(' + JSON.stringify(rel) + '); await new Promise(r => setTimeout(r, 500));' +
            ' return { rel: state.currentRel, previewLen: ($("preview") || {}).innerHTML ? $("preview").innerHTML.length : 0,' +
            ' flowNodes: document.querySelectorAll("#preview .flow-node, #preview [data-flow-node]").length }; })()', true);
          if (info.rel === rel && info.previewLen > 0) {
            console.log('[selftest] PASS 打开 ' + rel + '（预览 ' + info.previewLen + ' 字符，流程图节点 ' + info.flowNodes + ' 个）');
          } else {
            fail('打开 ' + rel + ' 后预览为空: ' + JSON.stringify(info));
          }
        }
        // PFM_SELFTEST_SHOT=<路径> 时顺手存一张真实渲染截图，便于人工核对界面
        if (process.env.PFM_SELFTEST_SHOT) {
          // 窗口被遮挡或还没绘制完时 capturePage 会返回空图，重试几次。
          let png = null;
          for (let i = 0; i < 5; i++) {
            const image = await targetWin.webContents.capturePage();
            png = image.toPNG();
            if (png && png.length > 0) break;
            await new Promise(r => setTimeout(r, 400));
          }
          if (png && png.length > 0) {
            fs.writeFileSync(process.env.PFM_SELFTEST_SHOT, png);
            console.log('[selftest] 截图已保存: ' + process.env.PFM_SELFTEST_SHOT + '（' + png.length + ' 字节）');
          } else {
            fail('截图为空：窗口可能未绘制');
          }
        }
      } catch (e) {
        fail(e.message);
      } finally {
        console.log('[selftest] ' + (process.exitCode ? '有失败项' : '全部通过'));
        app.exit(process.exitCode || 0);
      }
    }
  };
}


module.exports = { init, runSearchBench, installSelfTestDialogStubs, attachSelfTest };