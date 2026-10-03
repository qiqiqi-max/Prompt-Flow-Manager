// tests/write-gate.test.js
const { createWriteGate } = require('../lib/write-gate');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:write-gate] PASS ' + msg);
  else { failures++; console.error('[test:write-gate] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const gate = createWriteGate();
  const order = [];
  let releaseImport;
  const importStarted = new Promise(resolve => {
    gate.exclusive(async () => {
      order.push('import-start');
      resolve();
      await new Promise(r => { releaseImport = r; });
      order.push('import-end');
    });
  });
  await importStarted;
  const normal = gate.shared(async () => { order.push('save'); });
  await delay(20);
  ok(!order.includes('save'), '独占导入期间普通写入会等待', JSON.stringify(order));
  releaseImport();
  await normal;
  ok(JSON.stringify(order) === '["import-start","import-end","save"]', '导入结束后普通写入继续执行', JSON.stringify(order));

  const gate2 = createWriteGate();
  const order2 = [];
  let releaseSave;
  const saveStarted = new Promise(resolve => {
    gate2.shared(async () => {
      order2.push('save-start');
      resolve();
      await new Promise(r => { releaseSave = r; });
      order2.push('save-end');
    });
  });
  await saveStarted;
  const exclusive = gate2.exclusive(async () => { order2.push('import'); });
  await delay(20);
  ok(!order2.includes('import'), '独占导入会等待已开始的普通写入');
  releaseSave();
  await exclusive;
  ok(JSON.stringify(order2) === '["save-start","save-end","import"]', '普通写入完成后才开始导入', JSON.stringify(order2));

  const gate3 = createWriteGate();
  let nested = false;
  await gate3.exclusive(async () => {
    await gate3.shared(async () => { nested = true; });
  });
  ok(nested, '导入内部的写入不会被自己的独占锁卡住');

  const gate3b = createWriteGate();
  let chain = gate3b.shared(() => delay(50));
  const queue = (fn) => {
    const prev = chain;
    const run = prev.then(() => gate3b.shared(fn), () => gate3b.shared(fn));
    chain = run.then(() => {}, () => {});
    return run;
  };
  let queuedInsideImport = false;
  await Promise.race([
    gate3b.exclusive(async () => {
      await queue(async () => { queuedInsideImport = true; });
    }),
    delay(200).then(() => { throw new Error('queued nested write timed out'); })
  ]);
  ok(queuedInsideImport, '导入内部经过写队列的写入也不会被独占锁卡住');

  const gate4 = createWriteGate();
  await gate4.exclusive(async () => { throw new Error('boom'); }).catch(() => {});
  let afterError = false;
  await gate4.shared(async () => { afterError = true; });
  ok(afterError, '独占任务失败后仍会释放写入');

  if (failures) process.exit(1);
  console.log('[test:write-gate] 通过');
})().catch((e) => { console.error(e); process.exit(1); });
