'use strict';

function createWriteQueue(gate) {
  const tails = new Map();
  async function run(keys, fn) {
    const unique = [...new Set(keys)];
    const predecessors = unique.map(key => tails.get(key)).filter(Boolean);
    let release;
    const reserved = new Promise(resolve => { release = resolve; });
    // Reserve synchronously before shared: an exclusive import may already be queued.
    for (const key of unique) tails.set(key, reserved);
    try {
      await Promise.all(predecessors);
      return await gate.shared(fn);
    } finally {
      release();
      for (const key of unique) if (tails.get(key) === reserved) tails.delete(key);
    }
  }
  // Caller already owns the exclusive gate or this operation's complete reservation.
  // Re-entering run would wait on ordinary tasks queued behind our exclusive gate.
  function runLocked(keys, fn) {
    return Promise.resolve().then(fn);
  }
  return { run, runLocked };
}

module.exports = { createWriteQueue };
