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
      await realClick(document.getElementById('btn-new-folder'));
      check('点「＋目录」能弹出输入框', menuVisible());
      await pressEsc();
      check('Esc 能关掉弹层', !menuVisible());

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
