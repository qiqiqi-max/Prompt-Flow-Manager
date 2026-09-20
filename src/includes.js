// 模板包含引擎：用于项目脚手架与提示词片段的组合式拼装。
// 渲染进程与测试共用这一份实现。
//
// 语法：{{include: 相对路径.md}}
// 示例：{{include: prompts/snippets/architect.md}}
//
// 核心规则：
//   1. 围栏代码块（``` / ~~~）和行内代码（`...`）内的 {{include:...}} 一律放过（当作示例文本）；
//   2. 自动剥离被包含文件的 YAML Frontmatter，只内嵌 Markdown 正文；
//   3. 循环依赖保护：记录调用链上的 visited 集合，同一分支检测到环直接抛出并安全回落；
//   4. 嵌套深度上限：最大 5 层递归，防止异常深度的包含；
//   5. 路径越权拦截：禁止 ../ 跨根逃逸，保证所有包含局限在项目安全数据目录内。

const INCLUDES = (function () {
  const MASK = '\u0000';
  const FENCE = /^ {0,3}(`{3,}|~{3,})/;
  const INCLUDE_RE = /\{\{include:\s*([^{}\r\n]+?)\s*\}\}/g;
  const MAX_DEPTH = 5;

  function lineSpans(s) {
    const spans = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\n') { spans.push([start, i]); start = i + 1; }
    }
    spans.push([start, s.length]);
    return spans;
  }

  function maskCodeSpans(line, base, blank) {
    const runs = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '`') continue;
      let j = i;
      while (j < line.length && line[j] === '`') j++;
      runs.push([i, j - i]);
      i = j - 1;
    }
    for (let a = 0; a < runs.length; a++) {
      const open = runs[a];
      for (let b = a + 1; b < runs.length; b++) {
        if (runs[b][1] !== open[1]) continue;
        blank(base + open[0], base + runs[b][0] + runs[b][1]);
        a = b;
        break;
      }
    }
  }

  // 逐行跑围栏状态机 + 行内代码配对，屏蔽代码块内的包含语法
  function maskInert(s) {
    const buf = s.split('');
    const blank = (from, to) => {
      for (let k = from; k < to; k++) {
        if (buf[k] !== '\n' && buf[k] !== '\r') buf[k] = MASK;
      }
    };
    let fence = null;
    for (const span of lineSpans(s)) {
      const line = s.slice(span[0], span[1]);
      const m = line.match(FENCE);
      if (fence) {
        blank(span[0], span[1]);
        if (m && m[1][0] === fence.char && m[1].length >= fence.len) fence = null;
        continue;
      }
      if (m) {
        blank(span[0], span[1]);
        fence = { char: m[1][0], len: m[1].length };
        continue;
      }
      maskCodeSpans(line, span[0], blank);
    }
    return buf.join('');
  }

  function stripFrontmatter(text) {
    const s = String(text == null ? '' : text);
    const m = s.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    return m ? m[1] : s;
  }

  function normalizePath(rawRel) {
    if (!rawRel || typeof rawRel !== 'string') return null;
    const rel = rawRel.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    // 禁止包含连续两点路径跨根逃逸
    if (rel.split('/').includes('..')) return null;
    return rel;
  }

  // 提取文本中所有处于非代码区的有效包含标签
  function extract(text) {
    const s = String(text == null ? '' : text);
    if (!s.includes('{{include:')) return [];
    const masked = maskInert(s);
    const results = [];
    let m;
    INCLUDE_RE.lastIndex = 0;
    while ((m = INCLUDE_RE.exec(masked)) !== null) {
      const raw = s.slice(m.index, m.index + m[0].length);
      const rel = normalizePath(m[1]);
      results.push({
        raw,
        rel,
        valid: Boolean(rel),
        index: m.index,
        length: m[0].length
      });
    }
    return results;
  }

  function hasInclude(text) {
    return extract(text).length > 0;
  }

  // 同步解析（适用于测试和内存中已有文件映射的场景）
  function resolveSync(text, resolver, visited = new Set(), depth = 0) {
    const s = String(text == null ? '' : text);
    if (depth >= MAX_DEPTH || !hasInclude(s)) return s;

    const items = extract(s);
    if (!items.length) return s;

    let out = '';
    let lastIdx = 0;
    for (const it of items) {
      out += s.slice(lastIdx, it.index);
      lastIdx = it.index + it.length;

      if (!it.valid) {
        out += `<!-- [include error: invalid path "${it.raw}"] -->`;
        continue;
      }
      if (visited.has(it.rel)) {
        out += `<!-- [include error: circular dependency "${it.rel}"] -->`;
        continue;
      }

      let content = null;
      try {
        content = resolver(it.rel);
      } catch {
        content = null;
      }

      if (content == null) {
        out += `<!-- [include error: file not found "${it.rel}"] -->`;
        continue;
      }

      const body = stripFrontmatter(content);
      const nextVisited = new Set(visited);
      nextVisited.add(it.rel);
      out += resolveSync(body, resolver, nextVisited, depth + 1);
    }
    out += s.slice(lastIdx);
    return out;
  }

  // 异步解析（适用于通过 IPC 或异步文件读取加载片段的场景）
  async function resolveAsync(text, asyncResolver, visited = new Set(), depth = 0) {
    const s = String(text == null ? '' : text);
    if (depth >= MAX_DEPTH || !hasInclude(s)) return s;

    const items = extract(s);
    if (!items.length) return s;

    let out = '';
    let lastIdx = 0;
    for (const it of items) {
      out += s.slice(lastIdx, it.index);
      lastIdx = it.index + it.length;

      if (!it.valid) {
        out += `<!-- [include error: invalid path "${it.raw}"] -->`;
        continue;
      }
      if (visited.has(it.rel)) {
        out += `<!-- [include error: circular dependency "${it.rel}"] -->`;
        continue;
      }

      let content = null;
      try {
        content = await asyncResolver(it.rel);
      } catch {
        content = null;
      }

      if (content == null) {
        out += `<!-- [include error: file not found "${it.rel}"] -->`;
        continue;
      }

      const body = stripFrontmatter(content);
      const nextVisited = new Set(visited);
      nextVisited.add(it.rel);
      out += await resolveAsync(body, asyncResolver, nextVisited, depth + 1);
    }
    out += s.slice(lastIdx);
    return out;
  }

  return {
    extract,
    hasInclude,
    resolveSync,
    resolveAsync,
    stripFrontmatter,
    normalizePath,
    MAX_DEPTH
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = INCLUDES;
