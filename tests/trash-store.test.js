// tests/trash-store.test.js
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createTrashStore } = require('../lib/trash-store');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:trash-store] PASS ' + msg);
  else { failures++; console.error('[test:trash-store] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};
const appError = (code, detail) => new Error(detail == null ? code : code + '|' + detail);
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message).split('|')[0]; } };

async function withStore(fn, rmImpl, writeImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-trash-store-'));
  const trashDir = path.join(root, '.trash');
  const store = createTrashStore({
    trashDir,
    appError,
    ensureDir: (dir) => fsp.mkdir(dir, { recursive: true }),
    writeFileAtomic: writeImpl || (async (file, data) => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, data, 'utf8');
    }),
    readIndexJson: async (file, fallback) => {
      try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return { ...fallback }; }
    },
    random: () => 0.123456,
    clock: () => 1000,
    rm: rmImpl || fsp.rm,
    logError: () => {}
  });
  try { await fn(store, trashDir, root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

(async () => {
  await withStore(async (store, trashDir) => {
    ok(store.storePath('abc.md') === path.join(trashDir, 'abc.md'), '接受单层存放名');
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'x\0y']) {
      ok(await codeOf(() => store.storePath(bad)) === 'E_TRASH_BAD_STORE', '拒绝损坏的存放名：' + JSON.stringify(bad));
    }
  });

  await withStore(async (store, trashDir) => {
    await fsp.mkdir(trashDir, { recursive: true });
    await fsp.writeFile(path.join(trashDir, '1-123456.md'), 'taken');
    const name = store.uniqueStoreName('1', '.md');
    ok(name !== '1.md' || !fs.existsSync(path.join(trashDir, name)), '生成的存放名不会覆盖已有文件', name);
    await fsp.writeFile(path.join(trashDir, '1.md'), 'taken');
    ok(store.uniqueStoreName('1', '.md') === '1-123456-100.md', '随机后缀重复时仍能生成新名字');
  });

  await withStore(async (store) => {
    ok(JSON.stringify(await store.readIndex()) === '{"items":[]}', '没有索引时返回空回收站');
    await store.writeIndex({ items: [{ id: 'a', store: 'a.md' }] });
    ok((await store.readIndex()).items[0].id === 'a', '能写入并读回索引');
  });

  await withStore(async (store, trashDir) => {
    await fsp.mkdir(trashDir, { recursive: true });
    await fsp.writeFile(path.join(trashDir, 'ok.md'), 'x');
    await fsp.writeFile(path.join(trashDir, 'busy.md'), 'x');
    await store.writeIndex({ items: [
      { id: 'ok', name: 'ok.md', store: 'ok.md' },
      { id: 'busy', name: 'busy.md', store: 'busy.md' },
      { id: 'bad', name: 'bad.md', store: '../outside' }
    ] });
    const result = await store.empty();
    const left = (await store.readIndex()).items.map(i => i.id);
    ok(JSON.stringify(result.failedNames) === '["busy.md"]', '清空时报告删不掉的条目', JSON.stringify(result));
    ok(JSON.stringify(left) === '["busy"]', '只保留删不掉的条目，摘掉已删除和损坏条目', JSON.stringify(left));
    ok(!fs.existsSync(path.join(trashDir, 'ok.md')) && fs.existsSync(path.join(trashDir, 'busy.md')), '只删除成功删除的文件');
  }, async (file, opts) => {
    if (path.basename(file) === 'busy.md') throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return fsp.rm(file, opts);
  });

  await withStore(async (store, trashDir, root) => {
    const full = path.join(root, 'prompts', 'a.md');
    const versionDir = path.join(root, '.versions', 'prompts', 'a.md');
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.mkdir(versionDir, { recursive: true });
    await fsp.writeFile(full, 'body');
    await fsp.writeFile(path.join(versionDir, 'v.md'), 'old');
    const moved = [];
    await store.moveToTrash({ rel: 'prompts/a.md', fullPath: full, versionDir, onFileMoved: (p) => moved.push(p) });
    const item = (await store.readIndex()).items[0];
    ok(!fs.existsSync(full) && fs.readFileSync(store.storePath(item.store), 'utf8') === 'body', '删除时正文移入回收站');
    ok(!fs.existsSync(versionDir) && fs.existsSync(path.join(store.storePath(item.versionStore), 'v.md')), '删除时版本目录一起移入回收站');
    ok(item.originalRel === 'prompts/a.md' && item.name === 'a.md', '索引记录原路径和文件名', JSON.stringify(item));
    ok(moved.length === 1 && moved[0] === full, '正文移动后通知调用方清缓存');
  });

  let failIndex = true;
  await withStore(async (store, trashDir, root) => {
    const full = path.join(root, 'prompts', 'b.md');
    const versionDir = path.join(root, '.versions', 'prompts', 'b.md');
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.mkdir(versionDir, { recursive: true });
    await fsp.writeFile(full, 'body');
    await fsp.writeFile(path.join(versionDir, 'v.md'), 'old');
    const code = await codeOf(() => store.moveToTrash({ rel: 'prompts/b.md', fullPath: full, versionDir }));
    ok(code === 'E_TRASH_INDEX_WRITE', '索引写失败时返回明确错误', code);
    ok(fs.readFileSync(full, 'utf8') === 'body', '索引写失败时正文回到原处');
    ok(fs.existsSync(path.join(versionDir, 'v.md')), '索引写失败时版本目录回到原处');
    const leftovers = fs.existsSync(trashDir) ? fs.readdirSync(trashDir) : [];
    ok(leftovers.length === 0, '索引写失败后回收站没有孤儿文件', JSON.stringify(leftovers));
    failIndex = false;
  }, null, async (file, data) => {
    if (failIndex && path.basename(file) === 'index.json') throw new Error('disk full');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, data, 'utf8');
  });

  const restoreOptions = (root) => ({
    resolveWritable: (rel) => {
      if (rel === 'config.json') throw appError('E_WRITE_FORBIDDEN', rel);
      return path.join(root, rel);
    },
    versionDirFor: (rel) => path.join(root, '.versions', rel)
  });

  await withStore(async (store, trashDir, root) => {
    const full = path.join(root, 'prompts', 'r.md');
    const versionDir = path.join(root, '.versions', 'prompts', 'r.md');
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.mkdir(versionDir, { recursive: true });
    await fsp.writeFile(full, 'body');
    await fsp.writeFile(path.join(versionDir, 'v.md'), 'old');
    const trashed = await store.moveToTrash({ rel: 'prompts/r.md', fullPath: full, versionDir });
    const moved = [];
    const res = await store.restoreFromTrash(trashed.id, { ...restoreOptions(root), onFileMoved: (p) => moved.push(p) });
    ok(res.rel === 'prompts/r.md' && fs.readFileSync(full, 'utf8') === 'body', '恢复到原路径');
    ok(fs.existsSync(path.join(versionDir, 'v.md')), '恢复版本目录');
    ok((await store.readIndex()).items.length === 0, '恢复后移除回收站记录');
    ok(moved.length === 1 && moved[0] === full, '恢复后通知调用方清缓存');
  });

  await withStore(async (store, trashDir, root) => {
    const full = path.join(root, 'prompts', 'same.md');
    const versionDir = path.join(root, '.versions', 'prompts', 'same.md');
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.mkdir(versionDir, { recursive: true });
    await fsp.writeFile(full, 'old body');
    await fsp.writeFile(path.join(versionDir, 'v.md'), 'old version');
    const trashed = await store.moveToTrash({ rel: 'prompts/same.md', fullPath: full, versionDir });
    await fsp.writeFile(full, 'new body');
    await fsp.mkdir(path.join(root, '.versions', 'prompts', 'same-restored1.md'), { recursive: true });
    await fsp.writeFile(path.join(root, '.versions', 'prompts', 'same-restored1.md', 'v.md'), 'existing version');
    const res = await store.restoreFromTrash(trashed.id, restoreOptions(root));
    const restoredVersionDir = path.join(root, '.versions', 'prompts', 'same-restored1.md');
    const versions = fs.readdirSync(restoredVersionDir).sort();
    ok(res.rel === 'prompts/same-restored1.md', '原位置有文件时生成恢复副本', JSON.stringify(res));
    ok(fs.readFileSync(full, 'utf8') === 'new body' && fs.readFileSync(path.join(root, res.rel), 'utf8') === 'old body', '恢复副本不覆盖现有文件');
    ok(versions.length === 2 && versions.includes('v.md') && versions.some(f => f.startsWith('restored-')), '已有版本目录时合并且不覆盖', JSON.stringify(versions));
  });

  await withStore(async (store) => {
    await store.writeIndex({ items: [{ id: 'gone', originalRel: 'prompts/gone.md', store: 'gone.md' }] });
    const code = await codeOf(() => store.restoreFromTrash('gone', restoreOptions('/tmp')));
    ok(code === 'E_TRASH_STORE_MISSING', '回收站文件丢失时返回明确错误');
    ok((await store.readIndex()).items.length === 0, '回收站文件丢失时移除无效记录');
  });

  await withStore(async (store, trashDir, root) => {
    await fsp.mkdir(trashDir, { recursive: true });
    await fsp.writeFile(path.join(trashDir, 'cfg.md'), 'payload');
    await store.writeIndex({ items: [{ id: 'cfg', originalRel: 'config.json', store: 'cfg.md' }] });
    const code = await codeOf(() => store.restoreFromTrash('cfg', restoreOptions(root)));
    ok(code === 'E_WRITE_FORBIDDEN', '拒绝恢复到写入白名单外');
    ok(fs.existsSync(path.join(trashDir, 'cfg.md')) && (await store.readIndex()).items.length === 1, '拒绝恢复时保留回收站文件和记录');
  });

  await withStore(async (store) => {
    ok(await codeOf(() => store.restoreFromTrash('missing', restoreOptions('/tmp'))) === 'E_TRASH_ITEM_MISSING', '恢复不存在的记录时返回明确错误');
  });

  if (failures) process.exit(1);
  console.log('[test:trash-store] 通过');
})().catch((e) => { console.error(e); process.exit(1); });
