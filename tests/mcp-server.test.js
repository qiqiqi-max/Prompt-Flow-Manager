// tests/mcp-server.test.js
// 回归测试：mcp/server.js 的只读 MCP 服务。
//
// 为什么用真子进程而不是直接 require handlers：这个模块的价值有一半在协议上
// ——行分隔 JSON-RPC 的读循环、id 回填、通知不回、错误码。直接调 handler 会把
// 这一半完全绕过，而"工具能跑"和"客户端能连上"是两件事。
//
// 覆盖的三类风险：
//   1. 只读边界被改宽（多出一个写工具、或者路径检查被绕过）——这条最要紧，
//      因为它的后果是模型能改用户的提示词库。
//   2. 协议细节错了（没回 id、把通知也回了、非法 JSON 就退出）——客户端会直接
//      连不上，而单测 handler 永远发现不了。
//   3. 返回内容没有上限（一条长正文把调用方的上下文撑爆）。
//
// 反向对照：把 safeLibraryRel 的白名单放宽成"只要是 .md 就放行"，下面那条
// ../config.json 的用例必须变红（见文件末尾的自检块）。
//
// 运行：PFM_DATA_DIR=. npm run test:mcp
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:mcp] PASS ' + msg);
  else { failures++; console.error('[test:mcp] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};

// 用仓库真实内容作被测库：MCP server 要回答的正是"这个库里有什么"，
// 造一份假库只能证明搬运逻辑对，证明不了它对真实文件的行为。
const dataRoot = path.resolve(process.env.PFM_DATA_DIR || root);

function startServer(env) {
  const child = spawn(process.execPath, [path.join(root, 'mcp', 'server.js')], {
    cwd: root,
    env: { ...process.env, PFM_DATA_DIR: dataRoot, ...(env || {}) },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const pending = [];
  child.stdout.on('data', () => {
    let nl;
    while ((nl = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (!line) continue;
      try { pending.push(JSON.parse(line)); } catch { pending.push({ bad: line }); }
    }
  });
  return {
    child,
    responses: () => pending,
    stderr: () => err,
    // 等待某个 id 的响应（或超时）。协议测试里超时必须当失败：
    // 没有这条，写错方法名之类的问题会以"responses 里没有"的形式静默过去。
    async waitFor(pred, ms) {
      const deadline = Date.now() + (ms || 8000);
      while (Date.now() < deadline) {
        const hit = pending.find(pred);
        if (hit) return hit;
        await new Promise(r => setTimeout(r, 30));
      }
      return null;
    },
    send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); },
    async call(id, method, params) {
      this.send({ jsonrpc: '2.0', id, method, params });
      return this.waitFor(m => m.id === id);
    },
    kill() { try { child.kill(); } catch { /* 已经退了 */ } }
  };
}

// tools/call 的结果是 content[0].text 里的 JSON 字符串
function payloadOf(res) {
  if (!res || !res.result || !Array.isArray(res.result.content)) return null;
  try { return JSON.parse(res.result.content[0].text); } catch { return null; }
}

(async () => {
  const srv = startServer();

  // ---------- 一、握手 ----------
  const init = await srv.call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  ok(!!init && init.result && init.result.serverInfo && init.result.serverInfo.name === 'prompt-flow-manager',
    'initialize 返回 serverInfo', JSON.stringify(init && init.result));
  ok(!!init && init.result && init.result.capabilities && !!init.result.capabilities.tools,
    'initialize 声明了 tools 能力');
  srv.send({ jsonrpc: '2.0', method: 'notifications/initialized' });   // 通知

  // ---------- 二、工具清单 ----------
  const list = await srv.call(2, 'tools/list');
  const tools = list && list.result && list.result.tools ? list.result.tools : [];
  ok(tools.length >= 5, '列出了工具（' + tools.length + ' 个）');
  const names = tools.map(t => t.name);
  for (const want of ['library_overview', 'prompts_list', 'prompts_search', 'prompts_get', 'workflows_list', 'prompts_references']) {
    ok(names.includes(want), '有工具 ' + want);
  }
  // 只读边界：**不能**有写工具。这条盯的是"以后有人顺手加一个 save"。
  const writeish = names.filter(n => /save|write|create|delete|rename|move|update|trash|edit/i.test(n));
  ok(writeish.length === 0, '工具清单里没有任何写操作', JSON.stringify(writeish));
  // 每个工具都要有 inputSchema：没有它调用方只能瞎猜参数名
  const noSchema = tools.filter(t => !t.inputSchema || t.inputSchema.type !== 'object');
  ok(noSchema.length === 0, '每个工具都声明了 object 类型的 inputSchema',
    JSON.stringify(noSchema.map(t => t.name)));
  // description 是模型挑工具的唯一依据，空的话这个工具等于不存在
  const noDesc = tools.filter(t => !t.description || t.description.length < 20);
  ok(noDesc.length === 0, '每个工具都有说清用途的描述', JSON.stringify(noDesc.map(t => t.name)));

  // ---------- 三、真实数据 ----------
  {
    const res = await srv.call(10, 'tools/call', { name: 'library_overview', arguments: {} });
    const data = payloadOf(res);
    ok(!!data && typeof data.counts === 'object', 'library_overview 返回目录计数', JSON.stringify(data && data.counts));
    ok(!!data && data.counts.prompts > 0, '概览里有提示词（' + (data && data.counts.prompts) + ' 条）');
    ok(!!data && Array.isArray(data.projectTypes) && data.projectTypes.length > 0,
      '概览列出了工程类型', JSON.stringify(data && data.projectTypes));
  }
  {
    const res = await srv.call(11, 'tools/call', { name: 'prompts_list', arguments: { limit: 3 } });
    const data = payloadOf(res);
    ok(!!data && Array.isArray(data.prompts) && data.prompts.length === 3 && data.total > 3,
      'prompts_list 遵守 limit 且报告总数', JSON.stringify({ total: data && data.total, n: data && data.prompts && data.prompts.length }));
    ok(!!data && data.prompts.every(p => p.rel && p.title !== undefined && !('body' in p)),
      'prompts_list 只给元数据、不带正文');
  }
  {
    // 阶段过滤必须真的过滤，不是只看"返回了东西"
    const res = await srv.call(12, 'tools/call', { name: 'prompts_list', arguments: { stage: 'testing' } });
    const data = payloadOf(res);
    ok(!!data && data.prompts.length > 0 && data.prompts.every(p => p.stage === 'testing'),
      'prompts_list 的阶段过滤生效', JSON.stringify(data && data.prompts.map(p => p.stage)));
  }
  {
    const res = await srv.call(13, 'tools/call', { name: 'prompts_search', arguments: { query: '需求', limit: 5 } });
    const data = payloadOf(res);
    ok(!!data && data.total > 0 && data.results.length > 0, 'prompts_search 命中真实内容',
      JSON.stringify({ total: data && data.total }));
  }
  {
    const res = await srv.call(14, 'tools/call', { name: 'prompts_get', arguments: { rel: 'prompts/project-init/需求分析.md' } });
    const data = payloadOf(res);
    ok(!!data && typeof data.body === 'string' && data.body.length > 20, 'prompts_get 返回正文');
    ok(!!data && data.body.includes('需求') && !data.body.includes('---\ntitle:'),
      'prompts_get 返回的是去掉 frontmatter 的正文', JSON.stringify(data && data.body.slice(0, 60)));
    ok(!!data && data.truncated === false, '正常长度的正文不标截断');
  }
  {
    const res = await srv.call(15, 'tools/call', { name: 'workflows_list', arguments: {} });
    const data = payloadOf(res);
    ok(!!data && data.workflows.length >= 2, 'workflows_list 返回工作流', String(data && data.workflows.length));
    const branch = data.workflows.find(w => w.rel.includes('branch-flow-example'));
    ok(!!branch && branch.steps.length === 5, '工作流步骤解析正确（分支示例 5 步）',
      JSON.stringify(branch && branch.steps.length));
    ok(!!branch && branch.steps.some(s => s.next.length === 2), '工作流步骤带上分支（next 数组）',
      JSON.stringify(branch && branch.steps.map(s => s.next)));
    ok(!!branch && Array.isArray(branch.unreachable) && branch.unreachable.length === 0,
      '正常工作的可达性判定为空', JSON.stringify(branch && branch.unreachable));
  }
  {
    const res = await srv.call(16, 'tools/call', { name: 'prompts_references', arguments: { rel: 'prompts/project-init/需求分析.md' } });
    const data = payloadOf(res);
    ok(!!data && Array.isArray(data.referencedBy) && data.referencedBy.length >= 2,
      'prompts_references 给出引用它的工作流', JSON.stringify(data && data.referencedBy));
    const all = await srv.call(17, 'tools/call', { name: 'prompts_references', arguments: {} });
    const allData = payloadOf(all);
    ok(!!allData && typeof allData.danglingCount === 'number', '不带 rel 时返回全库悬空体检',
      JSON.stringify(allData));
  }

  // ---------- 四、只读边界 ----------
  {
    // 路径逃逸：库内但不在内容目录下的文件（config.json 就在数据根目录）
    const res = await srv.call(20, 'tools/call', { name: 'prompts_get', arguments: { rel: '../config.json' } });
    ok(!!res && res.result && res.result.isError === true, '拒绝读取库外的相对路径（../config.json）');
    const res2 = await srv.call(21, 'tools/call', { name: 'prompts_get', arguments: { rel: 'config.json' } });
    ok(!!res2 && res2.result && res2.result.isError === true, '拒绝读取内容目录外的库内文件（config.json）');
    const res3 = await srv.call(22, 'tools/call', { name: 'prompts_get', arguments: { rel: '.versions/x.md' } });
    ok(!!res3 && res3.result && res3.result.isError === true, '拒绝读取版本目录（.versions 以点开头）');
    const res4 = await srv.call(23, 'tools/call', { name: 'prompts_get', arguments: { rel: 'C:/Windows/win.ini' } });
    ok(!!res4 && res4.result && res4.result.isError === true, '拒绝绝对路径');
    // 不存在的文件：报错而不是空正文（空正文会被当成"这个提示词是空的"）
    const res5 = await srv.call(24, 'tools/call', { name: 'prompts_get', arguments: { rel: 'prompts/testing/不存在.md' } });
    ok(!!res5 && res5.result && res5.result.isError === true, '不存在的文件报错而不是返回空正文');
  }

  // ---------- 五、协议细节 ----------
  {
    const res = await srv.call(30, 'tools/call', { name: '不存在的工具', arguments: {} });
    ok(!!res && !!res.error && res.error.code === -32602, '未知工具返回 -32602', JSON.stringify(res && res.error));
  }
  {
    const res = await srv.call(31, '没有这个方法', {});
    ok(!!res && !!res.error && res.error.code === -32601, '未知方法返回 -32601', JSON.stringify(res && res.error));
  }
  {
    // 非法 JSON 只丢那一行，会话继续：整条流断掉的话客户端只能重启 server
    srv.send({ broken: 'this is not json-rpc' });
    srv.child.stdin.write('{ 这不是 JSON\n');
    const after = await srv.call(32, 'ping', {});
    ok(!!after && !!after.result, '收到一行坏 JSON 之后服务仍然可用（不会整条断掉）');
  }
  {
    // 通知（没有 id）不能回响应：JSON-RPC 规定回了就是协议违规
    const before = srv.responses().length;
    srv.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise(r => setTimeout(r, 300));
    ok(srv.responses().length === before, '通知不发响应');
  }
  {
    // id 必须原样回填（客户端靠它对上请求）
    const res = await srv.call('abc-123', 'ping', {});
    ok(!!res && res.id === 'abc-123', 'id 原样回填（字符串 id）', JSON.stringify(res && res.id));
  }

  // ---------- 六、返回内容上限 ----------
  {
    // 造一条超长正文：不能整条塞回去。存在临时目录里的**另一个**库，
    // 不污染被测的真实库。
    const bigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-mcp-big-'));
    fs.mkdirSync(path.join(bigRoot, 'prompts', 'testing'), { recursive: true });
    fs.mkdirSync(path.join(bigRoot, 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(bigRoot, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(bigRoot, 'prompts', 'testing', '超长.md'),
      '---\ntitle: 超长\ntags: [自检]\n---\n' + 'x'.repeat(60000));
    const srv2 = startServer({ PFM_DATA_DIR: bigRoot });
    await srv2.call(1, 'initialize', {});
    const res = await srv2.call(2, 'tools/call', { name: 'prompts_get', arguments: { rel: 'prompts/testing/超长.md' } });
    const data = payloadOf(res);
    ok(!!data && data.truncated === true, '超长正文被截断且明确标注');
    ok(!!data && data.body.length <= 24000, '截断后的正文在上限内（' + (data && data.body.length) + ' 字符）');
    ok(!!data && data.totalChars === 60000, '报告了原始长度（' + (data && data.totalChars) + '）');
    srv2.kill();
    fs.rmSync(bigRoot, { recursive: true, force: true });
  }

  // ---------- 七、库目录不存在时也不能崩 ----------
  {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-mcp-empty-'));
    const srv3 = startServer({ PFM_DATA_DIR: emptyRoot });
    await srv3.call(1, 'initialize', {});
    const res = await srv3.call(2, 'tools/call', { name: 'library_overview', arguments: {} });
    const data = payloadOf(res);
    ok(!!data && data.counts && !data.counts.prompts, '空目录下概览返回零而不是抛错', JSON.stringify(data));
    const res2 = await srv3.call(3, 'tools/call', { name: 'prompts_search', arguments: { query: 'x' } });
    ok(!!res2 && !!res2.result && !res2.result.isError, '空目录下搜索不报错');
    srv3.kill();
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }

  // ---------- 八、子进程正常退出 ----------
  {
    const before = srv.child.exitCode;
    ok(before === null, 'server 在被显式结束前一直活着');
    srv.child.stdin.end();
    await new Promise(r => setTimeout(r, 800));
    ok(srv.child.exitCode === 0, 'stdin 关闭后 server 正常退出（不留孤儿进程）', String(srv.child.exitCode));
  }

  // ---------- 九、反向对照：路径白名单放宽后必须红 ----------
  // 不真的去改 mcp/tools.js（它不是变异脚本管的文件），而是把同一条判定
  // 用一个"只查后缀"的朴素实现再跑一遍上面的逃逸用例：它必须放行 config.json。
  // 这一步证明的是上面那三条"拒绝"的断言有分辨力，不是朴素实现有 bug。
  {
    const { safeLibraryRel } = require(path.join(root, 'mcp', 'tools.js'));
    const naiveSafe = (rel) => {
      const cleaned = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '');
      return cleaned.toLowerCase().endsWith('.md') ? cleaned : null;
    };
    // 朴素实现（只查后缀）拦得住扩展名不对的路径 —— 这一条没有分辨力，写出来是
    // 为了说明"光看 config.json 那两条不足以证明白名单在干活"。
    ok(naiveSafe('../config.json') === null, '朴素实现也拦得住扩展名不对的路径（这条不构成分辨力）');
    // 有分辨力的形状：**合法后缀 + 路径穿越**。白名单必须拦住，朴素实现必然放行。
    ok(naiveSafe('prompts/../secret.md') === 'prompts/../secret.md' && safeLibraryRel('prompts/../secret.md') === null,
      '反向对照：合法后缀 + 路径穿越，白名单拦住而朴素实现放行',
      JSON.stringify({ naive: naiveSafe('prompts/../secret.md'), real: safeLibraryRel('prompts/../secret.md') }));
    ok(safeLibraryRel('.versions/secret.md') === null && naiveSafe('.versions/secret.md') !== null,
      '反向对照：点开头的目录（.versions/.trash）白名单拒绝而朴素实现放行');
  }
  {
    // 上面"拒绝读取内容目录外的库内文件（config.json）"那条要真的有东西可读，
    // 否则它拦的是一个不存在的文件，证明力为零。所以这里造一个临时库：
    // 顶层放 config.json（像真实数据目录那样），另加一个以点开头的目录。
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-mcp-guard-'));
    fs.mkdirSync(path.join(fixture, 'prompts', 'testing'), { recursive: true });
    fs.mkdirSync(path.join(fixture, '.versions'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'drafts'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'config.json'), '{"theme":"dark","secret":"不该被读出来"}');
    fs.writeFileSync(path.join(fixture, 'secret.md'), '库根目录下的 .md，也不该被读出来');
    fs.writeFileSync(path.join(fixture, '.versions', 'secret.md'), '版本目录里的 .md');
    fs.writeFileSync(path.join(fixture, 'logs', 'note.md'), '日志目录里的 .md，也不该被读出来');
    fs.writeFileSync(path.join(fixture, 'drafts', '草稿.md'), '草稿正文，不该被读出来');
    fs.writeFileSync(path.join(fixture, 'prompts', 'testing', 'p.md'), '---\ntitle: P\n---\n正文');
    const srv4 = startServer({ PFM_DATA_DIR: fixture });
    await srv4.call(1, 'initialize', {});
    // logs/ 与 drafts/ 是刻意放进来的：它们在白名单之外，但有两段路径、
    // 也不以点开头，只能靠顶层白名单拦住。
    //
    // 一条实测出来的事实，别误以为这一整段在盯着白名单：把 safeLibraryRel 的
    // 顶层白名单撤掉之后，**这段一条都没红**。因为 prompts_get 还有第二道闸
    // ——rel 必须能在元数据列表里找到，而元数据只来自那三个目录。所以端到端的
    // 拒读是两道闸共同的结果。真正证明白名单本身在干活的是前面那两条直接调
    // safeLibraryRel 的单元断言（撤掉点段检查时它们确实变红了，实测）。
    // 分开写不是绕：端到端不泄漏和第二道闸是绑在一起的，那道闸一改，
    // 只有单元断言还站得住。
    for (const [i, rel] of ['config.json', 'secret.md', '.versions/secret.md', 'prompts/../config.json', 'logs/note.md', 'drafts/草稿.md'].entries()) {
      const res = await srv4.call(10 + i, 'tools/call', { name: 'prompts_get', arguments: { rel } });
      const text = res && res.result && res.result.content ? res.result.content[0].text : '';
      ok(!!res && res.result && res.result.isError === true && !String(text).includes('不该被读出来'),
        '拒绝读取真实存在的库外文件：' + rel);
    }
    // 库内的正常文件要能读出来（否则上面几条"拒绝"可能只是因为整个服务不工作）
    const good = await srv4.call(20, 'tools/call', { name: 'prompts_get', arguments: { rel: 'prompts/testing/p.md' } });
    ok(!!good && !!payloadOf(good) && payloadOf(good).title === 'P', '同一个服务能正常读取库内文件（拒绝不是因为它坏了）');
    srv4.kill();
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  console.log(failures ? `[test:mcp] ${failures} 条失败` : '[test:mcp] 通过');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('[test:mcp] 运行出错：', e);
  process.exit(1);
});
