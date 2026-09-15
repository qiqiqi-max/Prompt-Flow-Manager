// lib/zip-import.js
// ZIP 导入的纯逻辑部分，抽出来是为了能脱离 Electron 直接跑单测。
// 注意：archiver 只能压缩，不能解压，所以解压用 yauzl。
const path = require('path');
const yauzl = require('yauzl');

// 与 electron-main.js 的约定一致：错误码编在 message 里（`<CODE>|<细节>`），
// 渲染进程才能把它翻译成用户语言。
function appError(code, detail) {
  return new Error(detail == null || detail === '' ? code : code + '|' + detail);
}

// 单个 .md 条目上限，防止构造出的超大条目吃满内存
const MAX_IMPORT_ENTRY_BYTES = 4 * 1024 * 1024;
// 全部条目累计上限。单条上限管不住"很多条各自都不超限"的包：
// 所有正文都攒在下面的 out 数组里一次性返回，累计量才是真正的内存占用。
// 取 64MB：正常备份包（纯 Markdown）远到不了，构造包会在这里被截断。
const MAX_IMPORT_TOTAL_BYTES = 64 * 1024 * 1024;
// 条目数上限。字节数管不住"几十万个 1 字节条目"：每条都要建对象、
// 之后还要各自走一次 importMarkdown（含目录扫描与独占创建），条数本身就是成本。
const MAX_IMPORT_ENTRIES = 5000;

// 直接从 zip 流里读出所有 .md 条目内容。
// 不落盘、不使用 zip 内的路径来写文件，因此天然免疫 zip-slip 路径穿越。
function readZipMarkdownEntries(zipPath, options = {}) {
  const maxBytes = options.maxBytes || MAX_IMPORT_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes || MAX_IMPORT_TOTAL_BYTES;
  const maxEntries = options.maxEntries || MAX_IMPORT_ENTRIES;
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(appError('E_ZIP_OPEN', err.message));
      const out = [];
      const skipped = [];
      let totalBytes = 0;
      let settled = false;
      // 每条结束路径都要 close：autoClose 只在 yauzl 自己的 'end' 和它内部
      // 检测到的错误上触发，而下面 openReadStream 失败、条目流出错这两条是我们
      // 自己 reject 的，yauzl 那边什么都不知道，文件描述符会一直挂到进程退出。
      // 导入失败几次就攒几个泄漏的 fd。close() 内部有 isOpen 判断，重复调用无害。
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch {}
        fn(arg);
      };

      zip.on('error', (e) => done(reject, appError('E_ZIP_PARSE', e.message)));
      zip.on('end', () => done(resolve, { entries: out, skipped }));
      zip.on('entry', (entry) => {
        const isDir = /\/$/.test(entry.fileName);
        if (isDir || !entry.fileName.toLowerCase().endsWith('.md')) return zip.readEntry();
        if (entry.uncompressedSize > maxBytes) {
          skipped.push({ name: entry.fileName, reason: 'E_ZIP_ENTRY_TOO_BIG|' + maxBytes });
          return zip.readEntry();
        }
        // 累计上限：超了就跳过剩下的，而不是 reject。
        // 已经读出来的条目是好的，语义和单条超限保持一致（跳过 + 记原因），
        // 用户至少能拿到前一部分并从明细里看到被截断了。
        if (out.length >= maxEntries) {
          skipped.push({ name: entry.fileName, reason: 'E_ZIP_TOO_MANY_ENTRIES|' + maxEntries });
          return zip.readEntry();
        }
        if (totalBytes + entry.uncompressedSize > maxTotalBytes) {
          skipped.push({ name: entry.fileName, reason: 'E_ZIP_TOTAL_TOO_BIG|' + maxTotalBytes });
          return zip.readEntry();
        }
        zip.openReadStream(entry, (e2, stream) => {
          if (e2) return done(reject, appError('E_ZIP_ENTRY', entry.fileName));
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', () => {
            // 先 destroy 再 close：这个流对 reader 持有一份 ref，
            // 不放掉的话 close() 的 unref 不会把 refCount 降到 0，fd 照样不关。
            try { stream.destroy(); } catch {}
            done(reject, appError('E_ZIP_ENTRY', entry.fileName));
          });
          stream.on('end', () => {
            // 用真实读到的字节数累计，而不是 entry.uncompressedSize：
            // 后者只是包里的元数据，可以和实际内容不一致。
            const buf = Buffer.concat(chunks);
            totalBytes += buf.length;
            out.push({ name: path.posix.basename(entry.fileName), content: buf.toString('utf8') });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

// 标题会被当成文件名，必须剥掉路径分隔符和 Windows 非法字符，
// 否则 frontmatter 里写 title: ../../evil 就能把文件写到库外面。
function sanitizeTitle(raw) {
  const cleaned = String(raw == null ? '' : raw)
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '');
  return cleaned || '未命名';
}

// 生成不与现有文件冲突的相对路径。
// exists(rel) 由调用方提供（主进程里要走 safeJoin 校验）。
// 关键：循环体每轮都必须改变候选名，否则就是死循环。
function uniqueRel(rel, exists) {
  if (!exists(rel)) return rel;
  const ext = path.extname(rel);
  const base = rel.slice(0, rel.length - ext.length);
  for (let n = 1; n <= 9999; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!exists(candidate)) return candidate;
  }
  throw appError('E_TOO_MANY_DUPES', rel);
}

module.exports = {
  readZipMarkdownEntries, sanitizeTitle, uniqueRel, appError,
  MAX_IMPORT_ENTRY_BYTES, MAX_IMPORT_TOTAL_BYTES, MAX_IMPORT_ENTRIES
};
