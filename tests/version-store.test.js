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

  // ---------- 版本说明 ----------
  // 语义见 lib/version-store.js 文件头：说明挂在内容上。保存时先挂到 current，
  // 下次把这份内容存成快照时转给那条快照。
  const indexOf = async (root, rel) => JSON.parse(await fsp.readFile(path.join(root, '.versions', rel, 'index.json'), 'utf8'));

  await withStore(async (store, root) => {
    const rel = 'prompts/note.md';
    // 第一次保存（新文件，没有快照）填了说明：挂在当前内容上
    await store.recordCurrentNote(rel, 'v1', '初版', null);
    ok(await store.getCurrentNote(rel, 'v1') === '初版', '说明先挂在当前内容上');
    ok((await store.listVersions(rel)).length === 0, '挂说明不会凭空多出快照');
    // 第二次保存：v1 存成快照，说明跟着 v1 走；新内容 v2 带自己的说明
    await store.saveVersion(rel, 'v1');
    await store.recordCurrentNote(rel, 'v2', '加了示例', null);
    let list = await store.listVersions(rel);
    ok(list.length === 1 && list[0].note === '初版', '旧内容存成快照时说明转到那条快照上（不挂到错的内容上）', JSON.stringify(list));
    ok(await store.readVersion(rel, list[0].file) === 'v1', '带说明的快照装的正是那条说明描述的内容');
    ok(await store.getCurrentNote(rel, 'v2') === '加了示例', '新内容的说明挂在当前内容上');
    // 第三次保存没填说明：v2 的说明跟着 v2 进历史，当前内容没有说明
    await store.saveVersion(rel, 'v2');
    await store.recordCurrentNote(rel, 'v3', '', null);
    list = await store.listVersions(rel);
    ok(list.map(v => v.note).join('|') === '加了示例|初版', '不填说明的保存不影响已有说明，各自跟着自己的内容', JSON.stringify(list));
    ok(await store.getCurrentNote(rel, 'v3') === '', '没填说明的当前内容显示为没有说明');
    ok(!('current' in await indexOf(root, rel)), '当前内容没有说明时索引里不留 current');
  });

  await withStore(async (store) => {
    // 只存快照、之后不再调 recordCurrentNote 的路径（工作流引用同步就是这样）：
    // 说明转给快照之后 current 必须当场清掉。留着的话，正文哪天又变回这份字节
    // （外部工具撤销、同步盘回滚），同一句说明会同时出现在快照和当前内容两行上。
    const rel = 'prompts/refs-only.md';
    await store.recordCurrentNote(rel, 'w1', '工作流说明', null);
    await store.saveVersion(rel, 'w1');
    ok((await store.listVersions(rel))[0].note === '工作流说明', '只存快照的路径同样把说明转给快照');
    ok(await store.getCurrentNote(rel, 'w1') === '', '说明转给快照后当前内容不再重复带着它');
  });

  await withStore(async (store) => {
    const rel = 'prompts/same.md';
    // 内容没变的保存（只 bump 自动字段）不产生快照，说明要继续跟着当前内容走
    await store.recordCurrentNote(rel, 'body-v1', '保留我', null);
    await store.recordCurrentNote(rel, 'body-v1-bumped', '', 'body-v1');
    ok(await store.getCurrentNote(rel, 'body-v1-bumped') === '保留我', '没产生快照的保存把说明换绑到新写入的内容');
    // 产生了快照、但转交没成功（current 残留）时，不能换绑到新内容上
    await store.recordCurrentNote(rel, 'body-v2', '', null);
    ok(await store.getCurrentNote(rel, 'body-v2') === '', '产生快照的保存不会把旧说明换绑到新内容上');
  });

  await withStore(async (store) => {
    const rel = 'prompts/external.md';
    await store.recordCurrentNote(rel, 'mine', '我写的', null);
    // 外部编辑器改了正文：说明描述的已经不是磁盘上的内容
    ok(await store.getCurrentNote(rel, 'changed outside') === '', '正文被外部改过后不再显示当前内容的说明');
    await store.saveVersion(rel, 'changed outside');
    const list = await store.listVersions(rel);
    ok(list.length === 1 && list[0].note === '', '外部改过的内容存成快照时不会被安上不属于它的说明', JSON.stringify(list));
  });

  {
    const { normalizeVersionNote, MAX_VERSION_NOTE } = require('../lib/version-store');
    const messy = '  a\r\nb\tc\u0007d\u2028e  ';
    ok(normalizeVersionNote(messy, appError) === 'a b cd e', '说明去掉控制字符、换行折成空格、去首尾空白',
      JSON.stringify(normalizeVersionNote(messy, appError)));
    ok(normalizeVersionNote(null, appError) === '' && normalizeVersionNote(undefined, appError) === '', '缺省说明按空处理');
    // 包一层 try：按 UTF-16 码元计数的实现会在这里抛错，要让它落成这一条 FAIL，而不是整个脚本崩掉
    let emojiLen = null;
    try { emojiLen = normalizeVersionNote('😀'.repeat(MAX_VERSION_NOTE), appError).length; } catch (e) { emojiLen = e.message; }
    ok(emojiLen === MAX_VERSION_NOTE * 2, '上限按字符数算，emoji 不按两个算', String(emojiLen));
    ok(await errCode(() => normalizeVersionNote('x'.repeat(MAX_VERSION_NOTE + 1), appError)) === 'E_VERSION_NOTE_TOO_LONG', '超长说明被拒绝而不是被静默截断');
    ok(await errCode(() => normalizeVersionNote({ note: 'x' }, appError)) === 'E_VERSION_NOTE_INVALID', '非字符串说明被拒绝');
  }

  await withStore(async (store, root) => {
    const rel = 'prompts/edit.md';
    await store.saveVersion(rel, 'old');
    const [v] = await store.listVersions(rel);
    await store.setVersionNote(rel, v.file, '事后补的说明');
    ok((await store.listVersions(rel))[0].note === '事后补的说明', '能事后编辑某个版本的说明');
    await store.setVersionNote(rel, v.file, '   ');
    // 判键在不在，不判值真假：留一条 '' 的说明在值上也是假的，那样写分辨不出来
    ok((await store.listVersions(rel))[0].note === '' && !(v.file in ((await indexOf(root, rel)).notes || {})), '清空说明会删掉这一条');
    await store.setVersionNote(rel, null, '当前内容的说明', 'cur');
    ok(await store.getCurrentNote(rel, 'cur') === '当前内容的说明', '能事后编辑当前内容的说明');
    ok(await errCode(() => store.setVersionNote(rel, '../../secret.md', 'x')) === 'E_BAD_VERSION_FILE', '编辑说明时版本文件名走白名单');
    ok(await errCode(() => store.setVersionNote('../outside.md', v.file, 'x')) === 'E_PATH_ESCAPE', '编辑说明时拒绝穿越版本目录');
    ok(await errCode(() => store.setVersionNote(rel, '20200101-000000-000.md', 'x')) === 'E_VERSION_NOT_FOUND', '不存在（已被裁剪）的快照不能挂说明');
    ok(!((await indexOf(root, rel)).notes || {})['20200101-000000-000.md'], '拒绝时不在索引里留下孤儿说明');
    ok(await errCode(() => store.setVersionNote(rel, v.file, 'x'.repeat(201))) === 'E_VERSION_NOTE_TOO_LONG', '编辑时同样卡长度上限');
  });

  await withStore(async (store, root) => {
    const rel = 'prompts/prune.md';
    // maxUnpinned = 2：先存两条并各挂说明，给较新的那条加星标，再存两条
    await store.saveVersion(rel, 'p1');
    await store.saveVersion(rel, 'p2');
    let list = await store.listVersions(rel);
    const oldest = list[list.length - 1].file;
    const starred = list[0].file;
    await store.setVersionNote(rel, oldest, '会被裁掉');
    await store.setVersionNote(rel, starred, '留下来');
    await store.pinVersion(rel, starred, true);
    await store.saveVersion(rel, 'p3');
    await store.saveVersion(rel, 'p4');
    list = await store.listVersions(rel);
    const notes = (await indexOf(root, rel)).notes || {};
    ok(!list.some(v => v.file === oldest), '前提：最旧的未星标快照被裁剪了', JSON.stringify(list));
    ok(!(oldest in notes), '被裁剪的版本，说明随之从索引删除', JSON.stringify(notes));
    const kept = list.find(v => v.file === starred);
    ok(!!kept && kept.note === '留下来' && kept.pinned, '星标版本的说明不受裁剪影响');
    await store.pinVersion(rel, starred, false);
    ok((await store.listVersions(rel)).find(v => v.file === starred).note === '留下来', '取消星标不动说明');
  });

  await withStore(async (store, root) => {
    // 旧格式索引：只有 pinned，没有 notes / current
    const rel = 'prompts/legacy.md';
    const dir = path.join(root, '.versions', rel);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '20250101-000000-000.md'), 'legacy', 'utf8');
    await fsp.writeFile(path.join(dir, 'index.json'), JSON.stringify({ pinned: { '20250101-000000-000.md': true } }), 'utf8');
    let list = await store.listVersions(rel);
    ok(list.length === 1 && list[0].pinned === true && list[0].note === '', '旧格式索引照常读出星标，没有说明的条目显示为空');
    ok(await store.getCurrentNote(rel, 'x') === '', '旧格式索引没有 current 时当前内容没有说明');
    await store.setVersionNote(rel, '20250101-000000-000.md', '补一句');
    list = await store.listVersions(rel);
    ok(list[0].pinned === true && list[0].note === '补一句', '在旧格式索引上加说明不丢星标');
  });

  {
    const { sanitizeVersionIndex, contentHash } = require('../lib/version-store');
    const sha = contentHash('body');
    const clean = sanitizeVersionIndex({
      pinned: { '20250101-000000-000.md': true, 'evil.md': true, '20250101-000000-001.md': 'yes' },
      notes: { '20250101-000000-000.md': 'a\nb\u0000', 'evil.md': 'x', '20250101-000000-002.md': 'gone', '20250101-000000-003.md': 5 },
      current: { note: 'cur', sha256: sha },
      extra: { anything: 1 }
    }, f => f !== '20250101-000000-002.md');
    const expected = { pinned: { '20250101-000000-000.md': true }, notes: { '20250101-000000-000.md': 'a b' }, current: { note: 'cur', sha256: sha } };
    ok(JSON.stringify(clean) === JSON.stringify(expected), '导入索引只留白名单字段，说明按同样规则清洗，没导入的快照不留说明', JSON.stringify(clean));
    ok(!sanitizeVersionIndex({ current: { note: 'x', sha256: 'not-a-hash' } }).current, '导入索引里哈希不合法的 current 被丢弃');
    ok([...sanitizeVersionIndex({ notes: { '20250101-000000-000.md': 'x'.repeat(500) } }).notes['20250101-000000-000.md']].length === 200, '导入时超长说明截断到上限');
  }

  if (failures) process.exit(1);
  console.log('[test:version-store] 通过');
})().catch((e) => { console.error(e); process.exit(1); });
