'use strict';
// config.json 的读取。刻意不 require electron，路径和 fs 都由调用方传进来，裸 node 可测。
//
// 区分"读不到"和"损坏"：原先两种情况都静默回落默认值，而下一次任何 updateConfig
// （比如窗口位置 500ms 防抖保存）就会把默认值整份写回去，锁定列表、项目类型、
// 标签页全部丢失，连坏文件本身也被覆盖，无从恢复。损坏时先改名留档再回落。

const fsPromises = require('fs').promises;

// 返回解析出的对象；读不到或损坏时返回 null（损坏的已改名为 .corrupt-<ts>）。
// 读盘失败（ENOENT 以外的 EBUSY/EACCES）同样返回 null 而不是抛：createWindow
// 启动时也走这里，抛出去窗口就起不来了。
async function readConfigFile(file, { fsp = fsPromises, now = Date.now, logError = () => {} } = {}) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code !== 'ENOENT') logError('[config] 读取配置失败:', e.message);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    throw new Error('not an object');
  } catch (e) {
    const bak = file + '.corrupt-' + now();
    try { await fsp.rename(file, bak); } catch {}
    logError('[config] 配置文件损坏，已改名留档:', bak, e.message);
    return null;
  }
}

module.exports = { readConfigFile };
