const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createClarityReports } = require('./clarity');
const { createReportCache } = require('./report-cache');
const { createBlobCache } = require('./blob-cache');

test('Clarity reports survive new instances, deduplicate requests, and retain data on quota errors', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sitepulse-clarity-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const values = new Map();
  const store = { readJson: async key => values.get(key), writeJson: async (key, value) => values.set(key, value) };
  const env = { VERCEL: '1', BLOB_READ_WRITE_TOKEN: 'test-only', CLARITY_PROJECT_ID: 'project-test', CLARITY_API_TOKEN: 'token-test' };
  const remote = createBlobCache('clarity', { env, store });
  let now = Date.now();
  let calls = 0;
  let quotaExceeded = false;
  const fetchReport = async () => {
    calls++;
    await new Promise(resolve => setImmediate(resolve));
    return { ok: !quotaExceeded, status: quotaExceeded ? 429 : 200, json: async () => [{ metricName: 'Traffic', information: [{ sessions: '42' }] }] };
  };
  const instance = name => createClarityReports({ env, fetchReport, cache: createReportCache({ file: path.join(directory, name), freshMs: 12 * 3600000, clock: () => now, remote }) });
  const first = instance('first.json');
  const reports = await Promise.all([first('lotuspsychiatryandwellness_com', 3), first('lotuspsychiatryandwellness_com', 3)]);
  assert.equal(calls, 1);
  assert.equal(reports[0].insights[0].information[0].sessions, '42');
  await instance('second.json')('lotuspsychiatryandwellness_com', 3);
  assert.equal(calls, 1, 'New Vercel instance reads shared report without spending another Clarity request');
  await first('lotuspsychiatryandwellness_com', 1);
  assert.equal(calls, 2, 'Different day ranges have independent reports');
  now += 12 * 3600000 + 1;
  quotaExceeded = true;
  const third = instance('third.json');
  const stale = await third('lotuspsychiatryandwellness_com', 3);
  assert.equal(stale.cache.status, 'stale');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const retained = await third('lotuspsychiatryandwellness_com', 3);
  assert.equal(retained.insights[0].information[0].sessions, '42');
  assert.equal(retained.cache.refreshError, true);
});

test('missing Clarity credentials and invalid API payloads cannot become empty successful reports', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sitepulse-clarity-invalid-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(createClarityReports({ env: { DASHBOARD_CACHE_DIR: directory } })('lotuspsychiatryandwellness_com'), error => error.status === 503);
  const reports = createClarityReports({ env: { DASHBOARD_CACHE_DIR: directory, CLARITY_PROJECT_ID: 'test', CLARITY_API_TOKEN: 'test' }, fetchReport: async () => ({ ok: true, json: async () => ({ message: 'invalid report' }) }) });
  await assert.rejects(reports('lotuspsychiatryandwellness_com'), /invalid report/);
});
