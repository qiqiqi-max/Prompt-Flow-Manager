const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

function createDraftStore(options) {
  const {
    draftsDir,
    appError,
    writeFileAtomic,
    isAllowedRel,
    now = () => new Date().toISOString()
  } = options || {};

  function cleanRel(rel) {
    const value = String(rel == null ? '' : rel).replace(/\\/g, '/');
    if (!isAllowedRel(value)) throw appError('E_WRITE_FORBIDDEN', value);
    return value;
  }

  function fileFor(rel) {
    const value = cleanRel(rel);
    const name = crypto.createHash('sha256').update(value, 'utf8').digest('hex') + '.json';
    return path.join(draftsDir, name);
  }

  async function save(rel, content, baseContent) {
    const value = cleanRel(rel);
    await writeFileAtomic(fileFor(value), JSON.stringify({
      schema: 1,
      rel: value,
      content: String(content),
      baseContent: String(baseContent),
      updatedAt: now()
    }));
    return true;
  }

  async function read(rel) {
    const value = cleanRel(rel);
    const file = fileFor(value);
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw e;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schema === 1 && parsed.rel === value
          && typeof parsed.content === 'string' && typeof parsed.baseContent === 'string') {
        return parsed;
      }
      throw new Error('invalid draft');
    } catch {
      try { await fsp.rename(file, file + '.corrupt-' + Date.now()); } catch {}
      return null;
    }
  }

  async function clear(rel) {
    try { await fsp.unlink(fileFor(rel)); }
    catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
    return true;
  }

  return { fileFor, save, read, clear };
}

module.exports = { createDraftStore };
