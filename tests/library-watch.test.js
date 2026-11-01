// tests/library-watch.test.js
// 外部改动感知的纯逻辑：事件合并、自写过滤、路径过滤、导入期间暂停、监视失败不崩。
// 跑在真实临时目录上（stat/readdir 是真的），fs.watch 换成可以手动发事件的桩，
// 这样"同一批改动只通知一次"这类断言不受系统事件时序影响。最后一组用真的 fs.watch。
//
// 自带三组反向对照：
//   1. 旧式实现：fs.watch 来一个事件就通知一次（没有合并、没有过滤、不认自写、不认暂停）
//   2. 真实实现但 noteSelfWrite 失效 —— 自写过滤那几条必须红
//   3. 真实实现但 isPaused 失效 —— 导入期间暂停那一条必须红
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createLibraryWatcher, classifyRel } = require('../lib/library-watch');

const delay = ms => new Promise(r => setTimeout(r, ms));

// 改动前的样子：把 fs.watch 的事件原样转给渲染进程。
function legacyWatcher(opts) {
  const ws = [];
  return {
    start: async () => {
      for (const top of opts.tops || ['prompts', 'workflows', 'templates']) {
        const w = (opts.watch || fs.watch)(path.join(opts.root, top), { recursive: true }, (type, name) => {
          if (name) opts.onChange([{ rel: top + '/' + String(name).replace(/\\/g, '/'), type: 'modified' }]);
        });
        ws.push(w);
      }
    },
    close: () => ws.forEach(w => w.close()),
    noteSelfWrite: () => {},
    flush: async () => {},
    isWatching: () => ws.length > 0
  };
}
const noSelfWrite = (opts) => ({ ...createLibraryWatcher(opts), noteSelfWrite: () => {} });
const noPause = (opts) => createLibraryWatcher({ ...opts, isPaused: () => false });

function makeFakeWatch() {
  const live = new Map();   // top 目录名 -> fake watcher
  const all = [];
  let failNext = new Map(); // top -> 抛出的错误码
  const watch = (dir, options, cb) => {
    const top = path.basename(dir);
    if (failNext.has(top)) {
      const code = failNext.get(top);
      failNext.delete(top);
      const e = new Error(code + ': fake'); e.code = code;
      throw e;
    }
    const w = new EventEmitter();
    w.cb = cb;
    w.closed = false;
    w.close = () => { w.closed = true; };
    live.set(top, w);
    all.push(w);
    return w;
  };
  const emit = (top, type, name) => {
    const w = live.get(top);
    if (w && !w.closed) w.cb(type, name == null ? null : name.replace(/\//g, path.sep));
  };
  return { watch, emit, live, all, failOn: (top, code) => failNext.set(top, code) };
}
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-watch-'));
  for (const d of ['prompts/p', 'workflows', 'templates']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'prompts/p/a.md'), 'A', 'utf8');
  fs.writeFileSync(path.join(root, 'prompts/p/b.md'), 'B', 'utf8');
  fs.writeFileSync(path.join(root, 'workflows/w.md'), 'W', 'utf8');
  return root;
}

// 每个用例一个干净目录、一个 watcher。calls 记下 onChange 的每一次调用。
async function withLib(factory, extra, fn) {
  const root = makeRoot();
  const fake = makeFakeWatch();
  const calls = [];
  const logs = [];
  const log = { info: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) };
  const lib = factory({ root, onChange: c => calls.push(c), watch: fake.watch, log, debounceMs: 30, retryBaseMs: 20, ...extra });
  try {
    await lib.start();
    await fn({ root, fake, lib, calls, logs, full: rel => path.join(root, ...rel.split('/')) });
  } finally {
    try { lib.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const flat = calls => calls.flat().map(c => c.type + ':' + c.rel).sort().join(',');

async function runCases(factory, label) {
  const fails = [];
  const ok = (cond, msg, detail) => { if (!cond) fails.push(msg + (detail ? ' -> ' + detail : '')); };

  await withLib(factory, {}, async ({ fake, lib, calls, full }) => {
    fs.writeFileSync(full('prompts/p/a.md'), 'A changed', 'utf8');
    fake.emit('prompts', 'rename', 'p/a.md');
    fake.emit('prompts', 'change', 'p/a.md');
    fake.emit('prompts', 'change', 'p/a.md');
    fake.emit('prompts', 'change', 'p');
    await delay(60); await lib.flush();
    ok(calls.length === 1 && flat(calls) === 'modified:prompts/p/a.md', '一次外部修改的多条事件只通知一次', JSON.stringify(calls));
  });

  await withLib(factory, {}, async ({ fake, lib, calls, full }) => {
    fs.writeFileSync(full('prompts/p/a.md'), 'AA', 'utf8');
    fake.emit('prompts', 'change', 'p/a.md');
    fs.writeFileSync(full('prompts/p/b.md'), 'BB', 'utf8');
    fake.emit('prompts', 'change', 'p/b.md');
    fs.writeFileSync(full('workflows/w.md'), 'WW', 'utf8');
    fake.emit('workflows', 'change', 'w.md');
    await delay(60); await lib.flush();
    ok(calls.length === 1 && flat(calls) === 'modified:prompts/p/a.md,modified:prompts/p/b.md,modified:workflows/w.md',
      '同一批跨目录改动合并成一次通知', JSON.stringify(calls));
  });

  await withLib(factory, {}, async ({ fake, lib, calls, full }) => {
    // 本应用原子写的临时名、外部编辑器的备份、非 .md 文件
    fs.writeFileSync(full('prompts/p/.tmp-1-2-a.md.part'), 'x', 'utf8');
    fake.emit('prompts', 'rename', 'p/.tmp-1-2-a.md.part');
    fs.writeFileSync(full('prompts/p/a.md~'), 'x', 'utf8');
    fake.emit('prompts', 'rename', 'p/a.md~');
    fs.writeFileSync(full('prompts/p/a.md.swp'), 'x', 'utf8');
    fake.emit('prompts', 'change', 'p/a.md.swp');
    fs.writeFileSync(full('prompts/p/notes.txt'), 'x', 'utf8');
    fake.emit('prompts', 'rename', 'p/notes.txt');
    fs.mkdirSync(full('prompts/.git'), { recursive: true });
    fs.writeFileSync(full('prompts/.git/x.md'), 'x', 'utf8');
    fake.emit('prompts', 'change', '.git/x.md');
    await delay(60); await lib.flush();
    ok(calls.length === 0, '临时文件、备份、非 .md、点开头目录都不通知', JSON.stringify(calls));
  });

  await withLib(factory, {}, async ({ fake, lib, calls, full }) => {
    // 应用自己保存：原子写（临时名 → rename 成目标）之后 noteSelfWrite
    fs.writeFileSync(full('prompts/p/.tmp-9-0-a.md.part'), 'saved by app', 'utf8');
    fake.emit('prompts', 'rename', 'p/.tmp-9-0-a.md.part');
    fs.renameSync(full('prompts/p/.tmp-9-0-a.md.part'), full('prompts/p/a.md'));
    lib.noteSelfWrite(full('prompts/p/a.md'));
    fake.emit('prompts', 'rename', 'p/.tmp-9-0-a.md.part');
    fake.emit('prompts', 'rename', 'p/a.md');
    fake.emit('prompts', 'change', 'p/a.md');
    await delay(60); await lib.flush();
    ok(calls.length === 0, '应用自己保存不通知', JSON.stringify(calls));
    // 自写登记过的路径，之后真正的外部修改照样要报
    fs.writeFileSync(full('prompts/p/a.md'), 'external after self save', 'utf8');
    fake.emit('prompts', 'change', 'p/a.md');
    await delay(60); await lib.flush();
    ok(flat(calls) === 'modified:prompts/p/a.md', '自写之后的外部修改照样通知', JSON.stringify(calls));
  });

  await withLib(factory, {}, async ({ fake, lib, calls, full }) => {
    fs.renameSync(full('prompts/p/b.md'), full('prompts/p/b2.md'));
    lib.noteSelfWrite(full('prompts/p/b.md'));
    lib.noteSelfWrite(full('prompts/p/b2.md'));
    fake.emit('prompts', 'rename', 'p/b.md');
    fake.emit('prompts', 'rename', 'p/b2.md');
    fake.emit('prompts', 'change', 'p');
    await delay(60); await lib.flush();
    ok(calls.length === 0, '应用自己改名不通知', JSON.stringify(calls));
  });

  await withLib(factory, {}, async ({ fake, lib, calls, full }) => {
    fs.unlinkSync(full('workflows/w.md'));
    fake.emit('workflows', 'rename', 'w.md');
    fs.writeFileSync(full('templates/t.md'), 'T', 'utf8');
    fake.emit('templates', 'rename', 't.md');
    await delay(60); await lib.flush();
    ok(flat(calls) === 'added:templates/t.md,removed:workflows/w.md', '外部删除和新增分别报成 removed / added', JSON.stringify(calls));
  });

  await withLib(factory, {}, async ({ fake, lib, calls, full }) => {
    // 外部把整个目录删掉 / 移进来：fs.watch 往往只报目录本身
    fs.rmSync(full('prompts/p'), { recursive: true, force: true });
    fake.emit('prompts', 'rename', 'p');
    fs.mkdirSync(full('prompts/q/deep'), { recursive: true });
    fs.writeFileSync(full('prompts/q/deep/z.md'), 'Z', 'utf8');
    fake.emit('prompts', 'rename', 'q');
    await delay(60); await lib.flush();
    ok(flat(calls) === 'added:prompts/q/deep/z.md,removed:prompts/p/a.md,removed:prompts/p/b.md',
      '整个目录被删或移入时按目录重扫', JSON.stringify(calls));
  });

  await withLib(factory, {}, async ({ fake, lib, calls }) => {
    fake.emit('prompts', 'change', null);
    await delay(60); await lib.flush();
    ok(calls.length === 0, '没有文件名的事件整棵重扫，没变化就不通知', JSON.stringify(calls));
  });

  {
    // 完整备份导入期间（write-gate 独占）：导入写的文件不通知，导入结束后只报真正的外部改动
    let paused = true;
    await withLib(factory, { isPaused: () => paused, pauseRetryMs: 20 }, async ({ fake, lib, calls, full }) => {
      fs.mkdirSync(full('prompts/imported'), { recursive: true });
      fake.emit('prompts', 'rename', 'imported');
      for (let i = 0; i < 20; i++) {
        const rel = 'prompts/imported/i' + i + '.md';
        fs.writeFileSync(full(rel), 'imported ' + i, 'utf8');
        lib.noteSelfWrite(full(rel));
        fake.emit('prompts', 'rename', 'imported/i' + i + '.md');
      }
      fs.writeFileSync(full('prompts/p/a.md'), 'external during import', 'utf8');
      fake.emit('prompts', 'change', 'p/a.md');
      await delay(120); await lib.flush();
      ok(calls.length === 0, '导入独占期间不比对也不通知', JSON.stringify(calls).slice(0, 200));
      paused = false;
      await delay(80); await lib.flush();
      ok(flat(calls) === 'modified:prompts/p/a.md', '导入结束后只报导入期间真正的外部改动', JSON.stringify(calls).slice(0, 200));
    });
  }

  {
    // 目录不存在 / EPERM：只记日志，不抛，之后重试成功
    let threw = false;
    const root = makeRoot();
    const fake = makeFakeWatch();
    const logs = [];
    fake.failOn('templates', 'EPERM');
    const lib = factory({
      root, onChange: () => {}, watch: fake.watch, retryBaseMs: 20,
      log: { info: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) }
    });
    try { await lib.start(); } catch { threw = true; }
    await delay(80);
    ok(!threw && logs.some(m => /templates/.test(m) && /EPERM/.test(m)), '监视失败只记日志不抛', JSON.stringify(logs));
    ok(lib.isWatching('templates'), '监视失败后按退避重试并恢复');
    // watcher 运行中报错（被监视的目录被删掉时 Windows 会这样）
    const before = fake.all.length;
    try { fake.live.get('prompts').emit('error', Object.assign(new Error('EPERM: gone'), { code: 'EPERM' })); } catch { threw = true; }
    await delay(80);
    ok(!threw && fake.all.length > before && lib.isWatching('prompts'), 'watcher 报错不崩，重新挂上');
    lib.close();
    ok(fake.all.every(w => w.closed), 'close 关掉全部 watcher');
    fs.rmSync(root, { recursive: true, force: true });
  }

  {
    // 真的 fs.watch：确认默认接线能工作，自写过滤在真实事件上也成立
    const root = makeRoot();
    const calls = [];
    const lib = factory({ root, onChange: c => calls.push(c), debounceMs: 100 });
    try {
      await lib.start();
      await delay(100);
      const self = path.join(root, 'prompts/p/b.md');
      const tmp = path.join(root, 'prompts/p/.tmp-1-1-b.md.part');
      fs.writeFileSync(tmp, 'self write via real watch', 'utf8');
      fs.renameSync(tmp, self);
      lib.noteSelfWrite(self);
      await delay(600);
      ok(calls.length === 0, '真实 fs.watch：自写不通知', JSON.stringify(calls));
      fs.writeFileSync(path.join(root, 'prompts/p/a.md'), 'real external edit', 'utf8');
      for (let i = 0; i < 40 && !calls.length; i++) await delay(50);
      ok(flat(calls) === 'modified:prompts/p/a.md', '真实 fs.watch：外部修改会通知', JSON.stringify(calls));
    } finally {
      lib.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log(`[test:library-watch] ${label}: ${fails.length ? fails.length + ' 条失败' : '全部通过'}`);
  return fails;
}
(async () => {
  let failures = 0;
  const check = (cond, msg) => {
    if (cond) console.log('[test:library-watch] PASS ' + msg);
    else { failures++; console.error('[test:library-watch] FAIL ' + msg); }
  };
  // 路径分类：只认三个内容目录下的 .md；临时文件、点开头的段、其他目录一律不管
  check(classifyRel('prompts/testing/a.md') === 'md', '内容目录下的 .md 归为 md');
  check(classifyRel('workflows/A.MD') === 'md', '扩展名不分大小写');
  check(classifyRel('prompts/testing/.tmp-12-3-a.md.part') === 'ignore', '原子写临时名被忽略');
  check(classifyRel('prompts/.gitkeep') === 'ignore' && classifyRel('prompts/.git/x.md') === 'ignore', '点开头的段被忽略');
  check(classifyRel('prompts/a.md~') === 'ignore' && classifyRel('prompts/a.md.tmp') === 'ignore', '编辑器备份/临时后缀被忽略');
  check(classifyRel('.versions/prompts/a.md') === 'ignore' && classifyRel('config.json') === 'ignore', '内容目录之外的路径被忽略');
  check(classifyRel('prompts/testing') === 'other' && classifyRel('templates') === 'other', '目录归为 other（要重扫）');

  const real = await runCases(createLibraryWatcher, '真实实现');
  for (const f of real) { failures++; console.error('[test:library-watch] FAIL ' + f); }
  if (!real.length) console.log('[test:library-watch] PASS 真实实现通过全部用例');

  // 反向对照：每一组都必须红在指定的断言上，红在别处说明目标断言是空的
  const controls = [
    ['旧式逐事件转发', legacyWatcher, [
      '一次外部修改的多条事件只通知一次', '同一批跨目录改动合并成一次通知',
      '临时文件、备份、非 .md、点开头目录都不通知', '应用自己保存不通知',
      '导入独占期间不比对也不通知', '监视失败只记日志不抛', '真实 fs.watch：自写不通知'
    ]],
    ['noteSelfWrite 失效', noSelfWrite, ['应用自己保存不通知', '应用自己改名不通知', '导入结束后只报导入期间真正的外部改动', '真实 fs.watch：自写不通知']],
    ['isPaused 失效', noPause, ['导入独占期间不比对也不通知']]
  ];
  for (const [label, factory, mustFail] of controls) {
    const got = await runCases(factory, '反向对照（' + label + '）');
    const missed = mustFail.filter(m => !got.some(f => f === m || f.startsWith(m + ' -> ')));
    if (missed.length) {
      failures++;
      console.error('[test:library-watch] FAIL 反向对照（' + label + '）没有红在：' + missed.join('、') + '——这些断言分辨不出坏实现');
    } else {
      console.log('[test:library-watch] PASS 反向对照（' + label + '）红在了指定的 ' + mustFail.length + ' 条断言上');
    }
  }
  console.log('[test:library-watch] ' + (failures ? '失败' : '通过'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('[test:library-watch] FAIL ' + (e && e.stack || e));
  process.exit(1);
});
