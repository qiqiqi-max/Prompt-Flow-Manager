// Actual browser editing: native paste must preserve the attempted text, and every
// submit path must refuse it before clipboard or workspace mutation can happen.
async function runMain({ mainWin, clipboard, check, sleep, inMain }) {
  const long = 'LOG-BEGIN\n' + 'x'.repeat(24982) + '\nLOG-END';
  const paste = async (id, value) => {
    await inMain(`(() => { const input = document.getElementById(${JSON.stringify(id)}); input.focus(); input.select(); })()`);
    clipboard.writeText(value);
    mainWin.webContents.paste();
    await sleep(80);
  };
  const inspect = (id, value, max, buttonIds) => inMain(`(() => {
    const input = document.getElementById(${JSON.stringify(id)});
    const error = input && document.getElementById(input.getAttribute('aria-describedby'));
    return !!input && input.value === ${JSON.stringify(value)} && input.getAttribute('aria-invalid') === 'true'
      && !!error && error.offsetHeight > 0 && error.textContent.includes('Too long: ${value.length} / ${max}')
      && ${JSON.stringify(buttonIds)}.every(id => document.getElementById(id).disabled);
  })()`);
  const workspace = () => inMain('window.promptFlowApi.getWorkspace().then(value => JSON.stringify(value))');
  for (const field of ['name', 'description', 'stack', 'path', 'constraints']) {
    await inMain('$("workspace-manage").click(); $("project-new").click(); $("project-name").value="Length project"; true');
    const value = field === 'name' ? 'n'.repeat(201) : long;
    const before = await workspace();
    await paste('project-' + field, value);
    const feedback = await inspect('project-' + field, value, field === 'name' ? 200 : 20000, ['project-save']);
    await inMain('$("project-save").click(); true');
    await sleep(100);
    check('长度保护 project-' + field, feedback && await workspace() === before);
    await inMain('$("workspace-close").click(); true');
  }
  await inMain('window.promptFlowApi.createFile("workflows/length-check.md", "---\\ntitle: Length check\\nflow:\\n  - id: a\\n---\\nFlow").then(() => refreshTree()).then(() => openFile("workflows/length-check.md"))');
  await inMain('document.querySelector("[data-run-act=start]").click(); true');
  const beforeRun = await workspace();
  await paste('run-name', 'r'.repeat(201));
  const runFeedback = await inspect('run-name', 'r'.repeat(201), 200, ['run-save']);
  await inMain('$("run-save").click(); true');
  await sleep(100);
  check('长度保护 run-name', runFeedback && await workspace() === beforeRun);
  await inMain('if ($("workspace-close")) $("workspace-close").click(); true');
  await inMain('window.promptFlowApi.createFile("prompts/testing/length-check.md", "---\\ntitle: Length check\\n---\\n[log]").then(() => refreshTree()).then(() => openFile("prompts/testing/length-check.md"))');
  for (const inline of [false, true]) {
    const inputId = inline ? 'ctx-input' : 'fill-in-0';
    const okId = inline ? 'ctx-ok' : 'fill-ok';
    await inMain(inline ? 'document.querySelector("mark.ph").click(); true' : 'copyContent(); true');
    await sleep(100);
    const before = await workspace();
    await paste(inputId, long);
    const feedback = await inspect(inputId, long, 20000, inline ? [okId] : [okId, 'fill-raw']);
    const sentry = 'DO-NOT-COPY-PREFIX-' + inputId;
    clipboard.writeText(sentry);
    await inMain(`(() => { document.getElementById('${okId}').click(); const input = document.getElementById('${inputId}'); if (input) input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', ctrlKey:${!inline}, bubbles:true, cancelable:true})); })()`);
    await sleep(100);
    check('长度保护 ' + (inline ? 'inline' : 'main-fill'), feedback && clipboard.readText() === sentry && await workspace() === before
      && await inMain(`!!document.getElementById('${inputId}') && !Object.keys(state.previewFills[state.currentRel] || {}).length`));
    let corrected = false;
    if (await inMain(`!!document.getElementById('${inputId}')`)) {
      await paste(inputId, 'v'.repeat(20000));
      clipboard.writeText('WAIT-FOR-CORRECTED-COPY-' + inputId);
      await inMain(`document.getElementById('${okId}').click(); true`);
      await sleep(100);
      if (inline && await inMain('!document.getElementById("ctx-input")')) await inMain('copyContent()');
      corrected = clipboard.readText() === 'v'.repeat(20000);
    }
    check('长度修正 ' + (inline ? 'inline' : 'main-fill'), corrected);
    await inMain('if (pendingPromptDone) pendingPromptDone(null); state.previewFills={}; true');
  }
  await inMain('setLang("zh").then(() => { $("workspace-manage").click(); $("project-new").click(); })');
  await paste('project-name', '中'.repeat(201));
  check('长度反馈中文', await inMain('(() => { const input=$("project-name"); const error=document.getElementById(input.getAttribute("aria-describedby")); return !!error && error.textContent.includes("内容过长：201 / 200") && $("project-save").disabled; })()'));
  await paste('project-name', 'n'.repeat(200));
  for (const [field, character] of [['description', 'd'], ['stack', 's'], ['path', 'p'], ['constraints', 'c']]) await paste('project-' + field, character.repeat(20000));
  await inMain('$("project-save").click(); true');
  await sleep(150);
  check('长度修正 project-fields', await inMain('window.promptFlowApi.getWorkspace().then(ws => ws.projects.projects.some(p => p.name === "n".repeat(200) && p.description === "d".repeat(20000) && p.stack === "s".repeat(20000) && p.path === "p".repeat(20000) && p.constraints === "c".repeat(20000)))'));
  await inMain('$("workspace-close").click(); setLang("en")');
  await inMain('openFile("workflows/length-check.md").then(() => { if (document.querySelector("[data-run-act=exit]")) document.querySelector("[data-run-act=exit]").click(); document.querySelector("[data-run-act=start],[data-run-act=restart]").click(); })');
  await paste('run-name', 'r'.repeat(200));
  await inMain('$("run-save").click(); true');
  await sleep(150);
  check('长度修正 run-name', await inMain('window.promptFlowApi.getWorkspace().then(ws => ws.runs.runs.some(run => run.name === "r".repeat(200)))'));
}

async function runPanel({ panel, clipboard, check, sleep, inPanel, inMain, visible }) {
  check('长度合法预填可立即提交 quick-fill', await inPanel('(() => { const inputs=[...document.querySelectorAll("#ql-fill textarea")]; const buttons=[...document.querySelectorAll(".ql-fill-actions button")]; return inputs.length>0 && inputs.every(input=>input.value.length<=20000) && buttons.length===2 && buttons.every(button=>!button.disabled); })()'));
  const long = 'q'.repeat(25000);
  await inPanel('(() => { const input=document.querySelector("#ql-fill textarea"); input.focus(); input.select(); })()');
  clipboard.writeText(long);
  panel.webContents.paste();
  await sleep(100);
  const before = await inMain('window.promptFlowApi.getWorkspace().then(value => JSON.stringify(value))');
  const feedback = await inPanel('(() => { const input=document.querySelector("#ql-fill textarea"); const error=document.getElementById(input.getAttribute("aria-describedby")); return input.value === "q".repeat(25000) && input.getAttribute("aria-invalid")==="true" && !!error && error.offsetHeight>0 && error.textContent.includes("Too long: 25000 / 20000") && [...document.querySelectorAll(".ql-fill-actions button")].every(button=>button.disabled); })()');
  const sentry = 'DO-NOT-COPY-PREFIX-QUICK'; clipboard.writeText(sentry);
  await inPanel('(() => { document.querySelector(".ql-fill-actions .primary").click(); document.querySelector("#ql-fill textarea").dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",ctrlKey:true,bubbles:true,cancelable:true})); })()');
  await sleep(100);
  check('长度保护 quick-fill', feedback && visible() && clipboard.readText() === sentry && before === await inMain('window.promptFlowApi.getWorkspace().then(value => JSON.stringify(value))'));
  await inPanel('(() => { const input=document.querySelector("#ql-fill textarea"); input.focus(); input.select(); })()');
  clipboard.writeText('q'.repeat(20000));
  panel.webContents.paste();
  await sleep(100);
  check('长度修正 quick-fill', await inPanel('(() => { const input=document.querySelector("#ql-fill textarea"); const error=document.getElementById(input.getAttribute("aria-describedby")); return input.value === "q".repeat(20000) && input.getAttribute("aria-invalid")==="false" && !!error && !error.textContent && [...document.querySelectorAll(".ql-fill-actions button")].every(button=>!button.disabled); })()'));
  await inPanel('(() => { const input=document.querySelector("#ql-fill textarea"); input.value=""; input.dispatchEvent(new Event("input",{bubbles:true})); })()');
}

module.exports = { runMain, runPanel };
