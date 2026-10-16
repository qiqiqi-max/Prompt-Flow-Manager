// tests/workflow-index.test.js
// 回归测试：lib/workflow-index.js 的引用提取。
//
// 为什么单独一个文件：这个模块的失败方式是**静默**的。少提取一条引用，用户删掉
// 提示词后没有任何提醒，工作流上凭空多一个坏节点；多提取一条（比如把注释或正文里
// 提到的路径算成引用），删除确认里会凭空多出一条根本不存在的依赖，用户会以为
// 自己记错了。两种都不抛错、不写日志，只能靠断言在这里拦住。
//
// 基准用仓库里真实的 workflows/*.md：它们就是用户真正会打开的那些工作流，
// 每个文件里的引用关系是读出来的（见各条断言），不是现编的小字符串。
//
// 反向对照在文件末尾：同一批断言拿一个**朴素实现**（frontmatter 里凡是出现
// `prompt:` 字样的行都算一条引用）再跑一遍，要求它必须红够多条。它证明的是
// "这批断言有分辨力"，不是"朴素实现写错了"——后者是显然的。
//
// 运行：PFM_DATA_DIR=<临时目录> npm run test:workflow-index
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.resolve(__dirname, '..');
const INDEX = require(path.join(root, 'lib', 'workflow-index.js'));

const dataRoot = process.env.PFM_DATA_DIR || root;

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:workflow-index] PASS ' + msg);
  else { failures++; console.error('[test:workflow-index] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};

// ---------- 一、真实工作流库的引用关系 ----------
// 逐个文件数出来的：分支流程示例 5 步、完整项目流程 3 步（见文件内容）。
// 数字写死是故意的——改工作流内容会让这些断言变红，提醒同步基准。
const readAll = async () => {
  const dir = path.join(dataRoot, 'workflows');
  const names = (await fs.promises.readdir(dir)).filter(n => n.endsWith('.md')).sort();
  const out = [];
  for (const n of names) out.push({ rel: 'workflows/' + n, content: await fs.promises.readFile(path.join(dir, n), 'utf8') });
  return out;
};

(async () => {
  const idx = INDEX.buildIndex(await readAll());

  ok(idx.workflows.length >= 2, '索引里包含仓库的多个工作流', String(idx.workflows.length));

  const branch = idx.referencesTo('prompts/project-init/需求分析.md');
  ok(Array.isArray(branch) && branch.length >= 2 && branch.every(r => r.startsWith('workflows/')),
    '反向查询返回引用它的工作流',
    JSON.stringify(branch));

  // 需求分析被三个工作流同时引用（branch-flow-example / full-project-flow /
  // 简要工作流）：这是"一个提示词被多个工作流复用"的最小样本，也正是删除前
  // 提醒要给出的信息。数字是数出来的——改工作流内容会让这条变红，提醒同步基准。
  ok(branch.length === 3
    && branch.includes('workflows/branch-flow-example.md')
    && branch.includes('workflows/full-project-flow.md')
    && branch.includes('workflows/简要工作流.md'),
  '同时被多个工作流引用的提示词能全部列出来', JSON.stringify(branch));

  ok(idx.referencesTo('prompts/testing/测试策略.md').length === 3,
    '被全部三个工作流引用的提示词数量正确',
    JSON.stringify(idx.referencesTo('prompts/testing/测试策略.md')));

  ok(idx.referencesTo('prompts/不存在/幽灵.md').length === 0, '没有任何引用时返回空数组');
  ok(idx.referencesTo('').length === 0 && idx.referencesTo(null).length === 0, '空 rel 不匹配任何工作流');

  // 排序稳定性：结果必须有序，否则界面上 chip 顺序会随 readdir 顺序跳。
  {
    const a = idx.referencesTo('prompts/project-init/需求分析.md');
    const b = idx.referencesTo('prompts/project-init/需求分析.md');
    ok(JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) === JSON.stringify(a.slice().sort()),
      '同一查询重复执行结果稳定且有序', JSON.stringify(a));
  }

  // ---------- 二、悬空引用 ----------
  {
    const existing = new Set(['prompts/project-init/需求分析.md']);
    const dangling = idx.danglingRefs(rel => existing.has(rel));
    ok(dangling.length > 0, '能找出指向不存在文件的引用', JSON.stringify(dangling));
    ok(dangling.every(d => !existing.has(d.prompt) && Array.isArray(d.workflows) && d.workflows.length),
      '每条悬空引用都带上是哪些工作流在用');
    ok(!dangling.some(d => d.prompt === 'prompts/project-init/需求分析.md'),
      '存在文件不在悬空列表里');
    ok(idx.danglingRefs(() => true).length === 0, '所有文件都存在时没有悬空引用');
  }

  // ---------- 三、提取策略：flow 优先、frontmatter 兜底、正文不算 ----------
  {
    // 正文里提到别的 prompt 路径，不该被当成引用（这是"多报一条吓唬用户"的形状）。
    const bodyMention = [
      '---', 'title: 提到别人的文件', 'flow:', '  - id: a', '    prompt: prompts/real.md', '---',
      '参见 prompts/mentioned-only-in-body.md 的写法'
    ].join('\n');
    const i2 = INDEX.buildIndex([{ rel: 'workflows/x.md', content: bodyMention }]);
    ok(i2.referencesTo('prompts/mentioned-only-in-body.md').length === 0,
      '正文里提到的路径不算引用（只在正文出现）');
    ok(i2.referencesTo('prompts/real.md').length === 1, 'flow 里的引用仍然被提取');
  }
  {
    // flow 段取不到（写法不标准）时退回 frontmatter，但同一份 frontmatter
    // 之外的内容不参与。
    const flat = [
      '---', 'title: 非标准写法', 'prompts:', '  - prompt: prompts/a.md', '  - prompt: "prompts/b.md"', '---',
      'body prompts/c.md'
    ].join('\n');
    const i3 = INDEX.buildIndex([{ rel: 'workflows/y.md', content: flat }]);
    ok(i3.referencesTo('prompts/a.md').length === 1 && i3.referencesTo('prompts/b.md').length === 1,
      'flow 段提取不到时退回 frontmatter 的 prompt 行', JSON.stringify(i3.workflows));
    ok(i3.referencesTo('prompts/c.md').length === 0, '兜底路径也不采信正文');
  }
  {
    // 引号：flow 里 prompt 值带引号时，比较必须基于**去掉引号后的值**。
    // 直接拿整行做字符串比对会漏（"prompts/q.md" 不等于 prompts/q.md）。
    const quoted = ['---', 'title: 带引号', 'flow:', '  - id: a', '    prompt: "prompts/q.md"', '---', ''].join('\n');
    const i4 = INDEX.buildIndex([{ rel: 'workflows/z.md', content: quoted }]);
    ok(i4.referencesTo('prompts/q.md').length === 1, '带引号的 prompt 值能正确匹配（去引号后比较）',
      JSON.stringify(i4.workflows));

    // 反向对照：朴素实现（直接搜 frontmatter 里的整行）会漏掉带引号的这一条。
    const naive = (content, wanted) => /\bprompt:\s*[^\n]*\b/.test(String(content).split('---')[1] || '')
      && String(content).split('---')[1].indexOf('prompt: ' + wanted) >= 0;
    ok(naive(quoted, 'prompts/q.md') === false, '朴素实现确实漏掉带引号的引用（证明上面那条有分辨力）');
  }

  // ---------- 四、collectWorkflows 的目录规则 ----------
  {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pfm-wfidx-'));
    try {
      await fs.promises.mkdir(path.join(tmp, 'workflows'), { recursive: true });
      await fs.promises.writeFile(path.join(tmp, 'workflows', 'a.md'), '---\ntitle: A\n---\n');
      await fs.promises.writeFile(path.join(tmp, 'workflows', 'b.md'), '---\ntitle: B\n---\n');
      await fs.promises.writeFile(path.join(tmp, 'workflows', '.hidden.md'), '---\ntitle: H\n---\n');
      await fs.promises.writeFile(path.join(tmp, 'workflows', 'note.txt'), '不是工作流');

      let readCount = 0;
      const collected = await INDEX.collectWorkflows(tmp, async (rel) => {
        readCount++;
        return { content: await fs.promises.readFile(path.join(tmp, rel), 'utf8') };
      });
      ok(collected.length === 2, '只收集 workflows/ 下的 .md（跳过隐藏文件和 .txt）',
        JSON.stringify(collected.map(c => c.rel)));
      ok(readCount === 2 && collected.every(c => c.rel.startsWith('workflows/')),
        '每个工作流只读一次且相对路径正确');
      ok(collected.map(c => c.rel).join(',') === 'workflows/a.md,workflows/b.md', '收集结果按名字排序');

      // 目录不存在时不抛（新库首启就是这个状态）
      const emptyRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pfm-wfidx-empty-'));
      const none = await INDEX.collectWorkflows(emptyRoot, async () => ({ content: '' }));
      ok(none.length === 0, '没有 workflows 目录时返回空列表而不是抛错');
      await fs.promises.rm(emptyRoot, { recursive: true, force: true });
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  }

  // ---------- 五、反向对照：朴素实现必须红 ----------
  // 朴素实现 = "frontmatter 里出现 prompt: 字样的行都算引用"，不做去引号、
  // 不区分 flow 段与正文。用它跑上面同一批语义断言，必须至少红 3 条。
  {
    const naiveIndex = (workflows) => {
      const byPrompt = new Map();
      for (const wf of workflows) {
        const fm = (String(wf.content).match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
        for (const line of fm.split(/\r?\n/)) {
          if (!/prompt:/.test(line)) continue;
          const raw = line.replace(/^\s*(?:-\s*)?prompt:\s*/, '').trim();   // 不去引号
          if (!raw) continue;
          if (!byPrompt.has(raw)) byPrompt.set(raw, new Set());
          byPrompt.get(raw).add(wf.rel);
        }
      }
      return { referencesTo: (p) => Array.from(byPrompt.get(String(p || '')) || []) };
    };

    // 每条用例都必须真正区分两种实现。第一版这里写过一条"正文里提到路径"，
    // 它在两种实现下结果相同（朴素实现也不看正文），所以那条用例没有分辨力
    // —— 它证明不了任何东西，换成带引号的引用才有意义。下面的比较对每条用例
    // 都做这个判断：结果一样就判失败，不允许它悄悄混在计数里。
    const cases = [
      {
        name: '带双引号的引用',
        content: ['---', 'title: 带引号', 'flow:', '  - id: a', '    prompt: "prompts/q.md"', '---', ''].join('\n'),
        prompt: 'prompts/q.md'
      },
      {
        name: '带单引号的引用',
        content: ['---', 'title: 单引号', 'flow:', '  - id: a', "    prompt: 'prompts/s.md'", '---', ''].join('\n'),
        prompt: 'prompts/s.md'
      }
    ];
    let discriminators = 0;
    for (const c of cases) {
      const naive = naiveIndex([{ rel: 'workflows/n.md', content: c.content }]).referencesTo(c.prompt);
      const real = INDEX.buildIndex([{ rel: 'workflows/n.md', content: c.content }]).referencesTo(c.prompt);
      if (JSON.stringify(naive) === JSON.stringify(real)) {
        console.error('[test:workflow-index] FAIL 反向对照用例没有分辨力：' + c.name);
        failures++;
      } else {
        discriminators++;
      }
    }
    ok(discriminators === cases.length,
      '反向对照：每条用例都能分辨朴素实现（' + discriminators + '/' + cases.length + '）');
  }

  console.log(failures ? `[test:workflow-index] ${failures} 条失败` : '[test:workflow-index] 通过');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('[test:workflow-index] 运行出错：', e);
  process.exit(1);
});
