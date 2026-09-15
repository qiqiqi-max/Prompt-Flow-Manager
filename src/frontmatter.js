// frontmatter 解析：主进程与渲染进程共用这一份。
//
// 为什么要抽出来：这段解析原先在 electron-main.js 和 src/renderer.js 里各有一份
// 逐字复制的实现。两边都要解析同一批文件，而"主进程存进 meta 的值"和"渲染进程
// 显示/编辑的值"必须完全一致——一旦其中一份被改（加个字段、调一下类型推断），
// 另一份不会跟着改，症状是保存后界面显示的值和磁盘里的不一样，而且没有任何报错。
//
// 加载方式和 src/i18n.js 一样：浏览器里靠 <script> 声明全局，
// 主进程里靠结尾的 module.exports 直接 require。渲染进程禁用了 require，
// 所以不能用 CommonJS 单一入口。
const FRONTMATTER = {
  // 返回 { meta, body }。没有 frontmatter 时 meta 为空对象、body 是原文。
  parse(content) {
    const m = String(content == null ? '' : content)
      .match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { meta: {}, body: content == null ? '' : content };
    const yaml = m[1];
    const body = m[2];
    const meta = {};
    for (const line of yaml.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if (val.startsWith('[') && val.endsWith(']')) {
        val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      } else if (val === 'true') {
        val = true;
      } else if (val === 'false') {
        val = false;
      } else if (/^-?\d+$/.test(val)) {
        val = parseInt(val, 10);
      } else {
        val = val.replace(/^["']|["']$/g, '');
      }
      meta[key] = val;
    }
    return { meta, body };
  },

  // 只要正文。和 parse().body 的区别：这里不解析 yaml，搜索路径上对全库调用，
  // 省掉逐行分割的开销。
  strip(content) {
    const s = String(content == null ? '' : content);
    const m = s.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    return m ? m[1] : s;
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = FRONTMATTER;
