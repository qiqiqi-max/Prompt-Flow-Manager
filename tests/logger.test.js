// tests/logger.test.js
// lib/logger.js + lib/diagnostics.js 的单测。不启动 Electron：
// 这两个模块刻意不 require('electron')（目录由 init({dir}) 传进来），
// 就是为了能在这里用裸 node 跑。
//
// 反向对照做进测试自身，形状照 tests/debounce.test.js：
// 同一批断言先跑真实实现，再跑一组**故意不滚动、不脱敏、写失败就抛**的桩，
// 要求桩必须失败。若桩也全绿，说明这批断言分辨不出"没实现"和"实现了"，
// 测试判定自己无效（CONTRIBUTING.md 第一节）。
//
// 所有落盘都在 os.tmpdir() 下的 mkdtemp 目录里，绝不碰真实数据目录。
// 运行：npm run test:logger（或 node tests/logger.test.js）
const fs = require('fs');
const os = require('os');
const path = require('path');

const logger = require('../lib/logger');
const diagnostics = require('../lib/diagnostics');

const tmpDirs = [];
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-logger-test-'));
  tmpDirs.push(d);
  return d;
}
function cleanup() {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 留着也无害，在 tmp 里 */ }
  }
}

// ---------- 反向对照用的桩 ----------
// 三处故意退化，正对应三组断言：
//   1. 从不滚动（append 到底）        → 滚动 / 文件数上限 / 删最旧 三组断言应该变红
//   2. 不脱敏（原样写入、不转义换行） → 脱敏组应该变红
//   3. 写失败直接抛                   → "不抛进调用方"那组应该变红
// 这不是"旧版实现"，本模块没有旧版；它扮演的是"如果这些行为都没写会怎样"。
function makeStub() {
  const st = { dir: null, active: null, failures: 0, written: 0, enabled: false };
  const redact = (v) => (v == null ? String(v) : (typeof v === 'string' ? v : String(v)));
  return {
    init(opts) {
      st.dir = path.resolve(opts.dir);
      st.active = path.join(st.dir, 'app.log');
      fs.mkdirSync(st.dir, { recursive: true });
      st.enabled = true;
      return { enabled: true };
    },
    info(...args) {
      // 故意不 try/catch：目录被删/被占时异常会直接穿到调用方
      fs.appendFileSync(st.active, new Date().toISOString() + ' INFO '
        + args.map(redact).join(' ') + '\n', 'utf8');
      st.written++;
    },
    warn(...a) { this.info(...a); },
    error(...a) { this.info(...a); },
    redact,
    tail() { return []; },
    status() { return { enabled: st.enabled, failures: st.failures, written: st.written, dir: st.dir, lastFailure: null }; },
    files() {
      if (!st.dir) return [];
      return fs.readdirSync(st.dir)
        .filter(n => n === 'app.log' || /^app-\d+\.log$/.test(n))
        .sort()
        .map(n => ({ name: n, size: fs.statSync(path.join(st.dir, n)).size }));
    },
    _resetForTest() { st.dir = null; st.active = null; st.failures = 0; st.written = 0; st.enabled = false; }
  };
}

// 第二个桩：**每次写入都滚动**。
// 为什么需要它：上面那个"从不滚动"的桩证明不了"阈值以下不滚动"这条断言有分辨力——
// 不滚动的实现恰好也满足"只有一个文件"。而"无条件每次都滚"是真实存在的错法
// （把 curSize > 0 那个前置判断写漏就是这个行为），它会让日志被切成一堆碎片、
// 归档里全是单行文件，历史几秒钟就被挤掉。
// CONTRIBUTING.md 的推论一："构造的失败场景，本身也要验证"——所以对照桩要按
// 每条断言想查的行为分别构造，不能只造一个然后指望它覆盖全部。
function makeAlwaysRotateStub() {
  const base = makeStub();
  const st = { dir: null, active: null };
  return {
    ...base,
    init(opts) {
      st.dir = path.resolve(opts.dir);
      st.active = path.join(st.dir, 'app.log');
      return base.init(opts);
    },
    info(...args) {
      // 先无条件滚一次，再写。maxFiles 也不管，档位一路涨。
      try {
        const names = fs.readdirSync(st.dir).filter(n => /^app-\d+\.log$/.test(n));
        const next = names.length + 1;
        if (fs.existsSync(st.active)) fs.renameSync(st.active, path.join(st.dir, 'app-' + next + '.log'));
      } catch { /* 桩，不需要健壮 */ }
      base.info(...args);
    },
    warn(...a) { this.info(...a); },
    error(...a) { this.info(...a); },
    _resetForTest() { st.dir = null; st.active = null; base._resetForTest(); }
  };
}

// ---------- 断言批次 ----------
// 每个 section 独立 try/catch：桩在"写失败会抛"那节必然抛异常，
// 不隔离的话它会带走后面所有 section，反向对照就只能看到第一处失败，
// 其余断言到底有没有分辨力就无从得知（同 debounce.test.js 的理由）。
async function runSections(L) {
  const results = [];
  const section = async (name, body) => {
    const local = [];
    const ok = (cond, msg) => local.push([!!cond, msg]);
    try {
      await body(ok);
    } catch (e) {
      local.push([false, '抛出异常：' + (e && e.message ? e.message : e)]);
    }
    results.push([name, local]);
  };

  // ---- 1. 到阈值就滚动 ----
  await section('超过阈值触发滚动，活动文件被归档成 app-1.log', async (ok) => {
    L._resetForTest();
    const dir = mkTmp();
    L.init({ dir, maxBytes: 1024, maxFiles: 5, mirror: false });
    // 每行约 60+ 字节，写 40 行必然超过 1024
    for (let i = 0; i < 40; i++) L.info('line-' + i + ' padding-padding-padding');
    const names = L.files().map(f => f.name);
    ok(names.includes('app.log'), '仍有活动文件 app.log，实际 ' + JSON.stringify(names));
    ok(names.includes('app-1.log'), '产生了归档 app-1.log，实际 ' + JSON.stringify(names));
    const active = L.files().find(f => f.name === 'app.log');
    ok(active && active.size <= 1024, '活动文件不超过阈值，实际 ' + (active ? active.size : 'N/A') + ' 字节');
  });

  // ---- 2. 阈值以下不滚动 ----
  // 这条防的是"无条件每次都滚"也能骗过上一节的情况。
  await section('阈值以下不滚动', async (ok) => {
    L._resetForTest();
    const dir = mkTmp();
    L.init({ dir, maxBytes: 1024 * 1024, maxFiles: 5, mirror: false });
    for (let i = 0; i < 20; i++) L.info('short-' + i);
    const names = L.files().map(f => f.name);
    ok(names.length === 1 && names[0] === 'app.log', '只有一个文件，实际 ' + JSON.stringify(names));
  });

  // ---- 3. 文件数上限 + 删最旧 ----
  await section('文件数封顶，最旧的被删掉', async (ok) => {
    L._resetForTest();
    const dir = mkTmp();
    L.init({ dir, maxBytes: 512, maxFiles: 3, mirror: false });
    // 每行打一个序号，最后可以按内容判断"哪一档是旧的"
    for (let i = 0; i < 300; i++) L.info('seq-' + String(i).padStart(4, '0') + ' ' + 'x'.repeat(40));
    const names = L.files().map(f => f.name);
    ok(names.length === 3, '文件总数封在 maxFiles=3，实际 ' + names.length + ' 个：' + JSON.stringify(names));
    ok(!names.includes('app-3.log'), '没有产生第 4 档 app-3.log，实际 ' + JSON.stringify(names));
    // 最旧的那一档必须已经被删：app-2.log 里不该还留着最开始那几行
    const oldest = path.join(dir, 'app-2.log');
    const oldestText = fs.existsSync(oldest) ? fs.readFileSync(oldest, 'utf8') : '';
    ok(!oldestText.includes('seq-0000'), '最早的记录已随最旧文件被删除');
    const activeText = fs.readFileSync(path.join(dir, 'app.log'), 'utf8');
    ok(activeText.includes('seq-0299'), '最新的记录在活动文件里');
  });

  // ---- 4. 写失败不抛进调用方 ----
  await section('落盘失败不抛，只计数', async (ok) => {
    L._resetForTest();
    const dir = mkTmp();
    L.init({ dir, mirror: false });
    L.info('before-break');
    // 把活动文件替换成目录：appendFileSync 必然失败（Windows/Linux 都是 EISDIR/EPERM）
    fs.rmSync(path.join(dir, 'app.log'), { force: true });
    fs.mkdirSync(path.join(dir, 'app.log'));
    let threw = false;
    try {
      for (let i = 0; i < 3; i++) L.info('after-break-' + i);
    } catch { threw = true; }
    ok(threw === false, '调用方没有收到异常');
    const st = L.status();
    ok(st.failures > 0, '失败被计数（诊断里能看到），实际 failures=' + st.failures);
    ok(st.lastFailure && !!st.lastFailure.code, '记下了最近一次失败的错误码：'
      + JSON.stringify(st.lastFailure));
  });

  // ---- 5. init 目录不可用时不抛、退化成只输出 console ----
  await section('init 到不可建的目录也不抛，退化为只镜像', async (ok) => {
    L._resetForTest();
    const dir = mkTmp();
    // 用文件占住目标目录名，mkdirSync 必然失败
    const blocked = path.join(dir, 'blocked');
    fs.writeFileSync(blocked, 'x', 'utf8');
    let threw = false;
    let st = null;
    try {
      st = L.init({ dir: path.join(blocked, 'logs'), mirror: false });
      L.info('still-alive');
    } catch { threw = true; }
    ok(threw === false, 'init 没有抛异常（否则会拖垮启动）');
    ok(st && st.enabled === false, '标记为未启用，实际 ' + JSON.stringify(st && st.enabled));
  });

  // ---- 6. 脱敏 ----
  await section('脱敏：换行被转义、超长被截断、凭据被打码、根目录被替换', async (ok) => {
    L._resetForTest();
    const dir = mkTmp();
    const fakeData = path.join(dir, 'data');
    L.init({ dir, mirror: false, dataRoot: fakeData });

    // 6a 换行：一次调用只能产生一行
    const before = fs.existsSync(path.join(dir, 'app.log'))
      ? fs.readFileSync(path.join(dir, 'app.log'), 'utf8').split('\n').filter(Boolean).length : 0;
    L.info('多行正文', '第一行\n第二行\r\n第三行');
    const afterLines = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').split('\n').filter(Boolean);
    ok(afterLines.length === before + 1, '含换行的参数只产生一行，实际多了 '
      + (afterLines.length - before) + ' 行');
    ok(/\\n/.test(afterLines[afterLines.length - 1]), '换行被转义成 \\n 字面量');

    // 6b 长度截断：模拟"整篇提示词正文被误传进来"
    const body = '这是提示词正文'.repeat(200);
    L.info('body=', body);
    const line = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').split('\n').filter(Boolean).pop();
    ok(line.length < body.length, '超长字段被截断，行长 ' + line.length + ' < 原文 ' + body.length);
    ok(!line.includes(body), '正文没有原样落盘');
    ok(/…\(\+\d+\)/.test(line), '截断留了标记（能看出丢了多少）');

    // 6c 凭据打码
    L.info('config: api_key=sk-abcdef1234567890 token=deadbeefcafe');
    const credLine = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').split('\n').filter(Boolean).pop();
    ok(!credLine.includes('sk-abcdef1234567890'), 'api_key 的值没有落盘：' + credLine);
    ok(!credLine.includes('deadbeefcafe'), 'token 的值没有落盘：' + credLine);
    ok(/\*\*\*/.test(credLine), '打码留了痕迹');

    // 6d 根目录替换成 <data>
    L.info('写入失败 ' + path.join(fakeData, 'prompts', 'a.md'));
    const pathLine = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').split('\n').filter(Boolean).pop();
    ok(pathLine.includes('<data>'), 'dataRoot 前缀被换成 <data>：' + pathLine);
    ok(!pathLine.toLowerCase().includes(fakeData.toLowerCase()), '绝对路径前缀没有原样落盘');

    // 6e redact 是公开的，调用点可以主动用
    ok(L.redact('a\nb') === 'a\\nb', 'redact() 可单独调用');
  });

  // ---- 7. 行格式稳定（测试和以后的 grep 都依赖它） ----
  await section('行格式：ISO 时间戳 + 级别', async (ok) => {
    L._resetForTest();
    const dir = mkTmp();
    L.init({ dir, mirror: false });
    L.info('[heal] 数据目录检查通过，无需修复');
    L.warn('warn 行');
    L.error('error 行');
    const lines = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').split('\n').filter(Boolean);
    ok(lines.length === 3, '三行都落盘了，实际 ' + lines.length);
    const re = logger.LINE_RE || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (INFO|WARN|ERROR) /;
    ok(lines.every(l => re.test(l)), '每行都符合 <ISO> <LEVEL> 形状：' + JSON.stringify(lines[0]));
    ok(/ INFO \[heal\] /.test(lines[0]), '原有的 [heal] 前缀在文件里保留');
    ok(lines[1].includes(' WARN '), '级别 WARN 出现在行里');
    ok(lines[2].includes(' ERROR '), '级别 ERROR 出现在行里');
  });

  // ---- 8. tail 只返回尾部、且不返回残行 ----
  await section('tail 返回最后 N 行', async (ok) => {
    L._resetForTest();
    const dir = mkTmp();
    L.init({ dir, mirror: false });
    for (let i = 0; i < 50; i++) L.info('t-' + i);
    const t = L.tail(5);
    ok(Array.isArray(t) && t.length === 5, 'tail(5) 返回 5 行，实际 ' + (Array.isArray(t) ? t.length : typeof t));
    ok(t[4].includes('t-49'), '最后一行是最新的：' + t[4]);
    ok(!t.some(l => l === ''), '没有空行');
  });

  return results;
}

// ---------- 诊断包（只对真实实现跑；桩没有 diagnostics 可对照） ----------
async function runDiagnostics() {
  const local = [];
  const ok = (cond, msg) => local.push([!!cond, msg]);
  try {
    logger._resetForTest();
    const root = mkTmp();
    const logsDir = path.join(root, 'logs');
    logger.init({ dir: logsDir, mirror: false, dataRoot: root });
    logger.info('[bootstrap] 诊断采集前的一行');

    // 造一个像真实数据目录的结构
    const dirs = {};
    for (const top of ['prompts', 'workflows', 'templates']) {
      const d = path.join(root, top);
      fs.mkdirSync(d, { recursive: true });
      dirs[top] = d;
    }
    fs.writeFileSync(path.join(dirs.prompts, '银行需求评审.md'), '---\ntitle: t\n---\n绝密正文内容 SECRET_BODY', 'utf8');
    fs.mkdirSync(path.join(dirs.prompts, 'testing'), { recursive: true });
    fs.writeFileSync(path.join(dirs.prompts, 'testing', 'b.md'), '# b', 'utf8');
    fs.writeFileSync(path.join(dirs.prompts, '.hidden.md'), 'x', 'utf8');
    fs.writeFileSync(path.join(dirs.workflows, 'w.md'), '# w', 'utf8');

    const healReport = {
      ranAt: '2026-01-01T00:00:00.000Z',
      droppedGhostEntries: [{ id: '1', name: '机密方案.md', store: '1.md' }],
      adoptedOrphanFiles: [],
      droppedBadStore: [],
      orphanVersionDirs: [],
      unrestorableEntries: [],
      removedTempFiles: ['prompts/.tmp-1-0-x.md.part'],
      errors: []
    };

    const d = diagnostics.collect({
      appVersion: '1.4.0',
      versions: process.versions,
      isPackaged: false,
      dataRoot: root,
      codeRoot: root,
      dirs,
      healReport,
      configPath: path.join(root, 'config.json')
    });

    ok(d.app.version === '1.4.0', 'app.version 采到了：' + d.app.version);
    ok(!!d.runtime.node, 'node 版本采到了：' + d.runtime.node);
    ok(d.system.platform === process.platform, 'platform 采到了：' + d.system.platform);
    ok(d.app.packaged === false, 'packaged 标记正确：' + d.app.packaged);
    ok(d.roots.dataRoot === root, 'dataRoot 原样给出（路径指错是本项目最严重故障的根因）');
    ok(d.roots.sameRoot === true, '识别出开发模式下两个根目录相同');
    ok(d.roots.dataRootWritable === true, '探测到数据目录可写');
    ok(d.roots.configExists === false, 'config.json 不存在时报 false');
    ok(d.roots.disk === null || (d.roots.disk.freeBytes > 0), '磁盘剩余空间可得或明确为 null：'
      + JSON.stringify(d.roots.disk));
    ok(d.counts.prompts.files === 2, 'prompts 下 .md 计数为 2（隐藏文件不计），实际 ' + d.counts.prompts.files);
    ok(d.counts.workflows.files === 1, 'workflows 计数为 1，实际 ' + d.counts.workflows.files);
    ok(d.counts.templates.files === 0, 'templates 计数为 0，实际 ' + d.counts.templates.files);
    ok(d.heal.droppedGhostEntries === 1, '自愈报告只留数量，实际 ' + d.heal.droppedGhostEntries);
    ok(d.logger && d.logger.enabled === true, '带上了 logger 状态');
    ok(Array.isArray(d.logTail) && d.logTail.length >= 1, '带上了日志尾部，实际 ' + d.logTail.length + ' 行');
    ok(d.logFiles.some(f => f.name === 'app.log'), '带上了日志文件清单');

    // 关键：整个诊断包里不许出现正文，也不许出现用户文件名
    const json = JSON.stringify(d);
    ok(!json.includes('SECRET_BODY'), '诊断包不含提示词正文');
    ok(!json.includes('银行需求评审'), '诊断包不含用户文件名');
    ok(!json.includes('机密方案'), '自愈报告里的文件名也没带进来');
    ok(!fs.existsSync(path.join(root, '.diag-probe-' + process.pid)), '可写性探测没有留下文件');

    // exportTo 必须要求注入 writer，不许自己实现原子写
    let noWriterThrew = false;
    try {
      await diagnostics.exportTo(path.join(root, 'x.json'), {}, null);
    } catch (e) {
      noWriterThrew = /E_DIAG_NO_WRITER/.test(e.message);
    }
    ok(noWriterThrew, '没有注入 writer 时明确抛 E_DIAG_NO_WRITER（而不是偷偷用 fs.writeFile）');

    // 注入一个假的原子写，验证参数与内容
    let seen = null;
    const fakeWriter = async (p, data) => { seen = { p, data }; fs.writeFileSync(p, data, 'utf8'); };
    const out = path.join(root, diagnostics.defaultFileName(new Date('2026-01-02T03:04:05Z')));
    const res = await diagnostics.exportTo(out, { appVersion: '1.4.0', dirs }, fakeWriter);
    ok(res.ok === true && res.bytes > 0, 'exportTo 返回写入字节数：' + JSON.stringify(res));
    ok(seen && seen.p === out, 'writer 收到的是调用方给的完整路径');
    ok(JSON.parse(seen.data).schema === 1, '写出的是可解析 JSON，带 schema 版本');
    ok(/^pfm-diagnostics-\d{8}-\d{6}\.json$/.test(path.basename(out)),
      '默认文件名形状稳定：' + path.basename(out));
  } catch (e) {
    local.push([false, '抛出异常：' + (e && e.stack ? e.stack : e)]);
  }
  return [['诊断包采集与导出', local]];
}

function countFails(results) {
  let n = 0;
  for (const [, local] of results) for (const [ok] of local) if (!ok) n++;
  return n;
}

(async () => {
  console.log('[test:logger] lib/logger.js + lib/diagnostics.js');

  const real = await runSections(logger);
  const diag = await runDiagnostics();
  for (const [name, local] of real.concat(diag)) {
    console.log('[test:logger] ' + name);
    for (const [ok, msg] of local) console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + msg);
  }
  const realFails = countFails(real) + countFails(diag);

  // 反向对照：不滚动 / 不脱敏 / 写失败就抛的桩必须跑不过上面那批断言。
  // 证明的是"断言有分辨力"，不是"桩有 bug"（后者是构造出来的既定事实）。
  const stub = await runSections(makeStub());
  const stubFails = countFails(stub);
  const stubSections = stub.filter(([, l]) => l.some(([ok]) => !ok)).length;
  console.log('[test:logger] 反向对照（不滚动/不脱敏/失败即抛的桩）失败 ' + stubFails
    + ' 项，覆盖 ' + stubSections + '/' + stub.length + ' 个 section');
  for (const [name, local] of stub) {
    const bad = local.filter(([ok]) => !ok);
    if (bad.length) console.log('  控制组失败 → ' + name + '：' + bad.map(([, m]) => m).join(' / '));
  }

  // 逐项点名：光看总数不够。滚动、上限、不抛、脱敏这四组各自都必须在控制组里变红，
  // 否则某一组可能是恒真断言而被别组的失败数掩盖（CONTRIBUTING.md 的推论二）。
  const stubMap = new Map(stub.map(([name, local]) => [name, local]));
  const mustGoRed = [
    '超过阈值触发滚动，活动文件被归档成 app-1.log',
    '文件数封顶，最旧的被删掉',
    '落盘失败不抛，只计数',
    '脱敏：换行被转义、超长被截断、凭据被打码、根目录被替换'
  ];
  const notRed = mustGoRed.filter(n => {
    const l = stubMap.get(n);
    return !l || !l.some(([ok]) => !ok);
  });
  if (notRed.length) {
    console.error('[test:logger] FAIL 这些 section 在控制组里居然全绿，对应断言无分辨力: '
      + notRed.join(' | '));
  }

  // 第二组对照：无条件每次都滚。专门给"阈值以下不滚动"那条断言验分辨力，
  // 上面那个"从不滚动"的桩对它是绿的（不滚动同样只留一个文件）。
  const stub2 = await runSections(makeAlwaysRotateStub());
  const stub2Fails = countFails(stub2);
  const noRotSection = '阈值以下不滚动';
  const noRotLocal = new Map(stub2.map(([n, l]) => [n, l])).get(noRotSection);
  const noRotRed = !!(noRotLocal && noRotLocal.some(([ok]) => !ok));
  console.log('[test:logger] 反向对照二（每次都滚的桩）失败 ' + stub2Fails + ' 项；'
    + '"' + noRotSection + '"是否变红: ' + (noRotRed ? '是' : '否'));
  if (!noRotRed) {
    console.error('[test:logger] FAIL "' + noRotSection + '" 在"每次都滚"的桩上仍是绿的，该断言无分辨力');
  }

  const controlOk = stubFails > 0 && notRed.length === 0 && noRotRed;
  if (stubFails === 0) {
    console.error('[test:logger] FAIL 反向对照全绿：这批断言分辨不出"没实现滚动/脱敏"，测试无效');
  }

  cleanup();
  const leftovers = tmpDirs.filter(d => fs.existsSync(d));
  if (leftovers.length) console.log('[test:logger] 注意：临时目录未清净 ' + leftovers.length + ' 个');

  const passed = realFails === 0 && controlOk;
  console.log('\n[test:logger] ' + (passed ? '通过' : '失败')
    + '（真实实现失败 ' + realFails + ' 项，控制组失败 ' + stubFails + ' 项）');
  process.exit(passed ? 0 : 1);
})();
