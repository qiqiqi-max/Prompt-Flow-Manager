(async () => {
    // 轮询等渲染进程完成首次 IPC 拉取
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (document.querySelectorAll('#tree .tree-row, #tree [data-rel], #tree > *').length > 0) break;
      await new Promise(r => setTimeout(r, 100));
    }
    return {
      bridgeReady: typeof window.promptFlowApi === 'object' && window.promptFlowApi !== null,
      nodeLeak: typeof window.require !== 'undefined' || typeof window.module !== 'undefined',
      markedReady: !!(window.marked && typeof window.marked.marked === 'function'),
      purifyReady: !!(window.DOMPurify && typeof window.DOMPurify.sanitize === 'function'),
      dmpReady: typeof window.diff_match_patch === 'function',
      i18nReady: typeof I18N === 'object' && !!I18N.zh,
      treeNodes: document.querySelectorAll('#tree > *').length,
      title: document.title
    };
  })()
