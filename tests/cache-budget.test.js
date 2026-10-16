// tests/cache-budget.test.js
// 回归测试：正文缓存的两道闸（条目数 + 总字符预算）与占用记账。
//
// 为什么单独一个文件：条数上限给的是**虚假的安全感**。5000 条每条 200KB 的提示词
// 是约 3GB 常驻内存，而 5000 条每条约 1KB 时才 15MB——同一个条数上限，两种库的
// 代价差两个数量级，区别在"文件多大"而不是"文件多少"。而这条上限此前只有
// 跑在 Electron 里的自检盯着，且只验了条数那一维。
//
// 运行：PFM_DATA_DIR=<临时目录> npm run test:cache-budget
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const LIB = require(path.join(root, 'lib', 'library.js'));
const FRONTMATTER = require(path.join(root, 'src', 'frontmatter.js'));

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:cache-budget] PASS ' + msg);
  else { failures++; console.error('[test:cache-budget] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};

const { cacheStats, contentCache, readParsedCached, dropFromCache } = LIB;

// 这个测试只碰临时目录里的文件；同时它直接操共享的缓存对象，
// 所以每段开始前先把缓存清空、把两道闸的初值记下来，结束时复原。
const savedMax = cacheStats.CONTENT_CACHE_MAX;
const savedChars = cacheStats.CONTENT_CACHE_MAX_CHARS;

function resetCache() {
  for (const key of Array.from(contentCache.keys())) dropFromCache(key);
  cacheStats.cachedChars = 0;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-cache-budget-'));

function writeFile(name, bodyChars) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '---\ntitle: ' + name + '\n---\n' + 'x'.repeat(bodyChars), 'utf8');
  return p;
}

(async () => {
  try {
    // ---------- 一、记账：插入加、删除减 ----------
    {
      resetCache();
      cacheStats.CONTENT_CACHE_MAX = 1000;
      cacheStats.CONTENT_CACHE_MAX_CHARS = 32 * 1024 * 1024;
      const p = writeFile('a.md', 500);
      await readParsedCached(p);
      const afterInsert = cacheStats.cachedChars;
      ok(afterInsert > 500, '插入后占用被计入（含全小写副本，应大于正文长度）', String(afterInsert));
      dropFromCache(p);
      ok(contentCache.size === 0, '显式清理后条目不在缓存里');
      ok(cacheStats.cachedChars === 0, '显式清理把占用扣回去（不会越用越虚高）',
        String(cacheStats.cachedChars));

      // 反复重读同一个文件不该让占用累积
      await readParsedCached(p);
      const once = cacheStats.cachedChars;
      await readParsedCached(p);
      ok(cacheStats.cachedChars === once, '重复读同一个文件占用不累积',
        once + ' -> ' + cacheStats.cachedChars);
      // 中间改内容再读：旧条目的占用要先扣掉，否则每次改写都往账上加一份。
      // 这里断言的是**更强的不变量**——账面占用等于缓存里那条的真实占用，
      // 而不是"两次读数相等"。后者会被前一次漏扣抵消成同样的数字（都错就相等），
      // 而真正要防的正是"账和实物对不上"。
      writeFile('a.md', 500);
      await readParsedCached(p);
      const entry = contentCache.get(p);
      const real = entry ? entry.content.length + entry.bodyRaw.length + entry.bodyLower.length : -1;
      ok(real > 0 && cacheStats.cachedChars === real,
        '内容变化后重读：账面占用等于缓存里那条的真实占用（不是叠加，也不是凭空扣）',
        JSON.stringify({ account: cacheStats.cachedChars, real, once }));
      resetCache();
    }

    // ---------- 二、字符预算这道闸真的会淘汰 ----------
    {
      resetCache();
      cacheStats.CONTENT_CACHE_MAX = 100000;          // 条数闸放开，只留字符闸
      cacheStats.CONTENT_CACHE_MAX_CHARS = 4000;      // 一份文件约 1.5–2 千字符
      const files = [];
      for (let i = 0; i < 4; i++) files.push(writeFile('b' + i + '.md', 1000));
      for (const f of files) await readParsedCached(f);
      ok(contentCache.size > 0 && contentCache.size < 4,
        '字符预算内只留得下最近几个（条数上限还很宽）',
        JSON.stringify({ size: contentCache.size, chars: cacheStats.cachedChars }));
      ok(cacheStats.cachedChars <= 4000, '淘汰后占用压回预算内', String(cacheStats.cachedChars));
      ok(!contentCache.has(files[0]), '最久未访问的先被淘汰');
      ok(contentCache.has(files[files.length - 1]), '最近访问的留下');

      // 反向：条数上限很大时，只有字符闸能解释这次淘汰
      const naiveWouldKeep = files.length <= cacheStats.CONTENT_CACHE_MAX;
      ok(naiveWouldKeep === true,
        '反向对照：只看条数的实现会把这 4 个全留下，所以上面那条淘汰是字符闸干的');
      resetCache();
    }

    // ---------- 三、单个文件就超过预算时不缓存它 ----------
    {
      resetCache();
      cacheStats.CONTENT_CACHE_MAX = 100000;
      cacheStats.CONTENT_CACHE_MAX_CHARS = 2000;
      const huge = writeFile('huge.md', 20000);
      const entry = await readParsedCached(huge);
      ok(!!entry && entry.content.length > 20000, '超大文件仍然能读出内容（返回给调用方）');
      ok(contentCache.size === 0, '但它不进缓存（单个文件超过整个预算）',
        'size=' + contentCache.size);
      ok(cacheStats.cachedChars === 0, '占用账上没有它', String(cacheStats.cachedChars));
      // 再读一次仍是未命中——这是刻意的，不是 bug
      const before = cacheStats.cacheMisses;
      await readParsedCached(huge);
      ok(cacheStats.cacheMisses === before + 1, '超大文件每次都算未命中（不占缓存）');
      resetCache();
    }

    // ---------- 四、两道闸同时生效：条数更紧时按条数淘汰 ----------
    {
      resetCache();
      cacheStats.CONTENT_CACHE_MAX = 2;
      cacheStats.CONTENT_CACHE_MAX_CHARS = 32 * 1024 * 1024;
      const files = [];
      for (let i = 0; i < 3; i++) files.push(writeFile('c' + i + '.md', 100));
      for (const f of files) await readParsedCached(f);
      ok(contentCache.size === 2, '条数更紧时按条数淘汰', String(contentCache.size));
      ok(!contentCache.has(files[0]) && contentCache.has(files[2]), '留下的仍是最新的两个');
      resetCache();
    }

    // ---------- 五、反向对照：朴素实现（只看条数）必须红 ----------
    // 用同一批断言跑一个只判条数的实现，要求"占用压回预算内"这条必然失败。
    {
      const naive = (() => {
        const cache = new Map();
        let chars = 0;
        return {
          async read(p) {
            const content = await fs.promises.readFile(p, 'utf8');
            const bodyRaw = FRONTMATTER.strip(content);
            const entry = { content, bodyRaw, bodyLower: bodyRaw.toLowerCase() };
            cache.set(p, entry);
            chars += entry.content.length + entry.bodyRaw.length + entry.bodyLower.length;
            // 朴素实现：只按条数淘汰，不看占用
            while (cache.size > 2) {
              const oldest = cache.keys().next().value;
              const gone = cache.get(oldest);
              cache.delete(oldest);
              chars -= gone.content.length + gone.bodyRaw.length + gone.bodyLower.length;
            }
            return entry;
          },
          get size() { return cache.size; },
          get chars() { return chars; }
        };
      })();

      resetCache();
      const files = [];
      for (let i = 0; i < 4; i++) files.push(writeFile('d' + i + '.md', 1000));
      for (const f of files) await naive.read(f);
      const budget = 4000;
      ok(naive.chars > budget,
        '反向对照：只看条数的实现占用会超预算（这就是真实实现多出来的那道闸）',
        JSON.stringify({ naiveChars: naive.chars, budget, size: naive.size }));
      // 真实实现在同样的输入下不超预算。这里不断言"条数闸先触发"——实测是字符闸
      // 更早生效（一份 1000 字符正文的条目账面约 3000 字符，条数上限 2 时两份就
      // 超了 4000），写死哪道闸先动只会让这条断言跟着实现细节改。
      // 要卡住的是结果：账不超预算，且账面与实物一致。
      resetCache();
      cacheStats.CONTENT_CACHE_MAX = 2;                 // 与朴素实现同样的条数上限
      cacheStats.CONTENT_CACHE_MAX_CHARS = budget;
      for (const f of files) await readParsedCached(f);
      const realSum = Array.from(contentCache.values())
        .reduce((n, e) => n + e.content.length + e.bodyRaw.length + e.bodyLower.length, 0);
      ok(cacheStats.cachedChars <= budget && cacheStats.cachedChars === realSum,
        '反向对照的对照面：同一批输入下真实实现占用在预算内且账实相符',
        JSON.stringify({ realChars: cacheStats.cachedChars, realSum, budget, size: contentCache.size }));
      resetCache();
    }
  } finally {
    cacheStats.CONTENT_CACHE_MAX = savedMax;
    cacheStats.CONTENT_CACHE_MAX_CHARS = savedChars;
    for (const key of Array.from(contentCache.keys())) dropFromCache(key);
    cacheStats.cachedChars = 0;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也不影响结论 */ }
  }

  console.log(failures ? `[test:cache-budget] ${failures} 条失败` : '[test:cache-budget] 通过');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('[test:cache-budget] 运行出错：', e);
  process.exit(1);
});
