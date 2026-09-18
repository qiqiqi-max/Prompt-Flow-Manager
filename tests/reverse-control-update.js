// tests/reverse-control-update.js
// 反向对照：证明「升级检查」那一节的每条断言撤掉修复就必然变红。
//
// 为什么需要这个单独的脚本：CONTRIBUTING 里那条规矩（两种情况都通过的算空断言）
// 光靠"跑一遍全绿"是验证不了的。本仓库已经有过好几条全绿但实际恒真的断言，
// 最近的两条就在这一节里——一条把切片锚在了沙箱降级那处 `await createWindow()`
// 上（于是"不 await"在一段没有 runUpdateCheck 的文本上恒真），另一条锚了
// 一行注释（剥注释之后 indexOf 返回 -1，body 变空串，三条断言一起假绿）。
// 两条都是靠"故意改坏再看它红不红"发现的，不是靠读代码发现的。
//
// 做法：对每个"修复点"施加一次最小反向改动（改真实文件），跑真实的 npm test，
// 要求**指定的那条断言**出现在失败列表里。只要求"有失败"是不够的：改动可能
// 恰好撞红了另一条，那说明目标断言依然是空的。
//
// 安全性（这个脚本会**改真实源文件**，所以还原路径必须是最可靠的那部分）：
//   - 改动前把原文和 md5 记在内存里，同时在系统临时目录落一份磁盘备份。
//     内存那份够用于正常流程；磁盘那份是为了"进程被强杀"——那种情况下
//     finally 根本不会执行，内存里的原文随进程一起没了，只有磁盘备份能救回来。
//   - 每次跑完立刻写回，写回后再比一次 md5。对不上就红着退出并打出备份路径。
//   - SIGINT/SIGTERM 显式挂了处理函数。node 默认的 SIGINT 行为是直接终止进程，
//     **不会**走 finally，所以"Ctrl-C 也能还原"这件事必须自己接管信号才成立。
//   - 全程不启动 Electron，也不需要 PFM_DATA_DIR：npm test 是纯静态检查，不碰数据目录。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const FILES = ['electron-main.js', 'lib/update-check.js', 'src/renderer.js'];
// 磁盘备份目录。mkdtemp 的随机后缀保证两个进程同时跑不会互相覆盖备份。
const BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-rc-backup-'));
const original = new Map();
for (const rel of FILES) {
  const p = path.join(root, rel);
  const text = fs.readFileSync(p, 'utf8');
  const backup = path.join(BACKUP_DIR, rel.replace(/[\\/]/g, '__'));
  fs.writeFileSync(backup, text);
  original.set(rel, { path: p, text, hash: md5(text), backup });
}

function restoreAll() {
  let bad = 0;
  for (const [rel, o] of original) {
    fs.writeFileSync(o.path, o.text);
    const now = md5(fs.readFileSync(o.path, 'utf8'));
    if (now !== o.hash) {
      console.error('!! 还原失败: ' + rel + ' (期望 ' + o.hash + ' 实得 ' + now + ')');
      console.error('   磁盘备份在: ' + o.backup);
      bad++;
    }
  }
  return bad === 0;
}

// 被中断时也要还原。node 对 SIGINT 的默认动作是立刻终止，finally 不会跑，
// 那样就会把改坏的源文件留在工作区里——这个脚本最不能接受的后果。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error('\n收到 ' + sig + '，正在还原源文件…');
    const ok = restoreAll();
    console.error(ok ? '已还原 ✓' : '还原失败，备份目录: ' + BACKUP_DIR);
    process.exit(ok ? 130 : 2);
  });
}

// 施加一次替换。返回 false 表示要替换的文本没找到——那本身就是个问题
// （说明这个对照用例的假设已经和代码脱节），当成失败处理。
function mutate(rel, find, replace) {
  const o = original.get(rel);
  if (!o.text.includes(find)) return false;
  fs.writeFileSync(o.path, o.text.split(find).join(replace));
  return true;
}

// 跑真实的冒烟测试，把失败行收回来。
function runSmoke() {
  const r = spawnSync(process.execPath, [path.join(root, 'tests/smoke.test.js')], {
    cwd: root, encoding: 'utf8'
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const reds = out.split(/\r?\n/).filter(l => l.includes('✗')).map(l => l.trim());
  return { code: r.status, reds, out };
}

// 每个用例：改什么、期望哪条断言变红。
// expect 是正则，匹配失败行的文案。
const CASES = [
  {
    name: '模块读了响应里的 html_url',
    rel: 'lib/update-check.js',
    find: '  return { version: v.normalized, error: null };',
    replace: '  return { version: v.normalized, url: raw.html_url, error: null };',
    expect: /html_url/
  },
  {
    name: '模块读了响应里的 assets',
    rel: 'lib/update-check.js',
    find: '  if (raw.draft === true)',
    replace: '  if (raw.assets && raw.assets.length === -1) return { version: null, error: x };\n  if (raw.draft === true)',
    expect: /assets/
  },
  {
    name: 'open-release-page 改成接收调用方传来的 URL',
    rel: 'electron-main.js',
    find: "ipcMain.handle('open-release-page', async () => {\n  await shell.openExternal(updateCheck.RELEASE_PAGE_URL);",
    replace: "ipcMain.handle('open-release-page', async (e, url) => {\n  await shell.openExternal(url);",
    expect: /本地常量|不接收 url 参数/
  },
  {
    name: '启动时不再跑升级检查',
    rel: 'electron-main.js',
    find: '    runUpdateCheck();',
    replace: '    void 0;',
    expect: /启动时会跑升级检查/
  },
  {
    name: '升级检查被 await（窗口要等出网超时）',
    rel: 'electron-main.js',
    find: '    runUpdateCheck();',
    replace: '    await runUpdateCheck();',
    expect: /不 await/
  },
  {
    name: '模块不再排除自检进程',
    rel: 'lib/update-check.js',
    find: "  if (env.PFM_SELFTEST === '1' || env.PFM_SELFTEST_BENCH) return { check: false, reason: 'selftest' };",
    replace: '',
    expect: /排除自检进程/
  },
  {
    name: '主进程绕过 shouldCheck 直接查',
    rel: 'electron-main.js',
    find: '    const decision = updateCheck.shouldCheck({',
    replace: '    const decision = { check: true, reason: "x" } || ({',
    expect: /shouldCheck/
  },
  {
    name: '配置默认值里没有 updateCheck（等于没法关）',
    rel: 'electron-main.js',
    find: '    updateCheck: true,',
    replace: '',
    expect: /配置默认值里有 updateCheck/
  },
  {
    name: '设置里关掉之后照样发请求',
    rel: 'lib/update-check.js',
    find: "  if (config.updateCheck === false) return { check: false, reason: 'config-off' };",
    replace: '',
    expect: /关掉之后连请求都不发/
  },
  {
    name: '检查时间不走 updateConfig（直接覆盖整份配置）',
    rel: 'electron-main.js',
    find: '      await updateConfig({ updateLastCheckedAt: at });',
    replace: '      await saveConfig(Object.assign({}, config, { updateLastCheckedAt: at }));',
    expect: /updateConfig/
  },
  {
    name: '只在成功时记检查时间（离网用户每次启动都等满超时）',
    rel: 'electron-main.js',
    find: `    try {
      await updateConfig({ updateLastCheckedAt: at });
    } catch (e) {
      // 配置写不进去只影响"下次什么时候再查"，不该让整次检查算失败
      logger.error('[update] 记录检查时间失败（下次启动会再查一次）: ' + (e && e.message ? e.message : e));
    }

    if (res.error) {
      lastUpdateResult.error = res.error;
      logger.info('[update] 检查未完成（已忽略）: ' + res.error);
      return lastUpdateResult;
    }
`,
    replace: `    if (res.error) {
      lastUpdateResult.error = res.error;
      logger.info('[update] 检查未完成（已忽略）: ' + res.error);
      return lastUpdateResult;
    }

    try {
      await updateConfig({ updateLastCheckedAt: at });
    } catch (e) {
      logger.error('[update] 记录检查时间失败（下次启动会再查一次）: ' + (e && e.message ? e.message : e));
    }
`,
    expect: /失败也记检查时间/
  },
  {
    name: '外层 try 去掉（fire-and-forget 变成没人接的 rejection）',
    rel: 'electron-main.js',
    find: 'async function runUpdateCheck() {\n  try {\n',
    replace: 'async function runUpdateCheck() {\n  {\n',
    expect: /整个函数体被 try 包住/
  },
  {
    name: '外层 catch 里的日志删掉（静默且无痕）',
    rel: 'electron-main.js',
    find: "    logger.error('[update] 检查过程本身失败（已忽略）: ' + (e && e.stack ? e.stack : e));",
    replace: '',
    expect: /最外层兜住的异常会记日志/
  },
  {
    name: '渲染进程的版本号白名单只声明不使用',
    rel: 'src/renderer.js',
    find: '  return typeof v === \'string\' && VERSION_DISPLAY_RE.test(v) ? v : null;',
    replace: '  return typeof v === \'string\' ? v : null;',
    expect: /白名单真的被调用/
  },
  {
    name: '推过来的版本号不过白名单直接进界面',
    rel: 'src/renderer.js',
    find: '  const version = safeVersion(info && info.version);',
    replace: '  const version = info && info.version;',
    expect: /横幅里每一次读/
  },
  {
    name: '设置面板那条路径的版本号不过白名单',
    rel: 'src/renderer.js',
    find: `  const current = safeVersion(info && info.currentVersion) || '';
  const latest = safeVersion(info && info.version);`,
    replace: `  const current = (info && info.currentVersion) || '';
  const latest = info && info.version;`,
    expect: /设置面板那行状态文字/
  },
  {
    name: '横幅改用 innerHTML 拼版本号',
    rel: 'src/renderer.js',
    find: `  $('update-banner-text').textContent = t('updateFound', {
    version,
    current: updateBannerInfo.currentVersion
  });`,
    replace: `  $('update-banner-text').innerHTML = t('updateFound', {
    version,
    current: updateBannerInfo.currentVersion
  });`,
    expect: /不用 innerHTML/
  },
  {
    // 黑名单版本的断言（查 machineId / os.hostname() 这类词）会被这一行绕过：
    // 它新增的是一个此前没人想到的请求头名字。所以那条断言改成了白名单。
    name: '请求里多带一个带本机标识的请求头',
    rel: 'lib/update-check.js',
    find: "          'Accept': 'application/vnd.github+json',",
    replace: "          'Accept': 'application/vnd.github+json',\n          'X-Machine': require('os').hostname(),",
    expect: /请求头只有固定的三个字段/
  },
  {
    // 上面那条只拦"多一个字段"。把本机信息拼进 UA 不会多出字段名，
    // 所以要另有一条盯住 UA 的内容是常量。
    name: '把主机名拼进 User-Agent',
    rel: 'lib/update-check.js',
    find: "      userAgent: o.userAgent || 'Prompt-Flow-Manager'",
    replace: "      userAgent: o.userAgent || 'Prompt-Flow-Manager/' + require('os').hostname()",
    expect: /User-Agent 是固定常量/
  }
];

(function main() {
  console.log('反向对照：升级检查（共 ' + CASES.length + ' 个用例）');
  console.log('');

  // 先确认干净状态下是全绿的。这一步不能省：如果基线本来就有红，
  // 下面每个用例"出现了红"都不能说明是改动造成的。
  const base = runSmoke();
  if (base.code !== 0) {
    console.error('基线就不是全绿，先修好再跑反向对照。失败项：');
    base.reds.forEach(l => console.error('  ' + l));
    process.exit(1);
  }
  console.log('基线全绿 ✓');
  console.log('');

  let bad = 0;
  try {
    for (const c of CASES) {
      const ok = mutate(c.rel, c.find, c.replace);
      if (!ok) {
        console.error('✗ ' + c.name);
        console.error('    要替换的代码没找到（这个对照用例和代码脱节了，需要更新）');
        bad++;
        restoreAll();
        continue;
      }
      const r = runSmoke();
      restoreAll();

      const hit = r.reds.find(l => c.expect.test(l));
      if (hit) {
        console.log('✓ ' + c.name);
        console.log('    → ' + hit);
      } else if (r.code === 0) {
        console.error('✗ ' + c.name);
        console.error('    改坏了却全绿：这条断言是空的（恒真），必须重写');
        bad++;
      } else {
        console.error('✗ ' + c.name);
        console.error('    变红了，但红的不是目标断言（目标 ' + c.expect + '）：');
        r.reds.forEach(l => console.error('      ' + l));
        bad++;
      }
    }
  } finally {
    if (!restoreAll()) {
      console.error('');
      console.error('!! 文件没能还原干净，立刻检查 git status / git diff');
      process.exit(2);
    }
  }

  // 还原之后必须回到基线全绿，否则说明还原虽然 md5 对上了但有别的副作用。
  const after = runSmoke();
  console.log('');
  if (after.code !== 0) {
    console.error('还原后冒烟测试不再全绿，检查 git diff：');
    after.reds.forEach(l => console.error('  ' + l));
    process.exit(2);
  }
  console.log('还原后基线仍全绿 ✓');

  // 到这里已经确认工作区和开跑前逐字节一致（md5 对过，冒烟也回到全绿），
  // 磁盘备份没有保留价值了，删掉——否则每跑一次就在临时目录里攒一份源码副本。
  // 有失败时**故意不删**：那种情况下备份是唯一的兜底。
  if (bad === 0) {
    try { fs.rmSync(BACKUP_DIR, { recursive: true, force: true }); }
    catch { console.log('（备份目录没能删掉，可手动清理: ' + BACKUP_DIR + '）'); }
    console.log('[reverse-control:update] 通过（' + CASES.length + ' 个修复点全部证明「撤掉就变红」）');
    process.exit(0);
  }
  console.error('[reverse-control:update] ' + bad + ' 个修复点没能证明变红');
  console.error('（源文件已还原，备份留在 ' + BACKUP_DIR + '）');
  process.exit(1);
})();
