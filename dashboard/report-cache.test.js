const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createReportCache } = require('./report-cache');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'corevitals-cache-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'reports.json');
}

test('deduplicates concurrent loads and persists Maps across restarts', async t => {
  const file = await fixture(t);
  const cache = createReportCache({ file });
  let calls = 0;
  const loader = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return { pages: new Map([['/', { pageViews: 42 }]]) }; };
  const reports = await Promise.all([cache.get('site:30d', loader), cache.get('site:30d', loader)]);
  assert.equal(calls, 1);
  assert.equal(reports[0].pages.get('/').pageViews, 42);
  const restarted = createReportCache({ file });
  const saved = await restarted.get('site:30d', () => { throw new Error('Should use saved data'); });
  assert.equal(saved.cache.status, 'fresh');
  assert.equal(saved.pages.get('/').pageViews, 42);
});

test('returns stale data immediately, keeps last good result on failure and backs off', async t => {
  const file = await fixture(t);
  let now = 100000;
  const cache = createReportCache({ file, freshMs: 100, clock: () => now });
  await cache.get('a', async () => ({ total: 12 }));
  now += 101;
  let fail;
  let calls = 0;
  const loader = () => { calls++; return new Promise((_, reject) => { fail = reject; }); };
  const stale = await cache.get('a', loader);
  assert.equal(stale.total, 12);
  assert.equal(stale.cache.refreshing, true);
  fail(new Error('ECONNRESET'));
  await new Promise(resolve => setImmediate(resolve));
  const fallback = await cache.get('a', loader);
  assert.equal(fallback.total, 12);
  assert.equal(fallback.cache.refreshError, true);
  assert.equal(calls, 1);
});

test('explicit retry calls upstream again immediately after a failed first request', async t => {
  const file = await fixture(t);
  const cache = createReportCache({ file });
  let calls = 0;
  const loader = async () => {
    calls++;
    if (calls === 1) throw new Error('Transient upstream failure');
    return { total: 42 };
  };
  await assert.rejects(cache.get('search:28d', loader), /Transient upstream failure/);
  await assert.rejects(cache.get('search:28d', loader), /Transient upstream failure/);
  assert.equal(calls, 1, 'Automatic requests still respect failure backoff');
  const retried = await cache.get('search:28d', loader, { force: true });
  assert.equal(calls, 2, 'The Retry button makes a new upstream request');
  assert.equal(retried.total, 42);
  assert.equal(retried.cache.status, 'live');
});

test('separates date/page keys, rejects expired data and preserves complete reports', async t => {
  const file = await fixture(t);
  let now = 100000;
  const cache = createReportCache({ file, freshMs: 100, maxAgeMs: 1000, clock: () => now });
  await cache.get('page-a:7d', async () => ({ total: 70, unavailableSections: [] }));
  await assert.rejects(cache.get('page-b:7d', async () => { throw new Error('no data'); }), /no data/);
  const retained = await cache.get('page-a:7d', async () => ({ total: 0, unavailableSections: ['queries'] }), { force: true });
  assert.equal(retained.total, 70);
  assert.equal(retained.cache.refreshError, true);
  now += 1001;
  await assert.rejects(cache.get('page-a:7d', async () => { throw new Error('expired'); }), /complete saved report|expired/);
});
