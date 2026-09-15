// tests/packaged-smoke.js
// 对**打包产物**跑自检，而不是对源码目录跑。
//
// 为什么必须单独有这一层：本项目出过的最严重的一次故障是"打包后界面全白"，
// 原因是 preload / index.html 的路径指向了数据目录而不是 asar 内的代码目录。
// 那个 bug 在 npm run test:ui 下**永远测不出来**——开发模式里 CODE_ROOT 和
// DATA_ROOT 恰好是同一个目录，指错了也照样能读到文件。
// 只有真的打成 exe、让 CODE_ROOT 变成 asar 内路径、DATA_ROOT 变成 userData，
// 两者分叉之后，路径错误才会暴露。
//
// 同理，ensureSeedData（首次运行把种子数据从 asar 拷到可写目录）整段代码
// 在开发模式下直接 return，源码测试一行都跑不到。
//
// 运行：npm run dist 之后 npm run test:packaged
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const unpackedDir = path.join(distDir, 'win-unpacked');

let failures = 0;
const pass = (msg, extra) => console.log('[test:packaged] PASS ' + msg + (extra ? ' → ' + extra : ''));
const fail = (msg) => { console.error('[test:packaged] FAIL ' + msg); failures++; };
const assert = (ok, msg, extra) => { if (ok) pass(msg, extra); else fail(msg + (extra ? '（' + extra + '）' : '')); };

function findExe(dir, pattern) {
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).find(n => n.endsWith('.exe') && pattern.test(n));
  return hit ? path.join(dir, hit) : null;
}

// win-unpacked 里的 exe 是控制台可见的：stdout 能抓到，所以断言走这里。
// portable 那个单文件 exe 是 GUI 子系统 + 自解压启动器，不往父进程控制台写东西
// （实测 0 字节输出），只有退出码可用——所以它只做退出码检查。
const unpackedExe = findExe(unpackedDir, /./);

// portable 必须按 package.json 里的当前版本号精确匹配，不能用 /\d+\.\d+\.\d+/
// 这种"任意版本号"。dist/ 是不清理的增量目录，里面会堆着历史版本；
// 实测第一版就踩了：readdirSync 先返回了三周前的 1.3.0.exe，于是"打包产物检查
// 通过"其实是在验证一个陈旧的 exe——比没有这层检查更糟，因为它给的是假绿。
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const portableExe = findExe(distDir, new RegExp('\\b' + pkgVersion.replace(/\./g, '\\.') + '\\b'));
const stalePortables = fs.existsSync(distDir)
  ? fs.readdirSync(distDir).filter(n => n.endsWith('.exe') && !n.includes(pkgVersion))
  : [];

if (!unpackedExe) {
  console.error('[test:packaged] 找不到 dist/win-unpacked/*.exe，请先执行 npm run dist');
  process.exit(1);
}

const tmpDirs = [];
const mkTmp = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-pkg-' + tag + '-'));
  tmpDirs.push(d);
  return d;
};
const cleanup = () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
};

function runExe(exe, env, timeoutMs) {
  const res = spawnSync(exe, [], {
    cwd: path.dirname(exe),
    env: { ...process.env, ...env, ELECTRON_ENABLE_LOGGING: '1' },
    encoding: 'utf8',
    timeout: timeoutMs || 120000,
    windowsHide: true
  });
  return {
    code: res.status,
    out: (res.stdout || '') + (res.stderr || ''),
    timedOut: res.error && res.error.code === 'ETIMEDOUT'
  };
}

console.log('[test:packaged] 被测产物: ' + path.basename(unpackedExe));

// ---------- 1) 打包产物能真正加载页面 ----------
// 这一组直指"白屏"故障：CODE_ROOT 现在是 asar 内路径，DATA_ROOT 是临时目录，
// 两者已经分叉，preload / index.html / vendor 脚本任何一个解析错都会红。
{
  const dataDir = mkTmp('boot');
  const r = runExe(unpackedExe, { PFM_SELFTEST: '1', PFM_DATA_DIR: dataDir });

  assert(!r.timedOut, '打包产物在超时前退出了');
  assert(r.code === 0, '打包产物自检退出码为 0', 'exit=' + r.code);

  const mustHave = [
    // preload 是从 asar 里按 CODE_ROOT 解析的，指错就没有这个桥
    [/\[selftest\] PASS contextBridge 已注入 window\.promptFlowApi/, 'contextBridge 在打包后仍注入'],
    // 打包后仍不能把 Node 能力漏进渲染进程
    [/\[selftest\] PASS 渲染进程无 Node 能力泄漏/, '打包后渲染进程无 Node 能力泄漏'],
    // vendor 三个库是仓库内副本，被打进 asar；files 白名单漏了 src 就会红
    [/\[selftest\] PASS marked 已加载/, 'marked 从 asar 内加载成功'],
    [/\[selftest\] PASS DOMPurify 已加载/, 'DOMPurify 从 asar 内加载成功'],
    [/\[selftest\] PASS diff-match-patch 已加载/, 'diff-match-patch 从 asar 内加载成功'],
    // 文件树有节点 = index.html 加载了 + IPC 往返通了 + 数据目录读到了
    [/\[selftest\] PASS 文件树已渲染出节点/, '打包后文件树渲染出节点'],
    [/\[selftest\] 全部通过/, '打包产物自检全部通过']
  ];
  for (const [re, label] of mustHave) assert(re.test(r.out), label);

  if (failures) {
    console.error('---- 打包产物输出 ----');
    console.error(r.out.slice(-4000));
  }

  // ---------- 2) 首次运行的种子拷贝（开发模式下这段代码直接 return，测不到）----------
  assert(/\[ensureSeedData\] FINISHED/.test(r.out), 'ensureSeedData 跑完了（仅打包模式执行）');
  const seeded = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) seeded.push(p);
    }
  };
  for (const sub of ['prompts', 'workflows', 'templates']) {
    const p = path.join(dataDir, sub);
    assert(fs.existsSync(p), '种子目录已创建: ' + sub);
    if (fs.existsSync(p)) walk(p);
  }
  assert(seeded.length > 0, '种子 .md 文件真的落到了数据目录', seeded.length + ' 个');

  // 种子完成后不能残留进行中标记，否则下次启动会把用户改过的同名文件覆盖回去
  const flags = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).filter(n => n.startsWith('.seeding-'))
    : [];
  assert(flags.length === 0, '种子完成后没有残留 .seeding-* 标记', flags.join(',') || '无');
}

// ---------- 3) 退出码保真（反向对照）----------
// 上面"exit=0"要有意义，前提是这个产物**失败时真的会返回非零**。
// 不验这一条的话，只要打包产物永远返回 0，第 1 组就是个永远绿的空壳。
// 走一条必然失败的分支：功能自检缺 PFM_DATA_DIR 时代码显式 fail()。
{
  const r = runExe(unpackedExe, { PFM_SELFTEST: '1', PFM_SELFTEST_FUNCTIONAL: '1' });
  assert(r.code !== 0, '打包产物在自检失败时返回非零（否则 exit=0 无意义）', 'exit=' + r.code);
  assert(/拒绝在真实数据目录上跑/.test(r.out), '打包后"拒绝在真实库上跑"的护栏仍然生效');
}

// ---------- 4) 用户真正下载的那个单文件 exe ----------
// 它是自解压启动器，抓不到 stdout，只能看退出码；
// 但"能不能起得来"本身就是要防的回归——曾经打包产物直接白屏。
// 找不到当前版本的 portable 一律判失败，不能"跳过"：
// 跳过等于把"忘了打包"和"打包坏了"都变成绿灯。
if (!portableExe) {
  fail('dist 下没有 ' + pkgVersion + ' 的 portable exe，请先执行 npm run dist'
    + (stalePortables.length ? '（只找到旧版本：' + stalePortables.join(', ') + '）' : ''));
} else {
  console.log('[test:packaged] portable 产物: ' + path.basename(portableExe));
  if (stalePortables.length) {
    console.log('[test:packaged] 注意 dist 下还有旧版本产物，未参与检查: ' + stalePortables.join(', '));
  }
  const dataDir = mkTmp('port');
  const r = runExe(portableExe, { PFM_SELFTEST: '1', PFM_DATA_DIR: dataDir }, 180000);
  assert(!r.timedOut, 'portable 产物在超时前退出了');
  assert(r.code === 0, 'portable 产物自检退出码为 0', 'exit=' + r.code);

  // 没有 stdout 可断言，所以用磁盘副作用证明它真的跑到了业务逻辑，
  // 而不是"启动器解压失败但仍然返回 0"。
  const portSeeded = fs.existsSync(path.join(dataDir, 'prompts'));
  assert(portSeeded, 'portable 产物真的执行到了种子拷贝（不只是启动器返回 0）');

  const rFail = runExe(portableExe, { PFM_SELFTEST: '1', PFM_SELFTEST_FUNCTIONAL: '1' }, 180000);
  assert(rFail.code !== 0, 'portable 产物失败时返回非零', 'exit=' + rFail.code);
}

cleanup();
console.log('\n[test:packaged] ' + (failures ? '失败（' + failures + ' 项）' : '通过'));
process.exit(failures ? 1 : 0);
