'use strict';
// 使用统计与收藏：每个提示词的复制次数、最后使用时间，以及收藏列表。
// 刻意不 require electron，文件路径、原子写、写入队列都由调用方传进来，裸 node 可测。
//
// 为什么是独立文件（usage.json）而不是 config.json 的新键：
//   - 写入频率不同。这里每复制一次就要落盘，而 config.json 的每次写入都是
//     "读整份 → 合并 → 整份写回"，和渲染进程五个防抖、窗口尺寸、锁定检查共用一条
//     config 队列。统计塞进去，等于让一个高频写入去和锁定判断（trash 前的 isLocked）
//     抢同一把锁，还把整份设置的重写次数翻倍。
//   - 体积不同。统计按条目增长（上限 MAX_ITEMS 条，约几十 KB），config.json 却在
//     启动、每次改设置、每次删除前判锁时被整份读出来。
//   - 损坏半径不同。usage.json 写坏了只丢统计和收藏，不会连带主题/锁定/标签页。
// 统计属于本机数据：完整备份不导出它（换一台机器后"常用"应当从那台机器的使用习惯重新长出来，
// 合并两边的计数也没有明确语义）。
//
// 键是相对路径（rel，正斜杠）。改名/移动由主进程调 migrate 跟着文件走；
// 删进回收站时什么都不做（条目留着，恢复后原路径的统计还在）；清空回收站时 forget。

const fsPromises = require('fs').promises;

// 统计条目上限。超出时按"最后使用时间"淘汰最旧的（LRU）：最久没用过的那条
// 也最不可能出现在"常用"列表里。1000 条的 usage.json 约 80 KB，整份重写仍然便宜。
const MAX_ITEMS = 1000;
// 收藏上限。收藏是用户逐条手点的，到这个数说明已经失去"收藏"的意义；
// 满了拒绝新增而不是悄悄挤掉旧收藏（静默丢掉用户亲手标的东西比报错更糟）。
const MAX_FAVORITES = 200;
// "常用"排序的半衰期：14 天前的一次复制只算今天的一半。
const HALF_LIFE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
// JSON.parse 出来的对象里这几个是自有属性，原样拷进 items 会污染原型链上的查找。
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRel(rel) {
  return typeof rel === 'string' && rel.length > 0 && rel.length <= 1024
    && !DANGEROUS_KEYS.has(rel) && rel.toLowerCase().endsWith('.md');
}

function emptyData() {
  return { schema: 1, items: {}, favorites: [] };
}

// 手改过、旧版本写的、或者被截断后又补全的文件，都在这里收成合法结构。
// 不合法的条目逐条丢弃，不因为一条坏数据把整份统计判死。
function normalize(raw) {
  const data = emptyData();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return data;
  const items = raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items) ? raw.items : {};
  for (const rel of Object.keys(items)) {
    if (!isRel(rel)) continue;
    const it = items[rel];
    if (!it || typeof it !== 'object') continue;
    const count = Math.floor(Number(it.count));
    const lastUsedAt = Number(it.lastUsedAt);
    if (!Number.isFinite(count) || count < 1) continue;
    if (!Number.isFinite(lastUsedAt) || lastUsedAt < 0) continue;
    data.items[rel] = { count: Math.min(count, 1e9), lastUsedAt };
  }
  const seen = new Set();
  for (const rel of Array.isArray(raw.favorites) ? raw.favorites : []) {
    if (!isRel(rel) || seen.has(rel)) continue;
    seen.add(rel);
    data.favorites.push(rel);
  }
  data.favorites = data.favorites.slice(0, MAX_FAVORITES);
  return evict(data);
}

function evict(data, max = MAX_ITEMS) {
  const rels = Object.keys(data.items);
  if (rels.length <= max) return data;
  // 同一毫秒的按 rel 排，保证淘汰结果确定（测试和两次运行之间都一致）
  rels.sort((a, b) => (data.items[b].lastUsedAt - data.items[a].lastUsedAt) || (a < b ? -1 : a > b ? 1 : 0));
  const items = {};
  for (const rel of rels.slice(0, max)) items[rel] = data.items[rel];
  return { ...data, items };
}

// 记一次使用（调用方保证是"真的复制出去了"）。
function recordUse(data, rel, at) {
  if (!isRel(rel)) return data;
  const prev = data.items[rel];
  const items = { ...data.items, [rel]: { count: (prev ? prev.count : 0) + 1, lastUsedAt: at } };
  return evict({ ...data, items });
}

// 返回新数据；收藏已满且要新增时返回 null，由调用方报错。
// 新收藏放在最前面：侧边栏按这个顺序列，最近收藏的最容易找到。
function setFavorite(data, rel, on) {
  if (!isRel(rel)) return data;
  const has = data.favorites.includes(rel);
  if (on) {
    if (has) return data;
    if (data.favorites.length >= MAX_FAVORITES) return null;
    return { ...data, favorites: [rel, ...data.favorites] };
  }
  if (!has) return data;
  return { ...data, favorites: data.favorites.filter(r => r !== rel) };
}

// 改名/移动：统计和收藏跟着文件走。
//
// 目标路径上原有的条目一律被源覆盖（源没有就删掉），不做合并：改名成功说明目标
// 路径此刻没有文件，那里残留的只能是外部删掉的旧文件留下的统计。合并的话，
// 新改过去的文件会凭空继承一个已经不存在的文件的复制次数和收藏状态。
// 收藏位置保持不变（原来排第几还排第几），不因为改了个名就跳到最前面。
function migrate(data, oldRel, newRel) {
  if (!isRel(oldRel) || !isRel(newRel) || oldRel === newRel) return data;
  const hadItem = Object.prototype.hasOwnProperty.call(data.items, oldRel);
  const targetItem = Object.prototype.hasOwnProperty.call(data.items, newRel);
  const hadFav = data.favorites.includes(oldRel);
  const targetFav = data.favorites.includes(newRel);
  if (!hadItem && !targetItem && !hadFav && !targetFav) return data;
  const items = { ...data.items };
  delete items[newRel];
  if (hadItem) {
    items[newRel] = items[oldRel];
    delete items[oldRel];
  }
  const favorites = data.favorites
    .filter(r => r !== newRel)
    .map(r => (r === oldRel ? newRel : r));
  return { ...data, items, favorites };
}

// 彻底删除（清空回收站）时清掉。只删统计和收藏，不碰其他条目。
function forget(data, rels) {
  const drop = new Set((rels || []).filter(isRel));
  if (!drop.size) return data;
  const touched = [...drop].some(r => Object.prototype.hasOwnProperty.call(data.items, r) || data.favorites.includes(r));
  if (!touched) return data;
  const items = {};
  for (const [rel, it] of Object.entries(data.items)) if (!drop.has(rel)) items[rel] = it;
  return { ...data, items, favorites: data.favorites.filter(r => !drop.has(r)) };
}

// "常用"的综合分：复制次数按距今时间指数衰减，半衰期 HALF_LIFE_DAYS。
// 只按次数排，三个月前狂用过一阵的提示词会永远压在顶上；只按最近使用排，又和
// "最近打开"没区别。衰减之后两者兼顾：今天用了 3 次的排在一个月前用了 10 次的前面
// （3 × 1 = 3 > 10 × 0.25 = 2.5），而长期高频使用的条目依然稳定靠前。
function frecency(item, now) {
  const ageDays = Math.max(0, now - item.lastUsedAt) / DAY_MS;
  return item.count * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

// 分数相同时按最后使用时间、再按路径排，保证顺序确定。
function rankFrequent(data, now) {
  return Object.entries(data.items)
    .map(([rel, it]) => ({ rel, count: it.count, lastUsedAt: it.lastUsedAt, score: frecency(it, now) }))
    .sort((a, b) => (b.score - a.score) || (b.lastUsedAt - a.lastUsedAt) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function view(data, now) {
  return { favorites: data.favorites.slice(), frequent: rankFrequent(data, now) };
}

// 所有读改写都经过 queue（主进程传入 queueWrite('usage', fn)）：
//   - 串行化，两次复制几乎同时落地时不会互相覆盖计数；
//   - queueWrite 内部套着写入闸门（lib/write-gate.js），完整备份导入期间这里的写入
//     会排到导入之后，不会被导入失败的回滚卷进去，也不会插在导入中间。
// 读也走 queue：渲染进程刷新统计和记一次使用几乎同时发出时，读必须排在写后面，
// 否则拿到的是写之前的旧快照，界面上的计数会"倒退"一次。
function createUsageStore(options) {
  const {
    file,
    writeFileAtomic,
    queue,
    appError,
    fsp = fsPromises,
    now = Date.now,
    logError = () => {}
  } = options || {};

  async function read() {
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return emptyData();
      // 读不出来（被占用、权限）时不能当成空：接下来那次写入会用"空 + 1"把整份统计覆盖掉
      throw appError('E_USAGE_READ', (e && e.code) || 'UNKNOWN');
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return normalize(parsed);
    } catch (e) {
      // 和 config.json 同一个处理：先改名留档再回落空数据，下一次写入就不会把坏文件覆盖掉
      const bak = file + '.corrupt-' + now();
      try { await fsp.rename(file, bak); } catch {}
      logError('[usage] 统计文件损坏，已改名留档:', bak, e.message);
      return emptyData();
    }
  }

  async function write(data) {
    await writeFileAtomic(file, JSON.stringify(data, null, 2));
  }

  // 读 → 改 → 有变化才写。没变化不写：一次无效的 rename 也会碰到杀毒软件占用重试。
  function update(mutate) {
    return queue(async () => {
      const cur = await read();
      const next = await mutate(cur);
      if (next !== cur) await write(next);
      return next;
    });
  }

  return {
    file,
    snapshot: () => queue(async () => view(await read(), now())),
    // isLive 在队列内判：文件刚被删掉时不该再给它记一笔，也就不会凭空长出幽灵条目。
    async record(rel, { isLive = async () => true } = {}) {
      let recorded = false;
      const data = await update(async (cur) => {
        if (!isRel(rel) || !(await isLive(rel))) return cur;
        recorded = true;
        return recordUse(cur, rel, now());
      });
      return { recorded, ...view(data, now()) };
    },
    async setFavorite(rel, on) {
      const data = await update(async (cur) => {
        const next = setFavorite(cur, rel, !!on);
        if (next === null) throw appError('E_FAVORITES_FULL', String(MAX_FAVORITES));
        return next;
      });
      return view(data, now());
    },
    async migrate(oldRel, newRel) {
      return view(await update(async (cur) => migrate(cur, oldRel, newRel)), now());
    },
    // isLive 判"这个路径上现在是不是又有文件了"：清空回收站之前用户可能已经在原路径
    // 新建了同名文件，那份统计属于新文件，不能一起清掉。
    async forget(rels, { isLive = async () => false } = {}) {
      return view(await update(async (cur) => {
        const drop = [];
        for (const rel of rels || []) if (!(await isLive(rel))) drop.push(rel);
        return forget(cur, drop);
      }), now());
    }
  };
}

module.exports = {
  MAX_ITEMS,
  MAX_FAVORITES,
  HALF_LIFE_DAYS,
  isRel,
  emptyData,
  normalize,
  evict,
  recordUse,
  setFavorite,
  migrate,
  forget,
  frecency,
  rankFrequent,
  createUsageStore
};
