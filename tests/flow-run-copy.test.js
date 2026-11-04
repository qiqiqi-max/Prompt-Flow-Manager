// 异步读盘、include 和填写期间更换执行状态，旧请求不能写剪贴板或推进新执行。
// 直接运行 renderer 的真实函数，只替换 IPC、剪贴板和弹层这些异步边界。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const FLOW_RUN = require('../src/flow-run');
const FLOW_GRAPH = require('../src/flow-graph');
const FRONTMATTER = require('../src/frontmatter');
const PLACEHOLDERS = require('../src/placeholders');
const INCLUDES = require('../src/includes');
const PROJECT_CONTEXT = require('../src/project-context');
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const functions = ['flowRunContext', 'selectedWorkspaceRun', 'workspaceScope', 'activeWorkspaceProject', 'flowRunStepIssue', 'flowRunAction',
  'copyFlowRunStep', 'copyPromptBody', 'copyContent', 'expandIncludes', 'readIncludeContent'];
const source = (renderer.match(/^let flowRunRevision = 0;$/m) || [''])[0] + '\n' + functions.map(name => {
  const found = renderer.match(new RegExp('^(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?^\\}', 'm'));
  assert(found, 'missing renderer function: ' + name);
  return found[0];
}).join('\n');
const workflow = 'workflows/run.md';
const prompt = 'prompts/testing/first.md';
const steps = [{ id: 'a', prompt, next: ['b'] }, { id: 'b', prompt, next: [] }];
const graph = FLOW_GRAPH.analyze(steps);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function setup() {
  const effects = { copied: [], usage: [], remembered: [] };
  const ctx = vm.createContext({
    FLOW_RUN, FLOW_GRAPH, PLACEHOLDERS, INCLUDES, PROJECT_CONTEXT,
    workspaceHashes: new Map([['first-run','hash']]),
    workflowContentHash: async()=> 'hash',
    state: { previewFills:{}, currentRel: workflow, currentContent: 'workflow', flowRunActive: workflow,
      workspace: {projects:{revision:0,activeProjectId:null,projects:[]},runs:{revision:1,selectedByWorkflow:{[workflow]:'first-run'},runs:[{id:'first-run',revision:1,workflowRel:workflow,availability:'available',contextSnapshot:{values:{}},graphSnapshot:steps,progress:FLOW_RUN.serialize(FLOW_RUN.start(graph))}]}}, metaByRel: new Map([[prompt, {}]]) },
    api: { readFile: async () => ({ content: 'body' }) },
    parseWorkflowFlow: () => steps, parseFrontmatter: FRONTMATTER.parse,
    openNewRun() { ctx.state.workspace.runs.runs[0].id='new-run'; ctx.state.workspace.runs.selectedByWorkflow[workflow]='new-run'; },
    refreshFlowRun() {}, toast() {}, t: key => key, tErr: key => key,
    writeClipboard: async text => { effects.copied.push(text); },
    recordUsage: rel => effects.usage.push(rel),
    rememberScopedFill: async values => { effects.remembered.push(values); return true; },
    promptFillPlaceholders: async () => ({ '[name]': 'value' })
  });
  ctx.workspaceRunAction=async (act,payload) => { const entity=ctx.state.workspace.runs.runs[0]; entity.progress=FLOW_RUN[act](graph,entity.progress); entity.progress.values={...entity.progress.values,...payload.values}; entity.revision++; };
  vm.runInContext(source, ctx);
  return { ctx, effects };
}

(async () => {
  let failures = 0;
  const test = async (name, body) => {
    let timer;
    try {
      // 未兑现的 Promise 不会维持 Node 进程；漏到达异步边界也必须明确失败。
      await Promise.race([
        body(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), 1000); })
      ]);
      console.log('[test:flow-run-copy] PASS ' + name);
    }
    catch (error) { failures++; console.error('[test:flow-run-copy] FAIL ' + name + ': ' + error.message); }
    finally { clearTimeout(timer); }
  };
  for (const [boundary, action] of [['read', 'skip'], ['read', 'exit'], ['read', 'restart'], ['read', 'switch'],
    ['include', 'skip'], ['form', 'restart']]) {
    await test(boundary + ' pending then ' + action + ' discards stale copy', async () => {
      const { ctx, effects } = setup();
      const entered = deferred();
      const release = deferred();
      ctx.api.readFile = async rel => {
        if (boundary === 'read' || (boundary === 'include' && rel !== prompt)) {
          entered.resolve();
          await release.promise;
        }
        return { content: boundary === 'include' && rel === prompt
          ? '{{include: prompts/snippets/slow.md}}' : boundary === 'form' ? '[name]' : 'old body' };
      };
      ctx.promptFillPlaceholders = async () => { entered.resolve(); await release.promise; return { '[name]': 'old value' }; };
      const copying = ctx.copyFlowRunStep();
      await entered.promise;
      if (action === 'switch') ctx.state.currentRel = 'workflows/other.md';
      else await ctx.flowRunAction(action);
      release.resolve();
      await copying;
      assert.deepEqual(effects, { copied: [], usage: [], remembered: [] });
      if (action === 'restart') assert.equal(ctx.state.workspace.runs.runs[0].progress.current, 'a');
    });
  }
  await test('two pending copies only let the newest request complete', async () => {
    const { ctx, effects } = setup();
    const reads = [deferred(), deferred()];
    let index = 0; const entered=deferred();
    ctx.api.readFile = () => {entered.resolve(); return reads[index++].promise;};
    const oldCopy = ctx.copyFlowRunStep();
    await entered.promise;
    const newCopy = ctx.copyFlowRunStep();
    reads[1].resolve({ content: 'new body' });
    await newCopy;
    reads[0].resolve({ content: 'old body' });
    await oldCopy;
    assert.deepEqual(effects.copied, ['new body']);
    assert.deepEqual(effects.usage, [prompt]);
    assert.equal(ctx.state.workspace.runs.runs[0].progress.current, 'b');
  });
  await test('unchanged execution copies and advances exactly once', async () => {
    const { ctx, effects } = setup();
    await ctx.copyFlowRunStep();
    assert.deepEqual(effects.copied, ['body']);
    assert.deepEqual(effects.usage, [prompt]);
    assert.equal(ctx.state.workspace.runs.runs[0].progress.current, 'b');
  });
  await test('both clipboard methods failing never advances or remembers', async () => {
    const {ctx,effects}=setup();
    ctx.navigator={clipboard:{writeText:async()=>{throw new Error('denied');}}};
    ctx.document={createElement:()=>({select(){}}),body:{appendChild(){},removeChild(){}},execCommand:()=>false};
    vm.runInContext(renderer.match(/^async function writeClipboard\(text\) \{[\s\S]*?^\}/m)[0],ctx);
    await ctx.copyFlowRunStep();
    assert.equal(ctx.state.workspace.runs.runs[0].progress.current,'a');
    assert.deepEqual(effects,{copied:[],usage:[],remembered:[]});
  });
  await test('clipboard success with store failure leaves progress unchanged and reports failure', async () => {
    const {ctx,effects}=setup(); const messages=[];
    ctx.toast=message=>messages.push(message);
    ctx.workspaceRunAction=async()=>{throw new Error('E_WORKSPACE_WRITE');};
    await ctx.copyFlowRunStep();
    assert.deepEqual(effects.copied,['body']);
    assert.equal(ctx.state.workspace.runs.runs[0].progress.current,'a');
    assert(messages.includes('workspaceCopiedNotSaved'));
  });
  await test('changed workflow hash cannot copy before explicit resume',async()=> { const {ctx,effects}=setup(); ctx.workflowContentHash=async()=> 'changed'; await ctx.copyFlowRunStep(); assert.deepEqual(effects,{copied:[],usage:[],remembered:[]}); assert.equal(ctx.state.workspace.runs.runs[0].progress.current,'a'); });
  await test('ordinary clipboard failure returns false with visible error and no memory or usage',async()=> { const {ctx,effects}=setup(); const messages=[]; ctx.toast=message=>messages.push(message); ctx.state.currentContent='[name]'; ctx.navigator={clipboard:{writeText:async()=>{throw new Error('denied');}}}; ctx.document={createElement:()=>({select(){}}),body:{appendChild(){},removeChild(){}},execCommand:()=>false}; vm.runInContext(renderer.match(/^async function writeClipboard\(text\) \{[\s\S]*?^\}/m)[0],ctx); assert.equal(await ctx.copyContent(),false); assert.deepEqual(effects,{copied:[],usage:[],remembered:[]}); assert(messages.includes('workspaceCopyFailed')); });
  process.exitCode = failures ? 1 : 0;
})();
