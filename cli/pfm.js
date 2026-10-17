#!/usr/bin/env node
// 命令行入口：对本地提示词库做只读查询与体检。
//
// 和 mcp/server.js 是同一层东西的两种投递方式：那个把库给 AI 工具用，
// 这个给人用（脚本、CI、终端里快速翻）。两者都只读、都复用 lib/library.js，
// 唯一多出来的是 `check`——它按退出码报告库的健康状况，适合放进项目自己的
// 流水线（比如"提示词库里有悬空引用就别提交"）。
//
// 用法：
//   npm run pfm -- list --stage testing
//   npm run pfm -- search "缓存失效"
//   npm run pfm -- get prompts/project-init/需求分析.md
//   npm run pfm -- refs prompts/project-init/需求分析.md
//   npm run pfm -- check          # 悬空引用体检，有问题时退出码 1
//   npm run pfm -- overview
//   PFM_DATA_DIR=<目录> npm run pfm -- list     # 指定别的库
// 所有子命令支持 --json，供脚本消费。
const path = require('path');

const dataRoot = path.resolve(process.env.PFM_DATA_DIR || path.join(__dirname, '..'));

const { createLibrary } = require('../lib/library.js');
const workflowIndex = require('../lib/workflow-index.js');
const FRONTMATTER = require('../src/frontmatter.js');

const library = createLibrary({
  dataRoot,
  parseFrontmatter: (c) => FRONTMATTER.parse(c),
  stripFrontmatter: (c) => FRONTMATTER.strip(c)
});

// 与 mcp/tools.js 同一套只读白名单：只放行三个内容目录下的 .md。
// 这条检查在这里同样必要——`get ../../../config.json` 是命令行里最顺手的越权写法。
function safeLibraryRel(rel) {
  const cleaned = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0')) return null;
  const segs = cleaned.split('/');
  if (segs.length < 2) return null;
  if (!['prompts', 'workflows', 'templates'].includes(segs[0])) return null;
  for (const s of segs) if (s.startsWith('.')) return null;
  if (!segs[segs.length - 1].toLowerCase().endsWith('.md')) return null;
  return segs.join('/');
}

// 极简参数解析：只认 --flag value 与 --flag，不引依赖（这个项目运行时依赖只有两个）。
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++; }
      else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

const out = (text) => process.stdout.write(text + '\n');
const emit = (data, human, json) => out(json ? JSON.stringify(data, null, 2) : human(data));

async function loadIndex() {
  const list = await workflowIndex.collectWorkflows(dataRoot, (rel) => library.readParsedCached(path.join(dataRoot, rel)));
  return workflowIndex.buildIndex(list);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { _, flags } = parseArgs(rest);
  const asJson = !!flags.json;

  switch (cmd) {
    case 'overview': {
      const meta = await library.getMetaList(false);
      const counts = {};
      const stages = {};
      for (const m of meta) {
        counts[m.top] = (counts[m.top] || 0) + 1;
        if (m.top === 'prompts' && m.stage) stages[m.stage] = (stages[m.stage] || 0) + 1;
      }
      emit({ counts, stages }, (d) => {
        const rows = Object.entries(d.counts).map(([k, v]) => `  ${k}: ${v}`);
        const st = Object.entries(d.stages).map(([k, v]) => `  ${k}: ${v}`);
        return ['库目录: ' + dataRoot, '文件数:', ...rows, '提示词阶段分布:', ...st].join('\n');
      }, asJson);
      return 0;
    }

    case 'list': {
      const meta = await library.getMetaList(false);
      let items = meta.filter((m) => m.top === 'prompts');
      if (flags.stage) items = items.filter((m) => m.stage === flags.stage);
      if (flags.type) items = items.filter((m) => m.meta && m.meta.projectType === flags.type);
      const limit = Number(flags.limit) > 0 ? Number(flags.limit) : items.length;
      const shown = items.slice(0, limit).map((m) => ({
        rel: m.rel, title: (m.meta && m.meta.title) || m.name, stage: m.stage,
        tags: (m.meta && m.meta.tags) || []
      }));
      emit({ total: items.length, shown: shown.length, prompts: shown },
        (d) => d.prompts.map((p) => `${p.rel}\t${p.title}${p.tags.length ? '\t#' + p.tags.join(' #') : ''}`).join('\n')
          + (d.total > d.shown ? `\n（共 ${d.total} 条，显示 ${d.shown} 条）` : ''),
        asJson);
      return 0;
    }

    case 'search': {
      const q = _[0];
      if (!q) { process.stderr.write('用法: pfm search <关键词>\n'); return 2; }
      const results = await library.search(q);
      const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 20;
      const shown = results.slice(0, limit);
      emit({ query: q, total: results.length, results: shown },
        (d) => d.results.map((r) => `${r.rel}\t${r.name}`).join('\n') || '（没有命中）', asJson);
      return 0;
    }

    case 'get': {
      const rel = safeLibraryRel(_[0]);
      if (!rel) { process.stderr.write('rel 必须是 prompts/ workflows/ templates/ 下的 .md 相对路径\n'); return 2; }
      const entry = await library.readParsedCached(path.join(dataRoot, rel));
      if (!entry.content) { process.stderr.write('库里没有这个文件: ' + rel + '\n'); return 1; }
      const { meta, body } = FRONTMATTER.parse(entry.content);
      emit({ rel, meta, body }, (d) => [
        '# ' + (d.meta.title || rel),
        Object.entries(d.meta).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n'),
        '', d.body
      ].join('\n'), asJson);
      return 0;
    }

    case 'refs': {
      const idx = await loadIndex();
      const meta = await library.getMetaList(false);
      const exists = new Set(meta.map((m) => m.rel));
      if (_[0]) {
        const rel = safeLibraryRel(_[0]);
        if (!rel) { process.stderr.write('rel 必须是 prompts/ 下的 .md 相对路径\n'); return 2; }
        const refs = idx.referencesTo(rel);
        emit({ rel, referencedBy: refs }, (d) => d.referencedBy.join('\n') || '（没有工作流引用它）', asJson);
        return 0;
      }
      const dangling = idx.danglingRefs((r) => exists.has(r));
      emit({ danglingCount: dangling.length, dangling },
        (d) => d.dangling.map((x) => `${x.prompt}  ←  ${x.workflows.join(', ')}`).join('\n')
          || '（没有悬空引用）', asJson);
      return 0;
    }

    case 'check': {
      // 体检：悬空引用 + 工作流里从入口走不到的步骤。任一有问题就退出码 1，
      // 这样它可以当成"提示词库的 lint"放进任何流水线。退出码是这条命令的
      // 主要产出，人类可读的输出只是给人看的附注。
      const idx = await loadIndex();
      const meta = await library.getMetaList(false);
      const exists = new Set(meta.map((m) => m.rel));
      const dangling = idx.danglingRefs((r) => exists.has(r));
      const unreachable = [];
      const FLOW_GRAPH = require('../src/flow-graph.js');
      for (const wf of idx.workflows) {
        const entry = await library.readParsedCached(path.join(dataRoot, wf.rel));
        const g = FLOW_GRAPH.analyze(FLOW_GRAPH.parseSteps(entry.content));
        if (g.unreachable.length) unreachable.push({ rel: wf.rel, steps: g.unreachable });
      }
      const problems = dangling.length + unreachable.length;
      emit({ problems, dangling, unreachable }, (d) => {
        if (!d.problems) return '✓ 提示词库体检通过（无悬空引用、无不可达步骤）';
        const lines = [];
        for (const x of d.dangling) lines.push(`悬空引用: ${x.prompt}  ←  ${x.workflows.join(', ')}`);
        for (const x of d.unreachable) lines.push(`不可达步骤: ${x.rel}  →  ${x.steps.join(', ')}`);
        return lines.join('\n');
      }, asJson);
      return problems ? 1 : 0;
    }

    default:
      process.stderr.write([
        'Prompt Flow Manager 命令行（只读）',
        '',
        '  pfm overview                     库概览（文件数、阶段分布）',
        '  pfm list [--stage s] [--type t]  列提示词（不含正文）',
        '  pfm search <关键词>              全文检索',
        '  pfm get <rel>                    读一条提示词的元数据与正文',
        '  pfm refs [<rel>]                 谁引用了它 / 全库悬空引用',
        '  pfm check                        体检：悬空引用 + 不可达步骤（有问题退出码 1）',
        '',
        '所有子命令支持 --json。库目录用 PFM_DATA_DIR 指定，默认是本仓库。'
      ].join('\n') + '\n');
      return cmd ? 2 : 0;
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  process.stderr.write('pfm 执行失败: ' + String(e && e.message ? e.message : e) + '\n');
  process.exit(1);
});
