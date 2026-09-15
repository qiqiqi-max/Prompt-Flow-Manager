// tests/smoke.test.js - 冒烟测试
// 运行：npm test          退出码 0 = 全过，非 0 = 有失败
// 这里覆盖的都是真实出现过的故障，不是为了凑数：每条断言下面都注明了它防的是什么。
// 界面能否真正渲染由 npm run test:ui（Electron 自检）负责，静态检查测不到那一层。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { console.error('  ✗ ' + msg); failures++; }
}
function section(name) { console.log('--- ' + name + ' ---'); }

const mainSrc = fs.readFileSync(path.join(root, 'electron-main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');

console.log('冒烟测试');

section('关键文件存在性');
const required = [
  'electron-main.js', 'preload.js', 'lib/zip-import.js', 'scripts/sync-vendor.js',
  'src/index.html', 'src/styles.css', 'src/renderer.js', 'src/i18n.js', 'src/frontmatter.js',
  'src/vendor/marked.umd.js', 'src/vendor/purify.min.js', 'src/vendor/diff-match-patch.js',
  'package.json', 'build/icon.png', 'prompt-flow-manager.ico', '.gitignore'
];
for (const f of required) assert(fs.existsSync(path.join(root, f)), '存在 ' + f);

section('预置内容目录');
function countMd(dir) {
  let n = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) n += countMd(p);
    else if (ent.name.endsWith('.md')) n++;
  }
  return n;
}
for (const d of ['prompts', 'workflows', 'templates']) {
  const full = path.join(root, d);
  assert(fs.existsSync(full) && fs.statSync(full).isDirectory(), '目录存在 ' + d);
  const count = countMd(full);
  assert(count > 0, d + ' 下有 .md 文件（共 ' + count + ' 个）');
}

section('package.json 合法性');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert(pkg.main === 'electron-main.js', 'main 指向 electron-main.js');
assert(!!(pkg.scripts && pkg.scripts.start && pkg.scripts.dist && pkg.scripts.test), '有 start/dist/test 脚本');
assert(!!(pkg.build && pkg.build.appId), 'build 配置有 appId');
// 防回归：渲染进程用 vendor 副本，但 lib/zip-import.js 在主进程里 require yauzl，
// 打进 asar 后必须能解析，所以 yauzl 只能是 dependencies。
assert(!!(pkg.dependencies && pkg.dependencies.yauzl), 'yauzl 在 dependencies（主进程运行时需要）');
assert(!!(pkg.dependencies && pkg.dependencies.archiver), 'archiver 在 dependencies');
// 防回归：lib/ 曾漏在 build.files 之外会导致打包版启动即崩
for (const p of ['lib/**/*', 'src/**/*', 'preload.js']) {
  assert(pkg.build.files.includes(p), 'build.files 包含 ' + p);
}
// 会被 sync-vendor 拷进 src/vendor/ 的三个库必须锁死到确定版本。
// 理由：vendor 副本是提交进仓库的，而 ^x.y.z 允许 npm install 装到别的版本，
// 于是"package.json 声明的版本"和"实际加载的那份文件"可以静默不一致，
// 出问题时按声明的版本号去查 changelog 会查错。
// DOMPurify 尤其重要：sandbox 是关的（见 webPreferences 注释），
// 它是提示词正文渲染唯一的 XSS 边界，版本必须是确定的。
for (const dep of ['dompurify', 'marked', 'diff-match-patch']) {
  const range = (pkg.devDependencies || {})[dep] || '';
  assert(/^\d+\.\d+\.\d+$/.test(range), dep + ' 锁定到确定版本（当前 ' + range + '）');
}
assert(!!(pkg.engines && pkg.engines.node), '声明了 engines.node');

section('JS 语法检查');
const jsFiles = [
  'electron-main.js', 'preload.js', 'lib/zip-import.js', 'scripts/sync-vendor.js',
  'src/renderer.js', 'src/i18n.js', 'src/frontmatter.js', 'tests/smoke.test.js',
  'src/vendor/marked.umd.js', 'src/vendor/purify.min.js', 'src/vendor/diff-match-patch.js'
];
for (const f of jsFiles) {
  try {
    execSync('node --check ' + JSON.stringify(path.join(root, f)), { stdio: 'pipe' });
    assert(true, f + ' 语法正确');
  } catch (e) {
    assert(false, f + ' 语法错误: ' + (e.stderr ? e.stderr.toString().split('\n')[0] : e.message));
  }
}

section('打包路径分离（曾导致打包版白屏）');
// 故障回顾：APP_ROOT 打包后指向 userData，却又拿它去加载 preload.js / src/index.html，
// 而这两个文件只存在于 asar 内，结果窗口一片空白。
assert(/const CODE_ROOT = __dirname/.test(mainSrc), 'CODE_ROOT 用 __dirname 定位代码资源');
assert(/app\.isPackaged \? app\.getPath\('userData'\) : __dirname/.test(mainSrc), 'DATA_ROOT 打包后指向 userData、开发时指向项目目录');
// PFM_DATA_DIR 是给测试用的逃生口，只允许影响数据目录，不能影响代码目录
assert(/PFM_DATA_DIR/.test(mainSrc), 'DATA_ROOT 支持 PFM_DATA_DIR 覆盖（供功能自检隔离数据）');
assert(!/PFM_DATA_DIR[\s\S]{0,200}CODE_ROOT\s*=/.test(mainSrc), 'PFM_DATA_DIR 不影响 CODE_ROOT');
assert(/preload: path\.join\(CODE_ROOT, 'preload\.js'\)/.test(mainSrc), 'preload 从 CODE_ROOT 加载');
assert(/loadFile\(path\.join\(CODE_ROOT, 'src', 'index\.html'\)\)/.test(mainSrc), 'index.html 从 CODE_ROOT 加载');
assert(!/path\.join\(DATA_ROOT, 'preload\.js'\)/.test(mainSrc), '未从数据目录加载 preload.js');
assert(!/path\.join\(DATA_ROOT, 'src'/.test(mainSrc), '未从数据目录加载 src/');

section('渲染进程隔离');
assert(/contextIsolation: true/.test(mainSrc), 'contextIsolation 已开启');
assert(/nodeIntegration: false/.test(mainSrc), 'nodeIntegration 已关闭');
assert(/contextBridge\.exposeInMainWorld/.test(preloadSrc), 'preload 走 contextBridge');
// 防回归：contextBridge 暴露的属性不可配置，若叫 'api' 会和 renderer.js 里
// const api = ... 撞车，抛 "Identifier 'api' has already been declared"，整段脚本不执行。
assert(!/exposeInMainWorld\('api'/.test(preloadSrc), "桥接名不叫 'api'（会与渲染进程的 const api 冲突)");
assert(!/\brequire\s*\(/.test(rendererSrc), 'renderer.js 不再使用 require');
// 防回归：i18n.js 已在全局声明 const I18N，renderer.js 再声明一次会让整个脚本不执行。
assert(!/^\s*(const|let|var)\s+I18N\b/m.test(rendererSrc), 'renderer.js 未重复声明 I18N');
const i18nDecls = (fs.readFileSync(path.join(root, 'src/i18n.js'), 'utf8').match(/^\s*(const|let|var)\s+I18N\b/gm) || []).length;
assert(i18nDecls === 1, 'I18N 全局只声明一次');
for (const v of ['vendor/marked.umd.js', 'vendor/purify.min.js', 'vendor/diff-match-patch.js', 'i18n.js', 'frontmatter.js', 'renderer.js']) {
  assert(htmlSrc.includes('src="' + v + '"'), 'index.html 引入了 ' + v);
}
assert(/Content-Security-Policy/.test(htmlSrc), 'index.html 有 CSP');

section('主进程符号完整性（曾出现调用不存在的函数）');
// 故障回顾：import-single / import-zip / add-project-type / remove-project-type
// 调用了从未定义的 createFile() 和 setConfig()，一点就 ReferenceError。
assert(/async function createFileAt\(/.test(mainSrc), 'createFileAt 已定义');
// 不锁 async：updateConfig 现在是同步函数返回 queueConfigWrite 的 promise
// （写入要排队串行化，见 queueConfigWrite）。这里只关心"定义存在"。
assert(/function updateConfig\(/.test(mainSrc), 'updateConfig 已定义');
assert(!/createFile\(null,/.test(mainSrc), '不再调用不存在的 createFile(null, ...)');
assert(!/setConfig\(null,/.test(mainSrc), '不再调用不存在的 setConfig(null, ...)');
// 粗查：所有被调用的本地函数都要有定义
const defined = new Set();
for (const m of mainSrc.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
for (const m of mainSrc.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
for (const m of mainSrc.matchAll(/let\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
const imported = new Set(['readZipMarkdownEntries', 'sanitizeTitle', 'uniqueRel']);
const suspicious = ['createFile', 'setConfig', 'saveVersionFile', 'writeConfig'];
for (const name of suspicious) {
  const called = new RegExp('(?<![\\w.])' + name + '\\s*\\(').test(mainSrc);
  assert(!called || defined.has(name) || imported.has(name), name + ' 未被当作不存在的函数调用');
}

section('ZIP 导入逻辑');
const { readZipMarkdownEntries, sanitizeTitle, uniqueRel } = require('../lib/zip-import');
// 防回归：原实现用 archiver（只能压缩）去"解压"，导入永远是空的却返回成功
assert(!/require\('archiver'\)\('zip'/.test(mainSrc), '不再用 archiver 假装解压');
assert(/zip-import/.test(mainSrc), '主进程使用 lib/zip-import');

// uniqueRel 死循环回归：原代码 while 循环体不改变 rel
const existing = new Set(['prompts/testing/a.md', 'prompts/testing/a-1.md']);
const exists = (r) => existing.has(r);
assert(uniqueRel('prompts/testing/b.md', exists) === 'prompts/testing/b.md', '无冲突时原样返回');
assert(uniqueRel('prompts/testing/a.md', exists) === 'prompts/testing/a-2.md', '重名时递增到未占用的名字');
let loopGuard = true;
try {
  // 全部占用时必须抛错而不是死循环
  uniqueRel('x.md', () => true);
  loopGuard = false;
} catch (e) { loopGuard = /^E_TOO_MANY_DUPES\b/.test(e.message); }
assert(loopGuard, '候选名耗尽时抛错，不会死循环');

// sanitizeTitle：frontmatter 的 title 会变成文件名，必须挡住路径穿越。
// 注意别写成 `A === '具体值' || 弱条件` 那种形式：这里原先第一个子句其实是 false
// （真实输出是 '__.._evil' 而不是 '_.._evil'），全靠后半句"不含 /"兜着，
// 于是穿越防护退化成只查一个字符，改坏了也测不出来。改成逐条断言真正的保证。
{
  const traversal = sanitizeTitle('../../evil');
  assert(!/[\\/]/.test(traversal), 'title 中的路径分隔符被清除（得到 ' + traversal + '）');
  assert(!traversal.startsWith('.'), 'title 不以点开头（否则会变成隐藏文件/被目录遍历跳过）');
  // 关键性质：清洗后的名字拼进目录里不能跑出这个目录
  const joined = path.join('/lib/prompts', traversal + '.md');
  assert(joined.startsWith(path.join('/lib/prompts') + path.sep), '清洗后的名字拼路径不会逃出目标目录');
  // 纯点号的标题不能产出 "." / ".." 这种在文件系统里有特殊含义的名字
  for (const raw of ['.', '..', '....']) {
    const out = sanitizeTitle(raw);
    assert(out !== '.' && out !== '..', 'title "' + raw + '" 不会产出 . 或 ..（得到 ' + out + '）');
  }
}
assert(!sanitizeTitle('a\\b:c*d?e"f<g>h|i').match(/[\\/:*?"<>|]/), 'Windows 非法字符被清除');
assert(sanitizeTitle('   ') === '未命名', '空标题回退为默认名');
// Windows 下文件名结尾的点和空格会被静默吃掉，导致"写入的名字"和"磁盘上的名字"不一致
assert(!/[. ]$/.test(sanitizeTitle('evil. ')), 'title 结尾的点和空格被清除');

section('ZIP 真实往返（压缩 → 解压）');
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-zip-'));
  const zipPath = path.join(tmp, 't.zip');
  try {
    const archiver = require('archiver');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      const ar = archiver('zip', { zlib: { level: 9 } });
      out.on('close', resolve);
      ar.on('error', reject);
      ar.pipe(out);
      ar.append('---\ntitle: 往返测试\nstage: testing\n---\n正文内容', { name: 'prompts/testing/往返测试.md' });
      ar.append('---\ntitle: 第二个\n---\nbody2', { name: 'nested/dir/第二个.md' });
      ar.append('not markdown', { name: 'readme.txt' });
      ar.finalize();
    });
    const { entries, skipped } = await readZipMarkdownEntries(zipPath);
    assert(entries.length === 2, '只读出 .md 条目（读到 ' + entries.length + ' 个，忽略 .txt）');
    assert(skipped.length === 0, '无超限条目被跳过');
    const roundTrip = entries.find(e => e.name === '往返测试.md');
    assert(!!roundTrip, '条目名正确解析（含中文）');
    assert(!!roundTrip && roundTrip.content.includes('正文内容'), '条目内容完整且为 UTF-8');
    const oversize = await readZipMarkdownEntries(zipPath, { maxBytes: 5 });
    assert(oversize.entries.length === 0 && oversize.skipped.length === 2, '超过大小上限的条目被跳过而非静默丢弃');
  } catch (e) {
    assert(false, 'ZIP 往返测试异常: ' + e.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  section('版本管理约定');
  // 防回归：星标版本曾被算进 30 条上限，导致未星标版本被提前删掉
  assert(/const unpinned = files\.filter\(f => !pinned\[f\]\)/.test(mainSrc), 'pruneVersions 只按未星标数量算配额');
  assert(!/removed >= files\.length - MAX_UNPINNED_VERSIONS/.test(mainSrc), '不再用总数（含星标）算配额');
  // 防回归：时间戳只到秒，同一秒内两次保存会互相覆盖
  assert(/getMilliseconds\(\)/.test(mainSrc), '版本时间戳带毫秒，避免同秒覆盖');
  // 防回归：versionDirFor 直接 path.join(rel)，可路径穿越
  // 两半都要在：Windows 上跨盘符时 path.relative 返回绝对路径而不是一串 ..，
  // 只判 startsWith('..') 会被 'D:/x' 这类输入整个绕过（见 safeJoin 的说明）。
  assert(/path\.relative\(VERSIONS_DIR, resolved\)/.test(mainSrc), 'versionDirFor 做了越权校验');
  assert(/relV\.startsWith\('\.\.'\) \|\| path\.isAbsolute\(relV\)/.test(mainSrc), 'versionDirFor 同时判了 isAbsolute（跨盘符）');
  assert(/rel2\.startsWith\('\.\.'\) \|\| path\.isAbsolute\(rel2\)/.test(mainSrc), 'safeJoin 同时判了 isAbsolute（跨盘符）');
  assert(/function isSelfUrl\(/.test(mainSrc), '导航守卫有 isSelfUrl 白名单判定');
  assert(!/url\.startsWith\('file:\/\/'\)\) return/.test(mainSrc), 'will-navigate 不再放行任意 file:// URL');
  assert(/VERSION_FILE_RE/.test(mainSrc), '版本文件名有白名单校验');
  assert(!/path\.join\(versionDirFor\(rel\), file\)/.test(mainSrc), 'read-version 不再直接拼接未校验的 file');

  section('锁定与配置');
  // 防回归：锁定只存在渲染进程内存里，主进程照删不误
  assert(/async function isLocked\(/.test(mainSrc), '主进程有 isLocked');
  assert(/if \(await isLocked\(rel\)\) throw appError\('E_LOCKED'/.test(mainSrc), 'trash 在主进程强制校验锁');
  assert(/lockedFiles: \[\]/.test(mainSrc), 'loadConfig 默认值含 lockedFiles');
  // 防回归：resize/move 每次触发都读写 config.json
  assert(/setTimeout\(flushBounds/.test(mainSrc), '窗口尺寸保存做了防抖');
  assert(!/win\.on\('resize', saveBounds\)/.test(mainSrc), '不再直接把未防抖的写盘挂到 resize');

  section('i18n 覆盖（英文界面曾大面积漏翻）');
// 故障回顾：字典有 85 个键，但 renderer.js 只调了 7 次 t()，其余几十处提示
// 全是硬编码中文 —— 切到 English 后一操作就弹中文。
// 这里用"白名单豁免"来卡：renderer.js 里任何含中文的行，要么是注释，
// 要么必须显式标注 // i18n-exempt: <理由>（或落在 i18n-exempt-start/end 区间内）。
function collectUnexemptedCjk(file) {
  const raw = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
  const cjk = /[\u4e00-\u9fa5]/;
  const bad = [];
  let inExemptBlock = false;
  raw.forEach((line, i) => {
    if (/\/\/\s*i18n-exempt-start/.test(line)) { inExemptBlock = true; return; }
    if (/\/\/\s*i18n-exempt-end/.test(line)) { inExemptBlock = false; return; }
    if (inExemptBlock) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;          // 纯注释行
    if (/\/\/\s*i18n-exempt\b/.test(line)) return;          // 行内豁免
    const code = line
      .replace(/\/\*[\s\S]*?\*\//g, '')   // 行内块注释
      .replace(/\/\/.*$/, '');            // 行尾注释
    if (cjk.test(code)) bad.push((i + 1) + ': ' + line.trim());
  });
  return bad;
}
const unexempted = collectUnexemptedCjk('src/renderer.js');
assert(unexempted.length === 0,
  'renderer.js 无未标注豁免的硬编码中文' + (unexempted.length ? '，违规行：\n      ' + unexempted.join('\n      ') : ''));

// t() 调用量：低于这个数说明又开始往代码里塞文案了
const tCalls = (rendererSrc.match(/\bt\('/g) || []).length + (rendererSrc.match(/\btErr\('/g) || []).length;
assert(tCalls >= 80, 'renderer.js 的 t()/tErr() 调用数 >= 80（实际 ' + tCalls + '）');
assert(/function tErr\(/.test(rendererSrc), '有统一的失败提示拼装函数 tErr');
assert(/function dirLabel\(/.test(rendererSrc), '有目录/阶段名本地化函数 dirLabel');
assert(/s\.split\('\{' \+ k \+ '\}'\)/.test(rendererSrc), 't() 支持 {name} 占位符替换');

// 防回归：map 回调用 t 作参数名会遮蔽全局 t()，回调内调 t('key') 直接抛异常
const shadow = [];
rendererSrc.split(/\r?\n/).forEach((line, i) => {
  if (/\.(map|forEach|filter|find|some|every|sort|reduce)\(\s*t\s*(=>|,)/.test(line) && /\bt\('/.test(line)) {
    shadow.push(i + 1);
  }
});
assert(shadow.length === 0, '没有在遮蔽了 t 的回调里调用 t()' + (shadow.length ? '（行 ' + shadow.join(',') + '）' : ''));

// index.html 引用的键必须都存在，否则界面上会直接显示键名
{
  const I18N = require('../src/i18n.js');
  const htmlKeys = new Set();
  for (const m of htmlSrc.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) htmlKeys.add(m[1]);
  const missing = [...htmlKeys].filter(k => !(k in I18N.zh));
  assert(missing.length === 0, 'index.html 引用的 i18n 键都存在' + (missing.length ? '，缺失：' + missing.join(', ') : ''));
  const used = new Set();
  for (const m of rendererSrc.matchAll(/\bt(?:Err)?\('([^']+)'/g)) used.add(m[1]);
  const missingR = [...used].filter(k => !(k in I18N.zh));
  assert(missingR.length === 0, 'renderer.js 引用的 i18n 键都存在' + (missingR.length ? '，缺失：' + missingR.join(', ') : ''));
  assert(htmlKeys.size >= 40, 'index.html 上挂了足够多的 data-i18n（' + htmlKeys.size + ' 个）');
}

section('错误码本地化');
// 主进程原先直接抛中文，英文界面下 tErr() 会拼出中文详情。
// 现在统一成 appError('E_XXX', detail)，渲染侧 describeError() 负责翻译。
assert(/function appError\(/.test(mainSrc), '主进程有 appError 工具');
assert(!/throw new Error\('[^']*[\u4e00-\u9fa5]/.test(mainSrc), '主进程不再抛中文字面量错误');
{
  const libSrc = fs.readFileSync(path.join(root, 'lib/zip-import.js'), 'utf8');
  assert(!/(throw|reject\()\s*new Error\('[^']*[\u4e00-\u9fa5]/.test(libSrc), 'lib/zip-import.js 不再抛中文字面量错误');
}
assert(/function describeError\(/.test(rendererSrc), '渲染进程有 describeError');
assert(/describeError\(e\)/.test(rendererSrc), 'tErr 走 describeError');
{
  const I18N = require('../src/i18n.js');
  // 主进程用到的每个错误码都必须有对应文案，否则界面上会露出 E_XXX
  const codes = new Set();
  for (const src of [mainSrc, fs.readFileSync(path.join(root, 'lib/zip-import.js'), 'utf8')]) {
    for (const m of src.matchAll(/appError\('([A-Z0-9_]+)'/g)) codes.add(m[1]);
  }
  assert(codes.size >= 10, '收集到足够多的错误码（' + codes.size + ' 个）');
  const missing = [...codes].filter(c => !('err_' + c in I18N.zh) || !('err_' + c in I18N.en));
  assert(missing.length === 0, '每个错误码都有中英文案' + (missing.length ? '，缺失：' + missing.join(', ') : ''));
  // 带 {detail} 的文案，中英必须一致地带占位符，否则一种语言会丢掉细节
  const inconsistent = [...codes].filter(c => {
    const k = 'err_' + c;
    return I18N.zh[k].includes('{detail}') !== I18N.en[k].includes('{detail}');
  });
  assert(inconsistent.length === 0, '中英文案的 {detail} 占位符一致' + (inconsistent.length ? '，不一致：' + inconsistent.join(', ') : ''));
}

section('搜索性能');
// 搜索会遍历整库。原先 getMetaList 读一遍、searchAll 再读一遍，是 2N 次 I/O。
assert(/async function getMetaList\(includeContent = false\)/.test(mainSrc), 'getMetaList 支持带出正文');
assert(/const meta = await getMetaList\(true\)/.test(mainSrc), 'searchAll 复用 getMetaList 读到的正文');
assert(!/countedReadFile\(safeJoin\(item\.rel\)\)/.test(mainSrc), 'searchAll 不再逐个重读文件');
assert(/async function readParsedCached\(/.test(mainSrc), '有按 mtime+size 失效的正文缓存');
assert(/hit\.mtimeMs === st\.mtimeMs && hit\.size === st\.size/.test(mainSrc), '缓存同时校验 mtime 与 size');
// 所有写入/移动/删除路径都必须清缓存，否则会读到旧内容
const dropCount = (mainSrc.match(/dropFromCache\(/g) || []).length;
assert(dropCount >= 8, '写入/改名/删除/回滚/恢复都清了缓存（' + dropCount + ' 处）');
assert(fs.existsSync(path.join(root, 'tests/search-bench.js')), '存在搜索压测脚本 tests/search-bench.js');
assert(!!pkg.scripts.bench, '有 npm run bench');

section('对话框自动化');
// 导出/导入四个流程要弹系统对话框，原先只能人工点
assert(/function installSelfTestDialogStubs\(/.test(mainSrc), '有自检用的对话框桩');
assert(/PFM_SELFTEST_DIALOGS/.test(mainSrc), '对话框桩由 PFM_SELFTEST_DIALOGS 队列驱动');
assert(/process\.env\.PFM_SELFTEST === '1' && process\.env\.PFM_SELFTEST_DIALOGS/.test(mainSrc),
  '对话框桩只在自检模式生效（生产行为不变）');
{
  const fnSrc = fs.readFileSync(path.join(root, 'tests/functional-smoke.js'), 'utf8');
  assert(/dialogQueue/.test(fnSrc), '功能测试准备了对话框队列');
  assert(/exportedZip/.test(fnSrc) && /PK/.test(fnSrc), '功能测试校验导出的 ZIP 是真 ZIP');
}

section('日志不能把应用打挂');
// 故障回顾：从终端启动后关掉终端、或 stdout 被管到提前退出的命令（PowerShell 的
// | Select-Object -First N 就会这样），下一次 console.log 抛 EPIPE，
// 主进程未捕获异常 → Electron 弹 "A JavaScript error occurred in the main process"。
assert(/for \(const stream of \[process\.stdout, process\.stderr\]\)/.test(mainSrc), '主进程给 stdout/stderr 挂了错误处理');
assert(/stream\.on\('error', \(\) => \{\}\)/.test(mainSrc), '写日志失败时静默丢弃，不抛异常');
{
  // 这个守卫必须在任何真实的 console.log 调用之前装上，否则启动早期的日志仍会崩。
  // 按行找，且跳过注释行——注释里提到 console.log 不算。
  const lines = mainSrc.split(/\r?\n/);
  const guardLine = lines.findIndex(l => l.includes('process.stdout, process.stderr'));
  const firstLogLine = lines.findIndex(l => !/^\s*(\/\/|\*)/.test(l) && /console\.log\s*\(/.test(l.replace(/\/\/.*$/, '')));
  assert(guardLine !== -1, '找到了 stdout/stderr 守卫');
  assert(firstLogLine === -1 || guardLine < firstLogLine,
    '守卫在第一次 console.log 调用之前（守卫第 ' + (guardLine + 1) + ' 行，首个日志第 ' + (firstLogLine + 1) + ' 行）');
}

section('弹层不能被自己的打开点击关掉');
// 故障回顾：promptInput() 是在按钮的 click 回调里显示弹层的，这次 click 继续冒泡到
// document，而 document 上监听的是 click 且"点弹层外就关闭"，于是弹层刚打开就被关掉。
// 表现是「新建提示词 / 新建工作流 / 新建目录 / 重命名 / 移动 / 创建副本 / 导入」
// 全部点了没反应——等于整个应用只能看不能改。
assert(!/document\.addEventListener\('click', \(e\) => \{\s*const menu = \$\('ctx-menu'\)/.test(rendererSrc),
  '关闭弹层的监听不再挂在 click 上');
assert(/document\.addEventListener\('mousedown'/.test(rendererSrc), '改为监听 mousedown（在 click 之前触发）');
assert(/function hideCtxMenu\(/.test(rendererSrc), '有统一的关闭函数 hideCtxMenu');
assert(/function showCenteredMenu\(/.test(rendererSrc), '有统一的居中显示函数 showCenteredMenu');
// 第二个故障：.ctx-menu 没有 left/top，position:fixed 下会落到视口外，
// 于是"显示了但看不见"。输入类弹层必须显式定位。
{
  const cssSrc = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  assert(/\.ctx-menu\.ctx-centered/.test(cssSrc), 'CSS 里有居中定位的 .ctx-centered');
  assert(/\.ctx-centered[\s\S]{0,120}left:\s*50%/.test(cssSrc), '.ctx-centered 显式设置了 left');
  assert(/\.ctx-centered[\s\S]{0,120}top:/.test(cssSrc), '.ctx-centered 显式设置了 top');
}
assert(/showCenteredMenu\(\);\s*\n\s*const inp = \$\('ctx-input'\)/.test(rendererSrc), 'promptInput 用居中显示');
assert(/menu\.classList\.remove\('ctx-centered'\); \/\/ 右键菜单按坐标定位/.test(rendererSrc),
  '右键菜单会清掉居中态，按坐标定位');

section('UI 点击自检');
// 之前所有测试都直接调 IPC，绕过了 UI，所以"点了没反应"一路没被发现。
assert(/PFM_SELFTEST_UI/.test(mainSrc), '主进程支持 UI 点击自检（PFM_SELFTEST_UI）');
assert(/dispatchEvent\(new MouseEvent\(type/.test(mainSrc), '用真实事件序列 mousedown→mouseup→click 点击');
assert(/r\.bottom <= window\.innerHeight \+ 1/.test(mainSrc), '弹层可见性判定包含"矩形在视口内"，不只看 hidden 类');
assert(/拒绝在真实库上点/.test(mainSrc), 'UI 自检未设 PFM_DATA_DIR 时拒绝执行');
{
  const uiSrc = fs.readFileSync(path.join(root, 'tests/ui-smoke.js'), 'utf8');
  assert(/PFM_SELFTEST_UI/.test(uiSrc), 'test:ui 会跑 UI 点击自检');
  assert(/点「新建提示词」后弹出阶段选择且在视口内/.test(uiSrc), 'test:ui 卡住"新建提示词"这条');
  assert(/整条新建流程真的落盘了文件/.test(uiSrc), 'test:ui 卡住"新建能落盘"这条');
}

section('工作流流程图解析');
// 故障回顾：flow 段用惰性正则 /^flow:\\s*\\n([\\s\\S]*?)(?=^\\S|\\n\\S|$)/m 去截，
// 多行模式下第一行行尾就满足 $，结果只解析出 1 个步骤且丢掉 prompt，
// 流程图永远只有一个空节点。README 里承诺的"点击节点跳转"实际一直是坏的。
assert(!/\(\?=\^\\S\|\\n\\S\|\$\)/.test(rendererSrc), '不再用会被行尾锚点截断的惰性正则截 flow 段');
assert(/lines\.findIndex\(l => \/\^flow:/.test(rendererSrc), 'flow 段改为按行提取');
assert(/if \(\/\^\\s\/\.test\(line\)\) blockLines\.push\(line\)/.test(rendererSrc), '缩进行归入 flow 段');
assert(/else break;/.test(rendererSrc), '遇到顶格行才结束 flow 段');
// 用真实的种子工作流验证解析结果
{
  const wf = fs.readFileSync(path.join(root, 'workflows/full-project-flow.md'), 'utf8');
  const stepLines = (wf.match(/^\s+- id:/gm) || []).length;
  assert(stepLines === 5, '示例工作流本身有 5 个步骤（实际 ' + stepLines + '）');
  const promptLines = (wf.match(/^\s+prompt:/gm) || []).length;
  assert(promptLines === stepLines, '每个步骤都有 prompt 字段');
}

section('只读体检');
assert(/PFM_SELFTEST_READONLY/.test(mainSrc), '主进程支持只读体检（PFM_SELFTEST_READONLY）');
assert(/renderFlowDiagram\(steps/.test(mainSrc), '只读体检会真的渲染一遍流程图并数节点');
assert(/brokenLinks/.test(mainSrc), '只读体检会检查流程图节点指向的文件是否存在');
{
  const uiSrc = fs.readFileSync(path.join(root, 'tests/ui-smoke.js'), 'utf8');
  assert(/PFM_SELFTEST_READONLY/.test(uiSrc), 'test:ui 会跑只读体检');
  assert(/流程图都能渲染出节点/.test(uiSrc), 'test:ui 校验流程图节点数');
  assert(/pfm-ui-/.test(uiSrc), 'test:ui 在临时目录副本上跑，不碰真实库');
}

section('测试防护');
// 功能自检会增删文件，必须拒绝在没有 PFM_DATA_DIR 的情况下运行
assert(/拒绝在真实数据目录上跑/.test(mainSrc), '功能自检未设 PFM_DATA_DIR 时会拒绝执行');
assert(fs.existsSync(path.join(root, 'tests/ui-smoke.js')), '存在 tests/ui-smoke.js');
assert(fs.existsSync(path.join(root, 'tests/functional-smoke.js')), '存在 tests/functional-smoke.js');
assert(!!pkg.scripts['test:fn'] && !!pkg.scripts['test:ui'], '有 test:ui / test:fn 脚本');

section('调试残留');
  // 防回归：buildSubTree/listTree 每次调用都同步 appendFileSync，日志无限增长
  assert(!/appendFileSync\(path\.join\(DATA_ROOT, 'debug\.log'\)/.test(mainSrc), '不再往数据目录写 debug.log');
  assert(!mainSrc.includes('\uFFFD'), 'electron-main.js 无编码乱码字符');
  for (const junk of ['.shot.ps1', '.screenshot.png', '.screenshot-v2.png', 'debug.log']) {
    assert(!fs.existsSync(path.join(root, junk)), '开发残留已清理: ' + junk);
  }

  section('i18n 键完整性');
  const I18N = require('../src/i18n.js');
  const zhKeys = Object.keys(I18N.zh).sort();
  const enKeys = Object.keys(I18N.en).sort();
  assert(zhKeys.length > 20, 'zh 字典条目数 > 20');
  assert(zhKeys.length === enKeys.length, 'en 与 zh 条目数一致 (' + zhKeys.length + ' vs ' + enKeys.length + ')');
  assert(zhKeys.filter(k => !(k in I18N.en)).length === 0, 'en 无缺失键');
  assert(enKeys.filter(k => !(k in I18N.zh)).length === 0, 'zh 无缺失键');

  section('frontmatter 示例格式');
  const sampleMd = fs.readFileSync(path.join(root, 'prompts/project-init/需求分析.md'), 'utf8');
  assert(/^---\r?\n[\s\S]*?\r?\n---/.test(sampleMd), '示例提示词含 frontmatter');

  section('图标');
  const iconPng = fs.readFileSync(path.join(root, 'build/icon.png'));
  assert(iconPng.length > 1000, 'icon.png 非空 (>1KB)');
  assert(iconPng[0] === 0x89 && iconPng[1] === 0x50, 'icon.png 是 PNG 格式');

  console.log('');
  if (failures === 0) {
    console.log('全部通过 ✓（界面能否真正渲染请另跑 npm run test:ui）');
    process.exit(0);
  } else {
    console.error(failures + ' 项失败');
    process.exit(1);
  }
})();
