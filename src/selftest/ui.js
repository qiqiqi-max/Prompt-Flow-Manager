(async () => {
    const out = [];
    const check = (name, ok, detail) => out.push([name, !!ok, detail || '']);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const menu = () => document.getElementById('ctx-menu');
    // 弹层"可见"的判定：没有 hidden、有尺寸、且矩形落在视口内。
    // 只判 hidden 是不够的——曾经 CSS 缺 left/top，弹层显示了但在视口外。
    const menuVisible = () => {
      const el = menu();
      if (!el || el.classList.contains('hidden')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 &&
        r.top >= 0 && r.left >= 0 &&
        r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1;
    };
    // 用真实事件序列点击：mousedown → mouseup → click，
    // 因为"关闭弹层"的监听挂在 mousedown 上，只 dispatch click 测不出真实行为。
    const realClick = async (el) => {
      for (const type of ['mousedown', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      await sleep(250);
    };
    const typeAndConfirm = async (value) => {
      const inp = document.getElementById('ctx-input');
      if (!inp) return false;
      inp.value = value;
      await realClick(document.getElementById('ctx-ok'));
      return true;
    };
    const pressEsc = async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const inp = document.getElementById('ctx-input');
      if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(250);
    };

    try {
      const before = (await window.promptFlowApi.getMetaList()).length;

      // ---- 空状态「新建提示词」完整走通三个弹层 ----
      await realClick(document.getElementById('empty-new-prompt'));
      check('点「新建提示词」后弹出阶段选择且在视口内', menuVisible(),
        menu() ? 'hidden=' + menu().classList.contains('hidden') + ' rect=' + JSON.stringify(menu().getBoundingClientRect()) : 'no menu');
      check('弹层里的输入框自动获得焦点', document.activeElement && document.activeElement.id === 'ctx-input',
        document.activeElement ? document.activeElement.id : 'none');
      // ---- 居中弹层是模态对话框：角色 + Tab 陷阱 + 关闭后归还焦点 ----
      // 这三条此前一条都没有：弹层没有 role，按 Tab 焦点会跑到弹层背后的
      // 侧边栏上（弹层还开着，焦点在看不见的地方走），关掉之后焦点被丢到 body。
      check('居中弹层读出对话框语义',
        menu().getAttribute('role') === 'dialog' && menu().getAttribute('aria-modal') === 'true',
        'role=' + menu().getAttribute('role') + ' aria-modal=' + menu().getAttribute('aria-modal'));
      {
        // 注意：**合成**的 keydown 不会触发浏览器的默认 Tab 行为（焦点根本不移动），
        // 所以'焦点留在弹层里'这件事在有无陷阱时都成立——第一版就是这么写的，
        // 撤掉陷阱它照样绿。真正能分辨的信号是反向的：有陷阱时是我们自己的处理器
        // 在移焦点，所以焦点**必须动**，而且绕一圈要回到起点。
        const focusedId = () => {
          const el = document.activeElement;
          return el && el.id ? el.id : (el ? el.tagName : 'none');
        };
        const start = focusedId();
        const seen = [];
        const presses = menu().querySelectorAll('input, button, select, textarea').length + 2;
        for (let i = 0; i < presses; i++) {
          const from = document.activeElement || menu();
          from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
          await sleep(60);
          seen.push(focusedId());
        }
        const distinct = new Set(seen).size;
        const allInside = seen.every(() => menu().contains(document.activeElement));
        check('按 Tab 焦点在弹层里循环（真的在移动）',
          distinct >= 2 && allInside && seen.includes(start),
          '起点 ' + start + '：' + seen.join(' → '));
      }
      if (!menuVisible()) return out; // 后面全都依赖这一步

      await typeAndConfirm('测试');
      check('确定后弹出名称输入', menuVisible());
      const newName = 'UI点击自检-' + Date.now();
      await typeAndConfirm(newName);
      check('再确定后弹出工程类型选择', menuVisible());
      await typeAndConfirm('其他');
      await sleep(700);

      const after = await window.promptFlowApi.getMetaList();
      const created = after.find(x => x.rel === 'prompts/testing/' + newName + '.md');
      check('整条新建流程真的落盘了文件', !!created && after.length === before + 1,
        '库内文件 ' + before + ' → ' + after.length + '，期望新增 ' + newName);
      check('新建后进入编辑模式', !!document.getElementById('editor-wrap') &&
        !document.getElementById('editor-wrap').classList.contains('hidden'));

      // ---- 工具栏按钮同样能弹出 ----
      await pressEsc();
      // 先 focus 再点：合成的 click 事件不会移动焦点（真实鼠标点击会），
      // 而归还给谁取决于打开弹层时谁有焦点。不补这一步，断言测的是
      // 'body 上打开弹层' 这个现实中不存在的场景。
      const folderBtn = document.getElementById('btn-new-folder');
      folderBtn.focus();
      await realClick(folderBtn);
      check('点「＋目录」能弹出输入框', menuVisible());
      await pressEsc();
      check('Esc 能关掉弹层', !menuVisible());
      // 关掉之后焦点应该回到刚才那个按钮上。丢到 body 的话，键盘用户要再按
      // 几十次 Tab 才能回到原来的位置。
      check('弹层关闭后焦点归还给打开的按钮',
        document.activeElement === folderBtn,
        document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none');
      // 角色属性不能留在弹层上：同一元素下一秒可能当右键菜单用，
      // 留着 role=dialog 会被读成对话框。
      check('关闭后不残留对话框属性',
        !document.getElementById('ctx-menu').hasAttribute('role')
          && !document.getElementById('ctx-menu').hasAttribute('aria-modal'),
        'role=' + document.getElementById('ctx-menu').getAttribute('role'));

      // ---- 点弹层外部要能关闭（防止把 mousedown 改错方向）----
      await realClick(document.getElementById('btn-new-workflow'));
      check('点「＋工作流」能弹出输入框', menuVisible());
      await realClick(document.body);
      check('点弹层外部能关闭', !menuVisible());

      // ---- 导入方式选择 ----
      await realClick(document.getElementById('btn-import'));
      check('点「导入」能弹出方式选择', menuVisible());
      await realClick(document.body);

      // ---- 主题切换 ----
      const themeBefore = document.body.className;
      await realClick(document.getElementById('btn-theme'));
      check('切换主题会改变 body class', document.body.className !== themeBefore,
        themeBefore + ' → ' + document.body.className);
      await realClick(document.getElementById('btn-theme'));

      // ---- 抽屉 ----
      await realClick(document.getElementById('btn-trash'));
      check('回收站抽屉能打开', !document.getElementById('trash-drawer').classList.contains('hidden'));
      await realClick(document.getElementById('btn-trash-close'));
      await realClick(document.getElementById('btn-settings'));
      check('设置抽屉能打开', !document.getElementById('settings-drawer').classList.contains('hidden'));
      await realClick(document.getElementById('btn-settings-close'));

      // ---- 文件树键盘导航 ----
      // 注意：导航只在文件行之间进行（.tree-row.file），当前项的类名是 active
      // 起点必须挑真的看得见的行。折叠目录里的行用 JS 照样点得开，但它们不在
      // 导航序列里，从那种行起步的话下面"切回上一个"会落到序列另一头（实测：
      // 起点是折叠着的 prompts/code-generation 里的文件，ArrowUp 直接绕到末尾）。
      const fileRows = Array.from(document.querySelectorAll('#tree .tree-row.file'))
        .filter(r => r.offsetParent !== null);
      if (fileRows.length > 1) {
        const tree = document.getElementById('tree');
        await realClick(fileRows[0]);
        await sleep(300);
        const firstRel = (document.querySelector('#tree .tree-row.file.active') || {}).__rel ||
          (document.querySelector('#tree .tree-row.file.active') || {}).dataset?.rel || state.currentRel;
        // 方向键只移焦点、不打开：按键从当前聚焦的行发出（真实键盘事件的 target 就是它）。
        // 原先每按一下都 click()，按住 ↓ 会沿途给每个文件开一个标签。
        const focusedRow = () => (document.activeElement && document.activeElement.closest)
          ? document.activeElement.closest('#tree .tree-row') : null;
        const key = (k) => (focusedRow() || tree).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        const tabsBefore = state.tabs.length;
        fileRows[0].focus();
        key('ArrowDown');
        await sleep(300);
        const moved = focusedRow();
        check('文件树方向键能把焦点移到下一行', !!moved && moved !== fileRows[0],
          moved ? (moved.__rel || moved.textContent.trim()) : '焦点不在树行上');
        check('方向键只移焦点、不打开文件', state.currentRel === firstRel && state.tabs.length === tabsBefore,
          'currentRel=' + String(state.currentRel) + ' tabs ' + tabsBefore + '→' + state.tabs.length);
        // 走到第一个可见的文件行再按 Enter
        let target = null;
        for (let i = 0; i < 50; i++) {
          const r = focusedRow();
          if (r && r.classList.contains('file') && r.__rel !== firstRel) { target = r; break; }
          key('ArrowDown');
          await sleep(60);
        }
        if (target) {
          key('Enter');
          await sleep(400);
          check('Enter 打开聚焦的文件', state.currentRel === target.__rel,
            String(state.currentRel) + ' 应为 ' + String(target.__rel));
        } else {
          check('Enter 打开聚焦的文件', false, '方向键走不到另一个文件行');
        }
        fileRows[0].focus();
        key('ArrowDown');
        key('ArrowUp');
        await sleep(200);
        check('方向键能切回上一行', focusedRow() === fileRows[0],
          focusedRow() ? (focusedRow().__rel || focusedRow().textContent.trim()) : '焦点不在树行上');
      } else {
        check('文件树里有多于一个文件行可供导航', false, '只有 ' + fileRows.length + ' 个文件行');
      }

      // ---- 方向键不许跳进折叠起来的目录 ----
      // 折叠用的是 .tree-children 上的 hidden 类，而不是行内 display:none。
      // 导航如果按 style 属性判可见性，折叠目录里的文件仍在序列里，
      // 方向键会 focus + click 打开一个屏幕上看不见的文件。
      {
        const tree = document.getElementById('tree');
        // 挑一个当前展开、且里面有可见文件行的目录，把它折叠掉
        let collapsedKids = null;
        for (const dirRow of document.querySelectorAll('#tree .tree-row.dir')) {
          const kids = dirRow.nextElementSibling;
          if (!kids || !kids.classList.contains('tree-children')) continue;
          if (kids.classList.contains('hidden')) continue;
          const inside = Array.from(kids.querySelectorAll('.tree-row.file'));
          if (!inside.length) continue;
          // 折叠之前先把当前选中项移到这个目录之外，否则起点本身就在折叠区里
          const outside = Array.from(document.querySelectorAll('#tree .tree-row.file'))
            .filter(r => !inside.includes(r));
          if (!outside.length) continue;
          await realClick(outside[0]);
          await sleep(250);
          await realClick(dirRow);
          await sleep(250);
          if (inside.every(r => r.offsetParent === null)) collapsedKids = inside;
          break;
        }

        // 这条无论成败都要报出来：它是下面那条断言的前提。
        // 只在失败时 check() 的话，"前提没建立起来"和"根本没跑到这里"在输出里
        // 长得一模一样，而 tests/ui-smoke.js 就没法要求它必须出现。
        check('能折叠一个带文件的目录用于验证', !!collapsedKids,
          collapsedKids ? '折叠了 ' + collapsedKids.length + ' 个文件行' : '没找到合适的目录，或折叠后子行仍然可见');
        if (collapsedKids) {
          // 沿着整圈走一遍。每走一步，当前选中的行都必须是真的看得见的行。
          const visibleCount = Array.from(document.querySelectorAll('#tree .tree-row.file'))
            .filter(r => r.offsetParent !== null).length;
          // 目录行也在导航序列里，所以按可见树行总数走一圈多。
          const visibleRowCount = Array.from(document.querySelectorAll('#tree .tree-row'))
            .filter(r => r.offsetParent !== null).length;
          const landed = [];
          tree.focus();
          for (let i = 0; i < Math.max(visibleCount, visibleRowCount) + 2; i++) {
            const from = (document.activeElement && document.activeElement.closest
              ? document.activeElement.closest('#tree .tree-row') : null) || tree;
            from.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            await sleep(60);
            const cur = document.activeElement && document.activeElement.closest
              ? document.activeElement.closest('#tree .tree-row') : null;
            if (cur && cur.offsetParent === null) landed.push(cur.__rel || cur.textContent.trim() || '?');
          }
          check('方向键不会跳进折叠目录里看不见的文件', landed.length === 0,
            landed.length ? '落到了隐藏行：' + landed.slice(0, 3).join(', ') : '走了 ' + (visibleCount + 2) + ' 步都落在可见行上');
        }
      }

      // ---- 筛选在刷新树之后仍然生效 ----
      // renderTree 重建的行全部可见，populateFilters 用 innerHTML 重建下拉框会把选中值清掉。
      // 原先 refreshTree 之后两样都不恢复：state.filter 还是旧条件，树和下拉框却回到"全部"。
      {
        const visibleFiles = () => Array.from(document.querySelectorAll('#tree .tree-row.file'))
          .filter(r => r.style.display !== 'none');
        const total = visibleFiles().length;
        const stageCounts = {};
        for (const r of visibleFiles()) {
          const s = stageOfRel(r.__rel);
          if (s) stageCounts[s] = (stageCounts[s] || 0) + 1;
        }
        const stage = Object.keys(stageCounts).find(s => stageCounts[s] < total);
        check('能挑出一个只命中部分文件的阶段用于验证筛选', !!stage, JSON.stringify(stageCounts) + ' / ' + total);
        if (stage) {
          document.getElementById('filter-stage').value = stage;
          applyFilter();
          const before = visibleFiles().length;
          await refreshTree();
          const after = visibleFiles().length;
          check('刷新文件树后筛选仍然生效', before > 0 && before < total && after === before,
            '筛选后 ' + before + '，刷新后 ' + after + '，总数 ' + total);
          check('刷新文件树后筛选下拉框保持选中值', document.getElementById('filter-stage').value === stage,
            '下拉框是 "' + document.getElementById('filter-stage').value + '"，应为 "' + stage + '"');
          await realClick(document.getElementById('btn-filter-clear'));
        }
      }

      // ---- 连续提示不会被上一条的计时器提前收走 ----
      {
        const box = document.getElementById('toast');
        toast('selftest-toast-1');
        await sleep(1200);
        toast('selftest-toast-2');
        await sleep(1000);
        check('第二条提示不被第一条的计时器提前隐藏', !box.classList.contains('hidden') && box.textContent === 'selftest-toast-2',
          'hidden=' + box.classList.contains('hidden') + ' text=' + box.textContent);
        await sleep(1000);
        check('提示到时会自动隐藏', box.classList.contains('hidden'));
      }

      // ---- 复用关系 chip：打开一个被引用的提示词，应能在元数据栏看到
      //      "被 N 个工作流引用"，点它跳到那个工作流 ----
      // 用种子里真实存在的引用（需求分析 ← 三个工作流），不用测试现造的夹具：
      // 造出来的引用只能证明"我刚写的那条链路通"，而这条 chip 的数据来自
      // 全库扫描，种子的引用关系才是真实输入。
      {
        const target = 'prompts/project-init/需求分析.md';
        await openFile(target);
        await sleep(600);   // 引用是异步查的，等它回来
        const chip = document.querySelector('#meta-bar .meta-chip.refs');
        check('被引用的提示词在元数据栏显示引用 chip', !!chip,
          document.getElementById('meta-bar').textContent || '(元数据栏为空)');
        const refs = chip ? JSON.parse(chip.dataset.refs || '[]') : [];
        check('引用 chip 带上了工作流列表', refs.length >= 1 && refs.every(r => r.startsWith('workflows/')),
          JSON.stringify(refs));
        if (chip) {
          await realClick(chip);
          await sleep(600);
          check('点引用 chip 能跳到引用它的工作流',
            String(state.currentRel).startsWith('workflows/'),
            String(state.currentRel) + '，chip 里是 ' + refs[0]);
        }
        // 反向：没有引用的工作流文件不该显示这枚 chip
        await openFile('workflows/branch-flow-example.md');
        await sleep(600);
        check('没有引用的文件不显示引用 chip', !document.querySelector('#meta-bar .meta-chip.refs'),
          document.getElementById('meta-bar').textContent);
      }

      // ---- 预览区就地填占位符 ----
      // 这条路径此前只有一个入口：点复制之后弹一个面板，面板上只有"提示文字"这一列，
      // 用户看不到占位符在正文里的位置。现在正文里的 [提示文字] 是可点的 chip。
      {
        const target = 'prompts/code-generation/功能实现.md';
        await openFile(target);
        await sleep(400);
        const marks = () => Array.from(document.querySelectorAll('#preview mark.ph'));
        check('预览区把 [占位符] 标成了可点的 chip（' + marks().length + ' 处）', marks().length >= 2,
          document.getElementById('preview').textContent.slice(0, 120));
        check('有占位符时显示提示行', !document.getElementById('preview-fill-hint').classList.contains('hidden'),
          document.getElementById('preview-fill-hint').textContent);
        const token = marks()[0] ? marks()[0].dataset.token : null;
        // 复制时如果弹出填充面板，这里没有真人去点"填好并复制"，copyContent 会
        // 永远不 resolve —— 后面的断言就一行都不执行，整个 test 却"全绿"。
        // 第一版就是这么写空的，被反向对照当场抓出来。所以这里给面板挂一个
        // 兜底应答：它一旦出现就把面板取消掉，让 copyContent 正常返回，
        // 于是"没写剪贴板"会变成一条**能变红**的失败。
        // 注意：window.promptFlowApi 是 contextBridge 暴露的，属性不可写，
        // 给它赋值会当场抛错（第一版这么写过，整段点击自检直接没了）。
        const origPromptDone = pendingPromptDone;
        const fillChip = async (el, value) => {
          el.click();
          for (let i = 0; i < 40 && !document.getElementById('ctx-input'); i++) await sleep(50);
          const inp = document.getElementById('ctx-input');
          if (!inp) return false;
          inp.value = value;
          await realClick(document.getElementById('ctx-ok'));
          return true;
        };
        try {
          check('点 chip 会弹出就地填写框', await fillChip(marks()[0], '自检填充值'),
            menu() ? 'hidden=' + menu().classList.contains('hidden') : 'no menu');
          await sleep(300);
        } finally {
          if (pendingPromptDone) { const cancel = pendingPromptDone; cancel(null); }
          pendingPromptDone = origPromptDone;
        }
        const filled = marks().find(el => el.dataset.token === token);
        check('填过的 chip 显示填进去的值',
          !!filled && filled.classList.contains('ph-filled') && filled.textContent === '自检填充值',
          filled ? filled.textContent : '(chip 不见了)');
        // 复制必须用填好的正文，而不是原样带 [占位符] 出去。
        // 剪贴板没法直接读，所以把 writeText 换成采集器——copyContent 里真正的
        // 写入点就是它，替换后能拿到用户实际会拿到的那份文本。
        const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
        let copied = null;
        navigator.clipboard.writeText = async (text) => { copied = text; };
        let copyDone = false;
        // 兜底：万一走到填充面板（说明没走就地填的分支），面板一出现就取消它。
        // 不做这个的话 copyContent 永远挂在 awaits promptFillPlaceholders 上，
        // 整段点击自检的输出全丢 —— 而失败原因是"没人点按钮"，不是被测代码错。
        // 取消之后 copyContent 正常返回 false，下面的断言才是一条能变红的失败。
        //
        // 这个看门狗必须在 copyContent **之后**单独 await，不能塞进 finally：
        // 第一版就是塞在 try/finally 里等它，结果每跑一次白白多等 3 秒，
        // 把整段自检顶过了 60 秒上限（实测就是这么红的）。
        const cancelPanelSoon = (async () => {
          for (let i = 0; i < 12; i++) {
            await sleep(50);
            if (pendingPromptDone) pendingPromptDone(null);
          }
        })();
        try {
          await copyContent();
          copyDone = true;
        } catch (err) {
          copied = 'THREW:' + String(err && err.message);
        } finally {
          navigator.clipboard.writeText = origWrite;
          await cancelPanelSoon;
        }
        check('复制用的是填好的正文', copyDone && !!copied && copied.includes('自检填充值'),
          !copyDone ? 'copyContent 没有返回（多半是弹了填充面板没人点）' : String(copied).slice(0, 120));
        check('复制不会改动磁盘上的文件', state.currentContent.includes(token),
          '原文件里应保留 ' + token);
      }

      // ---- 文件树多选与批量操作 ----
      // 全程走真实事件：Ctrl/Shift+点击行、点批量条按钮、在弹层里输入并点确定。
      // 原生确认框由 tests/ui-smoke.js 的对话框队列应答（顺序：批量移动的引用同步 → 批量删除）。
      // 批量移动的"引用只问一次"就靠这个队列验：问了两次的话第二次会吃掉删除那一项，
      // 删除被当成取消，下面删除那几条全红，ui-smoke 还会报"队列已空"。
      {
        const api = window.promptFlowApi;
        const D = 'prompts/testing/UI批量';
        const rA = D + 'A.md', rB = D + 'B.md', rC = D + 'C.md', rL = D + '锁定.md';
        const wf = 'workflows/UI批量引用.md';
        const L = I18N[(state.config && state.config.lang) || 'zh'] || I18N.zh;
        await api.createFile(rA, '---\ntitle: UI批量A\nstage: testing\ntags: [丙]\n---\nA');
        await api.createFile(rB, '---\ntitle: UI批量B\nstage: testing\ntags:\n  - 多行\n---\nB');
        await api.createFile(rC, '---\ntitle: UI批量C\nstage: testing\ntags: [丙]\n---\nC');
        await api.createFile(rL, '---\ntitle: UI批量锁定\nstage: testing\n---\n锁定正文');
        await api.createFile('prompts/deployment/UI批量B.md', '---\ntitle: 目标目录里的同名文件\n---\n不能被覆盖');
        await api.createFile(wf, '---\ntitle: UI批量引用\nflow:\n  - id: a\n    prompt: ' + rA + '\n  - id: b\n    prompt: ' + rB + '\n---\n');
        state.expandedPaths.add('prompts').add('prompts/testing').add('prompts/deployment');
        await refreshTree();
        await sleep(200);
        const rowOf = (rel) => Array.from(document.querySelectorAll('#tree .tree-row.file')).find(r => r.__rel === rel);
        const clickRow = async (rel, mods) => {
          const el = rowOf(rel);
          if (!el) return false;
          for (const type of ['mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...(mods || {}) }));
          }
          await sleep(200);
          return true;
        };
        const selected = () => [...state.treeSelection.selected].sort();
        const barShown = () => !document.getElementById('batch-bar').classList.contains('hidden');
        const waitFor = async (fn, ms) => {
          const t0 = Date.now();
          while (Date.now() - t0 < (ms || 4000)) { if (fn()) return true; await sleep(50); }
          return false;
        };
        const confirmInput = async (value) => {
          await waitFor(() => !!document.getElementById('ctx-input'), 2000);
          const inp = document.getElementById('ctx-input');
          if (!inp) return false;
          inp.value = value;
          await realClick(document.getElementById('ctx-ok'));
          return true;
        };

        // 选择：普通单击照旧打开文件；Ctrl+点击切换选中、不打开文件
        await clickRow(rA);
        await sleep(200);
        check('多选：普通单击仍然打开文件且不进入多选', state.currentRel === rA && selected().length === 0 && !barShown(),
          'currentRel=' + state.currentRel + ' selected=' + selected().join(','));
        await clickRow(rC, { ctrlKey: true });
        check('多选：单击 A 后 Ctrl+点击 C，两个都选中并出现批量条',
          selected().join() === [rA, rC].sort().join() && barShown() && state.currentRel === rA,
          selected().join(',') + ' bar=' + barShown());
        check('多选：选中行有可见的选中态',
          rowOf(rA).classList.contains('multi-selected') && rowOf(rC).getAttribute('aria-selected') === 'true'
          && !rowOf(rB).classList.contains('multi-selected'));
        await clickRow(rC, { ctrlKey: true });
        check('多选：再次 Ctrl+点击取消选中，只剩 1 个时批量条收起', selected().join() === rA && !barShown(), selected().join(','));

        // Esc 清空
        await clickRow(rB, { ctrlKey: true });
        const beforeEsc = selected().length;
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(150);
        check('多选：Esc 清空选择', beforeEsc === 2 && selected().length === 0 && !barShown(), 'before=' + beforeEsc + ' after=' + selected().length);

        // Shift+点击：按可见顺序。先在无筛选时确认 B 夹在 A、C 之间，再筛掉 B
        const order = Array.from(document.querySelectorAll('#tree .tree-row.file')).map(r => r.__rel);
        check('多选前置：树上 B 夹在 A 和 C 之间', order.indexOf(rA) < order.indexOf(rB) && order.indexOf(rB) < order.indexOf(rC),
          [rA, rB, rC].map(r => order.indexOf(r)).join(','));
        await clickRow(rA);
        await clickRow(rC, { shiftKey: true });
        check('多选：Shift+点击选中锚点到这一行之间的所有可见行', selected().join() === [rA, rB, rC].sort().join(), selected().join(','));
        document.getElementById('filter-tag').value = '丙';
        applyFilter();
        await sleep(100);
        check('多选前置：标签筛选把 B 隐藏了而 A、C 可见',
          rowOf(rB).offsetParent === null && rowOf(rA).offsetParent !== null && rowOf(rC).offsetParent !== null);
        check('多选：筛选后看不见的行从选择里剔掉', selected().join() === [rA, rC].sort().join(), selected().join(','));
        await clickRow(rA);
        await clickRow(rC, { shiftKey: true });
        check('多选：Shift+点击跳过被筛掉、看不见的行', selected().join() === [rA, rC].sort().join(), selected().join(','));
        document.getElementById('filter-tag').value = '';
        applyFilter();
        await sleep(100);

        // 折叠目录：目录里的选中项剔掉（折叠用的是 hidden 类，不是行内 display:none）
        await clickRow(rA);
        await clickRow(rC, { ctrlKey: true });
        const testingDir = Array.from(document.querySelectorAll('#tree .tree-row.dir'))
          .find(r => r.nextElementSibling && r.nextElementSibling.contains(rowOf(rA)) && !r.nextElementSibling.querySelector('.tree-row.dir'));
        const beforeCollapse = selected().length;
        if (testingDir) await realClick(testingDir);
        check('多选：折叠目录后目录里的选中项被剔掉、批量条收起',
          !!testingDir && beforeCollapse === 2 && selected().length === 0 && !barShown(),
          'dir=' + !!testingDir + ' before=' + beforeCollapse + ' after=' + selected().length);
        if (testingDir) await realClick(testingDir);

        // Shift+方向键扩展选择
        {
          await clickRow(rA);
          rowOf(rA).focus();
          rowOf(rA).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
          await sleep(100);
          check('多选：Shift+↓ 把下一行并进选择', selected().join() === [rA, rB].sort().join(), selected().join(','));
          clearTreeSelection();
        }

        // 批量移动：连点两下只弹一个选目录弹层；同名生成新名字；标签页路径跟着改；引用只问一次
        await clickRow(rA);
        await clickRow(rB, { ctrlKey: true });
        const moveBtn = document.getElementById('btn-batch-move');
        moveBtn.click();
        await sleep(50);
        const disabledWhileRunning = moveBtn.disabled;
        const firstMenuInput = document.getElementById('ctx-input');
        // 绕过按钮禁用直接再调一次入口：防的是"另一个入口同时触发"，按钮禁用拦不住那种
        batchMoveSelected();
        await sleep(100);
        check('批量：进行中再次触发被拦下（按钮禁用 + 提示进行中，弹层还是原来那一个）',
          disabledWhileRunning && document.getElementById('ctx-input') === firstMenuInput
          && document.getElementById('toast').textContent === L.batchBusy,
          'disabled=' + disabledWhileRunning + ' toast=' + document.getElementById('toast').textContent);
        await confirmInput(L.stage_deployment || 'deployment');
        await waitFor(() => !state.batchRunning, 6000);
        const metaRels = (await api.getMetaList()).map(m => m.rel);
        const newA = 'prompts/deployment/UI批量A.md', newB = 'prompts/deployment/UI批量B-1.md';
        check('批量移动：两个文件都移到了目标目录，同名的生成新名字',
          metaRels.includes(newA) && metaRels.includes(newB) && !metaRels.includes(rA) && !metaRels.includes(rB),
          JSON.stringify(metaRels.filter(r => r.includes('UI批量'))));
        check('批量移动：目标目录里原有的同名文件没有被覆盖',
          (await api.readFile('prompts/deployment/UI批量B.md')).content.includes('不能被覆盖'));
        check('批量移动：已打开的标签页跟着改路径',
          state.tabs.some(tb => tb.rel === newA) && !state.tabs.some(tb => tb.rel === rA) && state.currentRel === newA,
          'tabs=' + state.tabs.map(tb => tb.rel).join(',') + ' current=' + state.currentRel);
        const wfAfter = (await api.readFile(wf)).content;
        check('批量移动：确认一次后两个文件的工作流引用都更新了',
          wfAfter.includes('prompt: ' + newA) && wfAfter.includes('prompt: ' + newB), wfAfter);
        check('批量移动：移动后选择清空', selected().length === 0 && !barShown());

        // 批量打标签：跨目录选择，行内 / 多行两种写法；当前打开的标签页重读
        await clickRow(rC);
        await clickRow(newA, { ctrlKey: true });
        await clickRow(newB, { ctrlKey: true });
        await realClick(document.getElementById('btn-batch-tags'));
        await confirmInput('UI批量标签, 第二个');
        await waitFor(() => !state.batchRunning, 6000);
        const cAfter = await api.readFile(rC);
        const bAfter = await api.readFile(newB);
        check('批量打标签：行内数组追加两个标签', JSON.stringify(cAfter.meta.tags) === '["丙","UI批量标签","第二个"]', JSON.stringify(cAfter.meta.tags));
        check('批量打标签：多行列表保留写法并追加',
          bAfter.content.includes('tags:\n  - 多行\n  - "UI批量标签"\n  - "第二个"\n'), bAfter.content);
        check('批量打标签：当前打开的标签页重读了磁盘（元信息栏出现新标签）',
          state.currentRel === rC && state.currentContent.includes('UI批量标签')
          && document.getElementById('meta-bar').textContent.includes('UI批量标签'),
          document.getElementById('meta-bar').textContent);
        check('批量打标签：每个文件留了一条快照', (await api.listVersions(rC)).length === 1);
        check('批量打标签：完成后选择保留（便于接着操作这一批）', selected().length === 3, selected().join(','));
        await realClick(document.getElementById('btn-batch-tags'));
        await waitFor(() => !!document.getElementById('ctx-tags-remove'), 2000);
        document.getElementById('ctx-input').value = '第二个';
        await realClick(document.getElementById('ctx-tags-remove'));
        await waitFor(() => !state.batchRunning, 6000);
        check('批量删标签：只拿掉输入的那一个',
          JSON.stringify((await api.readFile(rC)).meta.tags) === '["丙","UI批量标签"]'
          && !(await api.readFile(newB)).content.includes('第二个'), (await api.readFile(newB)).content);

        // 批量删除：锁定的被主进程跳过并在报告里列出；当前标签被删时切到相邻的那个
        await api.setConfig({ lockedFiles: [rL] });
        state.lockedFiles = new Set([rL]);
        await openFile(rL);
        await clickRow(rC);
        await clickRow(rL, { ctrlKey: true });
        await clickRow(newA, { ctrlKey: true });
        await realClick(document.getElementById('btn-batch-delete'));
        const reportShown = await waitFor(() => !!document.querySelector('#ctx-menu .batch-report-list'), 6000);
        const items = Array.from(document.querySelectorAll('#ctx-menu .batch-report-item'))
          .map(li => ({ rel: li.dataset.rel, code: li.dataset.code, kind: li.classList.contains('skipped') ? 'skipped' : 'failed' }));
        check('批量删除：结果汇总列出被跳过的锁定文件及原因',
          reportShown && items.length === 1 && items[0].rel === rL && items[0].code === 'E_LOCKED' && items[0].kind === 'skipped',
          JSON.stringify(items));
        const reportTitle = (document.getElementById('batch-report-title') || {}).textContent || '';
        check('批量删除：汇总标题写明成功 2 个、跳过 1 个',
          reportTitle === L.batchReportTitle.split('{action}').join(L.batchActionDelete).split('{ok}').join('2').split('{failed}').join('0').split('{skipped}').join('1'),
          reportTitle);
        if (document.getElementById('ctx-ok')) await realClick(document.getElementById('ctx-ok'));
        await waitFor(() => !state.batchRunning, 4000);
        const trashedRels = (await api.listTrash()).items.map(i => i.originalRel);
        check('批量删除：未锁定的进了回收站', trashedRels.includes(rC) && trashedRels.includes(newA), JSON.stringify(trashedRels.slice(0, 6)));
        check('批量删除：锁定的文件还在', (await api.readFile(rL)).content.includes('锁定正文'));
        check('批量删除：被删文件的标签页关掉了，当前标签切到相邻的那个',
          !state.tabs.some(tb => tb.rel === rC || tb.rel === newA) && state.currentRel === rL && state.activeTab === rL,
          'tabs=' + state.tabs.map(tb => tb.rel).join(',') + ' current=' + state.currentRel);
        await api.setConfig({ lockedFiles: [] });
        state.lockedFiles = new Set();
        clearTreeSelection();
      }

      // ---- 右键菜单 ----
      const fileRow = document.querySelector('#tree .tree-row.file') || document.querySelector('#tree .tree-row');
      if (fileRow) {
        fileRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
        await sleep(250);
        const items = menu() ? menu().querySelectorAll('.ctx-item').length : 0;
        check('右键菜单能弹出且有菜单项（' + items + ' 项）', menuVisible() && items > 0);
        await realClick(document.body);
      }
    } catch (e) {
      check('UI 点击自检执行中断', false, e && e.message ? e.message : String(e));
    }
    return out;
  })()
