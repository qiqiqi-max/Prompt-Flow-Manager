const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')).digest('hex');
}

function buildManifest(entries, meta = {}) {
  return {
    schema: 1,
    app: 'prompt-flow-manager',
    appVersion: String(meta.appVersion || ''),
    createdAt: String(meta.createdAt || new Date().toISOString()),
    files: (Array.isArray(entries) ? entries : [])
      .map(entry => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path))
  };
}

// 没有清单是旧版本备份；有清单时必须精确匹配，避免把缺文件或损坏的备份导入一半。
function verifyManifest(entries, manifest) {
  if (!manifest) return { ok: true, legacy: true, missing: [], changed: [], extra: [] };
  if (manifest.schema !== 1 || manifest.app !== 'prompt-flow-manager' || !Array.isArray(manifest.files)) {
    return { ok: false, legacy: false, invalid: true, missing: [], changed: [], extra: [] };
  }
  const actual = new Map((Array.isArray(entries) ? entries : []).map(entry => [entry.path, entry]));
  const expected = new Map(manifest.files.map(entry => [entry.path, entry]));
  const missing = [];
  const changed = [];
  for (const [file, item] of expected) {
    const got = actual.get(file);
    if (!got) missing.push(file);
    else if (got.size !== item.size || got.sha256 !== item.sha256) changed.push(file);
  }
  const extra = [...actual.keys()].filter(file => !expected.has(file)).sort();
  return { ok: missing.length === 0 && changed.length === 0 && extra.length === 0, legacy: false, missing, changed, extra };
}

module.exports = { sha256, buildManifest, verifyManifest };
