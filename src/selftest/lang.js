(async () => {
              await setLang('__LANG__');
              await new Promise(r => setTimeout(r, 400));
              // 只检查"界面外壳"的文案。以下容器渲染的是用户数据
              // （提示词标题、标签、正文、工程类型…），里面出现中文是正常的，
              // 把它们算进来会让检查变成误报。
              const userDataContainers = [
                'tree', 'tabs-bar', 'breadcrumb', 'meta-bar', 'preview', 'editor',
                'recent-list', 'search-results', 'types-list',
                'version-list', 'version-detail', 'version-diff', 'trash-list',
                'filter-stage', 'filter-type', 'tag-datalist'
              ];
              const clone = document.body.cloneNode(true);
              for (const id of userDataContainers) {
                const el = clone.querySelector('#' + id);
                if (el) el.remove();
              }
              document.body.appendChild(clone);
              clone.style.position = 'absolute';
              clone.style.left = '-99999px';
              const text = clone.innerText || '';
              clone.remove();
              const chunks = text.match(/[\u4e00-\u9fa5]+/g) || [];
              return { lang: '__LANG__', chunks: [...new Set(chunks)].slice(0, 20), total: chunks.length };
            })()
