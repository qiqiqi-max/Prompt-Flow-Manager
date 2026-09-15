// lib/diagnostics.js
// 诊断包：把"排查一次启动/写入故障需要的环境事实"收成一个 JSON。
//
// 为什么和 logger.js 分开而不是塞成它的一个函数：
//   - logger 在 app.whenReady 的第一行就要跑，它的依赖面应该尽量小、
//     加载它不该顺带把 os/statfs/目录遍历那套代码一起拉进来。
//   - diagnostics 只在用户点"导出诊断信息"时执行一次，是冷路径，
//     可以随便做 IO（统计文件数、读日志尾部）。
//   - 依赖方向单向：diagnostics 依赖 logger，反过来没有。
//     合成一个文件就没法保持这个方向，logger 里迟早会出现"顺手调用 collect()"。
//
// 两条硬约束：
//   1. 不 require('electron')。版本号、isPackaged、两个根目录全部由调用方传进来。
//      理由同 logger：DATA_ROOT / CODE_ROOT 的判断只允许存在一份
//      （electron-main.js:123-133），这里再抄一遍就是第二个真值来源。
//   2. 不自己实现原子写。writeFileAtomic 在 electron-main.js:385，
//      是"临时名带 pid + 计数器、不以 .md 结尾、以 . 开头"三条约束一起才成立的
//      （见那里的注释），而启动自愈的 .part 清理规则 TMP_PART_RE
//      （electron-main.js:1475）是按那个形状写死的。抄第二份的话，两边一旦漂移，
//      症状是自愈把别人正在写的临时文件删掉、或者留下永远清不掉的垃圾。
//      所以 exportTo() 收一个 writer 函数当依赖。
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

// 和 electron-main.js:233 / lib/zip-import.js 里的同名函数保持一致的形状：
// 抛出的 message 是 'E_CODE|detail'，渲染侧 describeError() 按 err_<CODE> 查文案。
// 这里各自留一份是故意的——这两个模块都不 require electron，也不该反向依赖主进程，
// 而函数体只有一行。冒烟测试会回查每个码都有中英文案，所以漂移会被抓到。
function appError(code, detail) {
  return new Error(detail == null || detail === '' ? code : code + '|' + detail);
}

// 统计时的遍历上限。数据目录在开发模式下就是仓库根目录，
// 而 node_modules 有十万级条目（electron-main.js:1584-1587 踩过同一个坑）。
// 这里只扫三个内容目录，仍然加上限防病态结构。
const MAX_SCAN_ENTRIES = 20000;

// 日志尾部行数。够看出最后一次启动做了什么，又不会让 JSON 大到没法贴。
const TAIL_LINES = 200;

// ---------- 内容统计 ----------
// 只数数量和深度，不收集文件名。理由见 collect() 里 sanitizeHeal 上面的说明。
function countTree(dir) {
  const out = { files: 0, dirs: 0, bytes: 0, maxDepth: 0, truncated: false };
  let scanned = 0;
  const walk = (d, depth) => {
    if (scanned > MAX_SCAN_ENTRIES) { out.truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      scanned++;
      if (scanned > MAX_SCAN_ENTRIES) { out.truncated = true; return; }
      // 与 buildSubTree（electron-main.js:616）一致：点开头的项不算内容。
      // 保持一致是为了让"诊断包里说有 42 个文件"和"界面上看到 42 个文件"对得上，
      // 否则用户报的数字和开发者查的数字永远差几个，白白浪费一轮来回。
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        out.dirs++;
        if (depth + 1 > out.maxDepth) out.maxDepth = depth + 1;
        walk(full, depth + 1);
      } else if (e.name.toLowerCase().endsWith('.md')) {
        out.files++;
        try { out.bytes += fs.statSync(full).size; } catch { /* 刚被删 */ }
      }
    }
  };
  walk(dir, 0);
  return out;
}

// ---------- 磁盘剩余空间 ----------
// fs.statfsSync 是 Node 18.15+ 的内置（本项目 engines.node >= 18），
// 不需要任何依赖。拿不到就返回 null，而不是让整个诊断失败——
// "磁盘满" 恰好是最需要诊断的场景之一，那时候什么都可能抛。
function diskFree(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(dir);
    const bsize = Number(st.bsize) || 0;
    return {
      freeBytes: Number(st.bavail) * bsize,
      totalBytes: Number(st.blocks) * bsize
    };
  } catch {
    return null;
  }
}

// ---------- 自愈报告的脱敏 ----------
// lastHealReport 里带文件名和相对路径（electron-main.js:1511 的 item.name /
// item.store、1569 的 originalRel）。这些是**用户起的标题**，
// 「XX 银行需求评审提示词.md」这种名字本身就是敏感信息。
// 而诊断包的用途是贴给开发者/贴进 issue，所以这里只保留结构与数量，
// 加上"有没有出错"的判断依据。要看具体是哪个文件，去看本机的 logs/app.log——
// 那份文件不会离开用户的机器。
function sanitizeHeal(report) {
  if (!report || typeof report !== 'object') return null;
  if (report.failed) return { ranAt: report.ranAt || null, failed: logger.redact(report.failed) };
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  return {
    ranAt: report.ranAt || null,
    droppedGhostEntries: n(report.droppedGhostEntries),
    adoptedOrphanFiles: n(report.adoptedOrphanFiles),
    droppedBadStore: n(report.droppedBadStore),
    orphanVersionDirs: n(report.orphanVersionDirs),
    unrestorableEntries: n(report.unrestorableEntries),
    removedTempFiles: n(report.removedTempFiles),
    // errors 是程序自己生成的消息，但里面会拼文件名，所以过一遍 redact
    errors: Array.isArray(report.errors) ? report.errors.map(e => logger.redact(e)) : []
  };
}

// ---------- 采集 ----------
// 全部字段都是"环境事实"或"数量"，没有一处包含提示词正文，也没有文件名。
//
// ctx（全部可选，缺项就是 null）：
//   appVersion   app.getVersion()
//   versions     process.versions（electron / chrome / node 从这里取）
//   isPackaged   app.isPackaged
//   dataRoot     DATA_ROOT
//   codeRoot     CODE_ROOT
//   dirs         { prompts, workflows, templates } 绝对路径
//   healReport   lastHealReport（由调用方传，不去摸主进程全局）
//   configPath   CONFIG_PATH，只用来报"存不存在"，不读内容
function collect(ctx) {
  const c = ctx || {};
  const v = c.versions || {};
  const dataRoot = c.dataRoot ? String(c.dataRoot) : null;
  const codeRoot = c.codeRoot ? String(c.codeRoot) : null;

  const counts = {};
  const dirs = c.dirs || {};
  for (const key of ['prompts', 'workflows', 'templates']) {
    counts[key] = dirs[key] ? countTree(String(dirs[key])) : null;
  }

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    app: {
      version: c.appVersion == null ? null : String(c.appVersion),
      packaged: c.isPackaged === undefined ? null : !!c.isPackaged
    },
    runtime: {
      electron: v.electron || null,
      chrome: v.chrome || null,
      node: v.node || null,
      v8: v.v8 || null
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      osRelease: (() => { try { return os.release(); } catch { return null; } })(),
      // 语言环境影响 i18n 相关的报告，值本身不敏感
      locale: process.env.LANG || process.env.LC_ALL || null,
      cpus: (() => { try { return os.cpus().length; } catch { return null; } })(),
      totalMemBytes: (() => { try { return os.totalmem(); } catch { return null; } })()
    },
    // 两个根目录**原样**给出，不脱敏。
    // 这是唯一的例外，因为"路径指错了"正是这个项目最严重那次故障的根因
    // （打包版白屏，见 CONTRIBUTING.md 第三节），看不到真实路径就白采集了。
    // 代价是路径里可能含 Windows 用户名——所以导出前必须让用户自己选保存位置、
    // 由用户决定给谁看，不能自动上传。
    roots: {
      dataRoot,
      codeRoot,
      // 开发模式下两者相同，这本身就是一条要点：很多"打包才出现"的问题
      // 在这里一眼能看出来。
      sameRoot: !!(dataRoot && codeRoot && path.normalize(dataRoot).toLowerCase() === path.normalize(codeRoot).toLowerCase()),
      dataRootWritable: dataRoot ? probeWritable(dataRoot) : null,
      configExists: c.configPath ? fs.existsSync(String(c.configPath)) : null,
      disk: dataRoot ? diskFree(dataRoot) : null
    },
    counts,
    heal: sanitizeHeal(c.healReport),
    logger: logger.status(),
    logFiles: logger.files(),
    // 日志正文由调用点保证不含提示词内容（logger.js 里的 redact 只是第二道），
    // 而这一段是诊断包里最有用的部分：它记着上一次启动到底走到哪一步。
    logTail: logger.tail(TAIL_LINES)
  };
}

// 只探测"能不能写"，不留下文件。
// 用的临时名故意**不**符合 writeFileAtomic 的 .tmp-<pid>-<seq>-*.part 形态：
// 那个形态会被启动自愈当成残留临时文件扫走（electron-main.js:1475 的 TMP_PART_RE）。
// 虽然这里写完立刻删，但万一进程正好在中间被杀，留一个不在自愈规则里的文件
// 比留一个"看起来像半截原子写"的文件更容易看出是什么。
function probeWritable(dir) {
  const probe = path.join(dir, '.diag-probe-' + process.pid);
  try {
    fs.writeFileSync(probe, 'x', { flag: 'w' });
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    try { fs.rmSync(probe, { force: true }); } catch { /* 本来就没建出来 */ }
    return false;
  }
}

// 导出到文件。
// writer 必须是调用方传进来的原子写函数（electron-main.js 的 writeFileAtomic），
// 签名 (fullPath, data) => Promise<void>。理由见文件头第 2 条。
// 没传 writer 就直接抛：这是编程错误，不是运行时故障，静默退化成 fs.writeFile
// 会让"导出的诊断包是半截文件"这种问题只在断电时才暴露。
async function exportTo(fullPath, ctx, writer) {
  if (typeof writer !== 'function') {
    throw appError('E_DIAG_NO_WRITER', 'writer');
  }
  const data = collect(ctx);
  const json = JSON.stringify(data, null, 2);
  await writer(String(fullPath), json);
  return { ok: true, bytes: Buffer.byteLength(json, 'utf8') };
}

// 建议的默认文件名。放在这里而不是主进程，是为了让格式和版本号一起演进。
function defaultFileName(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return 'pfm-diagnostics-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.json';
}

module.exports = { collect, exportTo, defaultFileName, countTree, diskFree, sanitizeHeal, TAIL_LINES };
