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
// 第十节是 prompts 能力（斜杠命令）：prompts/list、prompts/get、include 展开、
// 参数填充、撞名、路径边界、截断、分页和协议错误，反向对照写在各条断言旁边。
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
  // 客户端只在声明了 prompts 能力时才会去调 prompts/list，没声明就等于这个功能不存在
  ok(!!init && init.result && init.result.capabilities && !!init.result.capabilities.prompts
    && !init.result.capabilities.prompts.listChanged,
    'initialize 声明了 prompts 能力（不声明 listChanged）', JSON.stringify(init && init.result && init.result.capabilities));
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

  // ---------- 十、prompts 能力：库里的提示词做成斜杠命令 ----------
  //
  // 先用真实库过一遍（种子提示词就是用户会点的那些），再用临时库覆盖真实库里
  // 没有的形状：include 展开、撞名、路径边界、超长正文、分页。
  // 这一节的反向对照有两种：能在测试里直接跑的（朴素实现跑同一批输入必须不同），
  // 写在断言旁边；需要改源码的（删掉某道闸），在提交前手工跑过，结果记在交付说明里。
  const PLACEHOLDERS = require(path.join(root, 'src', 'placeholders.js'));
  const INCLUDES = require(path.join(root, 'src', 'includes.js'));
  const FRONTMATTER = require(path.join(root, 'src', 'frontmatter.js'));
  const { naturalName, assignPromptNames } = require(path.join(root, 'mcp', 'prompts.js'));
  const textOf = (res) => (res && res.result && Array.isArray(res.result.messages) && res.result.messages[0]
    && res.result.messages[0].content ? String(res.result.messages[0].content.text) : null);
  const errCode = (res) => (res && res.error ? res.error.code : null);
  {
    const srv5 = startServer();
    await srv5.call(1, 'initialize', {});
    const res = await srv5.call(2, 'prompts/list', {});
    const prompts = res && res.result && Array.isArray(res.result.prompts) ? res.result.prompts : [];
    const names = prompts.map(p => p.name);
    ok(prompts.length >= 5, 'prompts/list 列出了真实库的提示词（' + prompts.length + ' 条）', JSON.stringify(res && res.error));
    // 能直接当斜杠命令用：Unicode 字母数字加 -，不带空格、斜杠、大写 ASCII
    const badNames = names.filter(n => !/^[\p{L}\p{N}]+(?:--?[\p{L}\p{N}]+)*$/u.test(n) || /[A-Z]/.test(n));
    ok(names.length > 0 && badNames.length === 0, '每个 name 都能当斜杠命令（无空格/斜杠/大写）', JSON.stringify(badNames));
    ok(new Set(names).size === names.length, 'prompt name 全库唯一', JSON.stringify(names));
    ok(names.includes('project-init-需求分析'), '中文文件名保留成可读的 name', JSON.stringify(names));
    // 真实库里 snippets/ 有 8 个片段，放开过滤的话这条立刻红
    ok(!names.some(n => n.startsWith('snippets-')), 'snippets/ 下的片段不列成斜杠命令', JSON.stringify(names));
    const badArgs = prompts.flatMap(p => (p.arguments || [])
      .filter(a => !/^arg\d+(?:_[a-z0-9]+)*$/.test(a.name) || typeof a.description !== 'string' || a.required !== false)
      .map(a => p.name + ':' + JSON.stringify(a)));
    ok(badArgs.length === 0, '每个 argument 都是合法标识符 + 提示语描述 + 非必填', JSON.stringify(badArgs));
    // 具体条数和原文写死：`>= 1` 在"多提取了一个"的情况下照样绿
    const codegen = prompts.find(p => p.name === 'code-generation-功能实现');
    const codegenArgs = codegen ? codegen.arguments.map(a => [a.name, a.description]) : null;
    ok(JSON.stringify(codegenArgs) === JSON.stringify([
      ['arg1_react_typescript_vite', '如 React + TypeScript + Vite'],
      ['arg2', '在此描述要实现的功能'],
      ['arg3', '列出涉及的文件路径，或粘贴现有代码']
    ]), '功能实现的参数按出现顺序从占位符提取', JSON.stringify(codegenArgs));
    ok(!!codegen && codegen.title === '功能实现' && codegen.description === '根据需求拆分任务并生成可运行代码',
      'title / description 取自 frontmatter', JSON.stringify(codegen && { t: codegen.title, d: codegen.description }));
    // 反向对照：不剥 frontmatter 直接 extract，tags 那一行会被当成占位符
    const raw = fs.readFileSync(path.join(dataRoot, 'prompts', 'code-generation', '功能实现.md'), 'utf8');
    ok(PLACEHOLDERS.extract(raw).some(t => t.hint === '编码, 实现, 通用')
      && !!codegen && !codegen.arguments.some(a => a.description === '编码, 实现, 通用'),
      '反向对照：frontmatter 的 tags 不成为参数（不剥 frontmatter 时会）');

    const g = await srv5.call(3, 'prompts/get', { name: 'project-init-需求分析', arguments: { arg1: '做一个记账应用' } });
    const text = textOf(g);
    ok(!!g && !!g.result && g.result.messages.length === 1 && g.result.messages[0].role === 'user'
      && g.result.messages[0].content.type === 'text', 'prompts/get 返回一条 user 文本消息', JSON.stringify(g && (g.error || g.result)).slice(0, 300));
    ok(!!text && text.includes('做一个记账应用') && !text.includes('[在此粘贴你的想法、用户原话、或问题描述]'),
      'prompts/get 把参数填进正文');
    ok(!!text && !text.includes('stage: project-init') && !text.includes('createdAt:'), 'prompts/get 的正文剥掉了 frontmatter');
    ok(!!g && !!g.result && g.result.description === '项目启动阶段梳理需求、明确范围、产出需求清单',
      'prompts/get 的 description 取自 frontmatter', JSON.stringify(g && g.result && g.result.description));
    const g2 = await srv5.call(4, 'prompts/get', { name: 'project-init-需求分析' });
    ok(!!textOf(g2) && textOf(g2).includes('[在此粘贴你的想法、用户原话、或问题描述]'), '没传的参数保留原占位符');
    srv5.kill();
  }
  {
    const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-mcp-prompts-'));
    const w = (rel, text) => {
      const f = path.join(fx, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    };
    const SECRET = '不该被读出来';
    // 库外 / 内容目录外的真实文件：include 闸要拦的是**真的读得到**的东西，
    // 拦一个不存在的文件证明力为零（反向对照里用朴素解析器确认它们都读得到）
    w('config.json', '{"secret":"' + SECRET + '"}');
    w('secret.md', '库根目录的 .md ' + SECRET);
    w('logs/note.md', '日志 ' + SECRET);
    w('.versions/old.md', '旧版本 ' + SECRET);
    w('templates/frag.md', '---\ntitle: 模板片段\n---\n模板片段正文');
    w('prompts/snippets/roles/r.md', '---\ntitle: 角色\nstage: snippets\n---\n你是一位[角色名]。');
    const comboRaw = [
      '---', 'title: 组合提示词', 'description: 带 include 的提示词', 'tags: [甲, 乙]', '---',
      '用 [语言] 调用 [API 名称] 实现。',
      '{{include: prompts/snippets/roles/r.md}}',
      '目标：[在此描述目标]',
      '```', '示例：[语言]', '```', ''
    ].join('\n');
    w('prompts/code-generation/组合.md', comboRaw);
    const boundaryBody = [
      '甲 {{include: config.json}}',
      '乙 {{include: secret.md}}',
      '丙 {{include: logs/note.md}}',
      '丁 {{include: .versions/old.md}}',
      '戊 {{include: prompts/../secret.md}}',
      '己 {{include: templates/frag.md}}',
      // 白名单内但不存在：要报 include error，不能悄悄展开成空串
      '庚 {{include: prompts/testing/不存在.md}}', ''
    ].join('\n');
    w('prompts/testing/越界.md', '---\ntitle: 越界\n---\n' + boundaryBody);
    // 三个自然名相同的文件：空格、连字符、大写 + 下划线
    const clashRels = ['prompts/testing/a b.md', 'prompts/testing/a-b.md', 'prompts/testing/A_B.md'];
    w(clashRels[0], '---\ntitle: 空格版\n---\n正文：空格版');
    w(clashRels[1], '---\ntitle: 连字符版\n---\n正文：连字符版');
    w(clashRels[2], '---\ntitle: 大写版\n---\n正文：大写版');
    w('prompts/testing/超长.md', '---\ntitle: 超长\n---\n' + 'x'.repeat(60000));

    const srv6 = startServer({ PFM_DATA_DIR: fx });
    await srv6.call(1, 'initialize', {});
    const list = await srv6.call(2, 'prompts/list', {});
    const prompts = list && list.result ? list.result.prompts : [];
    const byTitle = (t) => prompts.find(p => p.title === t);
    ok(prompts.length === 6 && !list.result.nextCursor, '临时库列出 6 条且没有下一页',
      JSON.stringify(prompts.map(p => p.name)));
    ok(!prompts.some(p => p.title === '角色'), '临时库里的 snippets 片段同样不列出');

    // ---- 参数提取：展开 include 之后再取 ----
    const combo = byTitle('组合提示词');
    const comboArgs = combo ? combo.arguments.map(a => [a.name, a.description]) : null;
    ok(JSON.stringify(comboArgs) === JSON.stringify([
      ['arg1', '语言'], ['arg2_api', 'API 名称'], ['arg3', '角色名'], ['arg4', '在此描述目标']
    ]), 'include 进来的片段里的占位符也成为参数，按展开后的顺序编号', JSON.stringify(comboArgs));
    // 反向对照：不展开 include 直接 extract，片段里的 [角色名] 不会出现
    ok(!PLACEHOLDERS.extract(FRONTMATTER.strip(comboRaw)).some(t => t.hint === '角色名'),
      '反向对照：不展开 include 时取不到片段里的占位符');

    // ---- prompts/get：include 展开 + 参数填充 ----
    const plain = textOf(await srv6.call(3, 'prompts/get', { name: combo && combo.name }));
    const filled = textOf(await srv6.call(4, 'prompts/get', { name: combo && combo.name, arguments: { arg1: 'Go', arg3: '架构师' } }));
    ok(!!plain && plain.includes('你是一位[角色名]。') && !plain.includes('{{include:') && !plain.includes('title: 角色'),
      'prompts/get 展开了 include（且剥掉了片段的 frontmatter）', JSON.stringify(plain));
    ok(!!filled && filled.includes('用 Go 调用 [API 名称] 实现。') && filled.includes('你是一位架构师。')
      && filled.includes('目标：[在此描述目标]'),
      '传了的参数填进去（含片段里的），没传的保留原样', JSON.stringify(filled));
    ok(!!filled && filled.includes('示例：[语言]'), '代码块里同名的 [语言] 不被替换', JSON.stringify(filled));
    // 反向对照：按 split/join 全文替换会连代码块一起改掉——上一条有分辨力
    ok(!!plain && !plain.split('[语言]').join('Go').includes('示例：[语言]'),
      '反向对照：朴素全文替换会改坏代码块');

    // ---- include 的路径边界 ----
    const bound = byTitle('越界');
    const boundText = textOf(await srv6.call(5, 'prompts/get', { name: bound && bound.name }));
    ok(!!boundText && !boundText.includes(SECRET), 'include 读不到内容目录外的文件（config.json / 库根 / logs / .versions / ..）',
      JSON.stringify(boundText));
    ok(!!boundText && (boundText.match(/include error/g) || []).length === 6,
      '五处越界 + 一处不存在的 include 都留下了 include error 标记', JSON.stringify(boundText));
    ok(!!boundText && boundText.includes('己 模板片段正文'), '白名单内的 templates/ 照常展开（拒绝不是因为 include 坏了）');
    // 反向对照：不过闸、直接按路径读文件的解析器会把这几个文件读出来——
    // 证明上面那条"读不到"拦的是真实可达的文件
    const naive = await INCLUDES.resolveAsync(boundaryBody, async (r) => {
      try { return fs.readFileSync(path.join(fx, r), 'utf8'); } catch { return null; }
    });
    ok(naive.includes(SECRET), '反向对照：不过闸的解析器确实读得到这些文件');
    // 一条实测出来的事实（和第九节那段同一个形状）：只撤掉 include 解析器里的
    // safeLibraryRel，上面"读不到"那条**不会红**——第二道闸 known.has（rel 必须在
    // 元数据列表里，而元数据只来自三个内容目录下的 .md）照样把它们全拦住。
    // 撤掉 known.has 则是"不存在的 include 要报错"那条红。safeLibraryRel 本身的
    // 分辨力由第九节直接调它的单元断言证明。

    // ---- 撞名 ----
    const clash = clashRels.map(rel => ({ rel, title: FRONTMATTER.parse(fs.readFileSync(path.join(fx, rel), 'utf8')).meta.title }))
      .map(x => ({ ...x, p: byTitle(x.title) }));
    const clashNames = clash.map(x => x.p && x.p.name);
    ok(clashNames.every(n => /^testing-a-b--[0-9a-f]{8}$/.test(n || '')) && new Set(clashNames).size === 3,
      '自然名相同的三条全部加路径哈希后缀，互不重名', JSON.stringify(clashNames));
    ok(new Set(clashRels.map(naturalName)).size === 1, '反向对照：这三条的自然名确实相同（不处理撞名就会重名）');
    // macOS 文件名是 NFD：同一个"é"两种编码必须得到同一个 name
    ok(naturalName('prompts/x/cafe\u0301.md') === naturalName('prompts/x/caf\u00e9.md')
      && naturalName('prompts/x/caf\u00e9.md') === 'x-caf\u00e9', 'NFD 与 NFC 文件名得到同一个 name');
    let clashOk = true;
    for (const [i, x] of clash.entries()) {
      const t = textOf(await srv6.call(10 + i, 'prompts/get', { name: x.p && x.p.name }));
      if (!t || !t.includes('正文：' + x.title)) clashOk = false;
    }
    ok(clashOk, '撞名的三条各自取回自己的正文（name 映射没有串）');
    // 稳定性：和遍历顺序无关。"第一个保留原名、后来的加序号"的朴素做法顺序一变名字就变
    const fwd = assignPromptNames(clashRels);
    const rev = assignPromptNames(clashRels.slice().reverse());
    const naiveAssign = (rels) => {
      const seen = new Map();
      const out = new Map();
      for (const r of rels) {
        const b = naturalName(r);
        const n = seen.get(b) || 0;
        out.set(r, n ? b + '-' + (n + 1) : b);
        seen.set(b, n + 1);
      }
      return out;
    };
    ok(clashRels.every(r => fwd.get(r) === rev.get(r)), 'name 与遍历顺序无关');
    ok(clashRels.some(r => naiveAssign(clashRels).get(r) !== naiveAssign(clashRels.slice().reverse()).get(r)),
      '反向对照：朴素的"先到先得"命名换个顺序就变');
    const list2 = await srv6.call(6, 'prompts/list', {});
    ok(JSON.stringify(list2 && list2.result) === JSON.stringify(list.result), '两次 prompts/list 结果完全一致');

    // ---- 正文上限 ----
    const longText = textOf(await srv6.call(7, 'prompts/get', { name: byTitle('超长') && byTitle('超长').name }));
    ok(!!longText && longText.length <= 24000 && longText.includes('正文超长已截断') && longText.includes('共 60000 字符'),
      '超长正文截断到上限内并在正文里注明', String(longText && longText.length));

    // ---- 协议错误 ----
    const comboName = combo && combo.name;
    const bad = [
      ['未知 name', { name: '不存在的提示词' }],
      ['缺 name', {}],
      ['name 不是字符串', { name: 42 }],
      ['arguments 是数组', { name: comboName, arguments: ['Go'] }],
      ['参数值不是字符串', { name: comboName, arguments: { arg1: 3 } }],
      ['未知参数名', { name: comboName, arguments: { arg99: 'x' } }],
      ['snippets 片段不能当 prompt 取', { name: 'snippets-roles-r' }],
      ['rel 路径不是 name', { name: 'prompts/code-generation/组合.md' }],
      ['.. 路径不是 name', { name: '../config' }]
    ];
    for (const [i, [label, params]] of bad.entries()) {
      const r = await srv6.call(30 + i, 'prompts/get', params);
      ok(errCode(r) === -32602 && !r.result, 'prompts/get 拒绝（-32602）：' + label, JSON.stringify(r && (r.error || r.result)).slice(0, 200));
    }
    const badCursor = await srv6.call(40, 'prompts/list', { cursor: 'abc' });
    ok(errCode(badCursor) === -32602, 'prompts/list 拒绝无效 cursor（-32602）', JSON.stringify(badCursor && badCursor.error));
    srv6.kill();
    fs.rmSync(fx, { recursive: true, force: true });
  }
  {
    // 分页：一页 200 条，超过时给 nextCursor。没有分页的话第一页就是 205 条
    const many = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-mcp-many-'));
    fs.mkdirSync(path.join(many, 'prompts', 'testing'), { recursive: true });
    for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(many, 'prompts', 'testing', 'p' + i + '.md'), '正文 ' + i);
    const srv7 = startServer({ PFM_DATA_DIR: many });
    await srv7.call(1, 'initialize', {});
    const p1 = await srv7.call(2, 'prompts/list', {});
    const p2 = await srv7.call(3, 'prompts/list', { cursor: p1 && p1.result && p1.result.nextCursor });
    const n1 = p1 && p1.result ? p1.result.prompts.map(p => p.name) : [];
    const n2 = p2 && p2.result ? p2.result.prompts.map(p => p.name) : [];
    ok(n1.length === 200 && p1.result.nextCursor === '200', 'prompts/list 第一页 200 条并给出 nextCursor', String(n1.length));
    ok(n2.length === 5 && !p2.result.nextCursor && new Set(n1.concat(n2)).size === 205,
      'prompts/list 第二页取完剩余且不重复', String(n2.length));
    srv7.kill();
    fs.rmSync(many, { recursive: true, force: true });
  }

  console.log(failures ? `[test:mcp] ${failures} 条失败` : '[test:mcp] 通过');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('[test:mcp] 运行出错：', e);
  process.exit(1);
});
