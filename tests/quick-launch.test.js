// tests/quick-launch.test.js
// 真实拉起 Electron 验证全局快捷键呼出的快速搜索面板。步骤和断言在 lib/quick-launch-selftest.js，
// 这里只负责种数据、起进程、对输出。
//
// 跑两次：
//   full          快捷键开着启动。最小化主窗口按快捷键呼出 → 安全配置与主窗口逐项一致 →
//                 输入即搜（含乱序守卫）→ Enter 复制 → 占位符 / include → Esc / 失焦 →
//                 设置里关开关、键被占用、格式不对、改键 → 切语言主题 → 退出前注销
//   startup-taken 启动时键已被"别的程序"占用（替身假装的），PFM_SANDBOX=off。
//                 验证注册失败会当面提示，以及沙箱关着时面板和主窗口仍是同一个判定——
//                 和 full 那次的 sandbox=true 一起，证明面板的沙箱不是写死的。
//
// 自检模式下不注册真实的系统快捷键（见 electron-main.js 的 shortcutBackend），
// 所以不会抢开发机的按键，也不怕和别的测试进程互相"占用"。剪贴板是真的，跑完会放回去。
//
// "没有 FAIL" 证明不了"这条真的跑到了"（CONTRIBUTING 第一节），关键项都进 mustHave。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronBin = require(path.join(root, 'node_modules', 'electron'));

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-quick-launch-'));
  const testing = path.join(dir, 'prompts', 'testing');
  const snippets = path.join(dir, 'prompts', 'snippets');
  fs.mkdirSync(testing, { recursive: true });
  fs.mkdirSync(snippets, { recursive: true });
  fs.mkdirSync(path.join(dir, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  // 期望值写死在 lib/quick-launch-selftest.js（PLAIN_REL / FILL_REL / 正文里的标记串），两边一起改
  fs.writeFileSync(path.join(testing, 'ql-plain.md'),
    '---\ntitle: QL Plain\nstage: testing\ntags: [ql]\n---\nQLPLAIN-BODY-7731\nsecond line\n', 'utf8');
  fs.writeFileSync(path.join(testing, 'ql-fill.md'),
    '---\ntitle: QL Fill\nstage: testing\ntags: [ql]\n---\nQLFILL 目标：[QL目标]\n备注：[QL备注]\n语言：[QL语言=Go|Python|Go]\n{{include: prompts/snippets/ql-snippet.md}}\n', 'utf8');
  fs.writeFileSync(path.join(snippets, 'ql-snippet.md'),
    '---\ntitle: QL Snippet\n---\nSNIPPET-INCLUDED-5521\n', 'utf8');
  // 英文 + 深色：面板要跟着这两项走。fillMemory 是主窗口记住的填充值，面板要拿来预填。
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    lang: 'en',
    theme: 'dark',
    quickLaunchEnabled: true,
    quickLaunchShortcut: 'Ctrl+Alt+Space',
    fillMemory: { '[QL备注]': 'MEMO-7' }
  }, null, 2));
  return dir;
}

function runOnce(mode, extraEnv) {
  const dataDir = makeDataDir();
  return new Promise((resolve) => {
    const child = spawn(electronBin, [root], {
      cwd: root,
      env: {
        ...process.env,
        PFM_SELFTEST: '1',
        PFM_DATA_DIR: dataDir,
        PFM_SELFTEST_QUICK_LAUNCH: mode,
        ELECTRON_ENABLE_LOGGING: '1',
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(d); });
    child.stderr.on('data', d => { out += d; process.stderr.write(d); });
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
      resolve({ code, out });
    };
    const timer = setTimeout(() => { child.kill(); out += '\n[超时]'; finish(1); }, 120000);
    child.on('exit', code => finish(code));
  });
}

const FULL_MUST = [
  ...['project-name', 'project-description', 'project-stack', 'project-path', 'project-constraints', 'run-name', 'main-fill', 'inline', 'quick-fill'].map(route => new RegExp('PASS 长度保护 ' + route)),
  ...['main-fill', 'inline', 'project-fields', 'run-name', 'quick-fill'].map(route => new RegExp('PASS 长度修正 ' + route)),
  /PASS 长度反馈中文/,
  /PASS 长度合法预填可立即提交 quick-fill/,
  /PASS 自检模式下用的是内存替身/,
  /PASS 配置开着时启动即注册了快捷键/,
  /PASS 开着时启动就预先建好了面板/,
  /PASS 主窗口最小化时按快捷键也能呼出面板/,
  /PASS 面板置顶且是固定尺寸的小窗口/,
  /PASS 面板居中于当前显示器的工作区/,
  /PASS 面板跟随当前主题（深色）/,
  /PASS 面板跟随当前语言（英文）/,
  /PASS 面板与主窗口的 webPreferences 逐项一致，只有 preload 不同（默认沙箱判定/,
  // 这一次不强制沙箱：标准环境（CI）下是 true；缺运行库的机器上主窗口会就地降级，
  // 面板跟着按 false 重建——两种都必须和主窗口一致，所以只认"一致"不认具体值。
  // 强制 false 的那次在下面 startup-taken 里；"面板建在 sandboxActive 上而不是写死"
  // 另有 npm test 的静态断言。
  /PASS 面板沙箱与主窗口同一个判定（sandbox=(true|false)）/,
  /PASS 面板用最小白名单 preload，主窗口仍是完整的 preload\.js（默认沙箱判定）/,
  /PASS 面板页面拿不到 Node 能力（require\/process\/module 不可见，默认沙箱判定）/,
  /PASS 面板只暴露最小白名单，拿不到主窗口那套写操作（默认沙箱判定）/,
  /PASS 面板的 CSP 与主窗口逐字一致/,
  /PASS 面板内导航被拦截/,
  /PASS 面板禁止 window\.open/,
  /PASS 输入即搜：结果列出匹配的提示词/,
  /PASS 搜索结果乱序返回时，旧查询的结果不会盖掉新查询/,
  /PASS Enter 把选中的提示词正文（不含 frontmatter）写进剪贴板/,
  /PASS 复制成功后面板隐藏/,
  /PASS 快速面板复制成功只记一次使用/,
  /PASS 快速面板复制后主窗口常用列表自动更新/,
  /PASS 快速面板取消填写不增加使用次数/,
  /PASS 隐藏而不是销毁：再次呼出复用同一个面板实例/,
  /PASS ↑↓ 移动选中项，到头回绕/,
  /PASS 有占位符时在面板内弹出填空表单，先不复制/,
  /PASS 填空表单预填了主窗口记住的值/,
  /PASS 快速面板预填占位符默认值/,
  /PASS 快速面板选择选项会填入对应的值/,
  /PASS 快速面板 Shift\+Enter 保留换行行为且不提交/,
  /PASS 快速面板复制保留多行填写内容/,
  /PASS Ctrl\+Enter 填好后复制：\{\{include:\}\} 已展开、占位符已替换/,
  /PASS Esc 收起面板/,
  /PASS 填空表单里按 Esc 也能收起/,
  /PASS 再次呼出时回到搜索列表/,
  /PASS 面板失焦即收起/,
  /PASS 关掉开关立即注销快捷键/,
  /PASS 关掉开关写进了配置/,
  /PASS 快捷键被占用时提示用户/,
  /PASS 注册失败时开关拨回关闭、配置没写进去、没有残留注册/,
  /PASS 格式不对的快捷键被拒绝并提示/,
  /PASS 改组合键：新键规范化后注册、旧键不再响应/,
  /PASS 新组合键写进了配置/,
  /PASS 新组合键能呼出面板/,
  /PASS 开着时换键：旧键注销、新键生效/,
  /PASS 切换语言后设置里的状态行跟着变/,
  /PASS 主窗口切了语言和主题，下一次呼出面板就跟着变/,
  /PASS 两个窗口都没有控制台报错/,
  /PASS 退出前注销了全部全局快捷键/,
  // 注册失败必须进日志：用户说"按了没反应"时，这是唯一能查到原因的地方
  /\[quick-launch\] 全局快捷键注册失败（可能已被其他程序占用）: .*Ctrl\+Shift\+K/,
  /\[quick-launch\] 已注销全部全局快捷键/,
  /\[quick-launch\] 全部通过/
];
const TAKEN_MUST = [
  /PASS 自检模式下用的是内存替身/,
  /PASS 启动时快捷键被占用：主进程报告未生效/,
  /PASS 启动注册失败后没有残留任何注册/,
  /PASS 启动时注册失败会当面提示用户/,
  /PASS 没注册上时不预先建面板/,
  /PASS 自检入口可以不经快捷键直接呼出面板/,
  /PASS 面板与主窗口的 webPreferences 逐项一致，只有 preload 不同（强制关沙箱/,
  /PASS 面板沙箱与主窗口同一个判定（sandbox=false）/,
  /PASS 面板用最小白名单 preload，主窗口仍是完整的 preload\.js（强制关沙箱）/,
  /PASS 面板页面拿不到 Node 能力（require\/process\/module 不可见，强制关沙箱）/,
  /PASS 面板只暴露最小白名单，拿不到主窗口那套写操作（强制关沙箱）/,
  /PASS Esc 收起面板（强制关沙箱）/,
  /PASS 两个窗口都没有控制台报错/,
  /PASS 退出前注销了全部全局快捷键/,
  /\[quick-launch\] 全局快捷键注册失败（可能已被其他程序占用）: Ctrl\+Alt\+Space/,
  /\[quick-launch\] 全部通过/
];

function judge(label, res, must) {
  const missing = must.filter(re => !re.test(res.out));
  // 认 "[quick-launch] FAIL"，不认裸的 FAIL：日志里别的模块也可能打出这个词
  const fails = res.out.split(/\r?\n/).filter(l => /\[quick-launch\] FAIL/.test(l));
  const ok = res.code === 0 && missing.length === 0 && fails.length === 0;
  console.log('[test:quick-launch] ' + (ok ? 'PASS ' : 'FAIL ') + label
    + (ok ? '' : '（退出码 ' + res.code + '）'));
  for (const re of missing) console.log('    缺少: ' + re);
  for (const l of fails) console.log('    ' + l.trim());
  return ok;
}

(async () => {
  const full = await runOnce('full', { PFM_SELFTEST_SHORTCUT_TAKEN: 'Ctrl+Shift+K' });
  const taken = await runOnce('startup-taken', { PFM_SELFTEST_SHORTCUT_TAKEN: 'Ctrl+Alt+Space', PFM_SANDBOX: 'off' });
  const ok1 = judge('快捷键开着启动：呼出、搜索、复制、填空、隐藏、设置、退出', full, FULL_MUST);
  const ok2 = judge('启动时快捷键被占用：当面提示；沙箱关时安全配置仍与主窗口一致', taken, TAKEN_MUST);
  const ok = ok1 && ok2;
  console.log('[test:quick-launch] ' + (ok ? '通过' : '失败'));
  process.exit(ok ? 0 : 1);
})();
