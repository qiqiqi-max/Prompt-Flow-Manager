const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-workspace-ui-'));
fs.mkdirSync(path.join(data, 'prompts/testing'), {recursive:true});
fs.mkdirSync(path.join(data, 'workflows'), {recursive:true});
fs.writeFileSync(path.join(data, 'prompts/testing/context.md'), '---\ntitle: Context\n---\n[Project name] [custom=default]');
fs.writeFileSync(path.join(data, 'workflows/context.md'), '---\ntitle: Context flow\nflow:\n  - id: a\n    prompt: prompts/testing/context.md\n    next: b\n  - id: b\n    prompt: prompts/testing/context.md\n---\nFlow');
try {
 const result = spawnSync(require('electron'), [root], {cwd:root, encoding:'utf8', timeout:60000, env:{...process.env, PFM_SELFTEST:'1', PFM_DATA_DIR:data, PFM_UPDATE_CHECK:'off', ELECTRON_ENABLE_LOGGING:'1', PFM_SELFTEST_EVAL:fs.readFileSync(path.join(root,'src/selftest/workspace.js'),'utf8')}});
 const output = result.stdout + result.stderr;
 console.log(output.split('\n').filter(line => /workspace-ui|FAIL/.test(line)).join('\n'));
 if (result.status !== 0 || !output.includes('[workspace-ui] PASS complete')) { console.error(output.slice(-2000)); process.exitCode=1; }
 for(const bytes of ['{"schema":99}','{broken json']) {
  const recovery=fs.mkdtempSync(path.join(os.tmpdir(),'pfm-workspace-recovery-'));
  const filename=path.join(recovery,'projects.json');fs.writeFileSync(filename,bytes);
  try {
   const script="(async()=>{const status=document.getElementById('workspace-error');if(!status || status.classList.contains('hidden') || !status.textContent.trim() || !document.getElementById('workspace-project').disabled)throw new Error('[workspace-recovery] FAIL persistent recovery explanation');if(!document.querySelector('#tree .tree-row'))throw new Error('[workspace-recovery] FAIL library still usable');console.log('[workspace-recovery] PASS complete');})()";
   const run=spawnSync(require('electron'),[root],{cwd:root,encoding:'utf8',timeout:30000,env:{...process.env,PFM_SELFTEST:'1',PFM_DATA_DIR:recovery,PFM_SELFTEST_EVAL:script,ELECTRON_ENABLE_LOGGING:'1',PFM_UPDATE_CHECK:'off'}});
   const output=run.stdout+run.stderr;
   if(run.status!==0 || !output.includes('[workspace-recovery] PASS complete') || fs.readFileSync(filename,'utf8')!==bytes){console.error(output.slice(-1600));process.exitCode=1;}else console.log('[workspace-recovery] PASS unavailable status and original bytes preserved: '+bytes);
  } finally {fs.rmSync(recovery,{recursive:true,force:true});}
 }
} finally { fs.rmSync(data,{recursive:true,force:true}); }
