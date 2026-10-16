// MCP server 的工具定义与实现。
//
// 全部**只读**：列库、搜、读、看工作流图、查引用关系。没有任何写入工具。
//
// 为什么是只读，不是"暂时只做了读"：写操作要接的是一整套一致性机制——写队列、
// 版本快照、回收站、导入事务、锁定文件、引用同步。那是应用本体（主进程）的职责，
// 一个 stdio 子进程没有这些上下文，硬写会绕过它们的全部保证。而只读的价值本来就
// 成立：让 AI 工具按需查本地提示词库，不用用户先复制粘贴一轮。
//
// 边界上的两个硬约束：
//   1. 只读打开的路径都必须落在 prompts/ workflows/ templates/ 下（safeLibraryRel）。
//      这里是"库"这一侧的 read-file 白名单，和主进程那套是同一个道理：
//      不带这道检查，一个 ../../config.json 就能把用户设置读出来给模型。
//   2. 返回正文有长度上限。提示词库是用户的资产，一条几万字的正文塞进模型上下文
//      既没用又贵，而且会让调用方以为"拿到了全部"。
const path = require('path');

// 一次返回的正文上限。超出时截断并在结果里说明截断位置——静默截断比拒绝更坏：
// 模型会拿半截正文当完整内容用。
const MAX_BODY_CHARS = 24000;
// 列表类工具一次返回的条目上限（调用方可以用 limit 调小）
const MAX_LIST_ITEMS = 200;

function safeLibraryRel(rel) {
  const cleaned = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0')) return null;
  const segs = cleaned.split('/');
  if (segs.length < 2) return null;
  const top = segs[0];
  if (!['prompts', 'workflows', 'templates'].includes(top)) return null;
  // 任何一段以 . 开头都拒绝：.. 逃逸、.versions、.trash 都在这条上
  for (const s of segs) if (s.startsWith('.')) return null;
  if (!segs[segs.length - 1].toLowerCase().endsWith('.md')) return null;
  return segs.join('/');
}

function truncateBody(body) {
  const text = String(body == null ? '' : body);
  if (text.length <= MAX_BODY_CHARS) return { body: text, truncated: false };
  return { body: text.slice(0, MAX_BODY_CHARS), truncated: true, totalChars: text.length };
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function fail(message) {
  // isError 让调用方（模型）知道自己拿到的是错误而不是数据。
  // 消息里不带绝对路径：错误文本会进模型上下文，磁盘布局没必要给出去。
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// 工具清单。description 要写清"什么时候用我"，因为模型只凭它挑工具。
function toolDefinitions() {
  return [
    {
      name: 'library_overview',
      description: '概览本地提示词库：三个顶层目录各有几个文件、每个阶段有几个提示词、工程类型与标签清单、工作流数量。想知道"库里有什么"时先用它。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'prompts_list',
      description: '列出提示词（不含正文，只给标题/阶段/工程类型/标签/描述）。可按阶段或工程类型过滤。要正文用 prompts_get。',
      inputSchema: {
        type: 'object',
        properties: {
          stage: { type: 'string', description: '阶段目录名，如 project-init、code-generation、code-review、testing、deployment' },
          projectType: { type: 'string', description: '工程类型，如 前端项目' },
          limit: { type: 'number', description: '最多返回多少条，默认 50，上限 ' + MAX_LIST_ITEMS }
        },
        additionalProperties: false
      }
    },
    {
      name: 'prompts_search',
      description: '按关键词检索提示词全文（标题、标签、正文都算），返回命中片段与相关度。找"哪条提示词讲过某件事"时用它。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，多个词用空格分隔（全部命中才算匹配）' },
          limit: { type: 'number', description: '最多返回多少条，默认 20' }
        },
        required: ['query'],
        additionalProperties: false
      }
    },
    {
      name: 'prompts_get',
      description: '读一条提示词的元数据与正文。正文超长时会截断并注明。',
      inputSchema: {
        type: 'object',
        properties: { rel: { type: 'string', description: '库内相对路径，如 prompts/project-init/需求分析.md' } },
        required: ['rel'],
        additionalProperties: false
      }
    },
    {
      name: 'workflows_list',
      description: '列出工作流及其步骤图：每步的 id、标签、引用的提示词、后继步骤，以及从入口走不到的步骤。想把一组提示词串起来执行时先看它。',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: '最多返回多少个工作流，默认 20' } },
        additionalProperties: false
      }
    },
    {
      name: 'prompts_references',
      description: '查一条提示词被哪些工作流引用；不传 rel 时给全库的悬空引用体检（引用指向已经不在的文件）。改文件名之前用它可以知道会影响什么。',
      inputSchema: {
        type: 'object',
        properties: { rel: { type: 'string', description: '可选。库内相对路径；省略则只做悬空引用体检' } },
        additionalProperties: false
      }
    }
  ];
}

// 每个工具的调用实现。注入的 deps 见 mcp/server.js：
//   { library, workflowIndex, dataRoot, parseFrontmatter, flowGraph }
function createHandlers(deps) {
  const { library, workflowIndex, dataRoot, parseFrontmatter, flowGraph } = deps;

  const brief = (item) => ({
    rel: item.rel,
    title: (item.meta && item.meta.title) || item.name,
    stage: item.stage,
    projectType: (item.meta && item.meta.projectType) || null,
    tags: (item.meta && item.meta.tags) || [],
    description: (item.meta && item.meta.description) || null,
    updatedAt: (item.meta && item.meta.updatedAt) || null
  });

  const loadWorkflowIndex = async () => {
    const list = await workflowIndex.collectWorkflows(dataRoot, (rel) => library.readParsedCached(path.join(dataRoot, rel)));
    return workflowIndex.buildIndex(list);
  };

  return {
    async library_overview() {
      const meta = await library.getMetaList(false);
      const byTop = {};
      const stages = {};
      const projectTypes = new Set();
      const tags = new Set();
      for (const item of meta) {
        byTop[item.top] = (byTop[item.top] || 0) + 1;
        if (item.top === 'prompts' && item.stage) stages[item.stage] = (stages[item.stage] || 0) + 1;
        if (item.meta && item.meta.projectType) projectTypes.add(item.meta.projectType);
        for (const tag of (item.meta && item.meta.tags) || []) tags.add(tag);
      }
      return ok({
        counts: byTop,
        stages,
        projectTypes: Array.from(projectTypes).sort(),
        tags: Array.from(tags).sort().slice(0, 100),
        tagCount: tags.size
      });
    },

    async prompts_list(args) {
      const limit = Math.min(Number(args.limit) > 0 ? Number(args.limit) : 50, MAX_LIST_ITEMS);
      const meta = await library.getMetaList(false);
      let items = meta.filter(m => m.top === 'prompts');
      if (args.stage) items = items.filter(m => m.stage === args.stage);
      if (args.projectType) items = items.filter(m => m.meta && m.meta.projectType === args.projectType);
      return ok({ total: items.length, returned: Math.min(items.length, limit), prompts: items.slice(0, limit).map(brief) });
    },

    async prompts_search(args) {
      const limit = Math.min(Number(args.limit) > 0 ? Number(args.limit) : 20, MAX_LIST_ITEMS);
      const results = await library.search(String(args.query || ''));
      return ok({
        query: String(args.query || ''),
        total: results.length,
        returned: Math.min(results.length, limit),
        results: results.slice(0, limit)
      });
    },

    async prompts_get(args) {
      const rel = safeLibraryRel(args.rel);
      if (!rel) return fail('rel 必须是 prompts/ templates/ 下的 .md 相对路径（不接受绝对路径或 ..）');
      const meta = await library.getMetaList(false);
      const item = meta.find(m => m.rel === rel);
      if (!item) return fail('库里没有这个文件：' + rel);
      const entry = await library.readParsedCached(path.join(dataRoot, rel));
      const { body, truncated, totalChars } = truncateBody(entry.bodyRaw);
      return ok({
        rel,
        title: item.meta.title || item.name,
        stage: item.stage,
        projectType: item.meta.projectType || null,
        tags: item.meta.tags || [],
        description: item.meta.description || null,
        version: item.meta.version == null ? null : item.meta.version,
        updatedAt: item.meta.updatedAt || null,
        body,
        truncated,
        totalChars: truncated ? totalChars : body.length
      });
    },

    async workflows_list(args) {
      const limit = Math.min(Number(args.limit) > 0 ? Number(args.limit) : 20, MAX_LIST_ITEMS);
      const idx = await loadWorkflowIndex();
      // 步骤图从正文解析：索引里只有引用关系，没有步骤语义
      const out = [];
      for (const wf of idx.workflows.slice(0, limit)) {
        const entry = await library.readParsedCached(path.join(dataRoot, wf.rel));
        // 步骤解析与渲染进程共用 src/flow-graph.js 的那一份：从前端main进程
        // 各有一套的写法已经在'图上只画出一个空节点'那个故障里出过一次事。
        const steps = flowGraph.parseSteps(entry.content);
        const graph = flowGraph.analyze(steps);
        out.push({
          rel: wf.rel,
          title: (parseFrontmatter(entry.content).meta || {}).title || null,
          steps: steps.map(s => ({ id: s.id, label: s.label || null, prompt: s.prompt || null, next: s.next || [] })),
          unreachable: graph.unreachable,
          hasCycle: graph.hasCycle
        });
      }
      return ok({ total: idx.workflows.length, returned: out.length, workflows: out });
    },

    async prompts_references(args) {
      const idx = await loadWorkflowIndex();
      const meta = await library.getMetaList(false);
      const exists = new Set(meta.map(m => m.rel));
      const dangling = idx.danglingRefs(r => exists.has(r));
      if (!args.rel) {
        return ok({ danglingCount: dangling.length, dangling: dangling.slice(0, MAX_LIST_ITEMS) });
      }
      const rel = safeLibraryRel(args.rel);
      if (!rel) return fail('rel 必须是 prompts/ 下的 .md 相对路径');
      return ok({
        rel,
        referencedBy: idx.referencesTo(rel),
        dangling: dangling.some(d => d.prompt === rel)
      });
    }
  };
}

module.exports = { toolDefinitions, createHandlers, safeLibraryRel, MAX_BODY_CHARS, MAX_LIST_ITEMS };
