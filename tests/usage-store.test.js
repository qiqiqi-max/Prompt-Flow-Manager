// tests/usage-store.test.js
// 使用统计与收藏（lib/usage-store.js）：计数、上限淘汰、改名迁移、彻底删除清理、
// 常用排序规则，以及文件层的串行化、导入闸门、损坏留档。
//
// 自带反向对照：每个修复点各配一个"撤掉它"的变体，跑同一批断言，
// 要求**指定的那一条**变红。只要求"有失败"不够——变体可能恰好撞红邻近的另一条，
// 那说明目标断言依然是空的（见 CONTRIBUTING.md 第一节）。
// 运行：npm run test:usage-store
const fs = require('fs');
const os = require('os');
const path = require('path');
const real = require('../lib/usage-store');
const { createWriteGate } = require('../lib/write-gate');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1750000000000;
const appError = (code, detail) => new Error(code + '|' + (detail || ''));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 按 key 串行的最小写队列，和主进程 queueWrite 同形状：链上每一步都过写入闸门。
function makeQueue(gate) {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(() => gate.shared(fn), () => gate.shared(fn));
    tail = run.then(() => {}, () => {});
    return run;
  };
}

async function runCases(lib, label, wire = (o) => o) {
  const fails = [];
  const ok = (cond, msg, detail) => { if (!cond) fails.push(msg + (detail ? '（' + detail + '）' : '')); };
  const names = () => fails.map(f => f.replace(/（.*$/, ''));

  // ---- 计数 ----
  {
    let d = lib.emptyData();
    d = lib.recordUse(d, 'prompts/a.md', NOW - 1000);
    d = lib.recordUse(d, 'prompts/a.md', NOW);
    ok(d.items['prompts/a.md'] && d.items['prompts/a.md'].count === 2, '两次使用计数为 2', JSON.stringify(d.items));
    ok(d.items['prompts/a.md'] && d.items['prompts/a.md'].lastUsedAt === NOW, '最后使用时间取最近一次');
    ok(lib.recordUse(d, '__proto__', NOW) === d && lib.recordUse(d, 'config.json', NOW) === d, '非 .md 和原型键不记账');
  }

  // ---- 上限淘汰 ----
  {
    let d = lib.emptyData();
    for (let i = 0; i < lib.MAX_ITEMS; i++) d = lib.recordUse(d, `prompts/p${i}.md`, NOW - (lib.MAX_ITEMS - i) * 1000);
    d = lib.recordUse(d, 'prompts/new.md', NOW);
    const keys = Object.keys(d.items);
    ok(keys.length === lib.MAX_ITEMS, '超过上限时条目数封顶', String(keys.length));
    ok(!d.items['prompts/p0.md'] && !!d.items['prompts/new.md'] && !!d.items['prompts/p1.md'],
      '超过上限时淘汰最久没用的那一条');
  }

  // ---- 收藏 ----
  {
    let d = lib.emptyData();
    d = lib.setFavorite(d, 'prompts/a.md', true);
    d = lib.setFavorite(d, 'prompts/b.md', true);
    ok(JSON.stringify(d.favorites) === '["prompts/b.md","prompts/a.md"]', '新收藏排在最前', JSON.stringify(d.favorites));
    ok(lib.setFavorite(d, 'prompts/a.md', true) === d, '重复收藏不产生新数据（不写盘）');
    d = lib.setFavorite(d, 'prompts/a.md', false);
    ok(JSON.stringify(d.favorites) === '["prompts/b.md"]', '取消收藏');
    let full = lib.emptyData();
    for (let i = 0; i < lib.MAX_FAVORITES; i++) full = lib.setFavorite(full, `prompts/f${i}.md`, true);
    ok(lib.setFavorite(full, 'prompts/x.md', true) === null, '收藏满了拒绝新增（不悄悄挤掉旧收藏）');
    ok(full.favorites.length === lib.MAX_FAVORITES, '收藏上限内都能加进去', String(full.favorites.length));
  }

  // ---- 改名迁移 ----
  {
    let d = lib.emptyData();
    d = lib.recordUse(d, 'prompts/a.md', NOW);
    d = lib.recordUse(d, 'prompts/a.md', NOW);
    d = lib.setFavorite(d, 'prompts/z.md', true);
    d = lib.setFavorite(d, 'prompts/a.md', true);
    d = lib.setFavorite(d, 'prompts/y.md', true);
    // 目标路径上有外部删掉的旧文件留下的残留统计和收藏
    d = lib.recordUse(d, 'prompts/b.md', NOW - 5 * DAY);
    d = lib.setFavorite(d, 'prompts/b.md', true);
    const m = lib.migrate(d, 'prompts/a.md', 'prompts/b.md');
    ok(!m.items['prompts/a.md'] && m.items['prompts/b.md'] && m.items['prompts/b.md'].lastUsedAt === NOW,
      '统计跟着改名走', JSON.stringify(m.items));
    ok(m.items['prompts/b.md'] && m.items['prompts/b.md'].count === 2,
      '目标路径的残留统计被覆盖而不是合并', JSON.stringify(m.items['prompts/b.md']));
    ok(!m.favorites.includes('prompts/a.md') && m.favorites.filter(r => r === 'prompts/b.md').length === 1,
      '收藏跟着改名走', JSON.stringify(m.favorites));
    ok(JSON.stringify(m.favorites.filter(r => r !== 'prompts/b.md')) === '["prompts/y.md","prompts/z.md"]'
      && m.favorites.indexOf('prompts/b.md') === 1, '改名后收藏位置不变', JSON.stringify(m.favorites));
    // 源没有统计、目标有残留：残留必须清掉，新文件不继承已不存在的文件的东西
    let d2 = lib.recordUse(lib.emptyData(), 'prompts/ghost.md', NOW);
    d2 = lib.setFavorite(d2, 'prompts/ghost.md', true);
    const m2 = lib.migrate(d2, 'prompts/plain.md', 'prompts/ghost.md');
    ok(!m2.items['prompts/ghost.md'] && !m2.favorites.includes('prompts/ghost.md'),
      '源没有统计时目标残留也被清掉', JSON.stringify(m2));
    ok(lib.migrate(d, 'prompts/none.md', 'prompts/none2.md') === d, '两边都没有条目时不产生新数据');
  }

  // ---- 改名再删：清空回收站要清的是新路径 ----
  {
    let d = lib.recordUse(lib.emptyData(), 'prompts/a.md', NOW);
    d = lib.setFavorite(d, 'prompts/a.md', true);
    d = lib.migrate(d, 'prompts/a.md', 'prompts/b.md');
    const f = lib.forget(d, ['prompts/b.md']);
    ok(Object.keys(f.items).length === 0 && f.favorites.length === 0, '改名后删除再清空回收站，统计和收藏都清掉',
      JSON.stringify(f));
    ok(lib.forget(d, ['prompts/other.md']) === d, '清空不相干的路径时不产生新数据');
  }

  // ---- 常用排序 ----
  {
    let d = lib.emptyData();
    for (let i = 0; i < 10; i++) d = lib.recordUse(d, 'prompts/old-heavy.md', NOW - 28 * DAY);
    for (let i = 0; i < 3; i++) d = lib.recordUse(d, 'prompts/today.md', NOW);
    d = lib.recordUse(d, 'prompts/once.md', NOW - 1000);
    const order = lib.rankFrequent(d, NOW).map(x => x.rel);
    ok(order[0] === 'prompts/today.md' && order[1] === 'prompts/old-heavy.md',
      '今天用 3 次排在一个月前用 10 次前面', order.join(' > '));
    ok(order[2] === 'prompts/once.md', '长期高频仍排在只用过一次的前面', order.join(' > '));
    let t = lib.emptyData();
    t = lib.recordUse(t, 'prompts/b.md', NOW);
    t = lib.recordUse(t, 'prompts/a.md', NOW);
    ok(lib.rankFrequent(t, NOW).map(x => x.rel).join() === 'prompts/a.md,prompts/b.md', '同分同时刻按路径排，顺序确定');
  }

  // ---- 规范化 ----
  {
    const raw = JSON.parse('{"items":{"__proto__":{"count":5,"lastUsedAt":1},"prompts/a.md":{"count":2,"lastUsedAt":10},'
      + '"prompts/bad.md":{"count":"x"},"notes.txt":{"count":1,"lastUsedAt":1}},'
      + '"favorites":["prompts/a.md","prompts/a.md",3,"constructor"]}');
    const n = lib.normalize(raw);
    ok(JSON.stringify(Object.keys(n.items)) === '["prompts/a.md"]', '规范化丢掉坏条目和原型键', JSON.stringify(n.items));
    ok(JSON.stringify(n.favorites) === '["prompts/a.md"]', '规范化收藏去重并丢掉非法项', JSON.stringify(n.favorites));
    ok(Object.getPrototypeOf(n.items) === Object.prototype && !({}).count, '规范化不污染原型');
  }

  // ---- 文件层 ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-usage-'));
  try {
    const file = path.join(root, 'usage.json');
    let writes = 0;
    // The queue mutant must exercise lost updates and the import gate, not an unrelated partial-JSON recovery race.
    const writeFileAtomic = async (f, data) => {
      const temporary = f + '.tmp-' + ++writes;
      await fs.promises.writeFile(temporary, data, 'utf8');
      await fs.promises.rename(temporary, f);
    };
    const gate = createWriteGate();
    let clock = NOW;
    const store = lib.createUsageStore(wire({ file, writeFileAtomic, queue: makeQueue(gate), appError, now: () => clock }));

    const live = new Set(['prompts/a.md', 'prompts/b.md']);
    const isLive = async (r) => live.has(r);
    const r1 = await store.record('prompts/a.md', { isLive });
    ok(r1.recorded && r1.frequent[0] && r1.frequent[0].count === 1, '记一次使用后返回最新视图', JSON.stringify(r1));
    const r2 = await store.record('prompts/gone.md', { isLive });
    ok(!r2.recorded && !JSON.parse(fs.readFileSync(file, 'utf8')).items['prompts/gone.md'],
      '文件不存在时不记账', JSON.stringify(r2));

    // 并发两次记账：两次都要算上（串行化），读要排在写之后
    clock = NOW + 1;
    const [c1, c2, snap] = await Promise.all([
      store.record('prompts/a.md', { isLive }), store.record('prompts/a.md', { isLive }), store.snapshot()
    ]);
    void c1; void c2;
    ok(JSON.parse(fs.readFileSync(file, 'utf8')).items['prompts/a.md'].count === 3, '并发记账不丢计数');
    ok(snap.frequent[0] && snap.frequent[0].count === 3, '读排在先发出的写后面（计数不倒退）', JSON.stringify(snap.frequent));

    // 导入闸门：独占期间统计写入必须等着，不能插进导入中间
    let release;
    const held = gate.exclusive(() => new Promise(r => { release = r; }));
    await sleep(10);
    const before = writes;
    const pending = store.record('prompts/b.md', { isLive });
    await sleep(50);
    ok(writes === before, '完整备份导入独占期间不写统计文件', 'writes ' + before + ' → ' + writes);
    release();
    await held;
    await pending;
    ok(writes === before + 1, '导入结束后排队的统计写入照常落盘', 'writes ' + before + ' → ' + writes);

    // 没变化不写盘
    const w0 = writes;
    await store.setFavorite('prompts/a.md', false);
    await store.migrate('prompts/none.md', 'prompts/none2.md');
    ok(writes === w0, '没有变化时不写盘', 'writes ' + w0 + ' → ' + writes);

    // forget 跳过原路径上已经有新文件的条目
    await store.setFavorite('prompts/b.md', true);
    const fv = await store.forget(['prompts/a.md', 'prompts/b.md'], { isLive: async (r) => r === 'prompts/b.md' });
    ok(!fv.frequent.some(x => x.rel === 'prompts/a.md') && fv.favorites.includes('prompts/b.md'),
      '清空回收站时跳过原路径已有新文件的条目', JSON.stringify(fv));

    // 收藏满了抛带错误码的错误
    let fullErr = null;
    const fullFile = path.join(root, 'full.json');
    fs.writeFileSync(fullFile, JSON.stringify({ items: {}, favorites: Array.from({ length: lib.MAX_FAVORITES }, (_, i) => `prompts/f${i}.md`) }));
    const fullStore = lib.createUsageStore(wire({ file: fullFile, writeFileAtomic, queue: makeQueue(createWriteGate()), appError }));
    try { await fullStore.setFavorite('prompts/x.md', true); } catch (e) { fullErr = e; }
    ok(fullErr && /^E_FAVORITES_FULL\|/.test(fullErr.message), '收藏满了抛 E_FAVORITES_FULL', fullErr && fullErr.message);

    // 损坏：改名留档，不被下一次写入覆盖
    const broken = '{"items":{"prompts/a.md":{"count":9';
    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, broken);
    const badStore = lib.createUsageStore(wire({ file: bad, writeFileAtomic, queue: makeQueue(createWriteGate()), appError, now: () => 42 }));
    await badStore.record('prompts/a.md', { isLive });
    ok(fs.existsSync(bad + '.corrupt-42') && fs.readFileSync(bad + '.corrupt-42', 'utf8') === broken,
      '损坏的统计文件改名留档且内容不变');

    // 读失败（被占用）不能当成空文件，否则这一次写入会把整份统计覆盖成只有 1 条
    const busyFile = path.join(root, 'busy.json');
    const busyBody = JSON.stringify({ items: { 'prompts/a.md': { count: 7, lastUsedAt: 1 } }, favorites: [] });
    fs.writeFileSync(busyFile, busyBody);
    const busyFsp = { ...fs.promises, readFile: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
    const busyStore = lib.createUsageStore(wire({ file: busyFile, writeFileAtomic, queue: makeQueue(createWriteGate()), appError, fsp: busyFsp }));
    let busyErr = null;
    try { await busyStore.record('prompts/a.md', { isLive }); } catch (e) { busyErr = e; }
    ok(busyErr && /^E_USAGE_READ\|/.test(busyErr.message) && fs.readFileSync(busyFile, 'utf8') === busyBody,
      '读失败时报错且不覆盖原文件', busyErr ? busyErr.message : '没有报错');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`[test:usage-store] ${label}: ${fails.length ? fails.length + ' 条失败' : '全部通过'}`);
  return names();
}

// 反向对照变体：每个都只撤掉一个修复点。target 是它必须打红的那条断言。
const variants = [
  {
    target: '超过上限时淘汰最久没用的那一条',
    lib: { ...real, recordUse: (d, rel, at) => {
      if (!real.isRel(rel)) return d;
      const prev = d.items[rel];
      return { ...d, items: { ...d.items, [rel]: { count: (prev ? prev.count : 0) + 1, lastUsedAt: at } } };
    } }
  },
  {
    target: '收藏跟着改名走',
    lib: { ...real, migrate: (d, a, b) => {
      if (a === b || !d.items[a]) return d;
      const items = { ...d.items, [b]: d.items[a] };
      delete items[a];
      return { ...d, items };
    } }
  },
  {
    target: '目标路径的残留统计被覆盖而不是合并',
    lib: { ...real, migrate: (d, a, b) => {
      const m = real.migrate(d, a, b);
      if (m === d || !d.items[b] || !d.items[a]) return m;
      return { ...m, items: { ...m.items, [b]: { ...m.items[b], count: d.items[a].count + d.items[b].count } } };
    } }
  },
  {
    target: '今天用 3 次排在一个月前用 10 次前面',
    lib: { ...real, rankFrequent: (d) => Object.entries(d.items)
      .map(([rel, it]) => ({ rel, count: it.count, lastUsedAt: it.lastUsedAt, score: it.count }))
      .sort((x, y) => (y.score - x.score) || (y.lastUsedAt - x.lastUsedAt) || (x.rel < y.rel ? -1 : 1)) }
  },
  {
    // 主进程接线写错的形状：不把队列传进去（或传成直接执行），写入就绕过了闸门
    target: '完整备份导入独占期间不写统计文件',
    lib: real,
    wire: (o) => ({ ...o, queue: (fn) => fn() })
  },
  {
    target: '文件不存在时不记账',
    lib: { ...real, createUsageStore: (o) => {
      const s = real.createUsageStore(o);
      return { ...s, record: (rel) => s.record(rel) };
    } }
  },
  {
    // 旧写法：读失败一律当"还没有文件"
    target: '读失败时报错且不覆盖原文件',
    lib: { ...real, createUsageStore: (o) => real.createUsageStore({ ...o, fsp: o.fsp && o.fsp.readFile !== fs.promises.readFile
      ? { ...o.fsp, readFile: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }
      : o.fsp }) }
  }
];

(async () => {
  const realFails = await runCases(real, '真实实现');
  for (const f of realFails) console.error('[test:usage-store] FAIL ' + f);
  let controlOk = true;
  for (const v of variants) {
    const fails = await runCases(v.lib, '反向对照：撤掉「' + v.target + '」', v.wire);
    if (!fails.includes(v.target)) {
      controlOk = false;
      console.error('[test:usage-store] FAIL 反向对照没打红目标断言「' + v.target + '」，这条断言是空的；实际失败：'
        + (fails.join('；') || '无'));
    }
  }
  const passed = realFails.length === 0 && controlOk;
  console.log('[test:usage-store] ' + (passed ? '通过' : '失败'));
  process.exit(passed ? 0 : 1);
})().catch((e) => {
  console.error('[test:usage-store] FAIL ' + (e && e.stack || e));
  process.exit(1);
});
