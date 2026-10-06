const { createBlobStore, configured, cachePath } = require('./blob-store');

function createBlobCache(namespace, { env = process.env, store = createBlobStore({ env }) } = {}) {
  if (!env.VERCEL || !configured(env)) return null;
  if (!['analytics', 'search-console'].includes(namespace)) throw new Error('Invalid cache namespace.');
  return {
    async read(key) {
      const entry = await store.readJson(cachePath(namespace, key), { fresh: true });
      return entry?.key === key ? { time: entry.time, data: entry.data } : null;
    },
    write: (key, entry) => store.writeJson(cachePath(namespace, key), { key, ...entry }, true),
  };
}

module.exports = { createBlobCache };
