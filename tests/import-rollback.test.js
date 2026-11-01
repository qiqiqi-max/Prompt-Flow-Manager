// tests/import-rollback.test.js
// 真实启动 Electron：完整备份写入中途注入失败，验证正文、版本历史（含版本说明）、
// 设置和回收站都被撤回。
//
// 跑两轮，失败点不同：
//   files    写第一条版本快照之前就失败（PFM_SELFTEST_IMPORT_FAIL_AFTER_FILES）
//   versions 版本快照和 index.json（带版本说明）都写完之后才失败
//            （PFM_SELFTEST_IMPORT_FAIL_AFTER_VERSIONS）。这一轮还预先放一个
//            同名的孤立版本目录（只有 index.json、没有正文），导入会复用它：
//            trackDir 只删"导入新建的目录"，这个目录得靠 index.json 的快照恢复，
//            回滚后必须逐字节回到导入前的样子，不能带上备份里的版本说明。
// 只跑第一轮的话，"索引已经写进去了，回滚要把它撤掉"这条路径从来没被走到过：
// 那时版本目录还是空的，删不删都看不出来。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const archiver = require('archiver');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const electronBin = require(path.join(root, 'node_modules', 'electron'));
const hash = s => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const PROMPT_REL = 'prompts/testing/回滚导入.md';
const PROMPT_BODY = '---\ntitle: 回滚导入\n---\n正文';

async function makeBackup(zipPath) {
  const files = [
    [PROMPT_REL, PROMPT_BODY],
    ['.versions/' + PROMPT_REL + '/20260101-010203-004.md', '旧版本'],
    ['.versions/' + PROMPT_REL + '/index.json', JSON.stringify({
      pinned: { '20260101-010203-004.md': true },
      notes: { '20260101-010203-004.md': '回滚说明快照' },
      current: { note: '回滚说明当前', sha256: hash(PROMPT_BODY) }
    })],
    ['.pfm/portable-config.json', JSON.stringify({ schema: 1, config: { projectTypes: ['回滚类型'], lockedFiles: [PROMPT_REL], fillMemory: {} } })],
    ['.trash/index.json', JSON.stringify({ items: [{ id: 'old', originalRel: 'prompts/testing/回滚回收站.md', name: '回滚回收站.md', store: 'old.md' }] })],
    ['.trash/old.md', '回收站正文']
  ];
  const manifest = {
    schema: 1,
    app: 'prompt-flow-manager',
    appVersion: 'test',
    createdAt: new Date().toISOString(),
    files: files.map(([p, c]) => ({ path: p, size: Buffer.byteLength(c), sha256: hash(c) })).sort((a, b) => a.path.localeCompare(b.path))
  };
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const zip = archiver('zip');
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    for (const [p, c] of files) zip.append(c, { name: p });
    zip.append(JSON.stringify(manifest), { name: '.pfm/manifest.json' });
    zip.finalize();
  });
}

async function runCase(mode) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-import-rollback-'));
  const zipPath = path.join(dataDir, 'backup.zip');
  const queuePath = path.join(dataDir, '__dialogs.json');
  await makeBackup(zipPath);
  const versionDir = path.join(dataDir, '.versions', ...PROMPT_REL.split('/'));
  const orphanIndex = JSON.stringify({ pinned: {}, notes: { '20250101-000000-000.md': '孤立目录原有说明' } });
  if (mode === 'versions') {
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, 'index.json'), orphanIndex, 'utf8');
  }
  fs.writeFileSync(queuePath, JSON.stringify([{ canceled: false, filePaths: [zipPath] }, { kind: 'message', response: 1 }]));
  return new Promise((resolve) => {
    // versions 轮要求失败信息来自第二个注入点：否则第一个注入点误开了也会"通过"，
    // 而那样根本没写过索引。
    const expectMsg = mode === 'versions' ? 'after versions' : 'selftest import failure';
    const script = `
      (async () => {
        const api = window.promptFlowApi;
        const before = await api.getMetaList();
        let message = '';
        const importing = api.importZip().catch((e) => { message = String(e.message || e); });
        await new Promise(resolve => setTimeout(resolve, 0));
        const concurrentSave = api.setConfig({ sidebarWidth: 321 });
        await importing;
        await concurrentSave;
        const after = await api.getMetaList();
        const cfg = await api.getConfig();
        const trash = await api.listTrash();
        const versions = await api.listVersions(${JSON.stringify(PROMPT_REL)});
        const ok = /E_IMPORT_ROLLED_BACK/.test(message)
          && message.includes(${JSON.stringify(expectMsg)})
          && before.length === after.length
          && !after.some(m => m.rel.includes('回滚导入'))
          && versions.length === 0
          && !(cfg.projectTypes || []).includes('回滚类型')
          && !(cfg.lockedFiles || []).some(r => r.includes('回滚导入'))
          && cfg.sidebarWidth === 321
          && trash.items.length === 0;
        console.log(ok ? '[import-rollback] PASS ${mode}：中途失败后整次导入被撤回' : '[import-rollback] FAIL ${mode} ' + JSON.stringify({ message, before: before.length, after: after.length, versions, cfg, trash }));
      })()`;
    const env = {
      ...process.env,
      PFM_SELFTEST: '1',
      PFM_DATA_DIR: dataDir,
      PFM_SELFTEST_DIALOGS: queuePath,
      PFM_SELFTEST_EVAL: script,
      ELECTRON_ENABLE_LOGGING: '1'
    };
    if (mode === 'files') env.PFM_SELFTEST_IMPORT_FAIL_AFTER_FILES = '1';
    else env.PFM_SELFTEST_IMPORT_FAIL_AFTER_VERSIONS = '1';
    const child = spawn(electronBin, [root], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(d); });
    child.stderr.on('data', d => { out += d; process.stderr.write(d); });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      // 从进程外直接看磁盘：listVersions 只数 .md，版本目录里残留一个带说明的
      // index.json 它是看不见的。这份残留会在下次同名文件出现时把旧说明安上去。
      let diskOk;
      if (mode === 'versions') {
        // 预先存在的目录要留着，里面只能剩导入前那份 index.json
        const indexPath = path.join(versionDir, 'index.json');
        const files = fs.existsSync(versionDir) ? fs.readdirSync(versionDir) : [];
        const indexNow = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : null;
        diskOk = files.length === 1 && indexNow === orphanIndex;
        if (diskOk) console.log('[import-rollback] PASS versions：已有版本目录的 index.json 恢复原样，导入的版本说明被撤回');
        else console.error('[import-rollback] FAIL versions：已有版本目录没有恢复原样 ' + JSON.stringify({ files, indexNow }));
      } else {
        diskOk = !fs.existsSync(versionDir);
        if (diskOk) console.log('[import-rollback] PASS files：导入新建的版本目录被撤回');
        else console.error('[import-rollback] FAIL files：版本目录没有被撤回，残留 [' + fs.readdirSync(versionDir).join(', ') + ']');
      }
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
      const passed = code === 0 && diskOk
        && new RegExp('\\[import-rollback\\] PASS ' + mode + '：中途失败').test(out)
        && !/\[import-rollback\] FAIL/.test(out);
      resolve(passed);
    });
  });
}

(async () => {
  const results = [];
  for (const mode of ['files', 'versions']) results.push(await runCase(mode));
  const passed = results.every(Boolean);
  console.log(passed ? '[test:import-rollback] 通过' : '[test:import-rollback] 失败');
  process.exit(passed ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
