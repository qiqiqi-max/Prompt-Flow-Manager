// 内容目录的外部改动感知：CLI、MCP、git pull、外部编辑器都可能在应用之外改
// prompts/ workflows/ templates/。原先应用只在保存时靠 E_SAVE_CONFLICT 发现冲突，
// 文件树和已打开的标签页一直停在旧内容上。
//
// 这个模块不 require('electron')：fs.watch / stat / readdir 都可注入，
// 事件合并、自写过滤、路径过滤可以用裸 node 测（tests/library-watch.test.js）。
//
// ---- 为什么不按"事件"判断，而是按"快照差异"判断 ----
// fs.watch 的事件本身不可靠：Windows 上一次原子写会报 rename(临时名) +
// rename(目标) + change(目标) + change(父目录)，删除目录只报目录本身，
// 同一次改动可能来三遍，也可能一条都不报文件名（filename 为 null）。
// 所以事件在这里只当"去看一眼"的线索：防抖合并之后，对涉及的路径 stat 一遍，
// 跟快照里记的 (mtimeMs, size) 比，不同才算变化。
//
// ---- 自写过滤 ----
// 应用自己的保存/改名/导入/回滚/恢复也会触发 watch。主进程在每次写完之后调
// noteSelfWrite(fullPath)（挂在 dropFromCache 上，所有写路径本来就都经过它），
// 这里立刻 stat 一次，把写完之后的指纹记进快照。等事件合并到点再比对时，
// 磁盘上的指纹和快照一致 → 不报。
//
// 为什么不会漏掉真正的外部修改：快照记的是"我们写完那一刻"的指纹。之后外部
// 再改这个文件，mtime 或 size 至少一个会变，比对就不相等。不是"登记了路径就
// 忽略这条路径的事件一段时间"那种做法——那种做法在忽略窗口内的外部修改会被吞掉。
//
// 边界（已知、接受）：
//   1. 外部改动恰好落在"我们的写完成"和"我们的 stat"之间（同一个 tick 内的几十微秒），
//      快照会把外部的结果记成我们的。保存时的 E_SAVE_CONFLICT 仍然兜底。
//   2. 和正文缓存同一条边界：同一个 mtime 刻度内改成同样大小，指纹相等，看不出来。
//   3. 不在写闸（write-gate）里的写入（create-file）在写盘和 noteSelfWrite 之间
//      隔着一次 close 的 await，那一瞬若恰好轮到合并，会把新文件报成一次"新增"。
//      后果只是多刷一次文件树：新文件不可能有已打开的标签页。
//
// ---- 导入期间 ----
// 完整备份导入持有 write-gate 的独占锁，期间会写成百上千个文件，回滚时再删掉。
// isPaused() 为真时合并只是往后推，不比对也不通知；导入结束后一次比对，
// 导入写的文件都已经 noteSelfWrite 过，不会报；导入期间真正的外部改动照样能比出来。

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULT_TOPS = ['prompts', 'workflows', 'templates'];

// 临时文件的形态。点开头覆盖本应用原子写的 .tmp-<pid>-<seq>-*.part、.gitkeep、
// .git、编辑器的 .xxx.swp；其余几个是常见编辑器/下载工具的半成品后缀。
// 这里宽一点没关系：被忽略的只是"去看一眼"的线索，不是用户内容——
// 外部编辑器"写临时文件再 rename 成 x.md"的那一步会以 x.md 的名字再报一次。
const TEMP_SUFFIX_RE = /(~|\.part|\.tmp|\.temp|\.swp|\.swx|\.crdownload|\.download)$/i;

// 返回 'md' | 'other' | 'ignore'。rel 是相对 DATA_ROOT、用 / 分隔的路径。
function classifyRel(rel, tops = DEFAULT_TOPS) {
  if (typeof rel !== 'string' || !rel) return 'ignore';
  const segs = rel.split('/').filter(Boolean);
  if (!segs.length || !tops.includes(segs[0])) return 'ignore';
  if (segs.length === 1) return 'other';
  for (const s of segs.slice(1)) {
    if (s.startsWith('.')) return 'ignore';
  }
  const base = segs[segs.length - 1];
  if (TEMP_SUFFIX_RE.test(base)) return 'ignore';
  if (base.toLowerCase().endsWith('.md') && base.length > 3) return 'md';
  return 'other';
}

function fingerprintOf(st) {
  return { mtimeMs: st.mtimeMs, size: st.size };
}

function sameFingerprint(a, b) {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function createLibraryWatcher(options) {
  const {
    root,
    tops = DEFAULT_TOPS,
    onChange,
    isPaused = () => false,
    log = { info: () => {}, warn: () => {}, error: () => {} },
    watch = (dir, opts, cb) => fs.watch(dir, opts, cb),
    stat = (p) => fsp.stat(p),
    readdir = (p) => fsp.readdir(p, { withFileTypes: true }),
    debounceMs = 250,
    maxWaitMs = 2000,
    pauseRetryMs = 300,
    retryBaseMs = 1000,
    retryMaxMs = 60000
  } = options || {};
  if (!root) throw new Error('library-watch: root is required');
  if (typeof onChange !== 'function') throw new Error('library-watch: onChange is required');
  const rootNorm = path.resolve(root);

  const snapshot = new Map();      // rel -> { mtimeMs, size }
  let pending = new Map();         // rel -> 'md' | 'other'
  const selfPending = new Set();
  let ready = null;
  let timer = null;
  let firstEventAt = 0;
  let flushChain = Promise.resolve();
  let closed = false;
  const watchers = new Map();      // top -> { watcher, retryTimer, attempts }

  const relOf = (fullPath) => {
    const rel = path.relative(rootNorm, path.resolve(fullPath));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.replace(/\\/g, '/');
  };
  const fullOf = (rel) => path.join(rootNorm, ...rel.split('/'));

  // 递归收集 dir 下所有 .md 的指纹。读不动的子目录记进 failed，
  // 调用方据此不把那棵子树里的旧条目当成"被删了"。
  async function walk(dirRel, out, failed) {
    let entries;
    try {
      entries = await readdir(fullOf(dirRel));
    } catch (e) {
      if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) failed.push(dirRel);
      return;
    }
    for (const ent of entries) {
      const rel = dirRel + '/' + ent.name;
      const kind = classifyRel(rel, tops);
      if (kind === 'ignore') continue;
      if (ent.isDirectory()) {
        await walk(rel, out, failed);
      } else if (kind === 'md' && ent.isFile()) {
        try {
          out.set(rel, fingerprintOf(await stat(fullOf(rel))));
        } catch (e) {
          if (!(e && e.code === 'ENOENT')) failed.push(rel);
        }
      }
    }
  }

  async function scanAll() {
    const fresh = new Map();
    const failed = [];
    for (const top of tops) await walk(top, fresh, failed);
    for (const [rel, fp] of fresh) {
      // 扫描期间应用自己写过的，以 noteSelfWrite 记下的为准
      // （初始快照建完之前不会有合并，selfSeq 不会被清）
      if (!selfSeq.has(rel)) snapshot.set(rel, fp);
    }
  }

  // 自写登记的序号：比对开始前记一个值，stat 回来后再看一眼，变了说明比对期间
  // 应用自己写过这个文件，这次比对的结果作废（以 noteSelfWrite 记下的为准）。
  // 每轮合并开始时清空：上一轮的比对都已经结束（合并是串行的）。
  const selfSeq = new Map();
  // 同一个文件的两次自写（改名失败回滚时就会连着两次）必须按顺序 stat，
  // 线程池里两个 stat 的完成顺序不保证，后发的先回来会把旧指纹写进快照。
  const selfChains = new Map();
  // 自写之后 stat 失败（EPERM/EBUSY）：不知道写完是什么样。下一次比对到它时
  // 直接收下当时的指纹、不报——宁可漏报一次自写之后紧跟的外部改动（保存冲突兜底），
  // 也不能把自己的写入报成外部修改。
  const unknown = new Set();
  const retries = new Map();
  const MAX_RETRIES = 5;

  function noteSelfWrite(fullPath) {
    if (closed) return;
    const rel = relOf(fullPath);
    if (!rel || classifyRel(rel, tops) !== 'md') return;
    selfSeq.set(rel, (selfSeq.get(rel) || 0) + 1);
    const prev = selfChains.get(rel) || Promise.resolve();
    const p = prev.then(() => stat(fullOf(rel))).then(
      (st) => {
        if (st.isFile()) snapshot.set(rel, fingerprintOf(st));
        else snapshot.delete(rel);
      },
      (e) => {
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) snapshot.delete(rel);
        else unknown.add(rel);
      }
    );
    selfChains.set(rel, p);
    selfPending.add(p);
    p.finally(() => {
      selfPending.delete(p);
      if (selfChains.get(rel) === p) selfChains.delete(rel);
    });
  }

  function requeue(rel, kind, err) {
    const n = (retries.get(rel) || 0) + 1;
    if (n > MAX_RETRIES) {
      retries.delete(rel);
      log.warn('[watch] 多次读不到 ' + rel + '（' + (err && err.code) + '），放弃这次比对');
      return;
    }
    retries.set(rel, n);
    if (pending.get(rel) !== 'other') pending.set(rel, kind);
    schedule();
  }

  function record(out, rel, fp, old) {
    snapshot.set(rel, fp);
    if (unknown.delete(rel)) return;
    if (!old) out.set(rel, 'added');
    else if (!sameFingerprint(old, fp)) out.set(rel, 'modified');
  }

  // 目录（或已经不存在的路径）整棵重扫，和快照里这个前缀下的条目做差。
  // 外部把整个目录移进来/删掉时，fs.watch 往往只报目录本身。
  async function rescanDir(rel, out) {
    const seqBefore = new Map(selfSeq);
    const fresh = new Map();
    const failed = [];
    await walk(rel, fresh, failed);
    const prefix = rel + '/';
    const underFailed = (r) => failed.some(f => r === f || r.startsWith(f + '/'));
    const selfChanged = (r) => (selfSeq.get(r) || 0) !== (seqBefore.get(r) || 0);
    for (const r of Array.from(snapshot.keys())) {
      if (!r.startsWith(prefix) || fresh.has(r) || underFailed(r) || selfChanged(r)) continue;
      snapshot.delete(r);
      unknown.delete(r);
      out.set(r, 'removed');
    }
    for (const [r, fp] of fresh) {
      if (selfChanged(r)) continue;
      record(out, r, fp, snapshot.get(r));
    }
  }

  async function checkFile(rel, out) {
    const seq = selfSeq.get(rel) || 0;
    let st = null;
    let err = null;
    try { st = await stat(fullOf(rel)); } catch (e) { err = e; }
    if ((selfSeq.get(rel) || 0) !== seq) return;
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        retries.delete(rel);
        unknown.delete(rel);
        if (snapshot.delete(rel)) out.set(rel, 'removed');
        return;
      }
      // EPERM / EBUSY：Windows 上杀软、索引器、同步盘会短暂占着文件，下一轮再看
      requeue(rel, 'md', err);
      return;
    }
    retries.delete(rel);
    if (st.isDirectory()) { await rescanDir(rel, out); return; }
    if (!st.isFile()) return;
    record(out, rel, fingerprintOf(st), snapshot.get(rel));
  }

  // 返回 true 表示按目录重扫过
  async function checkOther(rel, out) {
    let st = null;
    try { st = await stat(fullOf(rel)); } catch (e) {
      if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) { requeue(rel, 'other', e); return false; }
    }
    if (st && !st.isDirectory()) return false;   // 非 .md 的普通文件，与库无关
    await rescanDir(rel, out);
    return true;
  }

  async function flushOnce() {
    if (closed) return;
    await ready;
    // 先等所有在飞的自写登记落进快照，再开始比对
    while (selfPending.size) await Promise.all(Array.from(selfPending));
    selfSeq.clear();
    if (isPaused()) { schedule(); return; }
    if (!pending.size) return;
    const batch = pending;
    pending = new Map();
    firstEventAt = 0;
    const out = new Map();
    // 目录先、浅的先：父目录重扫过，子目录就不用再扫一遍
    const dirs = [];
    const others = Array.from(batch).filter(([, k]) => k === 'other').map(([r]) => r)
      .sort((a, b) => a.length - b.length);
    for (const rel of others) {
      if (dirs.some(d => rel === d || rel.startsWith(d + '/'))) continue;
      if (await checkOther(rel, out)) dirs.push(rel);
    }
    for (const [rel, kind] of batch) {
      if (kind === 'md') await checkFile(rel, out);
    }
    if (closed || !out.size) return;
    const changes = Array.from(out, ([rel, type]) => ({ rel, type }));
    try {
      onChange(changes);
    } catch (e) {
      log.error('[watch] 通知外部改动失败: ' + (e && e.message ? e.message : e));
    }
  }

  // 合并是串行的：两轮比对交叉的话，两边都会拿同一份旧快照去比，同一个改动报两次。
  function flush() {
    const run = flushChain.then(flushOnce).catch((e) => {
      log.error('[watch] 比对外部改动失败: ' + (e && e.message ? e.message : e));
    });
    flushChain = run;
    return run;
  }

  // 防抖：最后一个事件之后 debounceMs 再比对；连续不断的改动（git checkout 一大批）
  // 最多攒 maxWaitMs 也要比一次，不能让用户一直看不到变化。
  // 暂停期间（导入独占写入）不重置计时器：导入会产生成千上万个事件，每个都重置
  // 一次只会白白空转，固定间隔回来看一眼"导入结束没有"就够了。
  function schedule() {
    if (closed) return;
    if (isPaused()) {
      if (!timer) timer = setTimeout(() => { timer = null; flush(); }, pauseRetryMs);
      return;
    }
    const now = Date.now();
    if (!firstEventAt) firstEventAt = now;
    const wait = Math.min(debounceMs, Math.max(0, firstEventAt + maxWaitMs - now));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; flush(); }, wait);
  }

  function onRaw(top, eventType, filename) {
    if (closed) return;
    // 有的平台/场景不给文件名（缓冲溢出时也会这样），只能整棵重扫
    if (filename == null) {
      pending.set(top, 'other');
      schedule();
      return;
    }
    const name = Buffer.isBuffer(filename) ? filename.toString('utf8') : String(filename);
    const rel = top + '/' + name.replace(/\\/g, '/').replace(/^\/+/, '');
    const kind = classifyRel(rel, tops);
    if (kind === 'ignore') return;
    // 目录上的 change 只是"里面有文件动了"的元数据变化，里面那个文件自己会报。
    // 不过滤的话应用每保存一次都要白扫一遍父目录。
    if (kind === 'other' && eventType !== 'rename') return;
    if (pending.get(rel) !== 'other') pending.set(rel, kind);
    schedule();
  }

  // 监视失败（目录不存在、EPERM、watcher 运行中报错——比如被监视的目录被删掉）
  // 只记日志、按指数退避重试，绝不抛：这是锦上添花的功能，挂掉的代价是
  // "外部改动要到保存时才发现"，也就是没有这个功能之前的行为。
  function fail(top, slot, w, e) {
    if (w && slot.watcher !== w) return;   // 同一个 watcher 的第二次报错
    if (slot.watcher) { try { slot.watcher.close(); } catch {} slot.watcher = null; }
    if (closed) return;
    if (slot.attempts === 0) {
      log.warn('[watch] 无法监视 ' + top + '（' + (e && (e.code || e.message)) + '），稍后重试；在此期间外部改动要到保存时才会发现');
    }
    slot.attempts++;
    const delay = Math.min(retryMaxMs, retryBaseMs * Math.pow(2, Math.min(slot.attempts - 1, 10)));
    if (slot.retryTimer) clearTimeout(slot.retryTimer);
    slot.retryTimer = setTimeout(() => { slot.retryTimer = null; attach(top); }, delay);
    if (slot.retryTimer.unref) slot.retryTimer.unref();
  }

  function attach(top) {
    if (closed) return;
    let slot = watchers.get(top);
    if (!slot) { slot = { watcher: null, retryTimer: null, attempts: 0 }; watchers.set(top, slot); }
    let w;
    try {
      // persistent: false —— watcher 不该是"进程不能退出"的理由
      w = watch(fullOf(top), { recursive: true, persistent: false }, (eventType, filename) => onRaw(top, eventType, filename));
    } catch (e) {
      fail(top, slot, null, e);
      return;
    }
    slot.watcher = w;
    if (w && typeof w.on === 'function') w.on('error', (e) => fail(top, slot, w, e));
    if (slot.attempts > 0) {
      // 断开期间的事件全丢了，整棵重扫一遍补回来
      log.info('[watch] 已恢复监视 ' + top);
      pending.set(top, 'other');
      schedule();
    }
    slot.attempts = 0;
  }

  function start() {
    if (!ready) {
      // 先挂 watcher 再建快照：建快照期间来的事件先攒着，flush 会等快照建完
      ready = scanAll().catch((e) => {
        log.error('[watch] 建立初始快照失败: ' + (e && e.message ? e.message : e));
      });
      for (const top of tops) attach(top);
    }
    return ready;
  }

  function close() {
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    for (const slot of watchers.values()) {
      if (slot.retryTimer) { clearTimeout(slot.retryTimer); slot.retryTimer = null; }
      if (slot.watcher) { try { slot.watcher.close(); } catch {} slot.watcher = null; }
    }
  }

  return {
    start,
    close,
    noteSelfWrite,
    flush,
    isWatching: (top) => !!(watchers.get(top) || {}).watcher,
    snapshotSize: () => snapshot.size
  };
}

module.exports = { createLibraryWatcher, classifyRel, sameFingerprint, DEFAULT_TOPS };
