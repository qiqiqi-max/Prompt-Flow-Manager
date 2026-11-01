// 批量打标签：只改 frontmatter 里顶层的 tags 字段，其余每一行原样保留。
//
// 为什么不用 FRONTMATTER.parse + stringify 整体重写：parse 是逐行 key: value 的
// 简化解析，认不得多行结构。工作流的 flow 数组、多行写法的 tags 列表在它眼里
// 要么被跳过、要么变成空串，再 stringify 回去就把这些字段整个抹掉了（CLAUDE.md
// 「不要改写用户 frontmatter 的结构字段」）。所以这里照 bumpAutoFields 的路子做
// 文本级替换：找到 tags 那一段，只换那一段。
//
// 认得的写法：
//   tags: [a, "b"]          行内数组（JSON 或逗号分隔，解析规则与 FRONTMATTER.parse 一致）
//   tags:                   多行列表，"- 值" 可以缩进也可以顶格
//     - a
//   tags: a                 单个标量（当成一项）
//   tags: / tags: []        空
//   （没有 tags 行）        添加时在 frontmatter 末尾补一行
//   （没有 frontmatter）    添加时在文件开头补一个只含 tags 的块
// 认不得的写法（锚点/别名/块标量/多行行内数组/带注释等）一律抛 E_TAGS_FORMAT，
// 不猜：猜错的代价是把用户的 frontmatter 改坏，而且没有任何报错。
//
// 写回格式：行内和标量都写成 JSON 引号的行内数组（和 FRONTMATTER.stringify 一致，
// 防止标签里的冒号、方括号改写其他字段）；多行列表保留多行，没动的项一字不改，
// 新项沿用第一项的缩进。

function appError(code, detail) {
  return new Error(detail == null || detail === '' ? code : code + '|' + detail);
}

// 与 FRONTMATTER.parse 同一个切分正则：两边对"哪一段是 frontmatter"的判断必须一致，
// 否则这里改的段落和界面上显示的段落不是同一段。
const FM_RE = /^---(\r?\n)([\s\S]*?)(\r?\n)---(\r?\n?)/;

// 标签本身的约束。换行会让下一行变成新的 key；控制字符写进 YAML 没有意义。
const MAX_TAG_LEN = 64;
const MAX_TAGS = 50;

function normalizeTagList(list) {
  if (!Array.isArray(list)) throw appError('E_TAGS_INVALID', typeof list);
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw appError('E_TAGS_INVALID', typeof raw);
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LEN || /[\u0000-\u001f\u007f]/.test(tag)) throw appError('E_TAGS_INVALID', tag.slice(0, MAX_TAG_LEN));
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS) throw appError('E_TAGS_INVALID', String(out.length));
  return out;
}

// 单个值的解引号，规则与 FRONTMATTER.parse 对标量的处理一致。
function unquoteScalar(v) {
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try { return String(JSON.parse(v)); } catch { return v.slice(1, -1); }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

// YAML 里这些开头意味着结构（映射、锚点、别名、块标量、标签、注释…），不是普通标量。
const UNSUPPORTED_SCALAR = /^[{&*!|>%@`#]/;

function parseInline(value) {
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw appError('E_TAGS_FORMAT', value.slice(0, 40));
    let parsed = null;
    try { parsed = JSON.parse(value); } catch { parsed = null; }
    if (Array.isArray(parsed)) {
      if (parsed.some(x => x !== null && typeof x === 'object')) throw appError('E_TAGS_FORMAT', value.slice(0, 40));
      return parsed.map(String);
    }
    const inner = value.slice(1, -1);
    if (/[[\]{}]/.test(inner)) throw appError('E_TAGS_FORMAT', value.slice(0, 40));
    return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  if (UNSUPPORTED_SCALAR.test(value) || /\s#/.test(value)) throw appError('E_TAGS_FORMAT', value.slice(0, 40));
  // YAML 的空值写法：tags: ~ / tags: null 都是"没有标签"。
  if (value === '~' || value === 'null') return [];
  const v = unquoteScalar(value);
  return v ? [v] : [];
}

// 把 yaml 段拆成 [{ text, eol }]，eol 是这一行后面原来的换行符（最后一行为空串）。
// 换行符逐行记下来，而不是统一 split 再用一种换行 join：混用 CRLF/LF 的文件
// 改完之后，没动过的行连换行符都不该变。
function splitLines(yaml) {
  const lines = [];
  const re = /\r?\n/g;
  let last = 0;
  let m;
  while ((m = re.exec(yaml))) {
    lines.push({ text: yaml.slice(last, m.index), eol: m[0] });
    last = m.index + m[0].length;
  }
  lines.push({ text: yaml.slice(last), eol: '' });
  return lines;
}
function joinLines(lines) {
  return lines.map(l => l.text + l.eol).join('');
}

const TAGS_LINE_RE = /^tags(\s*):(.*)$/;
const ITEM_RE = /^(\s*)-(\s+)(.*)$/;

// 找出 tags 字段。返回 null 表示没有这个字段。
//   { start, end, kind: 'inline'|'block', items, key, itemLines }
// end 是最后一行（含）的下标；block 时 itemLines 是每一项对应的行下标。
function locateTags(lines) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (TAGS_LINE_RE.test(lines[i].text)) hits.push(i);
  if (!hits.length) return null;
  // 两个顶层 tags 键：哪一个算数取决于解析器，改哪一个都可能改错。
  if (hits.length > 1) throw appError('E_TAGS_FORMAT', 'duplicate tags');
  const start = hits[0];
  const m = lines[start].text.match(TAGS_LINE_RE);
  const key = 'tags' + m[1] + ':';
  const value = m[2].trim();
  if (value) {
    return { start, end: start, kind: 'inline', items: parseInline(value), key, itemLines: [] };
  }
  // 值为空：后面紧跟的 "- x" 行是多行列表（缩进或顶格都算）。
  const items = [];
  const itemLines = [];
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const text = lines[i].text;
    const im = text.match(ITEM_RE);
    if (im) {
      const raw = im[3].trim();
      // 嵌套结构、带注释、空项都不是"一个标签"，不猜。
      if (!raw || raw.startsWith('[') || raw.startsWith('-') || /\s#/.test(raw) || UNSUPPORTED_SCALAR.test(raw)
        || (/^[^"']*:(\s|$)/.test(raw))) {
        throw appError('E_TAGS_FORMAT', raw.slice(0, 40));
      }
      items.push(unquoteScalar(raw));
      itemLines.push(i);
      end = i;
      continue;
    }
    // 列表之后还有缩进行（比如某一项是多行的映射）：结构超出了"字符串列表"。
    if (/^\s+\S/.test(text) && items.length) throw appError('E_TAGS_FORMAT', text.trim().slice(0, 40));
    break;
  }
  // tags: 下面直接是缩进的非列表行（映射等），同样不认。
  if (!items.length && start + 1 < lines.length && /^\s+\S/.test(lines[start + 1].text)) {
    throw appError('E_TAGS_FORMAT', lines[start + 1].text.trim().slice(0, 40));
  }
  return { start, end, kind: 'block', items, key, itemLines };
}

function encodeInline(list) {
  return '[' + list.map(t => JSON.stringify(t)).join(', ') + ']';
}

// 只读：给出文件当前的标签（与改写时认的是同一套规则）。
function readTags(content) {
  const text = String(content == null ? '' : content);
  const m = text.match(FM_RE);
  if (!m) return [];
  const loc = locateTags(splitLines(m[2]));
  return loc ? loc.items.slice() : [];
}

// 返回 { content, changed, before, after }。changed 为 false 时 content 就是原文。
function rewriteTags(content, opts) {
  const text = String(content == null ? '' : content);
  const add = normalizeTagList((opts && opts.add) || []);
  const remove = normalizeTagList((opts && opts.remove) || []);
  const m = text.match(FM_RE);

  if (!m) {
    if (!add.length) return { content: text, changed: false, before: [], after: [] };
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    return { content: '---' + eol + 'tags: ' + encodeInline(add) + eol + '---' + eol + text, changed: true, before: [], after: add };
  }

  const [whole, headEol, yaml, closeEol, tailEol] = m;
  const lines = splitLines(yaml);
  const loc = locateTags(lines);
  const before = loc ? loc.items : [];
  const kept = before.filter(t => !remove.includes(t));
  const added = add.filter(t => !kept.includes(t));
  const after = kept.concat(added);
  const same = after.length === before.length && after.every((t, i) => t === before[i]);
  if (same) return { content: text, changed: false, before, after };

  let next;
  if (!loc) {
    // 补一行在 yaml 段末尾。最后一行可能是空行（"---\n\n---"），补在它前面
    // 和补在后面效果相同，这里直接追加，换行符沿用开头那一行的。
    next = lines.concat([]);
    next[next.length - 1] = { text: next[next.length - 1].text, eol: headEol };
    next.push({ text: 'tags: ' + encodeInline(after), eol: '' });
    // 原先 yaml 段只有一行空串（frontmatter 是空的）时，上面会留下一行空行，去掉它。
    if (next.length === 2 && next[0].text === '') next.shift();
  } else if (loc.kind === 'inline' || !after.length || !loc.itemLines.length) {
    // 行内 / 标量 / 空：整段换成一行行内数组。多行列表被删空时也走这里，
    // 写成 tags: []，而不是留一个下面没有任何项的 "tags:"（解析出来是空串不是数组）。
    const replaced = { text: loc.key + ' ' + encodeInline(after), eol: lines[loc.end].eol };
    next = lines.slice(0, loc.start).concat([replaced], lines.slice(loc.end + 1));
  } else {
    // 多行列表：保留的项原样留着，删掉的项连同所在行一起拿掉，新项追加在最后一项后面。
    const firstItem = lines[loc.itemLines[0]].text.match(ITEM_RE);
    const indent = firstItem[1];
    const gap = firstItem[2];
    const removedLines = new Set(loc.itemLines.filter((ln, i) => remove.includes(loc.items[i])));
    const block = [];
    for (let i = loc.start + 1; i <= loc.end; i++) if (!removedLines.has(i)) block.push({ ...lines[i] });
    const eol = lines[loc.start].eol || headEol;
    for (const t of added) block.push({ text: indent + '-' + gap + JSON.stringify(t), eol });
    // 段内最后一行的换行符要还给原来块末那一行的位置（可能是 yaml 段的最后一行，eol 为空）。
    const tailLineEol = lines[loc.end].eol;
    for (let i = 0; i < block.length - 1; i++) if (!block[i].eol) block[i].eol = eol;
    block[block.length - 1].eol = tailLineEol;
    next = lines.slice(0, loc.start + 1).concat(block, lines.slice(loc.end + 1));
    if (!next[loc.start].eol) next[loc.start] = { ...next[loc.start], eol };
  }

  const newYaml = joinLines(next);
  const out = '---' + headEol + newYaml + closeEol + '---' + tailEol + text.slice(whole.length);
  // 写完立刻按同一套规则读回来比对。生成了一个自己都读不对的 frontmatter 时，
  // 宁可这一项失败，也不能把它写进用户的文件。
  const check = readTags(out);
  if (check.length !== after.length || !check.every((t, i) => t === after[i])) {
    throw appError('E_TAGS_FORMAT', 'verify');
  }
  return { content: out, changed: true, before, after };
}

module.exports = { rewriteTags, readTags, normalizeTagList, MAX_TAG_LEN, MAX_TAGS };
