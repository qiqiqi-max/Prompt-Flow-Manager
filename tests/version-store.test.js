// tests/version-store.test.js
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createVersionStore } = require('../lib/version-store');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:version-store] PASS ' + msg);
  else { failures++; console.error('[test:version-store] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};
const errCode = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message).split('|')[0]; } };
const appError = (code, detail) => new Error(detail == null ? code : code + '|' + detail);

async function withStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-version-store-'));
  let tick = Date.UTC(2026, 0, 2, 3, 4, 5, 6);
  const store = createVersionStore({
    versionsDir: path.join(root, '.versions'),
    maxUnpinned: 2,
    appError,
    now: () => new Date(tick++),
    ensureDir: (dir) => fsp.mkdir(dir, { recursive: true }),
    writeFileAtomic: async (file, data) => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, data, 'utf8');
    }
  });
  try { await fn(store, root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

(async () => {
  await withStore(async (store) => {
    const rel = 'prompts/a.md';
    await store.saveVersion(rel, 'one');
    await store.saveVersion(rel, 'two');
    let list = await store.listVersions(rel);
    ok(list.length === 2 && list[0].timestamp > list[1].timestamp, '版本列表按时间倒序返回', JSON.stringify(list));
    ok(await store.readVersion(rel, list[1].file) === 'one', '能读取指定版本');

    await store.pinVersion(rel, list[1].file, true);
    await store.saveVersion(rel, 'three');
    await store.saveVersion(rel, 'four');
    list = await store.listVersions(rel);
    const contents = await Promise.all(list.map(v => store.readVersion(rel, v.file)));
    ok(list.length === 3, '星标版本不占未星标配额', JSON.stringify(list));
    ok(contents.includes('one') && contents.includes('three') && contents.includes('four') && !contents.includes('two'), '超出配额时删除最旧的未星标版本', JSON.stringify(contents));
    const pinned = list.find(v => v.pinned);
    ok(!!pinned && await store.readVersion(rel, pinned.file) === 'one', '列表带回星标状态');
  });

  await withStore(async (store, root) => {
    ok(await errCode(() => store.listVersions('../outside.md')) === 'E_PATH_ESCAPE', '拒绝穿越版本目录');
    ok(await errCode(() => store.readVersion('prompts/a.md', '../../secret.md')) === 'E_BAD_VERSION_FILE', '拒绝非法版本文件名');
    const crossDrive = process.platform === 'win32' ? (path.parse(root).root[0].toUpperCase() === 'C' ? 'D:\\x.md' : 'C:\\x.md') : '/tmp/x.md';
    ok(await errCode(() => store.listVersions(crossDrive)) === 'E_PATH_ESCAPE', '拒绝绝对路径和跨盘符路径');
  });

  await withStore(async (store) => {
    const rel = 'prompts/collide.md';
    const dir = store.versionDirFor(rel);
    await fsp.mkdir(dir, { recursive: true });
    const first = store.timestampName(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6))) + '.md';
    await fsp.writeFile(path.join(dir, first), 'old', 'utf8');
    await store.saveVersion(rel, 'new');
    const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md')).sort();
    ok(files.length === 2, '快照撞名时不会覆盖已有版本', JSON.stringify(files));
    ok(await fsp.readFile(path.join(dir, first), 'utf8') === 'old', '撞名的旧快照内容保持不变');
  });

  if (failures) process.exit(1);
  console.log('[test:version-store] 通过');
})().catch((e) => { console.error(e); process.exit(1); });
