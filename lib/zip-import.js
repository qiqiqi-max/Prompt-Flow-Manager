// lib/zip-import.js
// ZIP 导入的纯逻辑部分，抽出来是为了能脱离 Electron 直接跑单测。
// 注意：archiver 只能压缩，不能解压，所以解压用 yauzl。
const path = require('path');
const yauzl = require('yauzl');

// 单个 .md 条目上限，防止构造出的超大条目吃满内存
const MAX_IMPORT_ENTRY_BYTES = 4 * 1024 * 1024;

// 直接从 zip 流里读出所有 .md 条目内容。
// 不落盘、不使用 zip 内的路径来写文件，因此天然免疫 zip-slip 路径穿越。
function readZipMarkdownEntries(zipPath, options = {}) {
  const maxBytes = options.maxBytes || MAX_IMPORT_ENTRY_BYTES;
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(new Error('无法打开 ZIP: ' + err.message));
      const out = [];
      const skipped = [];
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

      zip.on('error', (e) => done(reject, new Error('ZIP 解析失败: ' + e.message)));
      zip.on('end', () => done(resolve, { entries: out, skipped }));
      zip.on('entry', (entry) => {
        const isDir = /\/$/.test(entry.fileName);
        if (isDir || !entry.fileName.toLowerCase().endsWith('.md')) return zip.readEntry();
        if (entry.uncompressedSize > maxBytes) {
          skipped.push({ name: entry.fileName, reason: '超过大小上限 ' + maxBytes + ' 字节' });
          return zip.readEntry();
        }
        zip.openReadStream(entry, (e2, stream) => {
          if (e2) return done(reject, new Error('读取条目失败: ' + entry.fileName + ' - ' + e2.message));
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', (e3) => done(reject, new Error('读取条目失败: ' + entry.fileName + ' - ' + e3.message)));
          stream.on('end', () => {
            out.push({ name: path.posix.basename(entry.fileName), content: Buffer.concat(chunks).toString('utf8') });
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
  throw new Error('同名文件过多，无法生成新名称: ' + rel);
}

module.exports = { readZipMarkdownEntries, sanitizeTitle, uniqueRel, MAX_IMPORT_ENTRY_BYTES };
