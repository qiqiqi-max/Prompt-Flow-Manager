const { AsyncLocalStorage } = require('async_hooks');

// 普通写入可以并行；完整备份导入需要独占，避免失败回滚撤掉同时发生的改动。
function createWriteGate() {
  const context = new AsyncLocalStorage();
  let active = 0;
  let exclusiveActive = false;
  let tail = Promise.resolve();
  let wake = null;

  function changed() {
    if (wake) {
      const fn = wake;
      wake = null;
      fn();
    }
  }

  async function shared(fn) {
    if (context.getStore()) return fn();
    await tail;
    active++;
    try { return await fn(); }
    finally {
      active--;
      changed();
    }
  }

  function exclusive(fn) {
    const run = tail.then(async () => {
      exclusiveActive = true;
      while (active > 0) await new Promise(resolve => { wake = resolve; });
      return context.run(true, fn);
    }).finally(() => {
      exclusiveActive = false;
    });
    tail = run.then(() => {}, () => {});
    return run;
  }

  return { shared, exclusive, isExclusive: () => exclusiveActive };
}

module.exports = { createWriteGate };
