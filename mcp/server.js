#!/usr/bin/env node
// Prompt Flow Manager 的只读 MCP server（stdio）。
//
// 定位：把本地提示词库**暴露给**别的 AI 工具（Claude Code / Codex / 任何支持
// MCP 的客户端），让它们按需查"我库里有哪些提示词、某条讲了什么、哪个工作流
// 用它"。应用本身仍然不调用任何 AI 服务——数据流向是使用者来读我们，不是我们
// 出去调模型。这条边界见 README 的"适用场景"与 CLAUDE.md 的项目简介。
//
// 传输是 stdio 上的行分隔 JSON-RPC 2.0（MCP 的 stdio 传输：一行一条消息）。
// 没有用官方 SDK：这个项目运行时只有两个依赖（archiver / yauzl），为了一个
// 只读服务再拉进一棵依赖树不划算，而这里需要的协议面很窄——
// initialize / tools/list / tools/call / ping，加上 notify 的忽略即可。
//
// 用法（在 MCP 客户端里配置）：
//   {
//     "mcpServers": {
//       "prompt-flow-manager": {
//         "command": "node",
//         "args": ["<仓库绝对路径>/mcp/server.js"],
//         "env": { "PFM_DATA_DIR": "<可选：指向要暴露的提示词库>" }
//       }
//     }
//   }
// 不设 PFM_DATA_DIR 时用环境变量 PFM_LIBRARY_DIR，再退回仓库目录本身——
// 和开发模式下主进程的数据目录一致（见 electron-main.js 的 DATA_ROOT 说明：
// 打包版数据在 userData，那种情况下请显式指明目录）。
const path = require('path');
const { createLibrary } = require('../lib/library.js');
const workflowIndex = require('../lib/workflow-index.js');
const flowGraph = require('../src/flow-graph.js');
const FRONTMATTER = require('../src/frontmatter.js');
const { toolDefinitions, createHandlers } = require('./tools.js');

const SERVER_INFO = { name: 'prompt-flow-manager', version: require('../package.json').version };
const PROTOCOL_VERSION = '2024-11-05';

const dataRoot = path.resolve(
  process.env.PFM_DATA_DIR || process.env.PFM_LIBRARY_DIR || path.join(__dirname, '..')
);

const library = createLibrary({
  dataRoot,
  parseFrontmatter: (c) => FRONTMATTER.parse(c),
  stripFrontmatter: (c) => FRONTMATTER.strip(c)
});
const handlers = createHandlers({ library, workflowIndex, dataRoot, parseFrontmatter: (c) => FRONTMATTER.parse(c), flowGraph });

// 写响应。JSON-RPC 的 id 必须原样回填，通知（没有 id）不回。
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

// 处理一条请求。返回 Promise，调用方不做并发控制——stdio 上请求是顺序来的，
// 而每个工具都是一次目录遍历级的只读操作，排队即可。
async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return; // 通知，不回
    case 'ping':
      if (!isNotification) reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: toolDefinitions() });
      return;
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const handler = handlers[name];
      if (!handler) {
        replyError(id, -32602, '未知的工具: ' + String(name));
        return;
      }
      try {
        const result = await handler(args);
        reply(id, result);
      } catch (e) {
        // 工具内部抛错不当协议错误：把它作为 isError 的结果回给调用方，
        // 这样模型能看到"这一步失败了"，而不是整条会话断掉。
        reply(id, { isError: true, content: [{ type: 'text', text: '工具执行失败: ' + String(e && e.message ? e.message : e) }] });
      }
      return;
    }
    default:
      if (!isNotification) replyError(id, -32601, '不支持的方法: ' + String(method));
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // 一行解析不出来只丢这一行。整条流断掉的话，客户端只能重启 server，
      // 而它多半是因为别的原因写坏了一行。
      replyError(null, -32700, 'JSON 解析失败');
      continue;
    }
    handle(msg).catch((e) => {
      if (msg && msg.id !== undefined) replyError(msg.id, -32603, String(e && e.message ? e.message : e));
    });
  }
});
// stdin 结束 = 客户端退出，跟着退。不断开的话会留下一个没人管的进程。
process.stdin.on('end', () => process.exit(0));
