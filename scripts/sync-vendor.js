// scripts/sync-vendor.js
// 把渲染进程需要的第三方库从 node_modules 同步到 src/vendor/。
// 为什么需要这一步：渲染进程跑在 contextIsolation: true 下，没有 require，
// 只能用 <script> 加载普通脚本，所以必须落地一份浏览器可直接加载的构建产物。
// 升级依赖后重新执行：npm run sync-vendor
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nm = path.join(root, 'node_modules');
const vendor = path.join(root, 'src', 'vendor');

fs.mkdirSync(vendor, { recursive: true });

// 直接可用的浏览器构建
const copies = [
  ['marked/lib/marked.umd.js', 'marked.umd.js'],
  ['dompurify/dist/purify.min.js', 'purify.min.js']
];
for (const [from, to] of copies) {
  const src = path.join(nm, from);
  if (!fs.existsSync(src)) throw new Error('缺少依赖文件，请先 npm install: ' + from);
  fs.copyFileSync(src, path.join(vendor, to));
  console.log('copied ' + from + ' -> src/vendor/' + to);
}

// diff-match-patch 只发 CommonJS，包一层浏览器壳：
// 源码结尾用 module.exports，浏览器里 module 未定义会直接抛错。
const dmpEntry = path.join(nm, 'diff-match-patch/index.js');
if (!fs.existsSync(dmpEntry)) throw new Error('缺少依赖文件，请先 npm install: diff-match-patch');
const dmpSrc = fs.readFileSync(dmpEntry, 'utf8');
const wrapped = [
  '/* 由 scripts/sync-vendor.js 从 node_modules/diff-match-patch/index.js 生成，请勿手改。',
  ' * 原始许可：Apache-2.0（见 node_modules/diff-match-patch/LICENSE）',
  ' */',
  '(function (global) {',
  '  var module = { exports: {} };',
  '  var exports = module.exports;',
  dmpSrc,
  '  global.diff_match_patch = module.exports;',
  '})(typeof window !== \'undefined\' ? window : globalThis);',
  ''
].join('\n');
fs.writeFileSync(path.join(vendor, 'diff-match-patch.js'), wrapped, 'utf8');
console.log('generated src/vendor/diff-match-patch.js');
