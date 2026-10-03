// 只解析和改写工作流 frontmatter 中 flow[].prompt 的路径，避免误改正文和其他字段。
const WORKFLOW_REFS = {
  split(content) {
    const text = String(content == null ? '' : content);
    const m = text.match(/^---(\r?\n)([\s\S]*?)\r?\n---(\r?\n?)/);
    if (!m) return null;
    return { eol: m[1], yaml: m[2], head: '---' + m[1], tail: m[0].slice(('---' + m[1] + m[2]).length), body: text.slice(m[0].length) };
  },

  unquote(value) {
    const v = String(value || '').trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      try { return JSON.parse(v); } catch { return v.slice(1, -1); }
    }
    if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
    return v;
  },

  encode(value) {
    const v = String(value);
    return /^[A-Za-z0-9_./\-\u0080-\uffff]+$/.test(v) ? v : JSON.stringify(v);
  },

  mapPromptLines(content, fn) {
    const parts = this.split(content);
    if (!parts) return { content: String(content == null ? '' : content), count: 0 };
    let inFlow = false;
    let count = 0;
    const lines = parts.yaml.split(/\r?\n/).map((line) => {
      if (/^\S/.test(line)) inFlow = /^flow:\s*$/.test(line);
      if (!inFlow) return line;
      const m = line.match(/^(\s*(?:-\s*)?prompt:\s*)(.*?)(\s*)$/);
      if (!m) return line;
      const next = fn(this.unquote(m[2]));
      if (next == null) return line;
      count++;
      return m[1] + this.encode(next) + m[3];
    });
    return { content: parts.head + lines.join(parts.eol) + parts.tail + parts.body, count };
  },

  hasPromptRef(content, rel) {
    return this.mapPromptLines(content, value => (value === rel ? value : null)).count > 0;
  },

  replacePromptRefs(content, oldRel, newRel) {
    return this.mapPromptLines(content, value => (value === oldRel ? newRel : null));
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = WORKFLOW_REFS;
