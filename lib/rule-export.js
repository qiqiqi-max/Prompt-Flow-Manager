const fsp = require('fs/promises');
const path = require('path');

let seq = 0;

async function exists(file) {
  try { await fsp.lstat(file); return true; }
  catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
}

async function plan(targetDir, files, allowed) {
  const items = [];
  const seen = new Set();
  for (const item of Array.isArray(files) ? files : []) {
    const name = item && typeof item.name === 'string' ? item.name : '';
    if (!allowed.has(name) || path.basename(name) !== name || seen.has(name)) continue;
    seen.add(name);
    items.push({ name, content: String(item.content || ''), fullPath: path.join(targetDir, name) });
  }
  const existing = [];
  for (const item of items) if (await exists(item.fullPath)) existing.push(item.name);
  return { targetDir, items, existing };
}

async function writeAtomic(file, content) {
  const tmp = path.join(path.dirname(file), `.pfm-rule-${process.pid}-${seq++}-${path.basename(file)}.part`);
  try {
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, file);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch {}
    throw e;
  }
}

async function write(exportPlan, mode, onError) {
  const existing = new Set(exportPlan.existing);
  const written = [];
  const skipped = [];
  const failed = [];
  for (const item of exportPlan.items) {
    if (existing.has(item.name) && mode !== 'overwrite') {
      skipped.push(item.name);
      continue;
    }
    try {
      await writeAtomic(item.fullPath, item.content);
      written.push(item.name);
    } catch (e) {
      failed.push(item.name);
      if (onError) onError(item.name, e);
    }
  }
  return { written, skipped, failed };
}

module.exports = { plan, write };
