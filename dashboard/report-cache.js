const fs = require('fs/promises');
const path = require('path');

// Exact report keys prevent a cached date range or page leaking into another view.
function createReportCache({ file, freshMs = 10 * 60 * 1000, maxAgeMs = 7 * 86400000, clock = Date.now }) {
  const entries = new Map();
  const pending = new Map();
  const failures = new Map();
  let loading;
  let writing = Promise.resolve();
  const encode = (_, value) => value instanceof Map ? { __reportMap: [...value] } : value;
  const decode = (_, value) => value?.__reportMap ? new Map(value.__reportMap) : value;
  async function load() {
    if (!loading) loading = (async () => {
      try {
        for (const [key, entry] of JSON.parse(await fs.readFile(file, 'utf8'), decode)) {
          if (entry?.data && Number.isFinite(entry.time) && clock() - entry.time <= maxAgeMs) entries.set(key, entry);
        }
      } catch (_) { /* no saved report yet */ }
    })();
    return loading;
  }
  function save() {
    writing = writing.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify([...entries], encode));
      await fs.rename(temporary, file);
    }).catch(error => console.warn('Report cache could not be saved:', error.code || error.message));
    return writing;
  }
  function metadata(entry, status, extra = {}) {
    return { ...entry.data, cache: { status, fetchedAt: new Date(entry.time).toISOString(), ...extra } };
  }
  function refresh(key, loader) {
    if (pending.has(key)) return pending.get(key);
    const task = Promise.resolve().then(loader).then(data => {
      const previous = entries.get(key);
      if (data.unavailableSections?.length && previous && !previous.data.unavailableSections?.length) {
        throw new Error('Some report sections are unavailable; retaining the complete saved report.');
      }
      const entry = { data, time: clock() };
      if (!entries.has(key) && entries.size >= 100) entries.delete(entries.keys().next().value);
      entries.set(key, entry);
      failures.delete(key);
      // An incomplete report should not replace a complete last-known-good report.
      return save().then(() => entry);
    }).catch(error => {
      if (failures.size >= 100) failures.delete(failures.keys().next().value);
      failures.set(key, { until: clock() + 30000, error });
      throw error;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }
  async function get(key, loader, { force = false } = {}) {
    await load();
    let cached = entries.get(key);
    if (cached && clock() - cached.time > maxAgeMs) { entries.delete(key); cached = null; }
    if (!force && cached && clock() - cached.time < freshMs) return metadata(cached, 'fresh');
    const failure = failures.get(key);
    if (failure && failure.until > clock()) {
      if (cached) return metadata(cached, 'stale', { refreshError: true });
      throw failure.error;
    }
    if (!force && cached) {
      void refresh(key, loader).catch(error => console.warn('Background report refresh failed:', error.code || error.message));
      return metadata(cached, 'stale', { refreshing: true });
    }
    try { return metadata(await refresh(key, loader), 'live'); }
    catch (error) {
      if (cached) return metadata(cached, 'stale', { refreshError: true });
      throw error;
    }
  }
  return { get };
}

module.exports = { createReportCache };
