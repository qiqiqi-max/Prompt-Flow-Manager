// lib/update-check.js
// 「有没有新版本」的判定与取数。
//
// 这是本项目**第一个出网请求**。在此之前唯一的出网路径是 shell.openExternal，
// 全靠用户点击触发；也就是说在这个文件之前，应用自己从不主动连任何东西。
// 所以这里的每一条约束都不是防御性编程的习惯，而是为了让"多出来的这条网络路径"
// 不成为新的攻击面和新的隐私问题：
//
//   1. **发布页地址由本地常量拼出来，绝不用响应里的 html_url。**
//      响应是外部内容（GitHub 被打穿、企业内网做了 TLS 中间人、DNS 被投毒，
//      都会让它变成攻击者可控）。而这个地址最终要交给 shell.openExternal，
//      也就是"用应用的身份去打开一个由响应决定的东西"。响应里唯一被采纳的
//      是版本号，而且要过 VERSION_RE。
//   2. **不跟重定向。** 跟随重定向等于让响应决定下一个连谁，是 SSRF 的形状。
//      正常的 releases/latest 不重定向，遇到就当失败。
//   3. **响应体有字节上限。** 对端可以无限流，没有上限就是内存耗尽。
//   4. **失败一律静默。** 网络不通、GitHub 挂了、限流、公司防火墙拦了——
//      这些都不是用户的问题，不该弹任何东西，只记一行日志。
//   5. **不自动下载、不自动安装。** 判定结果只用来显示一句话和一个外链。
//      自动下载意味着要校验签名、要处理半个文件、要决定装在哪，
//      每一条都是新的故障来源，而收益只是省用户一次点击。
//   6. **请求里不带本机标识。** 只有一个固定的 User-Agent（GitHub 要求带），
//      内容是应用名 + 版本号。没有机器名、没有用户名、没有 OS 版本、没有任何 UUID。
//      版本号本身无法避免——"我是不是旧版"这个问题不带版本号就问不出来。
//
// 这个文件刻意不 require('electron')：判定逻辑是纯函数，取数的 transport 可注入，
// 所以整套能用裸 node 单测（同 lib/logger.js、lib/sandbox-state.js 的理由）。
const https = require('https');

// 发布页和 API 都从这两个常量拼。改仓库地址只改这里。
const REPO_OWNER = 'qiqiqi-max';
const REPO_NAME = 'Prompt-Flow-Manager';
const API_URL = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases/latest';
// 交给 shell.openExternal 的就是这个常量。它不参与任何字符串拼接，
// 也不受响应内容影响——这是第 1 条约束的落点。
const RELEASE_PAGE_URL = 'https://github.com/' + REPO_OWNER + '/' + REPO_NAME + '/releases/latest';

// 多久查一次。每次启动都查对 GitHub 不礼貌（匿名 API 每小时 60 次），
// 对用户也没意义——发版频率远低于启动频率。
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// 请求超时。启动后台任务不该无限期挂着一个 socket。
const TIMEOUT_MS = 8000;

// 响应体上限。releases/latest 正常是几 KB，给到 256 KiB 已经很宽。
const MAX_BYTES = 256 * 1024;

// 版本号白名单。响应里唯一被采纳的字段要过这条：
// 只允许 x.y.z 和可选的预发布后缀，前面允许一个 v。
// 这条正则同时挡住了"把版本号当文本塞进界面"的注入——里面不可能有 < > & 引号。
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseVersion(raw) {
  const m = VERSION_RE.exec(String(raw == null ? '' : raw).trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || null,
    // 归一化后的显示形式：去掉前导 v，界面和配置里统一用这个
    normalized: m[1] + '.' + m[2] + '.' + m[3] + (m[4] ? '-' + m[4] : '')
  };
}

// 比较两个版本号。a > b 返回 1，a < b 返回 -1，相等返回 0；任一侧解析不出来返回 null。
//
// 预发布版排在同号正式版**之前**（1.5.0-beta.1 < 1.5.0），这是 semver 的规矩。
// 不按这个来的话，装着 1.5.0 正式版的用户会被反复提示"有新版本 1.5.0-beta.1"。
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1;
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1;
  if (va.patch !== vb.patch) return va.patch > vb.patch ? 1 : -1;
  if (va.pre && !vb.pre) return -1;   // 预发布 < 正式
  if (!va.pre && vb.pre) return 1;
  if (!va.pre && !vb.pre) return 0;
  if (va.pre === vb.pre) return 0;
  return comparePre(va.pre, vb.pre);
}

// 预发布标识按 semver 逐段比：纯数字段按数值，其余按字典序，数字段小于非数字段，
// 段数少的在前。beta.2 < beta.10 靠的就是"纯数字按数值"这一条。
function comparePre(a, b) {
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (as[i] === undefined) return -1;
    if (bs[i] === undefined) return 1;
    if (as[i] === bs[i]) continue;
    const an = /^\d+$/.test(as[i]);
    const bn = /^\d+$/.test(bs[i]);
    if (an && bn) return Number(as[i]) > Number(bs[i]) ? 1 : -1;
    if (an) return -1;
    if (bn) return 1;
    return as[i] > bs[i] ? 1 : -1;
  }
  return 0;
}

// 从 releases/latest 的响应里挑出版本号。
//
// 只取 tag_name，其余字段一概不用——尤其**不取 html_url**（见文件头第 1 条）。
// draft / prerelease 理论上不会出现在 latest 里，但这是外部内容，
// 按"响应可能是任何东西"处理：出现就当没有新版本。
function parseRelease(body) {
  let raw;
  try {
    raw = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return { version: null, error: 'bad-json' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: null, error: 'bad-shape' };
  if (raw.draft === true) return { version: null, error: 'draft' };
  if (raw.prerelease === true) return { version: null, error: 'prerelease' };
  const v = parseVersion(raw.tag_name);
  if (!v) return { version: null, error: 'bad-version' };
  return { version: v.normalized, error: null };
}

// 这一次启动要不要去查。
//
// 返回 { check, reason }。reason 会进日志，是排障时唯一能看出"为什么没查"的地方。
//
// 优先级从上到下，第一条命中就返回：
//   env-off      PFM_UPDATE_CHECK=off|0，一律不查
//   env-forced-on PFM_UPDATE_CHECK=on|1，绕过下面所有条件（含时间间隔），给手动验证用
//   selftest     自检进程不许出网：会让测试依赖网络、变慢、偶发失败
//   dev          开发模式不查。跑一次 npm start 就打一次 GitHub 没有意义，
//                而且开发机上版本号本来就和 release 对不上
//   config-off   用户在设置里关掉了
//   too-soon     距上次检查不到 CHECK_INTERVAL_MS
function shouldCheck(opts) {
  const o = opts || {};
  const env = o.env || {};
  const config = o.config || {};
  const now = o.now == null ? Date.now() : o.now;

  const forced = String(env.PFM_UPDATE_CHECK || '').toLowerCase();
  if (forced === 'off' || forced === '0') return { check: false, reason: 'env-off' };
  if (forced === 'on' || forced === '1') return { check: true, reason: 'env-forced-on' };

  if (env.PFM_SELFTEST === '1' || env.PFM_SELFTEST_BENCH) return { check: false, reason: 'selftest' };
  if (!o.packaged) return { check: false, reason: 'dev' };
  if (config.updateCheck === false) return { check: false, reason: 'config-off' };

  const last = Date.parse(config.updateLastCheckedAt || '');
  // 时间戳解析不出来（首次运行、字段被写坏、用户改了系统时间往回调）就查一次。
  // 往回调时间会让 now - last 变成负数，那时也该查——否则一次改表能让检查永久停摆。
  if (Number.isFinite(last) && now - last >= 0 && now - last < CHECK_INTERVAL_MS) {
    return { check: false, reason: 'too-soon' };
  }
  return { check: true, reason: Number.isFinite(last) ? 'due' : 'first-run' };
}

// 拿到版本号之后判断要不要提示用户。
//
// 返回 { updateAvailable, version, reason }。
//   same / older   已经是最新（或本地更新，开发中会出现）
//   skipped        用户对这个版本点过"忽略"。注意只忽略**这一个**版本号，
//                  再有更新的版本照样提示——否则一次点击就等于永久关掉检查，
//                  而用户以为自己只是跳过了这一版
//   unparsable     两侧任一个版本号不合法
function evaluate(opts) {
  const o = opts || {};
  const cmp = compareVersions(o.latest, o.current);
  if (cmp == null) return { updateAvailable: false, version: null, reason: 'unparsable' };
  if (cmp <= 0) return { updateAvailable: false, version: null, reason: cmp === 0 ? 'same' : 'older' };
  const latest = parseVersion(o.latest).normalized;
  const skip = parseVersion(o.skipVersion);
  if (skip && skip.normalized === latest) {
    return { updateAvailable: false, version: latest, reason: 'skipped' };
  }
  return { updateAvailable: true, version: latest, reason: 'newer' };
}

// 默认 transport：https.get，带超时、字节上限、不跟重定向。
//
// 单独抽出来是为了让 fetchLatest 能在测试里换掉——否则这个模块的每条断言都要真的出网，
// 而"网络不通时会怎样"这类分支根本没法稳定构造。
function httpsTransport(opts) {
  const url = opts.url;
  const timeoutMs = opts.timeoutMs;
  const maxBytes = opts.maxBytes;
  const userAgent = opts.userAgent;
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let req;
    try {
      req = https.get(url, {
        headers: {
          // GitHub API 要求带 UA，不带会 403。内容见文件头第 6 条。
          'User-Agent': userAgent,
          'Accept': 'application/vnd.github+json',
          // 明确不接受压缩：省掉一层解压，也就省掉"解压炸弹"这类问题
          'Accept-Encoding': 'identity'
        },
        timeout: timeoutMs
      }, (res) => {
        const status = res.statusCode || 0;
        // 不跟重定向（文件头第 2 条）。3xx 直接当失败。
        if (status >= 300 && status < 400) {
          res.destroy();
          return done({ ok: false, error: 'redirect:' + status });
        }
        if (status !== 200) {
          res.destroy();
          return done({ ok: false, error: 'http:' + status });
        }
        let size = 0;
        const chunks = [];
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            // 超限就断连接，不要把已收到的部分交出去——半个 JSON 解析不了，
            // 而"继续收完再判断"正好是对端想要的
            res.destroy();
            return done({ ok: false, error: 'too-large' });
          }
          chunks.push(c);
        });
        res.on('end', () => done({ ok: true, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => done({ ok: false, error: 'stream:' + (e && e.message ? e.message : e) }));
      });
    } catch (e) {
      return done({ ok: false, error: 'request:' + (e && e.message ? e.message : e) });
    }
    // timeout 事件只是"socket 空闲够久了"，不会自己中止请求，必须显式 destroy。
    // 少了这句，超时后请求还挂着，进程退出时才收尾。
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => done({ ok: false, error: 'network:' + (e && e.message ? e.message : e) }));
  });
}

// 取一次最新版本号。**不抛异常**：返回 { version, error }，error 非空表示这次没拿到。
//
// 不抛是刻意的（文件头第 4 条）。调用点在启动后的后台定时器里，
// 抛出去就是一个没人接的 rejection，而这件事本来就允许失败。
async function fetchLatest(opts) {
  const o = opts || {};
  const transport = o.transport || httpsTransport;
  let res;
  try {
    res = await transport({
      url: o.url || API_URL,
      timeoutMs: o.timeoutMs == null ? TIMEOUT_MS : o.timeoutMs,
      maxBytes: o.maxBytes == null ? MAX_BYTES : o.maxBytes,
      userAgent: o.userAgent || 'Prompt-Flow-Manager'
    });
  } catch (e) {
    // transport 自己炸了也不该往外抛
    return { version: null, error: 'transport:' + (e && e.message ? e.message : e) };
  }
  if (!res || !res.ok) return { version: null, error: (res && res.error) || 'unknown' };
  return parseRelease(res.body);
}

module.exports = {
  compareVersions, parseVersion, parseRelease, shouldCheck, evaluate, fetchLatest,
  httpsTransport,
  REPO_OWNER, REPO_NAME, API_URL, RELEASE_PAGE_URL,
  CHECK_INTERVAL_MS, TIMEOUT_MS, MAX_BYTES, VERSION_RE
};
