// tests/export-file.test.js
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { writeExportFile, safeExportName } = require('../lib/export-file');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:export-file] PASS ' + msg);
  else { failures++; console.error('[test:export-file] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message).split('|')[0]; } };
const appError = (code, detail) => new Error(detail == null ? code : code + '|' + detail);

(async () => {
  ok(safeExportName('a/b:c?.md') === 'a_b_c_.md', '导出默认文件名清除非法字符');
  ok(safeExportName('   ') === 'untitled.md', '空标题使用默认文件名');
  ok(safeExportName('README') === 'README.md', '默认文件名补齐 Markdown 扩展名');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-export-file-'));
  try {
    const target = path.join(dir, 'out.md');
    await fsp.writeFile(target, 'old');
    await writeExportFile(target, 'new', { appError });
    ok(fs.readFileSync(target, 'utf8') === 'new', '覆盖确认后写入新内容');
    ok(!fs.readdirSync(dir).some(n => n.endsWith('.part')), '导出成功后没有临时文件');

    const failTarget = path.join(dir, 'fail.md');
    await fsp.writeFile(failTarget, 'keep');
    const code = await codeOf(() => writeExportFile(failTarget, 'broken', {
      appError,
      rename: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }
    }));
    ok(code === 'E_EXPORT_WRITE', '写入失败时返回明确错误', code);
    ok(fs.readFileSync(failTarget, 'utf8') === 'keep', '写入失败时保留原文件');
    ok(!fs.readdirSync(dir).some(n => n.endsWith('.part')), '写入失败时清理临时文件');

    const folder = path.join(dir, 'folder.md');
    await fsp.mkdir(folder);
    ok(await codeOf(() => writeExportFile(folder, 'x', { appError })) === 'E_EXPORT_TARGET_DIR', '拒绝把文件夹当作导出目标');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures) process.exit(1);
  console.log('[test:export-file] 通过');
})().catch((e) => { console.error(e); process.exit(1); });
