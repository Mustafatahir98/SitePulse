const crypto = require('crypto');

const PREFIX = 'sitepulse';
const CATALOG = `${PREFIX}/catalog.json`;
const configured = env => Boolean(env.BLOB_READ_WRITE_TOKEN);
const cachePath = (namespace, key) => `${PREFIX}/cache/${namespace}/${crypto.createHash('sha256').update(key).digest('hex')}.json`;

function createBlobStore({ env = process.env, sdk = require('@vercel/blob') } = {}) {
  function options() {
    if (!configured(env)) throw Object.assign(new Error('Private storage is not configured. Connect a Private Blob store and add BLOB_READ_WRITE_TOKEN.'), { status: 503 });
    return { token: env.BLOB_READ_WRITE_TOKEN, access: 'private', abortSignal: AbortSignal.timeout(20000) };
  }
  function checkPath(pathname) {
    if (typeof pathname !== 'string' || !pathname.startsWith(`${PREFIX}/`) || pathname.includes('..') || pathname.includes('\\')) throw new Error('Invalid private storage path.');
  }
  async function read(pathname, { fresh = false } = {}) {
    checkPath(pathname);
    const result = await sdk.get(pathname, { ...options(), useCache: !fresh });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream) throw new Error('Private report could not be read.');
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }
  async function write(pathname, data, contentType = 'application/json', overwrite = false) {
    checkPath(pathname);
    const result = await sdk.put(pathname, data, {
      ...options(), contentType, addRandomSuffix: false, allowOverwrite: overwrite,
      ...(overwrite ? { cacheControlMaxAge: 60 } : {}),
    });
    if (!new URL(result.url).hostname.endsWith('.private.blob.vercel-storage.com')) throw new Error('Private storage required. Publication stopped.');
    return result;
  }
  return {
    configured: () => configured(env),
    read,
    write,
    async readJson(pathname, settings) {
      const data = await read(pathname, settings);
      return data ? JSON.parse(data.toString('utf8')) : null;
    },
    writeJson: (pathname, data, overwrite = false) => write(pathname, JSON.stringify(data), 'application/json', overwrite),
  };
}

module.exports = { createBlobStore, configured, cachePath, CATALOG, PREFIX };
