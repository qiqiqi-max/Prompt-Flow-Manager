// 内容库的数据层：正文缓存、元数据列表、全文搜索。
//
// 为什么单独一个文件：这三件事是"提示词库"本身的能力，和 Electron 无关——
// 它们只依赖 DATA_ROOT 下的三个目录和 frontmatter 解析。此前它们长在
// electron-main.js 里，于是任何别的入口（只读的 MCP server、命令行工具、
// 裸 node 测试）想复用只能先把主进程整个 require 起来，而那会拉起 electron。
//
// 这里刻意不 require('electron')，也不读 app.getPath：DATA_ROOT 由调用方传进来，
// 和 lib/logger.js / lib/diagnostics.js 的约定一致（两个根目录的判断只允许存在
// 一份，见 electron-main.js 里那段说明）。
const fsPromises = require('fs/promises');
const path = require('path');
// 默认解析器。createLibrary 要求调用方显式传（签名上就看得见"这个模块不认识
// frontmatter 细节"），但直接 require 本模块的调用点也很多——比如主进程里
// 那几个只要正文的地方。它们用同一份实现兜底：src/frontmatter.js 本来就是
// 主进程与渲染进程共用的那一份，作默认值不会引入第二套解析规则。
const FRONTMATTER = require('../src/frontmatter.js');

// 缓存的计数器与容量上限。压测要把计数清零再读回来，缓存淘汰的自检要临时把
// 上限调小——那两件事都在 lib/selftest.js 里，而递增/判断上限的热路径在这里。
// 所以这四项必须是**同一个对象上的字段**并原样导出，不能按值传：那样自检清零
// 写的是自己那份副本，热路径继续加在原来的字段上，压测报出来的永远是
// 0 次读、0 命中，而且一切看着都正常。
const cacheStats = {
  // 读文件次数。搜索是唯一随库规模线性变差的操作，压测时用它量化 I/O。
  fileReadCount: 0,
  cacheHits: 0,
  cacheMisses: 0,
  // 缓存上限。原先没有：dropFromCache 只在删除/移动/保存时清对应条目，
  // 从没被删过、只是不再被访问的文件会永久留在 Map 里，而每条都存了正文 +
  // 一份全小写副本（约 2 倍文件大小）。长会话里反复浏览/搜索一个大库，常驻内存
  // 只增不减。按 LRU 封顶：命中时把条目挪到队尾，插入后从队首淘汰最久未用的。
  // 取 5000：远高于注释里 1000 条的性能基准，正常库一次搜索遍历不会触发淘汰
  // （否则会拉低命中率）；真超了也只是退化成重读，正确性不受影响。
  // 可写是为了让自检能临时调小，不必造几千个文件来验证淘汰。
  CONTENT_CACHE_MAX: 5000
};

// Map 保持插入顺序，所以队首就是最久未 touch 的条目（上限见 cacheStats）。
// fullPath -> { mtimeMs, size, content, meta, bodyRaw, bodyLower }
const contentCache = new Map();

const EMPTY_ENTRY = { content: '', meta: {}, bodyRaw: '', bodyLower: '' };

function countedReadFile(fullPath) {
  cacheStats.fileReadCount++;
  return fsPromises.readFile(fullPath, 'utf8');
}

// 按 (mtime, size) 做缓存：每次仍然 stat（很便宜），只重读真正变过的文件。
// 所以外部编辑器改的文件也能被发现，不会读到旧内容。
// 已知边界：同一个 mtime 刻度内把文件改成同样大小会命中旧缓存，概率极低且两个
// 维度同时相等才会发生，代价只是搜索结果延迟一次刷新。
// 连 frontmatter 的解析结果一起缓存：元数据列表每次都要对全库解析一遍，
// 在 1000 条规模下这部分和 stat 一样构成主要耗时。
// 搜索用的派生字段（去掉 frontmatter 的正文 + 其小写形式）同样缓存：
// 否则用户每敲一个字符，全文搜索就要对全库重做一次 stripFrontmatter 正则和
// toLowerCase 大字符串分配——1000 条规模下这是搜索剩余耗时的绝大部分，
// 而它们只随文件内容变化，和查询词无关，完全可以复用。
async function readParsedCached(fullPath, stripFrontmatter, parseFrontmatter) {
  // 兜底成共用的那份实现，见文件头的说明。缺了它会在调用点上以
  // "stripFrontmatter is not a function" 的形式炸出来——而那个调用点是
  // 工作流引用扫描，报出来的位置和真正的原因隔着一层。
  const strip = typeof stripFrontmatter === 'function' ? stripFrontmatter : (c) => FRONTMATTER.strip(c);
  const parse = typeof parseFrontmatter === 'function' ? parseFrontmatter : (c) => FRONTMATTER.parse(c);
  let st;
  try { st = await fsPromises.stat(fullPath); } catch { return EMPTY_ENTRY; }
  const hit = contentCache.get(fullPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    cacheStats.cacheHits++;
    // 命中即 touch：删了重插挪到队尾，这样淘汰时队首永远是最久未访问的那条。
    contentCache.delete(fullPath);
    contentCache.set(fullPath, hit);
    return hit;
  }
  cacheStats.cacheMisses++;
  let content = '';
  try { content = await countedReadFile(fullPath); } catch { return EMPTY_ENTRY; }
  const bodyRaw = strip(content);
  const entry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    content,
    meta: parse(content).meta,
    bodyRaw,
    bodyLower: bodyRaw.toLowerCase()
  };
  // 先 delete 再 set：过期条目重读后要挪到队尾，否则同 key 的 set 只更新值不改
  // 顺序，这条刚刷新却还排在队首，下一次淘汰就会把它当成最旧的删掉。
  contentCache.delete(fullPath);
  contentCache.set(fullPath, entry);
  // 超限则从队首（最久未用）逐个淘汰
  while (contentCache.size > cacheStats.CONTENT_CACHE_MAX) {
    const oldest = contentCache.keys().next().value;
    if (oldest === undefined) break;
    contentCache.delete(oldest);
  }
  return entry;
}

// 文件被删除/移动后清掉对应缓存，避免 Map 无限增长。
// 只从 Map 里删（不动 cacheStats 计数）。调用方另外要作废的东西——比如工作流
// 引用索引——由 electron-main.js 包一层处理：那是主进程的状态，不属于数据层。
function dropFromCache(fullPath) {
  contentCache.delete(fullPath);
}

// 元数据列表。includeContent=true 时把已经读到的正文一并带出来：
// 搜索需要正文，如果不带出去，全文搜索就得把每个文件再读一遍（2N 次 I/O）。
// 默认不带：结果要经 IPC 序列化给渲染进程，正文会白白拷一份。
async function getMetaList({ topDirs, parseFrontmatter, stripFrontmatter, includeContent = false }) {
  const out = [];
  for (const top of ['prompts', 'workflows', 'templates']) {
    const rootDir = topDirs[top];
    // 目录内并发。缓存命中时每个文件仍要 stat 一次做失效判断，
    // 串行 await 让整库 stat 排成一条链——1000 文件实测约 180ms，
    // 并发后降到 25ms 量级。字符串处理只占个位数毫秒，不是瓶颈。
    // 结果按原序拼装，保持输出顺序稳定。
    const walk = async (dir, baseRel) => {
      let entries;
      try { entries = await fsPromises.readdir(dir, { withFileTypes: true }); } catch { return; }
      const slots = await Promise.all(entries.map(async (e) => {
        if (e.name.startsWith('.')) return null;
        const rel = `${baseRel}/${e.name}`;
        if (e.isDirectory()) return { subdir: path.join(dir, e.name), rel };
        if (!e.name.toLowerCase().endsWith('.md')) return null;
        const entry = await readParsedCached(path.join(dir, e.name), stripFrontmatter, parseFrontmatter);
        let stage = null;
        if (top === 'prompts') {
          const segs = rel.split('/');
          stage = segs.length > 2 ? segs[1] : null;
        }
        const item = { rel, name: e.name, meta: entry.meta, stage, top };
        // 搜索走 includeContent=true，直接把缓存里的派生字段带过去（不再重算）。
        // 这些字段只在进程内使用，不经 IPC 发给渲染进程。
        if (includeContent) {
          item.content = entry.content;
          item.bodyRaw = entry.bodyRaw;
          item.bodyLower = entry.bodyLower;
        }
        return { item };
      }));
      // 子目录递归留在串行段：并发已经在每一层内部生效，
      // 再叠一层并发会把打开的文件句柄数放大到不可控。
      for (const slot of slots) {
        if (!slot) continue;
        if (slot.item) out.push(slot.item);
        else if (slot.subdir) await walk(slot.subdir, slot.rel);
      }
    };
    await walk(rootDir, top);
  }
  return out;
}

// 全文搜索。命中越多分的段越高（标题 > 标签/标题 > 正文），同段按出现位置。
async function searchAll(library, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  // 复用元数据列表已经读到的正文，不再逐个重读（原先是 2N 次 I/O）
  const meta = await library.getMetaList(true);
  const results = [];
  for (const item of meta) {
    const titleLower = (item.meta.title || item.name).toLowerCase();
    const tagsLower = Array.isArray(item.meta.tags) ? item.meta.tags.map(x => String(x).toLowerCase()) : [];
    // bodyRaw / bodyLower 来自正文缓存，不在这里重算——每敲一个字符重做全库的
    // 正则+toLowerCase 是搜索的主要开销。
    const bodyRaw = item.bodyRaw || '';
    const bodyLower = item.bodyLower || '';

    let allHit = true;
    let allInTitle = true;
    let allInTagsOrTitle = true;
    let firstBodyIdx = -1;

    for (const token of tokens) {
      const nameHit = titleLower.includes(token);
      const tagHit = tagsLower.some(x => x.includes(token));
      const bIdx = bodyLower.indexOf(token);
      const bodyHit = bIdx >= 0;

      if (!nameHit) allInTitle = false;
      if (!nameHit && !tagHit) allInTagsOrTitle = false;
      if (bodyHit && (firstBodyIdx === -1 || bIdx < firstBodyIdx)) {
        firstBodyIdx = bIdx;
      }
      if (!nameHit && !tagHit && !bodyHit) {
        allHit = false;
        break;
      }
    }
    if (!allHit) continue;

    let rank = 1, snippet = '';
    if (allInTitle) rank = 3;
    else if (allInTagsOrTitle) rank = 2;

    if (firstBodyIdx >= 0) {
      const start = Math.max(0, firstBodyIdx - 30);
      const end = Math.min(bodyRaw.length, firstBodyIdx + 80);
      snippet = (start > 0 ? '…' : '') + bodyRaw.slice(start, end) + (end < bodyRaw.length ? '…' : '');
    }
    results.push({ rel: item.rel, name: item.meta.title || item.name, stage: item.stage, projectType: item.meta.projectType, rank, snippet });
  }
  results.sort((a, b) => b.rank - a.rank);
  return results.slice(0, 60);
}

// 组装一个绑定好目录与解析器的数据层。
//
// parseFrontmatter / stripFrontmatter 由调用方注入（src/frontmatter.js 的两个
// 函数）：主进程和别的入口用的是同一份实现，这里再 require 一次也不会不一致，
// 但显式注入让"这个模块不认识 frontmatter 细节"这件事在签名上就看得见。
//
// 缓存与计数是**模块级**的，不是每个实例一份：lib/selftest.js 拿着 cacheStats
// 和 readParsedCached 两个引用去清零/调上限/验证 LRU 淘汰，而热路径用的必须是
// 同一个对象，否则自检改的是自己那份副本、热路径继续加在别的字段上，
// 压测报出来永远是 0 次读、0 命中，而且一切看着都正常（见 cacheStats 上方注释）。
// 所以这里只绑定目录与解析器，缓存本身不复制。
function createLibrary({ dataRoot, parseFrontmatter, stripFrontmatter }) {
  if (!dataRoot) throw new Error('createLibrary requires dataRoot');
  if (typeof parseFrontmatter !== 'function' || typeof stripFrontmatter !== 'function') {
    throw new Error('createLibrary requires parseFrontmatter and stripFrontmatter');
  }
  const topDirs = {
    prompts: path.join(dataRoot, 'prompts'),
    workflows: path.join(dataRoot, 'workflows'),
    templates: path.join(dataRoot, 'templates')
  };
  const library = {
    dataRoot,
    topDirs,
    readParsedCached: (fullPath) => readParsedCached(fullPath, stripFrontmatter, parseFrontmatter),
    dropFromCache,
    getMetaList: (includeContent) => getMetaList({ topDirs, parseFrontmatter, stripFrontmatter, includeContent }),
    search: (query) => searchAll(library, query)
  };
  return library;
}

module.exports = { createLibrary, cacheStats, contentCache, readParsedCached, dropFromCache, getMetaList, searchAll };
