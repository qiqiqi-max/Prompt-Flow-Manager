// 工作流引用索引：回答"这个提示词被哪些工作流引用"和"库里有哪几处悬空引用"。
//
// 为什么需要它：flow[].prompt 是工作流指向提示词的唯一边；改名/移动时主进程会
// 顺着它把引用迁走（find-workflow-refs + update-workflow-refs），但**反方向**一直
// 没有答案 —— 界面上没有任何地方能看出"删掉这个提示词会让哪几个工作流的节点变成
// 坏引用"。用户只能先删了，再逐个打开工作流，看流程图顶端那条警告汇总才知道。
//
// 每次 load() 都重新收集一遍，不做长期内容缓存。原因：内容缓存的失效点散在
// save / rename / trash / import / 回滚各处，漏一个地方的表现就是"刚改完的引用
// 关系还是旧的"，而且完全静默。工作流数量本身就是小头（每个工作流一份 frontmatter），
// 真正的大头是提示词和正文，它们仍然走主进程原有的 readParsedCached。
//
// 引用提取的顺序：
//   1. WORKFLOW_REFS.extractPrompts —— 逐行收集 flow 段下所有 prompt: 的值，
//      这是正式格式（对齐"流程图上画出来的那个引用"）。
//   2. 取不到时退回 frontmatter 里所有 prompt: 行 —— 兼容 flow 写法不标准、
//      但确实在 frontmatter 里声明了引用的旧文件。
//   3. 两级都没有则视为无引用。不退化到"全文 includes"：正文里出现的路径不是
//      引用，把它当引用会在删除确认里凭空吓唬用户，也会让 chip 指向不存在的关系。
const path = require('path');
const WORKFLOW_REFS = require('../src/workflow-refs');

// frontmatter 段的文本。用和 WORKFLOW_REFS 相同的边界（开头 --- 到下一个 ---）。
function frontmatterText(content) {
  const m = String(content == null ? '' : content).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

// flow 段下的 prompt 值。逐行收集而不是惰性正则截块：惰性正则会在第一行行尾
// 就满足匹配（renderer.js 的 parseWorkflowFlow 记着这个事故，多行模式下只解析出
// 第一个步骤）。这里同样按"从 flow: 开始、遇到顶格行结束"来收集。
function extractPrompts(content) {
  const yaml = frontmatterText(content);
  if (yaml == null) return [];
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex(l => /^flow:\s*$/.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;          // 段内空行不结束
    if (!/^\s/.test(line)) break;              // 顶格行 = flow 段结束
    const m = line.match(/^\s*(?:-\s*)?prompt:\s*(.*?)\s*$/);
    if (!m || !m[1]) continue;
    const v = WORKFLOW_REFS.unquote(m[1]).replace(/\\/g, '/');
    if (v) out.push(v);
  }
  return out;
}

// 兜底：frontmatter 里所有 prompt: 行（含 flow 段）。
function frontmatterPrompts(content) {
  const yaml = frontmatterText(content);
  if (yaml == null) return [];
  const out = [];
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:-\s*)?prompt:\s*(.*?)\s*$/);
    if (!m || !m[1]) continue;
    const v = WORKFLOW_REFS.unquote(m[1]).replace(/\\/g, '/');
    if (v) out.push(v);
  }
  return out;
}

function promptsOf(content) {
  const fromFlow = extractPrompts(content);
  return fromFlow.length ? fromFlow : frontmatterPrompts(content);
}

function buildIndex(workflows) {
  const byPrompt = new Map();   // prompt rel -> Set<workflow rel>
  const workflowsList = [];     // [{ rel, prompts: string[] }]
  const allPrompts = new Set();

  for (const wf of workflows || []) {
    if (!wf || typeof wf.rel !== 'string') continue;
    const prompts = Array.from(new Set(promptsOf(wf.content)));
    workflowsList.push({ rel: wf.rel, prompts });
    for (const p of prompts) {
      allPrompts.add(p);
      if (!byPrompt.has(p)) byPrompt.set(p, new Set());
      byPrompt.get(p).add(wf.rel);
    }
  }

  // 结果要稳定：插入顺序取决于目录遍历顺序，而 readdir 不保证有序，
  // 不排序的话同一份数据在不同机器上 chip 顺序会跳。
  const sorted = (set) => Array.from(set).sort();
  return {
    workflows: workflowsList,

    referencesTo(promptRel) {
      const wanted = String(promptRel || '').replace(/\\/g, '/');
      return sorted(byPrompt.get(wanted) || []);
    },

    // 指向不存在的提示词的引用。exists 由调用方注入：主进程用已经拉到的元数据
    // （一次遍历的结果），测试传自己的集合。默认存在 → 空索引。
    danglingRefs(exists) {
      const has = typeof exists === 'function' ? exists : () => true;
      const out = [];
      for (const rel of sorted(allPrompts)) {
        if (has(rel)) continue;
        out.push({ prompt: rel, workflows: sorted(byPrompt.get(rel)) });
      }
      return out;
    }
  };
}

// 读工作流目录并收集内容。readContent(rel) 返回 { content }（主进程注入
// readParsedCached）。目录不存在（还没建过 workflows/）时返回空数组 —— 新库首启。
async function collectWorkflows(dataRoot, readContent, fsPromises) {
  const fsp = fsPromises || require('fs').promises;
  let names;
  try { names = await fsp.readdir(path.join(dataRoot, 'workflows')); } catch { return []; }
  const out = [];
  for (const name of names.slice().sort()) {
    if (name.startsWith('.') || !name.toLowerCase().endsWith('.md')) continue;
    const rel = 'workflows/' + name;
    const entry = await readContent(rel);
    if (!entry) continue;
    out.push({ rel, content: entry.content });
  }
  return out;
}

module.exports = { buildIndex, collectWorkflows, promptsOf, extractPrompts, frontmatterPrompts };
