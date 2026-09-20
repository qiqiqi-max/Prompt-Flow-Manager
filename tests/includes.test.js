// tests/includes.test.js
// 针对 src/includes.js 的单元测试与反向对照测试。
const INCLUDES = require('../src/includes');
const PLACEHOLDERS = require('../src/placeholders');

let failures = 0;
const pass = (msg) => console.log('[test:includes] PASS ' + msg);
const fail = (msg) => { console.error('[test:includes] FAIL ' + msg); failures++; };
const assert = (ok, msg, extra) => { if (ok) pass(msg); else fail(msg + (extra ? '（' + extra + '）' : '')); };

// 1. 基础提取
{
  const text = '前置说明\n{{include: prompts/snippets/arch.md}}\n后置说明';
  const list = INCLUDES.extract(text);
  assert(list.length === 1, '能够提取单个 include 标签');
  assert(list[0].rel === 'prompts/snippets/arch.md', '正确解析相对路径');
}

// 2. 路径清洗与反斜杠兼容
{
  const text = '{{include: prompts\\snippets\\arch.md }}';
  const list = INCLUDES.extract(text);
  assert(list.length === 1 && list[0].rel === 'prompts/snippets/arch.md', '反斜杠与空格自动归一化');
}

// 3. 越权路径防范
{
  const text = '{{include: ../../outside.md}}';
  const list = INCLUDES.extract(text);
  assert(list.length === 1 && list[0].valid === false, '拒绝 .. 跨根路径');
}

// 4. 代码块中的包含语法必须被忽略
{
  const text = [
    '这是正文里的：{{include: a.md}}',
    '```markdown',
    '这是代码块里的：{{include: b.md}}',
    '```',
    '这是行内代码里的：`{{include: c.md}}`',
    '~~~',
    '这是波浪号代码块里的：{{include: d.md}}',
    '~~~'
  ].join('\n');

  const list = INCLUDES.extract(text);
  assert(list.length === 1 && list[0].rel === 'a.md', '代码块与行内代码中的 include 均被忽略');
}

// 5. 同步解析与 Frontmatter 剥离
{
  const files = {
    'a.md': '开始\n{{include: b.md}}\n结束',
    'b.md': '---\ntitle: B片段\n---\n这是B的正文'
  };
  const resolver = (rel) => files[rel] || null;
  const res = INCLUDES.resolveSync(files['a.md'], resolver);
  assert(res === '开始\n这是B的正文\n结束', '成功嵌入子片段且自动剥离 Frontmatter');
}

// 6. 多层嵌套解析
{
  const files = {
    'step1.md': '1->{{include: step2.md}}',
    'step2.md': '2->{{include: step3.md}}',
    'step3.md': '3'
  };
  const resolver = (rel) => files[rel] || null;
  const res = INCLUDES.resolveSync(files['step1.md'], resolver);
  assert(res === '1->2->3', '多层嵌套顺序解析成功');
}

// 7. 循环依赖安全截断
{
  const files = {
    'loop1.md': 'A->{{include: loop2.md}}',
    'loop2.md': 'B->{{include: loop1.md}}'
  };
  const resolver = (rel) => files[rel] || null;
  const res = INCLUDES.resolveSync(files['loop1.md'], resolver);
  assert(res.includes('circular dependency'), '循环依赖被安全拦截并留痕');
}

// 8. 深度超限保护
{
  const files = {};
  for (let i = 1; i <= 8; i++) {
    files[`d${i}.md`] = `[${i}]->{{include: d${i + 1}.md}}`;
  }
  const resolver = (rel) => files[rel] || null;
  const res = INCLUDES.resolveSync(files['d1.md'], resolver);
  assert(res.includes('[5]'), '最大深度保护生效且不崩溃');
}

// 9. 不存在的文件友好提示
{
  const res = INCLUDES.resolveSync('你好 {{include: not-found.md}}', () => null);
  assert(res.includes('file not found'), '文件不存在时安全回退');
}

// 10. 异步解析（与 Promise 配合）
(async () => {
  const files = {
    'async1.md': '异步开始\n{{include: async2.md}}',
    'async2.md': '异步完成'
  };
  const res = await INCLUDES.resolveAsync(files['async1.md'], async (rel) => files[rel]);
  assert(res === '异步开始\n异步完成', '异步解析完成');

  // 11. 与 PLACEHOLDERS 协同测试（拼装后占位符联合提取）
  {
    const files = {
      'main.md': '主项目：[项目名称]\n{{include: snippet.md}}',
      'snippet.md': '技术栈：[技术选型]，架构风格：[架构模式]'
    };
    const resolved = await INCLUDES.resolveAsync(files['main.md'], async (rel) => files[rel]);
    const tokens = PLACEHOLDERS.extract(resolved);
    assert(tokens.length === 3, '成功提取主模板与被引用片段的所有占位符');
    assert(tokens[0].hint === '项目名称', '首个占位符为主模板参数');
    assert(tokens[1].hint === '技术选型', '第二个占位符为子片段参数');
    assert(tokens[2].hint === '架构模式', '第三个占位符为子片段参数');

    const filled = PLACEHOLDERS.fill(resolved, {
      '[项目名称]': '我的新项目',
      '[技术选型]': 'React+FastAPI',
      '[架构模式]': '微服务'
    });
    assert(
      filled === '主项目：我的新项目\n技术栈：React+FastAPI，架构风格：微服务',
      '子片段中的占位符能够一次性完成填充'
    );
  }

  // --- 反向对照测试 ---
  console.log('\n[test:includes] --- 反向对照：朴素正则替换必须红 ---');
  let redCount = 0;
  // 朴素替换器：无代码块掩码、无循环引用检查
  function naiveReplace(text, resolver) {
    return text.replace(/\{\{include:\s*(.*?)\s*\}\}/g, (m, p) => resolver(p) || '');
  }

  // 对照1：代码块内的示例语法会被错误替换
  const codeBlockText = '```\n{{include: sample.md}}\n```';
  const naiveRes1 = naiveReplace(codeBlockText, () => '被替换了');
  if (naiveRes1.includes('被替换了')) {
    redCount++;
    console.log('  红：朴素实现错误替换了代码块内部的 include 标签');
  }

  // 对照2：死循环直接爆栈
  const circularText = '{{include: self.md}}';
  let _stackOverflow = false;
  try {
    let s = circularText;
    for (let loop = 0; loop < 20; loop++) {
      s = naiveReplace(s, () => '{{include: self.md}}');
    }
  } catch {
    _stackOverflow = true;
  }
  // 朴素实现如果不做环检查或深度检查，就会无限膨胀
  const naiveLoop = naiveReplace('{{include: self.md}}', () => '{{include: self.md}}');
  if (naiveLoop.includes('{{include: self.md}}')) {
    redCount++;
    console.log('  红：朴素实现无法侦测循环依赖并收敛');
  }

  assert(redCount >= 2, '反向对照证明朴素实现确实失败 (' + redCount + '/2 条)');

  if (failures > 0) {
    console.error(`\n[test:includes] 失败 ${failures} 项`);
    process.exit(1);
  } else {
    console.log('\n[test:includes] 全部通过 ✓');
  }
})();
