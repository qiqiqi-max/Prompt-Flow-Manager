// tests/batch-ops.test.js
// 批量操作的执行骨架（lib/batch-ops.js）：部分失败逐项汇总、进行中拒绝重复触发、
// 批量移动的目标名（同目录跳过、同名生成新名字、只移动提示词）。
//
// 失败方式是静默的："中途静默停止"时界面只看得到前面几个成功了，后面那些既没成功
// 也没报错，用户以为全部做完了。所以断言盯的是"失败那一项之后的项也执行了，
// 并且失败原因带着错误码"。
//
// 反向对照在文件末尾：一个"一项失败就整批 throw"的朴素 runner、一个没有忙碌标志的
// runner、一个不去重的目标名实现，各自要在指定断言上变红。
//
// 运行：npm run test:batch-ops
const path = require('path');
const REAL = require(path.join(__dirname, '..', 'lib', 'batch-ops.js'));

const codeOf = (fn) => {
  try { fn(); return null; } catch (e) { return String(e.message).split('|')[0]; }
};
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function runSuite(B) {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail == null ? '' : String(detail) });

  // 1. 部分失败：失败那一项之后的照样执行，三个桶各归各
  {
    const runner = B.createBatchRunner();
    const seen = [];
    let res = null;
    try {
      res = await runner.run(['a', 'b', 'c', 'd'], async (rel) => {
        seen.push(rel);
        if (rel === 'b') throw new Error('E_LOCKED|b');
        if (rel === 'c') return { skip: 'E_BATCH_SAME_DIR' };
        if (rel === 'd') { const e = new Error('raw'); e.code = 'EBUSY'; throw e; }
        return { newRel: rel + '2' };
      });
    } catch (e) { res = { thrown: String(e.message) }; }
    ok('一项失败后，后面的项照样执行', seen.join() === 'a,b,c,d', seen.join());
    ok('成功项带回 handler 的返回值', !!res.ok && res.ok.length === 1 && res.ok[0].rel === 'a' && res.ok[0].newRel === 'a2', JSON.stringify(res));
    ok('失败项带着错误码和细节', !!res.failed && res.failed.some(f => f.rel === 'b' && f.code === 'E_LOCKED' && f.detail === 'b'), JSON.stringify(res.failed));
    ok('fs 的错误码保留下来（不是一句 Error）', !!res.failed && res.failed.some(f => f.rel === 'd' && f.code === 'E_BATCH_IO' && f.detail === 'EBUSY'), JSON.stringify(res.failed));
    ok('跳过项单独成一桶', !!res.skipped && res.skipped.length === 1 && res.skipped[0].code === 'E_BATCH_SAME_DIR', JSON.stringify(res.skipped));
  }
  // 2. 进行中拒绝重复触发；结束（含抛错结束）后放开
  {
    const runner = B.createBatchRunner();
    let release;
    const first = runner.run(['a'], () => new Promise(r => { release = r; }));
    await delay(5);
    let second = null;
    try { await runner.run(['b'], async () => null); second = 'ran'; } catch (e) { second = String(e.message); }
    ok('上一批没完成时第二批被拒（E_BATCH_BUSY）', second === 'E_BATCH_BUSY', second);
    release();
    await first;
    let third = null;
    try { third = await runner.run(['c'], async () => { throw new Error('E_X'); }); } catch (e) { third = { thrown: e.message }; }
    let fourth = null;
    try { fourth = await runner.run(['d'], async () => null); } catch (e) { fourth = { thrown: e.message }; }
    ok('上一批结束（含全部失败）后可以再跑', !!fourth && Array.isArray(fourth.ok) && fourth.ok.length === 1 && !!third.failed, JSON.stringify({ third, fourth }));
  }
  // 3. 目标名
  {
    const taken = new Set(['prompts/deployment/同名.md', 'prompts/deployment/同名-1.md']);
    const exists = (r) => taken.has(r);
    ok('已在目标目录时返回 null（跳过）', B.pickMoveTarget('prompts/deployment/x.md', 'prompts/deployment', exists) === null);
    ok('不同名时保留原文件名', B.pickMoveTarget('prompts/testing/x.md', 'prompts/deployment', exists) === 'prompts/deployment/x.md');
    ok('同名时生成新名字（跳过已被占的 -1）',
      B.pickMoveTarget('prompts/testing/同名.md', 'prompts/deployment', exists) === 'prompts/deployment/同名-2.md',
      B.pickMoveTarget('prompts/testing/同名.md', 'prompts/deployment', exists));
    ok('目标目录写成反斜杠/带尾斜杠也认', B.pickMoveTarget('prompts/testing/x.md', 'prompts\\deployment\\', exists) === 'prompts/deployment/x.md');
    ok('工作流和模板不能移动（E_MOVE_NOT_PROMPT）', codeOf(() => B.pickMoveTarget('workflows/w.md', 'prompts/deployment', exists)) === 'E_MOVE_NOT_PROMPT');
    ok('目标目录不在 prompts/ 下被拒（E_MOVE_BAD_TARGET）', codeOf(() => B.pickMoveTarget('prompts/a/x.md', 'workflows', exists)) === 'E_MOVE_BAD_TARGET');
    ok('目标目录带 .. 被拒', codeOf(() => B.pickMoveTarget('prompts/a/x.md', 'prompts/../config', exists)) === 'E_MOVE_BAD_TARGET');
  }
  // 4. 参数校验
  {
    ok('rel 列表去重并统一分隔符', JSON.stringify(B.normalizeRelList(['prompts\\a.md', 'prompts/a.md', 'b'])) === JSON.stringify(['prompts/a.md', 'b']));
    ok('空列表被拒', codeOf(() => B.normalizeRelList([])) === 'E_INVALID_PAYLOAD');
    ok('非字符串被拒', codeOf(() => B.normalizeRelList(['a', 1])) === 'E_INVALID_PAYLOAD');
    ok('超过上限被拒', codeOf(() => B.normalizeRelList(new Array(B.MAX_BATCH + 1).fill(0).map((_, i) => 'r' + i))) === 'E_INVALID_PAYLOAD');
  }
  return results;
}

(async () => {
  let failed = 0;
  for (const r of await runSuite(REAL)) {
    if (r.pass) console.log('[test:batch-ops] PASS ' + r.name);
    else { failed++; console.error('[test:batch-ops] FAIL ' + r.name + ' -> ' + r.detail); }
  }

  // ---------- 反向对照 ----------
  // 每个朴素实现只改一处，对应一组必须变红的断言。
  const controls = [
    {
      what: '一项失败就整批抛出（中途静默停止）',
      impl: {
        ...REAL,
        createBatchRunner: () => ({
          run: async (rels, handler) => {
            const res = { ok: [], failed: [], skipped: [] };
            for (const rel of rels) {
              const r = await handler(rel);
              if (r && r.skip) res.skipped.push({ rel, code: r.skip }); else res.ok.push({ rel, ...(r || {}) });
            }
            return res;
          }
        })
      },
      mustRed: ['一项失败后，后面的项照样执行', '失败项带着错误码和细节']
    },
    {
      what: '没有忙碌标志',
      impl: {
        ...REAL,
        createBatchRunner: () => {
          const real = REAL.createBatchRunner();
          return { run: (rels, h) => REAL.createBatchRunner().run(rels, h), isBusy: real.isBusy };
        }
      },
      mustRed: ['上一批没完成时第二批被拒（E_BATCH_BUSY）']
    },
    {
      what: '目标名不去重、不判同目录',
      impl: { ...REAL, pickMoveTarget: (src, dir) => dir.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + path.posix.basename(src) },
      mustRed: ['同名时生成新名字（跳过已被占的 -1）', '已在目标目录时返回 null（跳过）']
    }
  ];
  for (const c of controls) {
    const res = await runSuite(c.impl);
    const stillGreen = c.mustRed.filter(name => (res.find(r => r.name === name) || { pass: true }).pass);
    if (stillGreen.length) {
      failed++;
      console.error('[test:batch-ops] FAIL 反向对照（' + c.what + '）在这些断言上仍然是绿的：' + stillGreen.join(' / '));
    } else {
      console.log('[test:batch-ops] PASS 反向对照（' + c.what + '）：' + c.mustRed.length + ' 条目标断言全部变红');
    }
  }

  if (failed) {
    console.error('[test:batch-ops] ' + failed + ' 项失败');
    process.exit(1);
  }
  console.log('[test:batch-ops] 通过');
})().catch((e) => {
  console.error('[test:batch-ops] FAIL 测试本身抛错: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
