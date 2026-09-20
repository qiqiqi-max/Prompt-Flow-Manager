// tests/heal.test.js
// 回归测试：启动自愈（healDataDir）必须把数据目录里的四类损坏修好，
// 并且**不许碰用户的完整内容**。
//
// 为什么需要这一层：这四类损坏都不是假想的，全都能由已知路径产生 ——
//   1) 幽灵条目：.trash/index.json 里有条目，但 .trash 下对应的正文文件没了
//      （用户手动清理过 .trash、同步盘删掉了、或杀软隔离）。表现是回收站里
//      有一条记录，点恢复必然失败，点清空也清不掉它。
//   2) 孤立正文：反过来 —— 正文躺在 .trash 里，索引里没有条目。这正是
//      trash handler 里 E_TRASH_ORPHANED 那条分支的产物（索引写失败且
//      文件没能搬回原位）。文件占着磁盘，但 UI 再也看不到它，等于永久丢失。
//   3) 越界 store：索引被外部编辑/同步冲突写坏，store 变成 "../x" 这种。
//      empty-trash 会跳过它、restore 会抛错，条目永远赖在回收站里。
//   4) 残留 .part：writeFileAtomic 写到一半进程被杀，临时文件留在盘上，
//      单个不大但每次崩溃攒一个，而且原先没有任何代码会清理它们。
//
// 断言放在进程外：进程退出后直接读磁盘定论。让被测进程自己汇报"我修好了"
// 等于自己发毕业证。
//
// 反向对照在文件末尾：同一个坏目录，跑一个**不触发自愈**的进程（PFM_SELFTEST_BENCH，
// 它在 whenReady 里就 app.exit 了，走不到 runStartupHeal），四类损坏必须**原样还在**。
// 两组结果必须不同，否则说明"修好了"是别的路径顺手做的，自愈这段代码根本没被验证。
// 运行：npm run test:heal
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

// 临时文件名必须和 writeFileAtomic 生成的形态完全一致（.tmp-<pid>-<seq>-<name>.part），
// 否则测的就不是同一件事。pid 故意用一个不可能是当前进程的值。
const STALE_PART = '.tmp-999999-0-被中断的写入.md.part';
// 形态不匹配的 .part：用户自己的半成品文件，绝不能被删。
const USER_PART = '下载了一半.part';

function makeBrokenDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-heal-'));
  const trash = path.join(dir, '.trash');
  fs.mkdirSync(path.join(dir, 'prompts', 'testing'), { recursive: true });
  fs.mkdirSync(trash, { recursive: true });

  // 一个完整的正常文件：自愈跑完必须一字不动。
  fs.writeFileSync(path.join(dir, 'prompts/testing/正常文件.md'),
    '---\ntitle: 正常文件\nstage: testing\nversion: 1\n---\n\n不许动我。\n', 'utf8');

  // ---- 损坏 2：孤立正文（.trash 里有文件，索引里没条目）----
  fs.writeFileSync(path.join(trash, '1700000000000-111111.md'),
    '---\ntitle: 孤立的正文\n---\n\n这份正文只在 .trash 里，索引没有它。\n', 'utf8');

  // ---- 损坏 1 / 3：索引里的幽灵条目和越界 store ----
  // 同时放一条完全正常的条目（正文真的在），用来确认自愈不会把好条目也摘掉。
  fs.writeFileSync(path.join(trash, '1700000000002-333333.md'),
    '---\ntitle: 正常的回收站条目\n---\n\n我是好的。\n', 'utf8');
  fs.writeFileSync(path.join(trash, 'index.json'), JSON.stringify({
    items: [
      { id: '1700000000001-222222', originalRel: 'prompts/testing/幽灵.md', name: '幽灵.md',
        trashedAt: '2026-01-01T00:00:00.000Z', store: '1700000000001-222222.md', versionStore: null },
      { id: 'bad-store', originalRel: 'prompts/testing/越界.md', name: '越界.md',
        trashedAt: '2026-01-01T00:00:00.000Z', store: '../逃出去.md', versionStore: null },
      { id: '1700000000002-333333', originalRel: 'prompts/testing/正常的回收站条目.md', name: '正常的回收站条目.md',
        trashedAt: '2026-01-01T00:00:00.000Z', store: '1700000000002-333333.md', versionStore: null }
    ]
  }, null, 2), 'utf8');

  // ---- 损坏 4：残留 .part ----
  // 放三个位置，确认扫描覆盖到内容目录、.trash 和数据根。
  // mtime 要往回拨：自愈只清理 60 秒以上没动过的（新的可能是别的进程正在写）。
  const old = Date.now() - 10 * 60 * 1000;
  for (const rel of ['prompts/testing/' + STALE_PART, '.trash/' + STALE_PART, STALE_PART]) {
    const p = path.join(dir, rel);
    fs.writeFileSync(p, '半截内容', 'utf8');
    fs.utimesSync(p, new Date(old), new Date(old));
  }
  // 刚刚写的 .part（mtime = 现在）：不能删，可能有别的进程正在写。
  fs.writeFileSync(path.join(dir, 'prompts/testing/.tmp-999998-0-刚写的.md.part'), '正在写', 'utf8');
  // 用户自己的 .part：形态不匹配，绝不能删。
  const up = path.join(dir, 'prompts/testing/' + USER_PART);
  fs.writeFileSync(up, '用户的文件', 'utf8');
  fs.utimesSync(up, new Date(old), new Date(old));

  fs.writeFileSync(path.join(dir, 'config.json'),
    JSON.stringify({ theme: 'light', lang: 'zh', lockedFiles: [] }, null, 2), 'utf8');
  return dir;
}

function run(dataDir, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(electronBin, [root], {
      cwd: root,
      env: { ...process.env, PFM_DATA_DIR: dataDir, ELECTRON_ENABLE_LOGGING: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: 1, out: out + '\n[超时]' }); }, 60000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// 退出后把磁盘状态收集成一个可比对的快照。
function snapshot(dir) {
  const trash = path.join(dir, '.trash');
  let idx = { items: [] };
  try { idx = JSON.parse(fs.readFileSync(path.join(trash, 'index.json'), 'utf8')); } catch (_) {}
  const items = Array.isArray(idx.items) ? idx.items : [];
  const listParts = (sub) => {
    try { return fs.readdirSync(path.join(dir, sub)).filter(n => n.endsWith('.part')); }
    catch (_) { return []; }
  };
  return {
    ids: items.map(i => i.id),
    stores: items.map(i => i.store),
    recovered: items.filter(i => i.recovered),
    hasGhost: items.some(i => i.id === '1700000000001-222222'),
    hasBadStore: items.some(i => i.store === '../逃出去.md'),
    hasGoodEntry: items.some(i => i.id === '1700000000002-333333'),
    orphanAdopted: items.filter(i => i.store === '1700000000000-111111.md'),
    orphanFileStillThere: fs.existsSync(path.join(trash, '1700000000000-111111.md')),
    goodFileStillThere: fs.existsSync(path.join(trash, '1700000000002-333333.md')),
    normalBody: (() => {
      try { return fs.readFileSync(path.join(dir, 'prompts/testing/正常文件.md'), 'utf8'); }
      catch (_) { return ''; }
    })(),
    staleParts: [
      fs.existsSync(path.join(dir, 'prompts/testing/' + STALE_PART)),
      fs.existsSync(path.join(trash, STALE_PART)),
      fs.existsSync(path.join(dir, STALE_PART))
    ],
    freshPart: fs.existsSync(path.join(dir, 'prompts/testing/.tmp-999998-0-刚写的.md.part')),
    userPart: fs.existsSync(path.join(dir, 'prompts/testing/' + USER_PART)),
    partsInContent: listParts('prompts/testing')
  };
}

(async () => {
  const results = [];
  const push = (name, ok, detail) => results.push([name, ok, detail]);

  // ---------- 主检查：正常启动，自愈应当跑 ----------
  const dir = makeBrokenDataDir();
  const before = snapshot(dir);
  // 前置条件：先确认这个坏目录真的是坏的。不验这一步，下面的"修好了"可能
  // 只是因为构造失败——本项目踩过这个坑（以为清空库能让断言变红，其实不能）。
  push('前置：构造出的目录确实有幽灵条目', before.hasGhost);
  push('前置：构造出的目录确实有越界 store', before.hasBadStore);
  push('前置：构造出的目录确实有孤立正文', before.orphanFileStillThere && before.orphanAdopted.length === 0);
  push('前置：构造出的目录确实有 3 个残留 .part', before.staleParts.every(Boolean));

  const r = await run(dir, { PFM_SELFTEST: '1' });
  push('自愈进程正常退出', r.code === 0, 'exit=' + r.code + (r.code === 0 ? '' : ' → ' + r.out.slice(-800)));

  const after = snapshot(dir);

  // 1) 幽灵条目被摘掉
  push('幽灵条目被摘掉（文件已不存在）', !after.hasGhost, 'ids=' + JSON.stringify(after.ids));
  // 2) 孤立正文被收养成条目，且文件还在（不是删掉了事）
  push('孤立正文被收养成回收站条目', after.orphanAdopted.length === 1,
    'stores=' + JSON.stringify(after.stores));
  push('被收养的条目落在可恢复的路径上',
    after.orphanAdopted.length === 1 && /^prompts\//.test(String(after.orphanAdopted[0].originalRel)),
    after.orphanAdopted.length ? String(after.orphanAdopted[0].originalRel) : '(无)');
  push('孤立正文文件本身没被删', after.orphanFileStillThere);
  // 3) 越界 store 被摘掉
  push('越界 store 条目被摘掉', !after.hasBadStore, 'stores=' + JSON.stringify(after.stores));
  // 好条目不能被误伤
  push('正常条目没被误摘', after.hasGoodEntry);
  push('正常条目的文件还在', after.goodFileStillThere);
  // 4) 残留 .part 被清掉，新的和用户的不动
  push('三处残留 .part 都被清掉', after.staleParts.every(v => v === false),
    'staleParts=' + JSON.stringify(after.staleParts));
  push('刚写的 .part 没被删（可能有进程正在写）', after.freshPart);
  push('用户自己的 .part 没被删（形态不匹配）', after.userPart,
    'partsInContent=' + JSON.stringify(after.partsInContent));
  // 底线：用户的完整内容一字不动
  push('用户的正常文件内容一字未改', after.normalBody === before.normalBody);
  // 日志留痕
  push('自愈在日志里留了痕迹', /\[heal\]/.test(r.out));

  // ---------- 反向对照：不触发自愈的进程，四类损坏必须原样还在 ----------
  // PFM_SELFTEST_BENCH 在 whenReady 里跑完压测就 app.exit()，走不到 runStartupHeal。
  // 用 bench=0 让它什么都不生成。
  const dir2 = makeBrokenDataDir();
  const r2 = await run(dir2, { PFM_SELFTEST_BENCH: '0' });
  const ctrl = snapshot(dir2);
  push('对照组进程正常退出', r2.code === 0, 'exit=' + r2.code);
  push('对照组没有跑自愈（日志里没有 [heal]）', !/\[heal\]/.test(r2.out));
  push('对照：幽灵条目原样还在', ctrl.hasGhost);
  push('对照：越界 store 原样还在', ctrl.hasBadStore);
  push('对照：孤立正文仍然没被收养', ctrl.orphanAdopted.length === 0);
  push('对照：残留 .part 原样还在', ctrl.staleParts.every(Boolean));
  // 这条是整个反向对照的意义：两组必须不同。都绿说明"修好了"不是自愈做的。
  push('两组结果不同 → 测到的是自愈本身',
    !after.hasGhost && ctrl.hasGhost
    && after.orphanAdopted.length === 1 && ctrl.orphanAdopted.length === 0
    && after.staleParts.every(v => v === false) && ctrl.staleParts.every(Boolean));

  for (const d of [dir, dir2]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }

  let passed = true;
  for (const [name, ok, detail] of results) {
    console.log('[test:heal] ' + (ok ? 'PASS ' : 'FAIL ') + name + (!ok && detail ? ' → ' + detail : ''));
    if (!ok) passed = false;
  }
  console.log('\n[test:heal] ' + (passed ? '通过' : '失败'));
  process.exit(passed ? 0 : 1);
})();
