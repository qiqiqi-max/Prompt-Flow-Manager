const PROJECT_CONTEXT = (function () {
  const dangerous = new Set(['__proto__', 'constructor', 'prototype']);
  const aliases = Object.assign(Object.create(null), {
    '项目名称': 'name', 'Project name': 'name',
    '项目描述': 'description', 'Project description': 'description',
    '技术栈': 'stack', 'Tech stack': 'stack',
    '项目路径': 'path', 'Project path': 'path',
    '项目约束': 'constraints', 'Project constraints': 'constraints'
  });
  const fields = ['name', 'description', 'stack', 'path', 'constraints'];
  const own = (raw, key) => !!raw && Object.prototype.hasOwnProperty.call(raw, key);
  function cleanValues(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    let count = 0;
    for (const key of Object.keys(raw)) {
      if (dangerous.has(key)) continue;
      const value = raw[key];
      if (!key || key.length > 500 || typeof value !== 'string' || value.length > 20000) continue;
      if (count >= 200) break;
      out[key] = value;
      count++;
    }
    return out;
  }
  function snapshot(project, globalValues) {
    const out = { values: cleanValues(project ? project.values : globalValues) };
    for (const field of fields) out[field] = project && typeof project[field] === 'string' ? project[field] : '';
    return out;
  }
  function fieldValues(project) {
    const out = {};
    for (const [label, field] of Object.entries(aliases)) out['[' + label + ']'] = project && typeof project[field] === 'string' ? project[field] : '';
    return out;
  }
  function resolve(descriptor, { context = null, values, globalValues } = {}) {
    const token = descriptor.token;
    // Own empty values represent a deliberate clearing in this fill session.
    if (own(values, token)) return typeof values[token] === 'string' ? values[token] : '';
    if (context !== null) {
      if (own(context.values, token)) return typeof context.values[token] === 'string' ? context.values[token] : '';
      const field = aliases[descriptor.hint];
      if (field && typeof context[field] === 'string' && context[field]) return context[field];
    } else if (own(globalValues, token)) return typeof globalValues[token] === 'string' ? globalValues[token] : '';
    return typeof descriptor.default === 'string' ? descriptor.default : '';
  }
  return { snapshot, resolve, cleanValues, fieldValues };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PROJECT_CONTEXT;
