// tests/close-flush.test.js
// 回归测试：关窗时还挂在防抖窗口里的配置写入，必须真的落盘。
//
// 修的是什么 bug：渲染进程有五个写 config 的 debounce（tabs 500ms / recent 500 /
// lockedFiles 400 / sidebarWidth 400 / expandedPaths 600），原先没有任何对外把手。
// 于是"改完立刻关窗"那一次改动直接消失：拖宽侧边栏马上关窗，重开还是旧宽度；
// 展开几个目录再关窗，展开状态丢失。修法是给 debounce 加 .flush()，渲染进程暴露
// window.__pfmFlushPending，主进程 win.on('close') 里先 preventDefault 把窗口留住，
// 催渲染进程 flush 完再真的关。
//
// 为什么现有测试覆盖不到：tests/debounce.test.js 只测 debounce 这个函数本身的语义
// （eval 源码里截出来的定义），测不到"主进程真的会在关窗时调它"这条链。而
// test:fn / test:ui 跑完都是 app.exit()，那条路径压根不走窗口关闭流程。
//
// 断言放在进程外：把数据目录指到临时位置，进程退出之后读 config.json 定论。
// "落盘"要等关窗流程整个走完才算数，在进程里自己断言等于自己发毕业证。
//
// destroy 组是反向对照：win.destroy() 不触发 'close'，握手根本不会跑。两组结果
// 必须不同，才说明 flush 组测到的是握手本身，而不是"这个值反正总会被写进去"。
// 运行：npm run test:close
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
let electronBin;
try {
  electronBin = require(path.join(root, 'node_modules', 'electron'));
} catch (e) {
  console.error('找不到 electron，请先 npm install');
  process.exit(1);
}

const REL = 'prompts/testing/关窗落盘标记.md';
// 主进程自检分支里写死的同一个值（PFM_SELFTEST_CLOSE 分支的 markWidth）。
const MARK_WIDTH = 377;
// 预置的初始宽度，用来确认"关窗前磁盘上还是旧值"这个前置条件。
const INITIAL_WIDTH = 240;

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-close-'));
  fs.mkdirSync(path.join(dir, 'prompts', 'testing'), { recursive: true });
  fs.writeFileSync(path.join(dir, REL),
    '---\ntitle: 关窗落盘标记\nstage: testing\nversion: 1\n---\n\n# 关窗落盘标记\n\n用于验证关窗握手。\n',
    'utf8');
  fs.writeFileSync(path.join(dir, 'config.json'),
    JSON.stringify({ theme: 'light', lang: 'zh', lockedFiles: [], sidebarWidth: INITIAL_WIDTH }, null, 2),
    'utf8');
  return dir;
}

function run(dataDir, mode) {
  return new Promise((resolve) => {
    const child = spawn(electronBin, [root], {
      cwd: root,
      env: {
        ...process.env,
        PFM_SELFTEST: '1',
        PFM_SELFTEST_CLOSE: mode,
        PFM_DATA_DIR: dataDir,
        ELECTRON_ENABLE_LOGGING: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    // 超时要 kill：关窗握手写错的一种表现就是窗口再也关不掉（preventDefault 之后
    // 没人接着调 close），那样进程会一直挂着。
    const timer = setTimeout(() => { child.kill(); resolve({ code: 1, out: out + '\n[超时]' }); }, 60000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// 读退出后的 config.json；读不出来就当空对象（下面的断言会因此失败，正是想要的）。
function readConfig(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); }
  catch (e) { return {}; }
}

async function once(mode) {
  const dir = makeDataDir();
  const r = await run(dir, mode);
  const cfg = readConfig(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  return { ...r, cfg };
}

(async () => {
  const results = [];
  const push = (name, ok, detail) => results.push([name, ok, detail]);

  // ---- 主检查：正常关窗 ----
  const flush = await once('flush');
  push('flush 组：进程正常退出（关窗流程没卡死）', flush.code === 0,
    'exit=' + flush.code + (flush.code === 0 ? '' : ' → ' + flush.out.slice(-600)));
  push('flush 组：渲染进程暴露了 __pfmFlushPending',
    /\[selftest:close\] PASS 渲染进程暴露了 __pfmFlushPending/.test(flush.out));
  push('flush 组：关窗前该值确实还没落盘（前置条件成立）',
    /\[selftest:close\] PASS 关窗前该值还挂在防抖里/.test(flush.out),
    (/\[selftest\] FAIL 前置条件[^\n]*/.exec(flush.out) || [''])[0]);
  push('flush 组：关窗后待写入的 sidebarWidth 落盘了',
    flush.cfg.sidebarWidth === MARK_WIDTH,
    'config.sidebarWidth=' + JSON.stringify(flush.cfg.sidebarWidth) + '，期望 ' + MARK_WIDTH);
  // 顺带确认异步收尾整段都跑完了，而不是只跑到 flush 就被超时截断。
  push('flush 组：窗口尺寸也在关窗时存下来了',
    !!(flush.cfg.windowBounds && typeof flush.cfg.windowBounds.width === 'number'),
    'windowBounds=' + JSON.stringify(flush.cfg.windowBounds));

  // ---- 反向对照：destroy 不触发 close，握手不跑 ----
  const destroy = await once('destroy');
  push('destroy 组：进程正常退出', destroy.code === 0,
    'exit=' + destroy.code + (destroy.code === 0 ? '' : ' → ' + destroy.out.slice(-600)));
  push('destroy 组：待写入的 sidebarWidth 没落盘（销毁窗口不走握手）',
    destroy.cfg.sidebarWidth !== MARK_WIDTH,
    'config.sidebarWidth=' + JSON.stringify(destroy.cfg.sidebarWidth) + '，期望不是 ' + MARK_WIDTH);

  // ---- 两组必须分开 ----
  // 这条是整个测试的意义所在：如果两组都是 377，说明那个值是被别的路径写进去的
  // （比如防抖计时器自己到点了），flush 组的绿灯就是假的。
  push('两组结果不同 → 测到的是关窗握手本身，不是"这个值反正会被写进去"',
    flush.cfg.sidebarWidth === MARK_WIDTH && destroy.cfg.sidebarWidth !== MARK_WIDTH,
    'flush=' + JSON.stringify(flush.cfg.sidebarWidth) + ' destroy=' + JSON.stringify(destroy.cfg.sidebarWidth));

  let passed = true;
  for (const [name, ok, detail] of results) {
    console.log('[test:close] ' + (ok ? 'PASS ' : 'FAIL ') + name + (!ok && detail ? ' → ' + detail : ''));
    if (!ok) passed = false;
  }
  console.log('\n[test:close] ' + (passed ? '通过' : '失败'));
  process.exit(passed ? 0 : 1);
})();
