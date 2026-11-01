// MCP server 的 prompts 能力：把库里的提示词暴露成客户端里的斜杠命令。
//
// tools 是"模型按需来查"，prompts 是"用户点名来用"——Claude Code 等客户端会把
// prompts/list 的每一项做成一个斜杠命令，用户选中后客户端调 prompts/get 拿到
// 填好参数的正文，直接作为一条用户消息发出去。省掉的是"打开应用 → 复制 → 粘贴
// → 手改占位符"那一轮，和 copyContent() 做的是同一件事，所以处理顺序也照抄它：
// 剥 frontmatter → 展开 {{include:}} → 按占位符填值。
//
// 仍然只读：这里只读正文、拼字符串，不写任何文件。
//
// 三件需要自己设计的事，规则都写在对应函数上方：
//   1. prompt 的 name（assignPromptNames）：库里大量中文文件名，斜杠命令不宜带
//      空格和斜杠，还要稳定、唯一。
//   2. argument 的 name（argumentsFor）：占位符原文多是中文提示语，要变成合法、
//      稳定的标识符。
//   3. snippets 的取舍（isListedPrompt）。
//
// 占位符只经 src/placeholders.js 的 extract / fill 使用，这里不写任何占位符正则：
// 判定规则（链接、行内代码、围栏块、勾选框都不算占位符）只能有一份，抄一份的话
// 两边迟早对不上——斜杠命令列出来的参数和应用里填充面板上的不是同一批。
const crypto = require('crypto');
const path = require('path');

// snippets/ 下是给 {{include:}} 拼装用的片段（角色设定、技术栈约束、规则），
// 单独拿出来不是一条完整的提示词，做成斜杠命令只会把命令列表淹掉。
// 它们仍然能被 prompts/ 下的提示词 include 进来，也仍然能用 prompts_get 工具读。
const SNIPPET_STAGE = 'snippets';
// name 的长度上限（按码点算）。超长的路径截断后再走撞名处理，不会因此重名。
const MAX_NAME_CHARS = 64;
// argument name 里净化出来的那段后缀的长度上限。
const MAX_ARG_SLUG_CHARS = 24;
// 撞名时追加的路径哈希长度。8 位十六进制在一个提示词库的规模下够用；
// 万一同一组里还撞，退到完整的 40 位（见 assignPromptNames）。
const NAME_HASH_CHARS = 8;
// prompts/list 一页的条目上限，和 tools 的列表上限一致。
const PAGE_SIZE = 200;

// JSON-RPC 错误。server.js 认 rpcCode：带它的按协议错误回，不带的当内部错误（-32603）。
function rpcError(code, message) {
  const e = new Error(message);
  e.rpcCode = code;
  return e;
}

// 只有 prompts/ 下、不在 snippets/ 里的 .md 才列成斜杠命令。
// 直接放在 prompts/ 根下的文件（没有阶段目录）也算。
function isListedPrompt(rel) {
  const segs = String(rel || '').split('/');
  if (segs[0] !== 'prompts' || segs.length < 2) return false;
  if (segs.length > 2 && segs[1] === SNIPPET_STAGE) return false;
  return segs[segs.length - 1].toLowerCase().endsWith('.md');
}

// 一个 rel 的"自然名"：去掉 prompts/ 前缀和 .md，NFC 归一，ASCII 字母转小写，
// 任何一段非字母非数字的字符（空格、斜杠、标点、下划线）合成一个 -，首尾的 - 去掉。
//   prompts/code-generation/功能实现.md -> code-generation-功能实现
//   prompts/project-init/需求分析.md    -> project-init-需求分析
//
// 为什么保留中文而不是转成拼音或哈希：斜杠命令是给人选的，`/…需求分析` 一眼能认，
// `/p-3f9a1c` 认不出来；Unicode 字母数字在主流客户端里都能当命令名用。
// 为什么用路径而不用 frontmatter 的 title：title 可以随手改、可以重复，路径在库里
// 本来就唯一，而且带上阶段目录之后跨阶段同名的文件天然分得开。
// 为什么只转 ASCII 小写：Windows 上只改大小写的重命名不该让命令名变；而对其他
// 文字做大小写折叠没有必要，还会碰到一个字符变两个码点的特例。
// NFC 归一是因为 macOS 的文件名是 NFD：同一个"é"两种编码，命令名不能跟着平台变。
function naturalName(rel) {
  let s = String(rel || '').replace(/^prompts\//, '').replace(/\.md$/i, '');
  s = s.normalize('NFC').replace(/[A-Z]/g, c => c.toLowerCase());
  s = s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  const chars = Array.from(s);
  if (chars.length > MAX_NAME_CHARS) s = chars.slice(0, MAX_NAME_CHARS).join('').replace(/-+$/, '');
  return s || 'prompt';
}

function pathHash(rel, len) {
  return crypto.createHash('sha1').update(String(rel), 'utf8').digest('hex').slice(0, len);
}

// 给一批 rel 分配 name，返回 Map<rel, name>。
//
// 撞名规则：自然名相同的一组（比如 `a b.md` 和 `a-b.md`、`A.md` 和 `a.md`，或者
// 截断到 64 字之后才相同的两条长路径）**全部**改成 `自然名--路径哈希前 8 位`，
// 而不是"第一个保留原名、后面的加后缀"。后者取决于目录遍历顺序，新加一个文件
// 可能让原来那个改名，而谁算"第一个"在不同机器上都不一定一样。
// 全组加哈希的代价是：撞名组里原来那条的命令名会变一次（新文件加进来的那一刻）；
// 换来的是 name 只由 rel 和"库里有没有和它同自然名的文件"决定，与顺序无关。
//
// `--` 作分隔符是因为自然名里不可能出现连续两个 -（任何非字母数字的连续段都被
// 合成了一个 -），所以加了后缀的名字永远不会和另一个文件的自然名撞上。
function assignPromptNames(rels) {
  const groups = new Map();
  for (const rel of rels) {
    const base = naturalName(rel);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(rel);
  }
  const out = new Map();
  for (const [base, members] of groups) {
    if (members.length === 1) { out.set(members[0], base); continue; }
    const short = members.map(rel => base + '--' + pathHash(rel, NAME_HASH_CHARS));
    // 同组里哈希前缀也撞了（概率可以忽略，但不能因此出两个同名命令）：整组换完整哈希
    const clash = new Set(short).size !== short.length;
    members.forEach((rel, i) => out.set(rel, clash ? base + '--' + pathHash(rel, 40) : short[i]));
  }
  return out;
}

// 把 PLACEHOLDERS.extract 的结果变成 MCP 的 arguments 声明，同时给出
// argument name -> token 的映射（prompts/get 用它把传进来的值交给 fill）。
//
// name 规则：`arg<序号>`，提示语里有 ASCII 字母数字时再接 `_<净化后的小写片段>`。
//   [在此描述要实现的功能]          -> arg2
//   [如 React + TypeScript + Vite] -> arg1_react_typescript_vite
// 序号按占位符在（展开 include 之后的）正文里首次出现的顺序，从 1 开始。
//
// 为什么要序号：占位符原文多是中文提示语，纯净化之后大多是空串，没法当名字；
// 序号保证唯一、非空、是合法标识符（字母开头、只有 [a-z0-9_]）。
// 为什么还接一段净化片段：有英文提示的占位符能让用户在客户端里一眼认出是哪个空。
// 稳定性的边界：同一篇正文的 name 永远一样；改了正文里占位符的顺序或增删占位符，
// 后面的序号会跟着变——这和"占位符就是正文的一部分"是同一个事实，没法既跟着
// 正文走又与正文无关。
//
// required 一律 false：没填的占位符原样保留（fill 的语义），用户可能故意留空，
// 标成必填会逼客户端对每个空都追问一遍。
function argumentsFor(tokens) {
  const args = [];
  const tokenOf = new Map();
  (tokens || []).forEach((t, i) => {
    let slug = String(t.hint || '').normalize('NFKC').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (slug.length > MAX_ARG_SLUG_CHARS) slug = slug.slice(0, MAX_ARG_SLUG_CHARS).replace(/_+$/, '');
    const name = 'arg' + (i + 1) + (slug ? '_' + slug : '');
    args.push({ name, description: String(t.hint || ''), required: false });
    tokenOf.set(name, t.token);
  });
  return { args, tokenOf };
}

// 注入的 deps 见 mcp/server.js：
//   { library, dataRoot, placeholders, includes, safeLibraryRel, truncateBody }
function createPromptHandlers(deps) {
  const { library, dataRoot, placeholders, includes, safeLibraryRel, truncateBody } = deps;

  // 库里当前可列出的提示词，按元数据列表的顺序（目录遍历顺序，稳定），带上 name。
  // 每次请求都现算：name 的撞名处理依赖全库，缓存起来的话外部新加的文件不会被看到。
  const loadIndex = async () => {
    const meta = await library.getMetaList(false);
    const known = new Set(meta.map(m => m.rel));
    const items = meta.filter(m => m.top === 'prompts' && isListedPrompt(m.rel));
    const names = assignPromptNames(items.map(m => m.rel));
    return { known, items: items.map(m => ({ item: m, name: names.get(m.rel) })) };
  };

  // 正文 = 去掉 frontmatter + 展开 include。
  // include 的解析器和 prompts_get 工具是同一组闸：safeLibraryRel（只放行三个
  // 内容目录下的 .md）+ 必须在元数据列表里。任何一道不过就当"文件不存在"，
  // includes.js 会在原位留一行 include error 注释——比静默吞掉更好排查。
  const expandedBody = async (rel, known) => {
    const entry = await library.readParsedCached(path.join(dataRoot, rel));
    return includes.resolveAsync(entry.bodyRaw, async (r) => {
      const safe = safeLibraryRel(r);
      if (!safe || !known.has(safe)) return null;
      const inc = await library.readParsedCached(path.join(dataRoot, safe));
      return inc.content;
    });
  };

  const titleOf = (item) => (item.meta && item.meta.title) || item.name.replace(/\.md$/i, '');

  return {
    async list(params) {
      const p = params || {};
      let offset = 0;
      if (p.cursor !== undefined && p.cursor !== null) {
        if (typeof p.cursor !== 'string' || !/^\d+$/.test(p.cursor)) throw rpcError(-32602, 'cursor 无效');
        offset = Number(p.cursor);
      }
      const { known, items } = await loadIndex();
      const page = items.slice(offset, offset + PAGE_SIZE);
      const prompts = [];
      for (const { item, name } of page) {
        // 参数要从展开 include 之后的正文里取：片段里的占位符也是这条提示词的空，
        // 应用里复制时的填充面板也是这么算的（copyContent 先展开再 extract）。
        const body = await expandedBody(item.rel, known);
        const { args } = argumentsFor(placeholders.extract(body));
        const entry = { name, title: titleOf(item), arguments: args };
        if (item.meta && item.meta.description) entry.description = String(item.meta.description);
        prompts.push(entry);
      }
      const result = { prompts };
      if (offset + PAGE_SIZE < items.length) result.nextCursor = String(offset + PAGE_SIZE);
      return result;
    },

    async get(params) {
      const p = params || {};
      if (typeof p.name !== 'string' || !p.name) throw rpcError(-32602, 'name 必须是非空字符串');
      const given = p.arguments == null ? {} : p.arguments;
      if (typeof given !== 'object' || Array.isArray(given)) throw rpcError(-32602, 'arguments 必须是对象');
      const { known, items } = await loadIndex();
      const wanted = p.name.normalize('NFC');
      const hit = items.find(x => x.name === wanted);
      if (!hit) throw rpcError(-32602, '未知的 prompt: ' + p.name);

      const body = await expandedBody(hit.item.rel, known);
      const { args, tokenOf } = argumentsFor(placeholders.extract(body));
      const values = {};
      for (const [k, v] of Object.entries(given)) {
        // 认不出的参数名报错而不是忽略：正文改过之后客户端拿着旧参数名来调，
        // 忽略的话用户以为填进去了，发出去的却是原样的占位符。
        if (!tokenOf.has(k)) {
          throw rpcError(-32602, '未知的参数: ' + k + '（可用：' + (args.map(a => a.name).join(', ') || '无') + '）');
        }
        // MCP 规定参数值是字符串。数字之类的不替用户转：转出来的 "[object Object]"
        // 会被原样填进提示词。
        if (typeof v !== 'string') throw rpcError(-32602, '参数 ' + k + ' 必须是字符串');
        values[tokenOf.get(k)] = v;
      }
      const filled = placeholders.fill(body, values);
      // 上限沿用 prompts_get 工具的 MAX_BODY_CHARS。这里没有 truncated 字段可放，
      // 所以截断说明写进正文末尾，并且算在上限以内——静默截断会让模型拿半截当全部。
      const t = truncateBody(filled);
      let text = t.body;
      if (t.truncated) {
        const note = '\n\n[正文超长已截断：共 ' + t.totalChars + ' 字符，此处只给出前一部分]';
        text = t.body.slice(0, t.body.length - note.length) + note;
      }
      const meta = hit.item.meta || {};
      return {
        description: String(meta.description || titleOf(hit.item)),
        messages: [{ role: 'user', content: { type: 'text', text } }]
      };
    }
  };
}

module.exports = {
  createPromptHandlers,
  assignPromptNames,
  naturalName,
  argumentsFor,
  isListedPrompt,
  rpcError,
  SNIPPET_STAGE,
  PAGE_SIZE
};
