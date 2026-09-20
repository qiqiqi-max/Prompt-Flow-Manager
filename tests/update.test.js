// tests/update.test.js
// 升级检查的单测。裸 node 跑（lib/update-check.js 刻意不 require electron）。
//
// 这个模块是本项目第一个出网的地方，所以断言分两类：
//   1. 判定逻辑对不对（版本比较、要不要查、要不要提示）
//   2. **出网这件事本身的约束有没有被守住**——不跟重定向、有字节上限、有超时、
//      失败不抛、发布页地址不来自响应。第 2 类比第 1 类重要：判定错了是提示不准，
//      约束破了是多出一个攻击面。
//
// 反向对照（CONTRIBUTING.md 第一节的硬规则）：文件末尾有两组控制桩，
// 分别模拟"版本比较写成字符串比较"和"发布页地址取响应里的 html_url"。
// 每一条都必须让相应断言变红，否则那条断言是空断言。
const path = require('path');
const upd = require(path.join(__dirname, '..', 'lib', 'update-check.js'));

let pass = 0;
const failures = [];
function assert(cond, msg, extra) {
  if (cond) {
    pass++;
    console.log('  PASS ' + msg + (extra === undefined ? '' : ' → ' + extra));
  } else {
    failures.push(msg + (extra === undefined ? '' : ' → ' + extra));
    console.log('  FAIL ' + msg + (extra === undefined ? '' : ' → ' + extra));
  }
}
function section(name) { console.log('[test:update] ' + name); }

// 每个 section 包成函数，反向对照时要用同一批断言再跑一遍。
//
// 断言函数**作为参数传进去**，不是让 section 闭包引用外面那个 assert：
// 控制组要把断言结果收到单独的篮子里（不能混进主结果），如果靠重新赋值外层的
// assert 来切换，那是给一个函数声明重新赋值——eslint 的 no-func-assign 会拦，
// 而且切换期间任何异步 section 都会写错篮子。
const sections = [];
function defineSection(name, fn) { sections.push({ name, fn }); }

// ---------------------------------------------------------------------------
defineSection('版本号解析', (m, assert) => {
  assert(m.parseVersion('1.4.0') !== null, '常规版本号能解析');
  assert(m.parseVersion('v1.4.0') !== null, '带前导 v 也能解析（GitHub tag 常带 v）');
  assert(m.parseVersion('v1.4.0').normalized === '1.4.0', '归一化去掉前导 v',
    m.parseVersion('v1.4.0').normalized);
  assert(m.parseVersion('1.5.0-beta.1') !== null, '预发布版能解析');
  assert(m.parseVersion('1.5.0-beta.1').pre === 'beta.1', '预发布标识取出来',
    m.parseVersion('1.5.0-beta.1').pre);
  // 下面这些是"响应里唯一被采纳的字段"的边界。放过任何一条，
  // 就等于让外部内容直接进界面/进 openExternal 的参数。
  assert(m.parseVersion('') === null, '空串不是版本号');
  assert(m.parseVersion(null) === null, 'null 不是版本号');
  assert(m.parseVersion('1.4') === null, '缺一段不算（x.y 不接受）');
  assert(m.parseVersion('latest') === null, '文字不是版本号');
  assert(m.parseVersion('1.4.0; rm -rf /') === null, '带命令的不是版本号');
  assert(m.parseVersion('<img src=x onerror=alert(1)>') === null, '带标签的不是版本号');
  assert(m.parseVersion('1.4.0\n2.0.0') === null, '带换行的不是版本号');
  assert(m.parseVersion('../../etc/passwd') === null, '带路径的不是版本号');
});

// ---------------------------------------------------------------------------
defineSection('版本比较', (m, assert) => {
  assert(m.compareVersions('1.4.1', '1.4.0') === 1, 'patch 更大算新',
    m.compareVersions('1.4.1', '1.4.0'));
  assert(m.compareVersions('1.5.0', '1.4.9') === 1, 'minor 更大算新（不是字符串比较）',
    m.compareVersions('1.5.0', '1.4.9'));
  assert(m.compareVersions('2.0.0', '1.99.99') === 1, 'major 更大算新',
    m.compareVersions('2.0.0', '1.99.99'));
  assert(m.compareVersions('1.4.0', '1.4.0') === 0, '相同算相等');
  assert(m.compareVersions('1.4.0', '1.5.0') === -1, '更旧算旧');
  // 这两条是字符串比较必错的地方：'10' < '9' 按字典序成立
  assert(m.compareVersions('1.10.0', '1.9.0') === 1, '1.10.0 比 1.9.0 新（字典序会判错）',
    m.compareVersions('1.10.0', '1.9.0'));
  assert(m.compareVersions('1.4.10', '1.4.9') === 1, '1.4.10 比 1.4.9 新（字典序会判错）',
    m.compareVersions('1.4.10', '1.4.9'));
  // semver：预发布排在同号正式版之前。反了的话正式版用户会被反复提示装 beta
  assert(m.compareVersions('1.5.0-beta.1', '1.5.0') === -1, '预发布版比同号正式版旧',
    m.compareVersions('1.5.0-beta.1', '1.5.0'));
  assert(m.compareVersions('1.5.0', '1.5.0-beta.1') === 1, '正式版比同号预发布新');
  assert(m.compareVersions('1.5.0-beta.10', '1.5.0-beta.2') === 1,
    'beta.10 比 beta.2 新（数字段按数值比）', m.compareVersions('1.5.0-beta.10', '1.5.0-beta.2'));
  assert(m.compareVersions('bad', '1.4.0') === null, '解析不了就返回 null（不能瞎猜）');
  assert(m.compareVersions('1.4.0', undefined) === null, '缺一侧返回 null');
});

// ---------------------------------------------------------------------------
defineSection('要不要提示用户', (m, assert) => {
  let r = m.evaluate({ latest: '1.5.0', current: '1.4.0' });
  assert(r.updateAvailable === true, '有新版本时提示');
  assert(r.version === '1.5.0', '带出版本号', r.version);

  r = m.evaluate({ latest: '1.4.0', current: '1.4.0' });
  assert(r.updateAvailable === false, '同版本不提示');
  assert(r.reason === 'same', '理由是 same', r.reason);

  r = m.evaluate({ latest: '1.3.0', current: '1.4.0' });
  assert(r.updateAvailable === false, '本地更新时不提示（开发中会出现）');
  assert(r.reason === 'older', '理由是 older', r.reason);

  // 忽略只对那一个版本生效
  r = m.evaluate({ latest: '1.5.0', current: '1.4.0', skipVersion: '1.5.0' });
  assert(r.updateAvailable === false, '用户忽略过这个版本就不再提示');
  assert(r.reason === 'skipped', '理由是 skipped', r.reason);
  r = m.evaluate({ latest: '1.6.0', current: '1.4.0', skipVersion: '1.5.0' });
  assert(r.updateAvailable === true,
    '忽略只对那一个版本生效（否则一次点击等于永久关掉检查，而用户以为只跳过一版）');
  // 忽略值带 v 前缀时也要认得出来，否则用户点了忽略却还是天天被提示
  r = m.evaluate({ latest: '1.5.0', current: '1.4.0', skipVersion: 'v1.5.0' });
  assert(r.reason === 'skipped', '忽略值带 v 前缀也认（归一化后比较）', r.reason);

  r = m.evaluate({ latest: 'garbage', current: '1.4.0' });
  assert(r.updateAvailable === false, '版本号解析不了时不提示');
  assert(r.reason === 'unparsable', '理由是 unparsable', r.reason);
});

// ---------------------------------------------------------------------------
defineSection('这次启动要不要查', (m, assert) => {
  const base = { packaged: true, env: {}, config: {}, now: Date.parse('2026-01-10T00:00:00Z') };

  let r = m.shouldCheck({ ...base });
  assert(r.check === true, '打包版首次运行会查');
  assert(r.reason === 'first-run', '理由是 first-run', r.reason);

  r = m.shouldCheck({ ...base, packaged: false });
  assert(r.check === false, '开发模式不查（每次 npm start 都打 GitHub 没意义）');
  assert(r.reason === 'dev', '理由是 dev', r.reason);

  // 自检不许出网：否则测试依赖网络、变慢、偶发失败
  r = m.shouldCheck({ ...base, env: { PFM_SELFTEST: '1' } });
  assert(r.check === false, '自检进程不出网');
  assert(r.reason === 'selftest', '理由是 selftest', r.reason);
  r = m.shouldCheck({ ...base, env: { PFM_SELFTEST_BENCH: '500' } });
  assert(r.check === false, '压测进程也不出网');

  r = m.shouldCheck({ ...base, config: { updateCheck: false } });
  assert(r.check === false, '用户在设置里关掉就不查');
  assert(r.reason === 'config-off', '理由是 config-off', r.reason);

  r = m.shouldCheck({ ...base, env: { PFM_UPDATE_CHECK: 'off' } });
  assert(r.check === false, 'PFM_UPDATE_CHECK=off 不查');
  r = m.shouldCheck({ ...base, env: { PFM_UPDATE_CHECK: '0' } });
  assert(r.check === false, 'PFM_UPDATE_CHECK=0 不查');
  // 环境变量的优先级要压过配置项和时间间隔，否则没法手动验证
  r = m.shouldCheck({
    ...base, env: { PFM_UPDATE_CHECK: 'on' },
    config: { updateCheck: false, updateLastCheckedAt: '2026-01-09T23:59:00Z' }
  });
  assert(r.check === true, 'PFM_UPDATE_CHECK=on 压过配置项和时间间隔（手动验证用）');
  assert(r.reason === 'env-forced-on', '理由是 env-forced-on', r.reason);
  // env-off 要压过 env-on 之外的一切，也要排在最前
  r = m.shouldCheck({ ...base, env: { PFM_UPDATE_CHECK: 'off', PFM_SELFTEST: '1' } });
  assert(r.reason === 'env-off', 'env-off 优先级最高', r.reason);

  // 时间间隔
  const lastHour = new Date(base.now - 60 * 60 * 1000).toISOString();
  r = m.shouldCheck({ ...base, config: { updateLastCheckedAt: lastHour } });
  assert(r.check === false, '一小时前查过就不再查');
  assert(r.reason === 'too-soon', '理由是 too-soon', r.reason);

  const lastWeek = new Date(base.now - 7 * 24 * 60 * 60 * 1000).toISOString();
  r = m.shouldCheck({ ...base, config: { updateLastCheckedAt: lastWeek } });
  assert(r.check === true, '一周前查过会再查');
  assert(r.reason === 'due', '理由是 due', r.reason);

  r = m.shouldCheck({ ...base, config: { updateLastCheckedAt: 'not-a-date' } });
  assert(r.check === true, '时间戳写坏了当没查过（不能因为一个坏字段永久停摆）');

  // 用户把系统时间往前调过：now - last 是负数。这时也要查，
  // 否则一次改表就能让检查永久停在"未来的上次检查时间"上
  const future = new Date(base.now + 30 * 24 * 60 * 60 * 1000).toISOString();
  r = m.shouldCheck({ ...base, config: { updateLastCheckedAt: future } });
  assert(r.check === true, '上次检查时间在未来时照样查（系统时间被调过）');
});

// ---------------------------------------------------------------------------
defineSection('响应解析只采纳版本号', (m, assert) => {
  let r = m.parseRelease(JSON.stringify({ tag_name: 'v1.5.0', html_url: 'https://evil.example/x' }));
  assert(r.version === '1.5.0', '取 tag_name', r.version);
  assert(r.error === null, '没有错误');
  // 这条是文件头第 1 条约束的落点：解析结果里不该出现任何 URL，
  // 发布页地址只能来自本地常量
  assert(!('url' in r) && !('html_url' in r) && !('page' in r),
    '解析结果里没有任何来自响应的 URL（发布页地址只能来自本地常量）',
    JSON.stringify(r));
  assert(!JSON.stringify(r).includes('evil.example'),
    '响应里的 html_url 完全没被带出来');

  r = m.parseRelease('not json at all');
  assert(r.version === null && r.error === 'bad-json', '坏 JSON 报 bad-json', r.error);
  r = m.parseRelease(JSON.stringify([1, 2, 3]));
  assert(r.version === null && r.error === 'bad-shape', '数组不是对象，报 bad-shape', r.error);
  r = m.parseRelease(JSON.stringify({ tag_name: 'v1.5.0', draft: true }));
  assert(r.version === null && r.error === 'draft', '草稿版当没有新版本', r.error);
  r = m.parseRelease(JSON.stringify({ tag_name: 'v1.5.0', prerelease: true }));
  assert(r.version === null && r.error === 'prerelease', '预发布当没有新版本', r.error);
  r = m.parseRelease(JSON.stringify({ tag_name: 'garbage' }));
  assert(r.version === null && r.error === 'bad-version', '版本号不合法报 bad-version', r.error);
  r = m.parseRelease(JSON.stringify({}));
  assert(r.version === null, '缺 tag_name 时没有版本号');
});

// ---------------------------------------------------------------------------
defineSection('发布页地址是本地常量', (m, assert) => {
  assert(m.RELEASE_PAGE_URL.startsWith('https://github.com/'),
    '发布页是 github.com 上的 https 地址', m.RELEASE_PAGE_URL);
  assert(m.RELEASE_PAGE_URL.includes(m.REPO_OWNER + '/' + m.REPO_NAME),
    '发布页指向本仓库');
  assert(m.API_URL.startsWith('https://api.github.com/'), 'API 是 https', m.API_URL);
  // 整个模块源码里不许出现读取 html_url 的写法。这条防的是将来有人
  // "顺手用响应里的地址更准" —— 那一步就把 openExternal 的参数交给了外部内容。
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'lib', 'update-check.js'), 'utf8'
  ).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert(!/\.html_url/.test(src), '源码里不读响应的 html_url（剥注释后匹配）');
  assert(!/\.assets\b/.test(src), '源码里不读响应的 assets（不自动下载）');
  // release 的 body 是发布说明（Markdown，完全由发布者控制）。不读它：
  // 一旦读进来就得考虑往哪显示，而任何显示路径都是把外部富文本引进界面。
  //
  // 这条**不能**用源码 grep：模块里合法地存在 res.body（transport 拿回来的 HTTP
  // 响应体，就是那段要解析的 JSON 文本），/\.body\b/ 会命中它，于是断言对着真实
  // 实现变红——而它想查的是 raw.body（release 的发布说明字段），两者同名不同物。
  // 改成行为断言：喂一个带 body 的响应，看解析结果里有没有它。这比 grep 更强，
  // 因为换个写法（raw['body']、解构）也照样测得到。
  const withNotes = m.parseRelease(JSON.stringify({
    tag_name: 'v1.5.0',
    body: '## 更新说明\n<script>alert(1)</script>'
  }));
  assert(!JSON.stringify(withNotes).includes('alert(1)')
    && !JSON.stringify(withNotes).includes('更新说明'),
  '解析结果里不含 release 的发布说明（不把外部 Markdown 引进界面）',
  JSON.stringify(withNotes));
});

// ---------------------------------------------------------------------------
defineSection('取数失败一律不抛', async (m, assert) => {
  // 每一种失败都要走到"返回 error、不抛"。抛出去就是后台定时器里
  // 一个没人接的 rejection。
  const cases = [
    [{ ok: false, error: 'timeout' }, 'timeout', '超时'],
    [{ ok: false, error: 'network:ENOTFOUND' }, 'network:ENOTFOUND', '域名解析失败'],
    [{ ok: false, error: 'http:403' }, 'http:403', '被限流'],
    [{ ok: false, error: 'http:500' }, 'http:500', '服务端错误'],
    [{ ok: false, error: 'redirect:302' }, 'redirect:302', '重定向'],
    [{ ok: false, error: 'too-large' }, 'too-large', '响应过大'],
    [null, 'unknown', 'transport 返回空']
  ];
  for (const [res, wantErr, label] of cases) {
    const r = await m.fetchLatest({ transport: async () => res });
    assert(r.version === null && r.error === wantErr, label + '时返回 error 而不抛', r.error);
  }
  // transport 自己抛异常也要接住
  const r = await m.fetchLatest({ transport: async () => { throw new Error('boom'); } });
  assert(r.version === null && /^transport:/.test(r.error),
    'transport 抛异常也不往外抛', r.error);

  const ok = await m.fetchLatest({
    transport: async () => ({ ok: true, body: JSON.stringify({ tag_name: 'v9.9.9' }) })
  });
  assert(ok.version === '9.9.9' && ok.error === null, '正常情况能拿到版本号', ok.version);
});

// ---------------------------------------------------------------------------
defineSection('请求参数带上了约束', async (m, assert) => {
  let seen = null;
  await m.fetchLatest({ transport: async (o) => { seen = o; return { ok: true, body: '{}' }; } });
  assert(seen.url === m.API_URL, '默认打 releases/latest', seen.url);
  assert(seen.timeoutMs === m.TIMEOUT_MS && seen.timeoutMs > 0, '带超时', seen.timeoutMs);
  assert(seen.maxBytes === m.MAX_BYTES && seen.maxBytes > 0, '带字节上限', seen.maxBytes);
  assert(typeof seen.userAgent === 'string' && seen.userAgent.length > 0,
    '带 User-Agent（GitHub 不带会 403）', seen.userAgent);
  // 请求里不许带本机标识
  const blob = JSON.stringify(seen);
  assert(!/\b(?:hostname|username|userName|machineId|uuid)\b/i.test(blob),
    '请求参数里没有本机标识字段', blob);
  assert(!blob.includes(require('os').hostname()), '请求参数里没有机器名');
  assert(m.TIMEOUT_MS <= 30000, '超时不超过 30 秒', m.TIMEOUT_MS);
  assert(m.CHECK_INTERVAL_MS >= 60 * 60 * 1000,
    '检查间隔至少一小时（匿名 API 每小时 60 次，别把用户的额度打光）', m.CHECK_INTERVAL_MS);
});

// ---------------------------------------------------------------------------
// 真实 transport 的行为：不跟重定向、超时会中止请求。
// 用本地 http 服务器测不了 https.get，所以这里只测那些不需要真连接的性质，
// 真连接的部分由上面的注入式 transport 覆盖。
defineSection('真实 transport 的形状', (m, assert) => {
  assert(typeof m.httpsTransport === 'function', '默认 transport 是可替换的函数');
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'lib', 'update-check.js'), 'utf8'
  ).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  // 这三条是"出网约束"在源码层面的守卫。剥注释后匹配——文件头那段解释里
  // 就原样写着这些词，直接全文匹配会命中自己的说明文字（本仓库踩过这个坑）。
  assert(/status >= 300 && status < 400/.test(src), '真实 transport 显式处理 3xx（不跟重定向）');
  assert(/redirect:/.test(src), '重定向被记成 redirect: 错误');
  assert(/size > maxBytes/.test(src), '真实 transport 有字节上限判断');
  assert(/req\.on\('timeout'/.test(src) && /req\.destroy\(\)/.test(src),
    'timeout 时显式 destroy（timeout 事件本身不会中止请求）');
  assert(!/followRedirect|maxRedirects\s*:\s*[1-9]/.test(src), '没有开启跟随重定向的选项');
});

// ---------------------------------------------------------------------------
// 反向对照桩一：版本比较写成字符串比较（很容易顺手写成这样，而且大多数用例都对）
function makeStringCompareStub() {
  const stub = { ...upd };
  stub.compareVersions = (a, b) => {
    const va = upd.parseVersion(a);
    const vb = upd.parseVersion(b);
    if (!va || !vb) return null;
    if (va.normalized === vb.normalized) return 0;
    return va.normalized > vb.normalized ? 1 : -1;   // ← 字典序
  };
  stub.evaluate = (o) => {
    const cmp = stub.compareVersions(o.latest, o.current);
    if (cmp == null) return { updateAvailable: false, version: null, reason: 'unparsable' };
    if (cmp <= 0) return { updateAvailable: false, version: null, reason: cmp === 0 ? 'same' : 'older' };
    const latest = upd.parseVersion(o.latest).normalized;
    const skip = upd.parseVersion(o.skipVersion);
    if (skip && skip.normalized === latest) return { updateAvailable: false, version: latest, reason: 'skipped' };
    return { updateAvailable: true, version: latest, reason: 'newer' };
  };
  return stub;
}

// 反向对照桩二：发布页地址取响应里的 html_url，且忽略 draft/prerelease。
// 这是"看起来更准、实际把 openExternal 的参数交给外部内容"的那个改动。
function makeTrustResponseStub() {
  const stub = { ...upd };
  stub.parseRelease = (body) => {
    let raw;
    try { raw = typeof body === 'string' ? JSON.parse(body) : body; } catch { return { version: null, error: 'bad-json' }; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: null, error: 'bad-shape' };
    const v = upd.parseVersion(raw.tag_name);
    if (!v) return { version: null, error: 'bad-version' };
    return { version: v.normalized, error: null, html_url: raw.html_url || null };
  };
  return stub;
}

// 反向对照桩三：不做时间间隔判断、自检也出网、开发模式也出网
function makeAlwaysCheckStub() {
  const stub = { ...upd };
  stub.shouldCheck = () => ({ check: true, reason: 'always' });
  return stub;
}

(async () => {
  console.log('[test:update] lib/update-check.js（裸 node，不出网）\n');
  for (const s of sections) {
    section(s.name);
    await s.fn(upd, assert);
  }

  const realFailures = failures.slice();

  // ---- 反向对照 ----
  // 必须 await 每个 section：这里有两个 async section（取数失败一律不抛、
  // 请求参数带上了约束），不 await 的话它们的断言会在 runControl 返回之后才落进
  // 篮子，控制组统计到的是 0 项，看起来像"这些断言分辨不出改动"。
  const runControl = async (label, stub) => {
    const localFail = [];
    const collect = (cond, msg, extra) => {
      if (!cond) localFail.push(msg + (extra === undefined ? '' : '：' + extra));
    };
    const bySection = [];
    for (const s of sections) {
      const n = localFail.length;
      await s.fn(stub, collect);
      if (localFail.length > n) bySection.push(s.name + '：' + localFail.slice(n).join(' / '));
    }
    console.log('[test:update] 反向对照（' + label + '）失败 ' + localFail.length + ' 项');
    for (const line of bySection) console.log('  控制组失败 → ' + line);
    return { count: localFail.length, sections: bySection };
  };

  const c1 = await runControl('版本比较写成字典序', makeStringCompareStub());
  const c2 = await runControl('发布页地址取响应里的 html_url', makeTrustResponseStub());
  const c3 = await runControl('不做任何检查前置判断', makeAlwaysCheckStub());

  // 每个桩都必须让**特定**断言变红，光"有失败"不够——那可能是别的断言在响应
  const need = [
    [c1, /1\.10\.0 比 1\.9\.0 新/, '字典序桩必须让「1.10.0 比 1.9.0 新」变红'],
    [c1, /1\.4\.10 比 1\.4\.9 新/, '字典序桩必须让「1.4.10 比 1.4.9 新」变红'],
    [c2, /没有任何来自响应的 URL|html_url 完全没被带出来/, 'html_url 桩必须让「发布页不来自响应」变红'],
    [c2, /草稿版当没有新版本/, 'html_url 桩必须让「草稿版不提示」变红'],
    [c3, /开发模式不查/, '无判断桩必须让「开发模式不查」变红'],
    [c3, /自检进程不出网/, '无判断桩必须让「自检不出网」变红'],
    [c3, /一小时前查过就不再查/, '无判断桩必须让「时间间隔」变红']
  ];
  let controlOk = true;
  for (const [c, re, msg] of need) {
    const hit = c.sections.some(s => re.test(s));
    if (!hit) { console.error('[test:update] FAIL ' + msg + '（这批断言分辨不出该改动，测试无效）'); controlOk = false; }
  }
  if (c1.count === 0 || c2.count === 0 || c3.count === 0) {
    console.error('[test:update] FAIL 有控制组全绿：空断言');
    controlOk = false;
  }

  console.log('');
  if (realFailures.length === 0 && controlOk) {
    console.log('[test:update] 通过（真实实现失败 0 项，控制组失败 '
      + c1.count + '/' + c2.count + '/' + c3.count + ' 项）');
    process.exit(0);
  }
  for (const f of realFailures) console.error('[test:update] FAIL ' + f);
  console.error('[test:update] 失败 ' + realFailures.length + ' 项，通过 ' + pass + ' 项');
  process.exit(1);
})().catch(e => {
  console.error('[test:update] 测试自身抛异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
