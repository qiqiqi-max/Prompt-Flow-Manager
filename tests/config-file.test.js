// tests/config-file.test.js
// config.json 读取：不存在 / 损坏 / 结构不对 三种情况。
// 自带反向对照：改动前的实现（catch 一律返回默认值、不留档）必须在这批断言上失败。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readConfigFile } = require('../lib/config-file');

async function legacyReadConfigFile(file) {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; }
}

async function runCases(impl, label) {
  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-config-'));
  try {
    const file = path.join(root, 'config.json');
    const opts = { now: () => 1700000000000 };
    const corruptName = 'config.json.corrupt-1700000000000';

    ok(await impl(file, opts) === null, '文件不存在时返回 null');
    ok(fs.readdirSync(root).length === 0, '文件不存在时不产生任何文件');

    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', lockedFiles: ['prompts/a.md'] }));
    const good = await impl(file, opts);
    ok(good && good.theme === 'dark' && good.lockedFiles[0] === 'prompts/a.md', '正常文件原样解析');
    ok(fs.existsSync(file), '正常文件不被改名');

    const broken = '{"theme":"dark","lockedFiles":["prompts/a.md"';
    fs.writeFileSync(file, broken);
    ok(await impl(file, opts) === null, '损坏文件返回 null');
    ok(!fs.existsSync(file), '损坏文件被移走，下一次保存不会覆盖它');
    ok(fs.existsSync(path.join(root, corruptName))
      && fs.readFileSync(path.join(root, corruptName), 'utf8') === broken, '损坏文件改名留档且内容不变');

    for (const [name, body] of [['数组', '[1,2]'], ['null', 'null'], ['字符串', '"x"']]) {
      fs.rmSync(path.join(root, corruptName), { force: true });
      fs.writeFileSync(file, body);
      ok(await impl(file, opts) === null, `顶层是${name}时视为损坏`);
      ok(fs.existsSync(path.join(root, corruptName)), `顶层是${name}时也留档`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`[test:config-file] ${label}: ${fails.length ? fails.length + ' 条失败' : '全部通过'}`);
  return fails;
}

(async () => {
  const real = await runCases(readConfigFile, '真实实现');
  for (const f of real) console.error('[test:config-file] FAIL ' + f);
  const legacy = await runCases(legacyReadConfigFile, '反向对照（旧实现）');
  const controlOk = legacy.length > 0 && legacy.includes('损坏文件改名留档且内容不变');
  if (!controlOk) console.error('[test:config-file] FAIL 反向对照居然全绿：这批断言分辨不出旧版实现，测试无效');
  const passed = real.length === 0 && controlOk;
  console.log('[test:config-file] ' + (passed ? '通过' : '失败'));
  process.exit(passed ? 0 : 1);
})().catch((e) => {
  console.error('[test:config-file] FAIL ' + (e && e.stack || e));
  process.exit(1);
});
