// Exercise actual renderer/quick-panel code at asynchronous IPC boundaries.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const FRONTMATTER = require('../src/frontmatter');
const PLACEHOLDERS = require('../src/placeholders');
const PROJECT_CONTEXT = require('../src/project-context');
const INCLUDES = require('../src/includes');
const renderer = fs.readFileSync(require.resolve('../src/renderer.js'),'utf8');
const quick = fs.readFileSync(require.resolve('../src/quick-launch.js'),'utf8');
const deferred=()=> {let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve};};
const extract=name=> { const found=renderer.match(new RegExp('^(?:async )?function '+name+'\\([^)]*\\) \\{[\\s\\S]*?^\\}','m')); assert(found,'function '+name); return found[0]; };
const snapshot=(projectRevision,runRevision)=>({projects:{revision:projectRevision,activeProjectId:'a',projects:[{id:'a',revision:projectRevision,name:'A',values:{}}]},runs:{revision:runRevision,selectedByWorkflow:{},runs:[]},warnings:[]});
function rendererContext(source=renderer) {
 const ctx=vm.createContext({state:{workspace:snapshot(2,2),fillMemory:{},previewFills:{},currentRel:'prompts/a.md',workspaceBusy:0},
   api:{},renderWorkspaceControls(){},refreshFlowRun(){},renderContent(){},PROJECT_CONTEXT,window:{}});
 const functions=['activeWorkspaceProject','selectedWorkspaceRun','applyWorkspaceSnapshot','workspaceMutation','workspaceProjectAction'];
 vm.runInContext('let flowRunRevision=0; const workspacePending=new Set(); const workspaceHashes=new Map();\n'+functions.map(name=>source===renderer?extract(name):source.match(new RegExp('^(?:async )?function '+name+'\\([^)]*\\) \\{[\\s\\S]*?^\\}','m'))[0]).join('\n'),ctx);
 const flush=source.match(/window\.__pfmFlushPending = async \(\) => \{[\s\S]*?^\};/m)[0];
 for(const name of ['saveExpandedPathsDebounced','saveTabsDebounced','saveRecentDebounced','saveLockedDebounced','saveSidebarWidthDebounced','saveFillMemoryDebounced']) ctx[name]={flush:async()=>{}};
 vm.runInContext(flush,ctx); return ctx;
}
async function monotonic(source=renderer) {
 const ctx=rendererContext(source);
 ctx.applyWorkspaceSnapshot(snapshot(1,3));
 assert.equal(ctx.state.workspace.projects.revision,2);
 assert.equal(ctx.state.workspace.runs.revision,3);
 ctx.applyWorkspaceSnapshot(snapshot(4,1));
 assert.equal(ctx.state.workspace.projects.revision,4);
 assert.equal(ctx.state.workspace.runs.revision,3);
}
async function pendingClose(source=renderer) {
 const ctx=rendererContext(source); const gate=deferred();
 ctx.api.projectAction=async()=> {await gate.promise;return snapshot(3,2);};
 const before=vm.runInContext('flowRunRevision',ctx);
 const saving=ctx.workspaceProjectAction('select',{id:'a',revision:2});
 assert(vm.runInContext('flowRunRevision',ctx)>before,'selection invalidates before IPC resolves');
 let closed=false; const close=ctx.window.__pfmFlushPending().then(()=>{closed=true;});
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(closed,false,'close must await actual mutation');
 gate.resolve();await saving;await close;
 assert.equal(ctx.state.workspace.projects.revision,3);
}
function element(tag='div') {
 const node={tagName:tag.toUpperCase(),children:[],events:{},value:'',dataset:{},style:{},scrollHeight:40,classList:{add(){},remove(){},toggle(){}},setAttribute(){},focus(){},select(){},scrollIntoView(){},appendChild(child){this.children.push(child);},addEventListener(name,fn){this.events[name]=fn;},querySelectorAll(selector){return this.children.flatMap(child=>[child,...child.querySelectorAll(selector)]).filter(child=>selector==='.ql-item' ? child.className==='ql-item' : false);}};
 Object.defineProperty(node,'textContent',{get(){return this.text||'';},set(value){this.text=value;this.children=[];}});return node;
}
async function capturedQuickToken(source=quick) {
 const ids=new Map();const get=id=> {if(!ids.has(id)) ids.set(id,element(id==='ql-input'?'input':'div'));return ids.get(id);};
 let show;let latest;const calls=[];const accepted=[];
 const qlApi={onShow(fn){show=fn;},hide(){},search:async()=>[{rel:'prompts/a.md',name:'A'}],readFile:async()=>({content:'[Project name]'}),copy:async(text,rel,token)=>{calls.push(token);if(!token)token=latest;if(token.showGeneration!==latest.showGeneration)throw new Error('stale');accepted.push(text);}};
 const ctx=vm.createContext({window:{quickLaunchApi:qlApi},document:{getElementById:get,createElement:element,querySelectorAll:()=>[],documentElement:{style:{setProperty(){}}},body:{},addEventListener(){}},I18N:{zh:{},en:{}},FRONTMATTER,PLACEHOLDERS,PROJECT_CONTEXT,INCLUDES,setTimeout,clearTimeout,requestAnimationFrame:fn=>fn()});
 vm.runInContext(source,ctx);
 get('ql-input').value='A';latest={showGeneration:1,workspaceRevision:{projectsRevision:1,runsRevision:1}};
 show({...latest,contextSnapshot:{name:'Project A',values:{}},fillMemory:{}});
 await new Promise(resolve=>setTimeout(resolve,10));
 get('ql-input').events.keydown({key:'Enter',preventDefault(){}});
 await new Promise(resolve=>setTimeout(resolve,10));
 const actions=get('ql-fill').children.find(node=>node.className==='ql-fill-actions');assert(actions,'fill opened');
 const oldRaw=actions.children[0];
 latest={showGeneration:2,workspaceRevision:{projectsRevision:2,runsRevision:1}};
 show({...latest,contextSnapshot:{name:'Project B',values:{}},fillMemory:{}});
 oldRaw.events.click();await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(calls.length,1);assert.equal(calls[0].showGeneration,1,'old form passes its captured generation');assert.deepEqual(accepted,[],'old form cannot copy under latest generation');
}
(async()=> {
 for(const [name,test] of [['monotonic documents',monotonic],['pending mutation close',pendingClose],['captured quick token',capturedQuickToken]]) {await test();console.log('[workspace-ui-unit] PASS '+name);}
 for(const [name,test,source] of [
  ['old project snapshot',monotonic,renderer.replace('snapshot.projects.revision >= old.projects.revision','true')],
  ['pending close omitted',pendingClose,renderer.replace('while (workspacePending.size) await Promise.allSettled([...workspacePending]);','')],
  ['quick token omitted',capturedQuickToken,quick.replace('await qlApi.copy(text, rel, token);','await qlApi.copy(text, rel);')]
 ]) {let failed=false;try{await test(source);}catch{failed=true;}assert(failed,'reverse must fail: '+name);console.log('[workspace-ui-unit] PASS reverse '+name);}
})().catch(error=> {console.error('[workspace-ui-unit] FAIL '+error.stack);process.exitCode=1;});
