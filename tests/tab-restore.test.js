// tests/tab-restore.test.js
// 回归测试：带着"上次打开的标签"重启，正文必须真的加载出来。
//
// 为什么单独一个文件：现有三层测试都覆盖不到这条路径。
// test:fn 是直接调 IPC 的（绕过标签逻辑），test:ui 是从空状态点「新建」进去的
// （标签是当前会话新建的，天然有 content）。只有"config.json 里已经存着 tabs，
// 进程重启后从占位标签恢复"这一条路没人走过——于是 openFile() 里
// `if (!tab)` 判断的漏洞一直没被发现：占位标签存在但 content 是空串，
// 预览区空白，此时进编辑再保存就把文件正文清空了。
//
// 做法：预置一个含 tabs/activeTab 的 config.json，启动时用 PFM_SELFTEST_OPEN
// 打开同一个文件，断言预览区渲染出了内容。同时跑一遍对照组（config 无 tabs），
// 确保这个测试真的在测标签恢复，而不是在测"文件能不能打开"。
// 运行：npm run test:tabs
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

const REL = 'prompts/testing/标签恢复回归.md';
const BODY_MARK = '这段正文必须出现在预览区';

// 建一个只含单个提示词的数据目录；withTabs 决定 config 里要不要预置标签。
function makeDataDir(withTabs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-tabs-'));
  fs.mkdirSync(path.join(dir, 'prompts', 'testing'), { recursive: true });
  fs.writeFileSync(path.join(dir, REL),
    `---\ntitle: 标签恢复回归\nstage: testing\nversion: 3\n---\n\n# 标签恢复回归\n\n${BODY_MARK}\n`,
    'utf8');
  const cfg = { theme: 'light', lang: 'zh', lockedFiles: [] };
  if (withTabs) {
    cfg.tabs = [REL];
    cfg.activeTab = REL;
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  return dir;
}

function run(dataDir) {
  return new Promise((resolve) => {
    const child = spawn(electronBin, [root], {
      cwd: root,
      env: {
        ...process.env,
        PFM_SELFTEST: '1',
        PFM_SELFTEST_OPEN: REL,
        PFM_DATA_DIR: dataDir,
        ELECTRON_ENABLE_LOGGING: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: 1, out: out + '\n[超时]' }); }, 60000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

(async () => {
  const results = [];

  // 主检查：config 里有已保存的标签
  const withTabs = makeDataDir(true);
  const a = await run(withTabs);
  try { fs.rmSync(withTabs, { recursive: true, force: true }); } catch (_) {}
  const aOpened = /PASS 打开 .*（预览 (\d+) 字符/.exec(a.out);
  const aLen = aOpened ? parseInt(aOpened[1], 10) : 0;
  results.push(['恢复已保存的标签后，预览区有内容（不是空白）', a.code === 0 && aLen > 0,
    aOpened ? '预览 ' + aLen + ' 字符' : '预览为空 → ' + (/FAIL 打开[^\n]*/.exec(a.out) || [''])[0]]);

  // 对照组：config 里无标签。两组都通过才说明主检查测的是标签恢复本身。
  const noTabs = makeDataDir(false);
  const b = await run(noTabs);
  try { fs.rmSync(noTabs, { recursive: true, force: true }); } catch (_) {}
  const bOpened = /PASS 打开 .*（预览 (\d+) 字符/.exec(b.out);
  const bLen = bOpened ? parseInt(bOpened[1], 10) : 0;
  results.push(['对照组（config 无标签）同样能打开', b.code === 0 && bLen > 0,
    bOpened ? '预览 ' + bLen + ' 字符' : '预览为空']);

  let passed = true;
  for (const [name, ok, detail] of results) {
    console.log('[test:tabs] ' + (ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' → ' + detail : ''));
    if (!ok) passed = false;
  }
  console.log('\n[test:tabs] ' + (passed ? '通过' : '失败'));
  process.exit(passed ? 0 : 1);
})();
