// tests/draft-store.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDraftStore } = require('../lib/draft-store');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:draft-store] PASS ' + msg);
  else { failures++; console.error('[test:draft-store] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};
const appError = (code, detail) => new Error(detail == null ? code : code + '|' + detail);
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message).split('|')[0]; } };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-drafts-'));
  try {
    const store = createDraftStore({
      draftsDir: path.join(root, '.drafts'),
      appError,
      writeFileAtomic: async (file, data) => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, data, 'utf8');
      },
      isAllowedRel: rel => rel.startsWith('prompts/') && rel.endsWith('.md'),
      now: () => '2026-01-01T00:00:00.000Z'
    });
    await store.save('prompts/a.md', 'draft body', 'base body');
    const draft = await store.read('prompts/a.md');
    ok(draft && draft.content === 'draft body' && draft.baseContent === 'base body' && draft.updatedAt, '能保存并读取草稿');
    ok(fs.readdirSync(path.join(root, '.drafts')).length === 1, '草稿文件名不使用原始路径');
    await store.clear('prompts/a.md');
    ok(await store.read('prompts/a.md') === null, '能清除草稿');
    ok(await codeOf(() => store.save('../x.md', 'x', 'y')) === 'E_WRITE_FORBIDDEN', '拒绝不允许的路径');

    const file = store.fileFor('prompts/broken.md');
    fs.writeFileSync(file, '{broken');
    ok(await store.read('prompts/broken.md') === null && fs.readdirSync(path.join(root, '.drafts')).some(n => n.includes('.corrupt-')), '损坏草稿会改名留档且不打断打开文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (failures) process.exit(1);
  console.log('[test:draft-store] 通过');
})().catch((e) => { console.error(e); process.exit(1); });
