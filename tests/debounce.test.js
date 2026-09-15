// tests/debounce.test.js
// 回归测试：src/renderer.js 里的 debounce 必须是"可等待 + 可 flush"的版本。
//
// 为什么单独一个文件：这个 helper 决定了两件用别的测试看不见的事。
//   1. toggleLockFile 里 await 的是它。旧版返回 undefined，await 一个 tick 就过去，
//      锁状态还在 400ms 窗口里没落盘；此时主进程的 trash 去读 config 判锁，
//      读到的是没有该文件的旧快照，锁形同虚设。
//   2. 关窗时主进程要催渲染进程把五个配置 debounce（tabs/recent/locked/
//      sidebarWidth/expandedPaths）立刻落盘。旧版没有任何对外把手，
//      "拖完侧边栏立刻关窗"那次改动就随窗口一起消失。
// 这两条都是时序问题，test:ui / test:fn 的点击流跑不出来，静态 grep 也证明不了语义。
//
// 做法：从 src/renderer.js 里把 debounce 原文抠出来跑（不是抄一份到测试里——
// 抄一份的话改了源码测试照样绿）。跑完主检查后，再拿旧版实现跑同一批断言当反向对照，
// 要求它必须失败：否则说明这些断言对"退回旧版"根本没有分辨力，绿也是白绿。
//
// 不启动 Electron：这个 helper 只依赖 setTimeout / Promise。
// 运行：npm run test:debounce
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const RENDERER = path.join(root, 'src', 'renderer.js');

// 从源码里截取 debounce 定义。结尾锚点用行首的 "};"，因为函数体内的闭合都有缩进。
function extractDebounce(src) {
  const start = src.indexOf('const debounce = (fn, ms) => {');
  if (start === -1) throw new Error('找不到 debounce 定义（src/renderer.js 结构变了？）');
  const endMark = '\n};\n';
  const end = src.indexOf(endMark, start);
  if (end === -1) throw new Error('找不到 debounce 结尾');
  return src.slice(start, end + endMark.length);
}

// 旧版（修复前）实现，仅用于反向对照。
const LEGACY = 'const debounce = (fn, ms) => { let t; return (...a) => '
  + '{ clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };\n';

function loadDebounce(code) {
  // eslint-disable-next-line no-eval
  return eval(code + '\ndebounce;');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 每个 section 独立 try/catch。旧版实现在第 4 项就会因为 d.flush 不存在而抛错，
// 若不隔离，抛出去会带走后面所有 section——反向对照只能看到前三项失败，
// 5~10 项到底有没有分辨力就无从得知了（一次失败掩盖掉后续全部检查）。
async function runSections(debounce) {
  const results = [];
  const section = async (name, body) => {
    const local = [];
    const ok = (cond, msg) => local.push([!!cond, msg]);
    try {
      await body(ok);
    } catch (e) {
      local.push([false, '抛出异常：' + (e && e.message ? e.message : e)]);
    }
    results.push([name, local]);
  };

  await section('返回值是 promise，且在 fn 执行完之后才 resolve', async (ok) => {
    let done = false;
    const d = debounce(async () => { await sleep(20); done = true; return 'R'; }, 30);
    const p = d();
    ok(p && typeof p.then === 'function', '调用返回 promise');
    ok(done === false, 'fn 尚未执行');
    const r = await p;
    ok(done === true, 'await 之后 fn 已执行完');
    ok(r === 'R', 'promise 带回 fn 的返回值');
  });

  await section('防抖语义：连续调用只执行一次，用最后一次的参数', async (ok) => {
    const seen = [];
    const d = debounce(async (x) => { seen.push(x); }, 20);
    await Promise.all([d(1), d(2), d(3)]);
    ok(seen.length === 1, '只执行一次，实际 ' + seen.length);
    ok(seen[0] === 3, '用最后一次的参数，实际 ' + seen[0]);
  });

  await section('同一批的多个调用方全部结算', async (ok) => {
    const d = debounce(async () => 'X', 20);
    const rs = await Promise.all([d(), d(), d()]);
    ok(rs.every(r => r === 'X'), '三个调用方都拿到结果：' + JSON.stringify(rs));
  });

  await section('flush() 立刻执行待处理的那次，不等计时器', async (ok) => {
    let ran = false;
    const d = debounce(async () => { ran = true; }, 5000);
    d();
    const t0 = Date.now();
    await d.flush();
    const dt = Date.now() - t0;
    ok(ran === true, 'flush 后 fn 已执行');
    ok(dt < 1000, '没有等满 5000ms，实际 ' + dt + 'ms');
  });

  await section('flush() 会等已经在飞的那次执行完', async (ok) => {
    let done = false;
    const d = debounce(async () => { await sleep(120); done = true; }, 10);
    d();
    await sleep(40); // 计时器已触发，fn 在执行中
    ok(done === false, '此刻 fn 还没执行完（前置条件）');
    await d.flush();
    ok(done === true, 'flush 等到了在飞的那次');
  });

  await section('没有待处理也没有在飞时，flush() 立刻 resolve', async (ok) => {
    const d = debounce(async () => {}, 1000);
    const t0 = Date.now();
    await d.flush();
    ok(Date.now() - t0 < 500, '空 flush 立即返回');
  });

  await section('flush 之后不再持有已完成的 promise', async (ok) => {
    const d = debounce(async () => { await sleep(30); }, 10);
    d();
    await d.flush();
    const t0 = Date.now();
    await d.flush();
    ok(Date.now() - t0 < 500, '第二次 flush 立即返回');
  });

  await section('fn 抛错：等待者收到 reject，但 flush() 不 reject', async (ok) => {
    const d = debounce(async () => { throw new Error('boom'); }, 10);
    let rejected = false;
    d().catch(() => { rejected = true; });
    let flushThrew = false;
    try { await d.flush(); } catch { flushThrew = true; }
    await sleep(30);
    ok(rejected === true, '调用方拿到了 reject');
    // 关窗流程 await 的就是 flush()，它一旦 reject 会把关窗收尾带崩。
    ok(flushThrew === false, 'flush() 自身没有抛出');
  });

  await section('fire-and-forget 调用不产生 unhandledRejection', async (ok) => {
    const seen = [];
    const onUnhandled = (e) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    const d = debounce(async () => { throw new Error('boom'); }, 10);
    d(); // 故意不接 .catch，模拟 migrateLock / addRecent 的用法
    await sleep(80);
    process.removeListener('unhandledRejection', onUnhandled);
    ok(seen.length === 0, '没有 unhandledRejection，实际 ' + seen.length);
  });

  await section('flush 之后仍可复用', async (ok) => {
    let n = 0;
    const d = debounce(async () => { n++; }, 20);
    d();
    await d.flush();
    d();
    await d.flush();
    ok(n === 2, 'flush 后可复用，实际执行 ' + n + ' 次');
  });

  return results;
}

function countFails(results) {
  let fails = 0;
  for (const [, local] of results) for (const [ok] of local) if (!ok) fails++;
  return fails;
}

(async () => {
  let src;
  try {
    src = fs.readFileSync(RENDERER, 'utf8');
  } catch (e) {
    console.error('[test:debounce] FAIL 读不到 src/renderer.js：' + e.message);
    process.exit(1);
  }

  let code;
  try {
    code = extractDebounce(src);
  } catch (e) {
    console.error('[test:debounce] FAIL ' + e.message);
    process.exit(1);
  }

  // 主检查：真实源码
  const real = await runSections(loadDebounce(code));
  for (const [name, local] of real) {
    console.log('[test:debounce] ' + name);
    for (const [ok, msg] of local) console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + msg);
  }
  const realFails = countFails(real);

  // 反向对照：旧版实现必须跑不过这批断言。
  // 它证明的是"断言有分辨力"，不是"旧版有 bug"——后者已经是既定事实。
  const legacy = await runSections(loadDebounce(LEGACY));
  const legacyFails = countFails(legacy);
  const legacySections = legacy.filter(([, l]) => l.some(([ok]) => !ok)).length;
  console.log('[test:debounce] 反向对照（旧版 debounce）失败 ' + legacyFails
    + ' 项，覆盖 ' + legacySections + '/' + legacy.length + ' 个 section');

  const controlOk = legacyFails > 0;
  if (!controlOk) {
    console.error('[test:debounce] FAIL 反向对照居然全绿：这批断言分辨不出旧版实现，测试无效');
  }

  const passed = realFails === 0 && controlOk;
  console.log('\n[test:debounce] ' + (passed ? '通过' : '失败')
    + '（真实源码失败 ' + realFails + ' 项）');
  process.exit(passed ? 0 : 1);
})();
