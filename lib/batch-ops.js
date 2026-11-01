// 文件树批量操作（移动 / 打标签 / 删除）的执行骨架。纯逻辑，不 require electron。
//
// 为什么批量走主进程一次 IPC，而不是渲染进程循环调现有的 rename / trash：
//   1. 部分失败必须汇总。循环里任何一项抛错，调用方一个 try 包住整段的话就是
//      "中途静默停止"；每项各自 try 又要在渲染进程重写一遍错误码提取。
//      这里每一项单独结算，结果只有 ok / failed / skipped 三个桶，绝不中途停。
//   2. 同名时生成新名字要在**占住目标 key 之后**再确认。渲染进程只能先问
//      "这个名字在不在"再发 rename，两步之间隔着一次 IPC，别处的写入能插进来。
//   3. 进行中禁止重复触发，主进程这一层也要拦：渲染进程的按钮禁用拦得住连点，
//      拦不住两个入口（批量条 + 自检脚本）同时发起。
// 每一项仍然走主进程原有的写链（queueWriteMulti → writeGate.shared），所以
// 完整备份导入的独占闸门照样生效：导入进行中，批量会停在下一项之前等它结束，
// 而不是和导入交叉写。整批**不能**包进一个 writeGate.shared：shared 不可重入，
// 外层持有、内层 queueWrite 再进 shared 时，排在中间的导入会让内层永远等外层，
// 外层又在等内层——死锁。
const path = require('path');
const { uniqueRel } = require('./zip-import');

function appError(code, detail) {
  return new Error(detail == null || detail === '' ? code : code + '|' + detail);
}

// 一次批量的条数上限。文件树上全选整库也就几百个；上限防的是渲染进程（可能正在
// 渲染导入的第三方 .md）构造一个超大载荷让主进程长时间占着写链。
const MAX_BATCH = 500;

// 从异常里取出错误码。主进程统一抛 E_XXX|detail；fs 抛的是带 code 的 Error
// （ENOENT / EBUSY…），也要原样保住，汇总里"为什么失败"不能变成一句 Error。
function errorCode(err) {
  const msg = String(err && err.message != null ? err.message : err);
  const m = msg.match(/\b(E_[A-Z0-9_]+)(?:\|([\s\S]*))?$/);
  if (m) return { code: m[1], detail: m[2] || '' };
  if (err && typeof err.code === 'string') return { code: 'E_BATCH_IO', detail: err.code };
  return { code: 'E_BATCH_IO', detail: msg.slice(0, 120) };
}

// 渲染进程传来的 rel 列表：必须是字符串数组，去重，统一分隔符，有上限。
function normalizeRelList(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_BATCH) throw appError('E_INVALID_PAYLOAD');
  const out = [];
  for (const r of list) {
    if (typeof r !== 'string' || !r) throw appError('E_INVALID_PAYLOAD');
    const rel = r.replace(/\\/g, '/');
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

// handler(rel) 的约定：正常返回 → 成功；返回 { skip: 'E_XXX' } → 跳过（不算失败，
// 比如锁定、已在目标目录、标签没变化）；抛错 → 失败。返回其他对象时整个挂到结果上
// （批量移动用它带回 newRel）。
function createBatchRunner() {
  let busy = false;
  async function run(rels, handler) {
    if (busy) throw appError('E_BATCH_BUSY');
    busy = true;
    const result = { ok: [], failed: [], skipped: [] };
    try {
      for (const rel of rels) {
        try {
          const r = await handler(rel);
          if (r && r.skip) result.skipped.push({ rel, code: r.skip });
          else result.ok.push(Object.assign({ rel }, r && typeof r === 'object' ? r : {}));
        } catch (err) {
          const { code, detail } = errorCode(err);
          result.failed.push({ rel, code, detail });
        }
      }
      return result;
    } finally {
      busy = false;
    }
  }
  return { run, isBusy: () => busy };
}

// 批量移动的目标名。返回 null 表示文件已经在这个目录里（跳过，不算失败）。
// 同名时沿用导入的 uniqueRel（-1、-2 …），exists 由调用方给：主进程里要过 safeJoin。
function pickMoveTarget(srcRel, dirRel, exists) {
  const src = String(srcRel).replace(/\\/g, '/');
  const dir = String(dirRel).replace(/\\/g, '/').replace(/\/+$/, '');
  // 只有提示词能移动（和单个移动的 onlyPromptsMovable 一致）：工作流和模板
  // 有各自的顶层目录，挪进 prompts/ 之后它们就不再被当成工作流/模板识别了。
  if (!src.startsWith('prompts/')) throw appError('E_MOVE_NOT_PROMPT', src);
  if (!dir.startsWith('prompts/') || dir.split('/').some(s => s === '..' || s === '.' || s === '')) {
    throw appError('E_MOVE_BAD_TARGET', dir);
  }
  if (path.posix.dirname(src) === dir) return null;
  return uniqueRel(dir + '/' + path.posix.basename(src), exists);
}

module.exports = { createBatchRunner, errorCode, normalizeRelList, pickMoveTarget, MAX_BATCH };
