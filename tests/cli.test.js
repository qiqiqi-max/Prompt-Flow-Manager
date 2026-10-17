// tests/cli.test.js
// 回归测试：cli/pfm.js 的只读子命令、退出码与路径边界。
//
// 为什么用真子进程：这个入口的价值有一半在**退出码**上——`check` 是要放进流水线
// 当 lint 用的，而"打印了问题却退出 0"在人工看一眼的输出里完全看不出来。
// 直接调函数把 exit code 绕过去了，正好漏掉最要紧的那条。
//
// 反向对照在文件末尾：用一份**故意坏掉**的库（悬空引用 + 不可达步骤）跑 check，
// 要求退出码 1；同一份库上"只看有没有输出"的朴素判定会放行它。
//
// 运行：PFM_DATA_DIR=. npm run test:cli
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataRoot = path.resolve(process.env.PFM_DATA_DIR || root);

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:cli] PASS ' + msg);
  else { failures++; console.error('[test:cli] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};

function run(args, env) {
  const r = spawnSync(process.execPath, [path.join(root, 'cli', 'pfm.js'), ...args], {
    cwd: root,
    env: { ...process.env, PFM_DATA_DIR: dataRoot, ...(env || {}) },
    encoding: 'utf8'
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// ---------- 一、真实库上的只读命令 ----------
{
  const list = run(['list', '--json']);
  ok(list.code === 0, 'list 退出码 0', 'code=' + list.code);
  let data = null;
  try { data = JSON.parse(list.out); } catch { /* 下面断言会报出来 */ }
  ok(!!data && Array.isArray(data.prompts) && data.total > 0,
    'list --json 输出可解析且有条目', list.out.slice(0, 120));
  ok(!!data && data.prompts.every(p => p.rel && !('body' in p)),
    'list 只给元数据、不带正文');

  const filtered = run(['list', '--stage', 'testing', '--json']);
  const fdata = JSON.parse(filtered.out);
  ok(fdata.prompts.length > 0 && fdata.prompts.every(p => p.stage === 'testing'),
    'list --stage 真的过滤了', JSON.stringify(fdata.prompts.map(p => p.stage)));

  const search = run(['search', '需求', '--json']);
  const sdata = JSON.parse(search.out);
  ok(search.code === 0 && sdata.total > 0, 'search 有命中', JSON.stringify({ code: search.code, total: sdata.total }));

  const get = run(['get', 'prompts/project-init/需求分析.md', '--json']);
  const gdata = JSON.parse(get.out);
  ok(get.code === 0 && typeof gdata.body === 'string' && gdata.body.length > 20, 'get 返回正文');
  ok(!String(gdata.body).includes('---\ntitle:'), 'get 的正文不含 frontmatter');

  const refs = run(['refs', 'prompts/project-init/需求分析.md', '--json']);
  const rdata = JSON.parse(refs.out);
  ok(refs.code === 0 && Array.isArray(rdata.referencedBy) && rdata.referencedBy.length >= 2,
    'refs 给出引用它的工作流', JSON.stringify(rdata));

  const check = run(['check']);
  ok(check.code === 0, '真实库 check 通过（退出码 0）', 'code=' + check.code);
  ok(/体检通过/.test(check.out), 'check 明确说了通过');
}

// ---------- 二、路径边界 ----------
{
  const cases = ['../../../config.json', 'config.json', '.versions/x.md', 'C:/Windows/win.ini', 'prompts/../config.json'];
  for (const rel of cases) {
    const r = run(['get', rel]);
    ok(r.code === 2 && !r.out.includes('theme'),
      '拒绝越权的 rel：' + rel, JSON.stringify({ code: r.code, out: r.out.slice(0, 60) }));
  }
  const missing = run(['get', 'prompts/testing/不存在.md']);
  ok(missing.code === 1, '库内不存在的文件退出码 1（与"参数错"的 2 区分开）', 'code=' + missing.code);
  const noArg = run(['search']);
  ok(noArg.code === 2, '少参数退出码 2', 'code=' + noArg.code);
  const unknown = run(['没有这个子命令']);
  ok(unknown.code === 2, '未知子命令退出码 2', 'code=' + unknown.code);
  const help = run([]);
  ok(help.code === 0 && /pfm overview/.test(help.err + help.out), '不带参数打印用法且退出 0');
}

// ---------- 三、坏库：check 必须退出 1 ----------
{
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-cli-bad-'));
  fs.mkdirSync(path.join(bad, 'prompts', 'testing'), { recursive: true });
  fs.mkdirSync(path.join(bad, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(bad, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(bad, 'prompts', 'testing', '在的.md'), '---\ntitle: 在的\n---\n正文');
  // 两种毛病各一处：悬空引用（指向不存在的文件）+ 不可达步骤（自成一环）
  fs.writeFileSync(path.join(bad, 'workflows', '坏工作流.md'), [
    '---', 'title: 坏工作流', 'flow:',
    '  - id: a', '    prompt: prompts/testing/在的.md',
    '  - id: x', '    prompt: prompts/testing/幽灵.md', '    next: y',
    '  - id: y', '    prompt: prompts/testing/在的.md', '    next: x',
    '---', '正文'
  ].join('\n'));

  const r = run(['check', '--json'], { PFM_DATA_DIR: bad });
  const data = (() => { try { return JSON.parse(r.out); } catch { return null; } })();
  ok(r.code === 1, '坏库 check 退出码 1', 'code=' + r.code);
  ok(!!data && data.dangling.some(d => d.prompt === 'prompts/testing/幽灵.md'),
    'check 报出悬空引用', JSON.stringify(data && data.dangling));
  ok(!!data && data.unreachable.some(u => u.steps.includes('x') && u.steps.includes('y')),
    'check 报出不可达步骤', JSON.stringify(data && data.unreachable));

  // 反向对照：一个只看"有没有输出"的朴素判定会把这份坏库放行——
  // 它证明上面那条"退出码 1"的断言真的在辨别，而不是靠输出里恰好有字。
  const naivePass = r.out.trim().length > 0;
  ok(naivePass === true,
    '反向对照：朴素判定（只看有没有输出）会放行这份坏库，所以必须靠退出码');

  // 同一份坏库上，refs 也不该崩
  const refs = run(['refs'], { PFM_DATA_DIR: bad });
  ok(refs.code === 0 && /幽灵/.test(refs.out), 'refs 在坏库上仍然工作并列出悬空引用');
  fs.rmSync(bad, { recursive: true, force: true });
}

console.log(failures ? `[test:cli] ${failures} 条失败` : '[test:cli] 通过');
process.exit(failures ? 1 : 0);
