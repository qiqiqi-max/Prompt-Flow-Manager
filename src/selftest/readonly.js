(async () => {
            const api = window.promptFlowApi;
            const out = { files: [], errors: [], searches: [], flows: [] };
            const metas = await api.getMetaList();
            for (const item of metas) {
              try {
                const { content, meta } = await api.readFile(item.rel);
                const html = renderMarkdown(content.replace(/^---[\s\S]*?---\r?\n?/, ''));
                const rec = {
                  rel: item.rel,
                  bytes: content.length,
                  title: meta.title || null,
                  version: meta.version == null ? null : meta.version,
                  htmlLen: html.length
                };
                if (item.top === 'workflows') {
                  const steps = parseWorkflowFlow(content);
                  rec.flowSteps = steps.length;
                  // 真正把流程图渲染一遍并数节点数，只在游离元素里做，不动界面
                  const probe = document.createElement('div');
                  probe.innerHTML = renderFlowDiagram(steps, meta.title || item.rel);
                  const nodes = probe.querySelectorAll('[data-flow-node], .flow-node').length;
                  const brokenLinks = [];
                  for (const s of steps) {
                    if (!s.prompt) { brokenLinks.push(s.id + ' 缺 prompt'); continue; }
                    const target = s.prompt.startsWith('prompts/') ? s.prompt : 'prompts/' + s.prompt;
                    if (!metas.some(mm => mm.rel === target)) brokenLinks.push(s.id + ' → ' + s.prompt + '（文件不存在）');
                  }
                  out.flows.push({ rel: item.rel, steps: steps.length,
                    missing: steps.filter(s => !s.prompt).length, nodes, brokenLinks });
                }
                out.files.push(rec);
              } catch (e) {
                out.errors.push(item.rel + ' → ' + (e && e.message ? e.message : String(e)));
              }
            }
            for (const q of ['需求', 'prompt', '代码', 'zzz_no_match_zzz']) {
              try { out.searches.push({ q, hits: (await api.search(q)).length }); }
              catch (e) { out.errors.push('search(' + q + ') → ' + e.message); }
            }
            return out;
          })()
