// tests/file-move.test.js
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { movePromptWithHistory } = require('../lib/file-move');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:file-move] PASS ' + msg);
  else { failures++; console.error('[test:file-move] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};
const appError = (code, detail) => new Error(detail == null ? code : code + '|' + detail);
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message).split('|')[0]; } };

async function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-file-move-'));
  try { await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function paths(root, oldRel, newRel) {
  return {
    oldFull: path.join(root, oldRel),
    newFull: path.join(root, newRel),
    oldVersionDir: path.join(root, '.versions', oldRel),
    newVersionDir: path.join(root, '.versions', newRel)
  };
}

(async () => {
  await withRoot(async (root) => {
    const p = paths(root, 'prompts/a.md', 'prompts/b.md');
    await fsp.mkdir(path.dirname(p.oldFull), { recursive: true });
    await fsp.mkdir(p.oldVersionDir, { recursive: true });
    await fsp.writeFile(p.oldFull, 'body');
    await fsp.writeFile(path.join(p.oldVersionDir, 'v.md'), 'old');
    const moved = [];
    await movePromptWithHistory({ ...p, oldRel: 'prompts/a.md', newRel: 'prompts/b.md', appError, onFileMoved: f => moved.push(f) });
    ok(!fs.existsSync(p.oldFull) && fs.readFileSync(p.newFull, 'utf8') === 'body', '改名后正文移动到新路径');
    ok(fs.existsSync(path.join(p.newVersionDir, 'v.md')) && !fs.existsSync(p.oldVersionDir), '改名后版本历史跟随移动');
    ok(moved.includes(p.oldFull) && moved.includes(p.newFull), '改名后清理新旧路径缓存');
  });

  await withRoot(async (root) => {
    const p = paths(root, 'prompts/a.md', 'prompts/b.md');
    await fsp.mkdir(path.dirname(p.oldFull), { recursive: true });
    await fsp.mkdir(p.oldVersionDir, { recursive: true });
    await fsp.mkdir(p.newVersionDir, { recursive: true });
    await fsp.writeFile(p.oldFull, 'body');
    await fsp.writeFile(path.join(p.oldVersionDir, 'same.md'), 'moved version');
    await fsp.writeFile(path.join(p.newVersionDir, 'same.md'), 'existing version');
    await movePromptWithHistory({ ...p, oldRel: 'prompts/a.md', newRel: 'prompts/b.md', appError, random: () => 0.123456 });
    const files = fs.readdirSync(p.newVersionDir).sort();
    const contents = files.map(f => fs.readFileSync(path.join(p.newVersionDir, f), 'utf8')).sort();
    ok(files.length === 2 && contents.join('|') === 'existing version|moved version', '目标已有版本目录时合并且不覆盖', JSON.stringify({ files, contents }));
    ok(!fs.existsSync(p.oldVersionDir), '合并后旧版本目录被清理');
  });

  await withRoot(async (root) => {
    const p = paths(root, 'prompts/a.md', 'prompts/b.md');
    await fsp.mkdir(path.dirname(p.oldFull), { recursive: true });
    await fsp.mkdir(p.oldVersionDir, { recursive: true });
    await fsp.writeFile(p.oldFull, 'body');
    await fsp.writeFile(path.join(p.oldVersionDir, 'v.md'), 'old');
    const code = await codeOf(() => movePromptWithHistory({
      ...p,
      oldRel: 'prompts/a.md',
      newRel: 'prompts/b.md',
      appError,
      rename: async (from, to) => {
        if (from === p.oldVersionDir) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return fsp.rename(from, to);
      }
    }));
    ok(code === 'E_RENAME_HISTORY_MOVE', '版本历史移动失败时返回明确错误', code);
    ok(fs.readFileSync(p.oldFull, 'utf8') === 'body' && !fs.existsSync(p.newFull), '版本历史移动失败时正文回到原路径');
    ok(fs.existsSync(path.join(p.oldVersionDir, 'v.md')), '版本历史移动失败时旧历史仍在原处');
  });

  await withRoot(async (root) => {
    const p = paths(root, 'prompts/a.md', 'prompts/b.md');
    await fsp.mkdir(path.dirname(p.oldFull), { recursive: true });
    await fsp.writeFile(p.oldFull, 'old');
    await fsp.writeFile(p.newFull, 'existing');
    ok(await codeOf(() => movePromptWithHistory({ ...p, oldRel: 'prompts/a.md', newRel: 'prompts/b.md', appError })) === 'E_TARGET_EXISTS', '目标正文存在时拒绝覆盖');
    ok(fs.readFileSync(p.newFull, 'utf8') === 'existing' && fs.readFileSync(p.oldFull, 'utf8') === 'old', '拒绝覆盖时两个正文都不变');
  });

  if (failures) process.exit(1);
  console.log('[test:file-move] 通过');
})().catch((e) => { console.error(e); process.exit(1); });
