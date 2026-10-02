// 项目类型配置的纯逻辑。主进程负责串行化读写，这里只决定下一份列表。
function currentList(config, defaults) {
  return Array.isArray(config && config.projectTypes) ? [...config.projectTypes] : [...defaults];
}

function add(config, type, defaults, appError) {
  if (!type || typeof type !== 'string') throw appError('E_TYPE_INVALID');
  const value = type.trim();
  if (!value) throw appError('E_TYPE_EMPTY');
  const list = currentList(config, defaults);
  if (list.includes(value)) throw appError('E_TYPE_EXISTS', value);
  list.push(value);
  return list;
}

function remove(config, type, defaults, appError) {
  const list = currentList(config, defaults);
  if (list.length <= 1) throw appError('E_TYPE_MIN_ONE');
  const idx = list.indexOf(type);
  if (idx === -1) return null;
  list.splice(idx, 1);
  return list;
}

module.exports = { add, remove };
