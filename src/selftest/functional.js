(async () => {
    const api = window.promptFlowApi;
    const out = [];
    const check = (name, ok, detail) => out.push([name, !!ok, detail || '']);
    const expectThrow = async (name, fn) => {
      try { await fn(); check(name, false, '本应抛错但成功了'); }
      catch (e) { check(name, true); }
    };
    const rel = 'prompts/testing/自检临时.md';
    try {
      // 1. 新建
      await api.createFile(rel, '---\ntitle: 自检临时\nstage: testing\n---\n第一版正文');
      let read = await api.readFile(rel);
      check('新建提示词并自动写入 frontmatter', read.meta.version === 1 && !!read.meta.createdAt, JSON.stringify(read.meta));

      // 2. 保存 → 产生版本快照 + version 自增
      await api.saveFile(rel, read.content.replace('第一版正文', '第二版正文'));
      read = await api.readFile(rel);
      check('保存后 version 自增', read.meta.version === 2, 'version=' + read.meta.version);
      check('保存后正文已更新', read.content.includes('第二版正文'));

      let versions = await api.listVersions(rel);
      check('保存产生了 1 条历史版本', versions.length === 1, '共 ' + versions.length + ' 条');
      const oldVersion = await api.readVersion(rel, versions[0].file);
      check('历史版本存的是修改前的内容', oldVersion.includes('第一版正文'));

      // 3. 星标
      await api.pinVersion(rel, versions[0].file, true);
      versions = await api.listVersions(rel);
      check('版本可星标', versions[0].pinned === true);

      // 4. 回滚
      await api.rollbackVersion(rel, versions[0].file);
      read = await api.readFile(rel);
      check('回滚后正文回到旧版', read.content.includes('第一版正文'));
      versions = await api.listVersions(rel);
      check('回滚前的内容也被存成新版本（不丢）', versions.length === 2, '共 ' + versions.length + ' 条');

      // 5. 锁定：主进程必须拦住删除
      await api.setConfig({ lockedFiles: [rel] });
      await expectThrow('已锁定的文件删不掉（主进程强制）', () => api.trash(rel));

      // 6. 锁定状态下改名，锁要跟着走
      const renamed = 'prompts/testing/自检改名.md';
      await api.rename(rel, renamed);
      const cfg = await api.getConfig();
      check('改名后锁跟随文件', Array.isArray(cfg.lockedFiles) && cfg.lockedFiles.includes(renamed), JSON.stringify(cfg.lockedFiles));
      await expectThrow('改名后依然删不掉（无法绕过锁）', () => api.trash(renamed));
      const renamedVersions = await api.listVersions(renamed);
      check('改名后版本历史跟随', renamedVersions.length === 2, '共 ' + renamedVersions.length + ' 条');

      // 7. 解锁 → 删除 → 回收站 → 恢复
      await api.setConfig({ lockedFiles: [] });
      await api.trash(renamed);
      let trash = await api.listTrash();
      const item = trash.items.find(i => i.originalRel === renamed);
      check('删除进入回收站', !!item);
      await api.restore(item.id);
      const restored = await api.readFile(renamed);
      check('从回收站恢复成功', restored.content.includes('第一版正文'));
      check('恢复后版本历史也回来了', (await api.listVersions(renamed)).length === 2);

      // 8. 搜索与元数据
      const hits = await api.search('第一版正文');
      check('全文搜索命中正文', hits.some(h => h.rel === renamed), '命中 ' + hits.length + ' 条');

      // 8b. 正文缓存的失效验证：改完内容立刻搜，必须搜到新的、搜不到旧的。
      // 这是加缓存后最容易出的回归。
      const cur = await api.readFile(renamed);
      await api.saveFile(renamed, cur.content.replace('第一版正文', '缓存失效验证文本'));
      const newHits = await api.search('缓存失效验证文本');
      check('保存后立刻能搜到新内容（缓存已失效）', newHits.some(h => h.rel === renamed), '命中 ' + newHits.length + ' 条');
      const oldHits = await api.search('第一版正文');
      check('保存后搜不到旧内容（没有读到缓存旧值）', !oldHits.some(h => h.rel === renamed), '命中 ' + oldHits.length + ' 条');
      // 恢复内容，后面的导出/导入断言依赖它
      await api.saveFile(renamed, cur.content);
      check('内容已还原', (await api.readFile(renamed)).content.includes('第一版正文'));
      const metas = await api.getMetaList();
      check('元数据列表包含该文件', metas.some(m => m.rel === renamed));
      const tree = await api.listTree();
      check('文件树包含 prompts/workflows/templates 三个根', tree.length === 3);

      // 9. 越权防护 + 错误码本地化
      // 主进程抛的是 E_XXX|detail，渲染进程要能翻成当前语言；翻不出来才回退原文。
      const codeCheck = async (name, fn, expectCode) => {
        try { await fn(); check(name, false, '本应抛错'); }
        catch (e) {
          const shown = describeError(e);
          // 这里必须是 '\\b'（字符串里留下 \b 两个字符）才是正则的单词边界。
          // 原先写成 '\b'，那是退格符 U+0008——正则变成"退格 + E_XXX + 退格"，
          // 任何正常文案都命中不了，stillRaw 恒为 false，下面 4 条断言恒绿。
          // 这个错是被模板字符串藏起来的：那时源码写的是 '\\b'，看着像转义正确，
          // 但模板先把 \\b 还原成 \b 再交给 executeJavaScript，执行到的就是退格符。
          const stillRaw = new RegExp('\\b' + expectCode + '\\b').test(shown);
          check(name, !stillRaw, stillRaw ? '未翻译，仍是: ' + shown : shown);
        }
      };
      await codeCheck('E_PATH_ESCAPE 已本地化', () => api.readFile('../../../../Windows/win.ini'), 'E_PATH_ESCAPE');
      await codeCheck('E_LOCKED 已本地化', async () => {
        await api.setConfig({ lockedFiles: [renamed] });
        try { await api.trash(renamed); } finally { await api.setConfig({ lockedFiles: [] }); }
      }, 'E_LOCKED');
      await codeCheck('E_FILE_EXISTS 已本地化', () => api.createFile(renamed, 'x'), 'E_FILE_EXISTS');
      await codeCheck('E_BAD_VERSION_FILE 已本地化', () => api.readVersion(renamed, 'not-a-version.md'), 'E_BAD_VERSION_FILE');

      await expectThrow('拒绝读取库外文件（路径穿越）', () => api.readFile('../../../../Windows/win.ini'));
      await expectThrow('拒绝写入库外文件', () => api.saveFile('../../../evil.md', 'x'));
      await expectThrow('拒绝非法的版本文件名', () => api.readVersion(renamed, '../../../../Windows/win.ini'));

      // 10. 工程类型增删
      const before = (await api.getConfig()).projectTypes.length;
      await api.addProjectType('自检类型');
      check('可新增工程类型', (await api.getConfig()).projectTypes.includes('自检类型'));
      await api.removeProjectType('自检类型');
      check('可移除工程类型', (await api.getConfig()).projectTypes.length === before);
      await expectThrow('重复类型名被拒绝', async () => {
        await api.addProjectType('重复项');
        await api.addProjectType('重复项');
      });

      // 11. 导出 / 导入往返（依赖对话框桩，见 installSelfTestDialogStubs）
      // 这四个流程原先只能人工点，现在把 dialog 换成桩后可以全自动验证。
      if (window.__pfmDialogStubs) {
        const single = await api.exportSingle(renamed);
        check('导出单个提示词返回成功', single.ok === true, JSON.stringify(single));
        const zip = await api.exportZip();
        check('导出 ZIP 返回成功', zip.ok === true, JSON.stringify(zip));

        const imp1 = await api.importSingle();
        check('导入单个 .md 成功', imp1.ok === true && !!imp1.rel, JSON.stringify(imp1));
        const impRead = await api.readFile(imp1.rel);
        check('导入的内容可读且正确', impRead.content.includes('第一版正文'));
        check('导入重名时自动改名而非覆盖', imp1.rel !== renamed, imp1.rel);

        const imp2 = await api.importZip();
        check('导入 ZIP 报告了真实导入数量', imp2.ok === true && imp2.imported > 0,
          JSON.stringify({ ok: imp2.ok, imported: imp2.imported, failed: imp2.failed }));
        check('导入 ZIP 无失败条目', Array.isArray(imp2.failed) && imp2.failed.length === 0,
          JSON.stringify(imp2.failed));

        const cancel = await api.exportZip();
        check('用户取消导出时返回 ok:false', cancel.ok === false, JSON.stringify(cancel));
      }

      // 12. DOM clobbering 防护
      // 提示词正文是纯文本，但渲染后要插进 innerHTML。DOMPurify 默认放行 id，
      // 而 index.html 里 #preview 排在 <textarea id="editor"> 之前，
      // 所以正文里一个 <div id="editor"> 就能让 getElementById('editor')
      // 命中那个 div，保存逻辑读到 undefined，用户改动无声丢失。
      const clob = renderMarkdown('<div id="editor">x</div><div name="editor">y</div>');
      check('渲染正文会剥掉 id/name 属性', !/\sid=/.test(clob) && !/\sname=/.test(clob), clob);
      const probe = document.createElement('div');
      probe.innerHTML = clob;
      // 插到 body 最前面：文档顺序一定早于真正的 textarea，
      // 这样 id 若没被剥掉，getElementById 会先命中注入的节点。
      document.body.insertBefore(probe, document.body.firstChild);
      const hit = document.getElementById('editor');
      const hitTag = hit ? hit.tagName : 'null';
      probe.remove();
      check('注入 id="editor" 后 getElementById 仍命中真正的 textarea',
        hitTag === 'TEXTAREA', hitTag);

      // 13. 未保存改动的三选一对话框：保存 / 不保存 / 取消
      // 为什么必须测：切文件、切标签原先走的是 exitEditMode(true)，不问一声就把
      // 草稿写进磁盘——主进程每次 save-file 都会 bumpAutoFields 并生成版本快照，
      // 所以手滑点一下树里另一个文件，version 就自增一格、多一条快照，撤不回来。
      // 改成三选一之后，三条分支各自都有一种静默的坏法：
      //   取消 → 调用方不看返回值就照切，确认框形同虚设，草稿照样丢；
      //   不保存 → 顺手写了盘，用户明确说了不要还是写了；
      //   保存 → 只退出编辑没真写盘，用户以为存了。
      // 所以三条都要断言到磁盘上，不能只看界面。
      //
      // 走真实点击（标签栏 click → switchTab → leaveEditForSwitch），不直接调
      // leaveEditForSwitch：那样测不到调用方是否尊重了它的返回值，而"不尊重返回值"
      // 恰好是这里最容易犯且后果最重的错。
      if (window.__pfmDialogStubs) {
        const relA = 'prompts/testing/自检未保存A.md';
        const relB = 'prompts/testing/自检未保存B.md';
        await api.createFile(relA, '---\ntitle: 未保存A\nstage: testing\n---\nA 的原始正文');
        await api.createFile(relB, '---\ntitle: 未保存B\nstage: testing\n---\nB 的原始正文');
        const clickTab = (rel) => {
          const el = [...document.querySelectorAll('#tabs-bar .tab')].find(x => x.dataset.rel === rel);
          if (!el) return false;
          for (const type of ['mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          }
          return true;
        };
        const waitFor = async (fn, ms) => {
          const t0 = Date.now();
          while (Date.now() - t0 < (ms || 3000)) {
            if (fn()) return true;
            await new Promise(r => setTimeout(r, 50));
          }
          return false;
        };
        const MARK = ' 草稿标记不该静默落盘';
        await openFile(relA);
        await openFile(relB);
        const backToA = clickTab(relA) && await waitFor(() => state.activeTab === relA, 3000);
        check('三选一前置：两个标签都在，已切回 A 且不在编辑态',
          backToA && !state.editMode, 'active=' + state.activeTab + ' editMode=' + state.editMode);

        // 13a. 取消：切换必须被中止，草稿必须原样还在，磁盘不能动
        await enterEditMode();
        $('editor').value = state.currentContent + MARK;
        check('三选一前置：编辑器已经脏了', isDirty() === true);
        clickTab(relB);
        // 取消分支没有"状态变化"可以等，只能给足时间再断言什么都没发生
        await new Promise(r => setTimeout(r, 900));
        check('未保存三选一点取消：没有切走', state.activeTab === relA, 'active=' + state.activeTab);
        check('未保存三选一点取消：还留在编辑模式', state.editMode === true);
        // 光看 $('editor').value 是空断言：退出编辑只是把 editor-wrap 藏起来，
        // 没人会去清 textarea 的值，所以三条分支怎么错这一条都是绿的。
        // 要断言的是"草稿还摆在用户面前、能接着改"，所以连编辑器是否还显示一起看。
        check('未保存三选一点取消：草稿还摆在编辑器里且编辑器还显示着',
          $('editor').value.includes(MARK) && !$('editor-wrap').classList.contains('hidden'),
          'hidden=' + $('editor-wrap').classList.contains('hidden'));
        const aCancel = await api.readFile(relA);
        check('未保存三选一点取消：磁盘正文没被动过',
          !aCancel.content.includes(MARK) && aCancel.meta.version === 1, 'version=' + aCancel.meta.version);

        // 13b. 不保存：切过去，但磁盘正文、version、版本快照都不能变
        // 这条前置不能省：13b 全靠"此刻仍在编辑态且脏着"才有意义。13a 若把编辑态
        // 弄丢了，下面的 clickTab 根本不会走到 leaveEditForSwitch，切换照样成功，
        // "不保存：切过去了"就会因为压根没弹框而变成绿的假象。
        check('三选一前置：13b 开始前仍在编辑态且草稿还脏着',
          state.editMode === true && isDirty() === true,
          'editMode=' + state.editMode + ' dirty=' + isDirty());
        clickTab(relB);
        const wentB = await waitFor(() => state.activeTab === relB, 3000);
        check('未保存三选一点不保存：切过去了', wentB, 'active=' + state.activeTab);
        check('未保存三选一点不保存：已退出编辑模式', state.editMode === false);
        const aDiscard = await api.readFile(relA);
        check('未保存三选一点不保存：磁盘正文没被写入草稿',
          !aDiscard.content.includes(MARK), aDiscard.content.slice(0, 40));
        check('未保存三选一点不保存：version 没有自增',
          aDiscard.meta.version === 1, 'version=' + aDiscard.meta.version);
        check('未保存三选一点不保存：没有多出版本快照',
          (await api.listVersions(relA)).length === 0);

        // 13c. 保存：切过去，且草稿真的落到磁盘上
        clickTab(relA);
        await waitFor(() => state.activeTab === relA, 3000);
        await enterEditMode();
        $('editor').value = state.currentContent + MARK;
        clickTab(relB);
        const savedThenB = await waitFor(() => state.activeTab === relB, 3000);
        check('未保存三选一点保存：切过去了', savedThenB, 'active=' + state.activeTab);
        check('未保存三选一点保存：已退出编辑模式', state.editMode === false);
        const aSaved = await api.readFile(relA);
        check('未保存三选一点保存：草稿真的落盘了',
          aSaved.content.includes(MARK), aSaved.content.slice(0, 60));
        check('未保存三选一点保存：version 自增到 2',
          aSaved.meta.version === 2, 'version=' + aSaved.meta.version);
      }

      // 清理
      const leftovers = (await api.getMetaList()).filter(mm => mm.rel !== renamed && mm.top === 'prompts');
      for (const mm of leftovers) { try { await api.trash(mm.rel); } catch (_) {} }
      await api.trash(renamed);
      await api.emptyTrash();
      check('清空回收站后为空', (await api.listTrash()).items.length === 0);
    } catch (e) {
      check('功能自检执行中断', false, e && e.message ? e.message : String(e));
    }
    return out;
  })()
