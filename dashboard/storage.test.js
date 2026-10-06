const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createBlobStore, CATALOG, cachePath } = require('./blob-store');
const { createReportStorage } = require('./report-storage');
const { uploadReports } = require('./upload-reports');
const { createReportCache } = require('./report-cache');

function memoryStore() {
  const files = new Map();
  const writes = [];
  const sdk = {
    async put(pathname, data, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.addRandomSuffix, false);
      writes.push(pathname);
      if (files.has(pathname) && !options.allowOverwrite) throw new Error('Already exists');
      files.set(pathname, Buffer.from(data));
      return { pathname, url: `https://test.private.blob.vercel-storage.com/${pathname}` };
    },
    async get(pathname, options) {
      assert.equal(options.access, 'private');
      const data = files.get(pathname);
      if (!data) return null;
      return { statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } }) };
    },
  };
  const blob = createBlobStore({ env: { BLOB_READ_WRITE_TOKEN: 'test-token-only' }, sdk });
  return { blob, files, writes };
}

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sitepulse-storage-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function reports(root) {
  const rows = [{ url: 'https://example.com/', siteName: 'Example', title: 'Homepage' }];
  await fs.writeFile(path.join(root, 'oldScrapedData_example_com.json'), JSON.stringify(rows));
  await fs.writeFile(path.join(root, 'CWV_Report_example_com_2026-09-01.xlsx'), 'old-excel');
  await fs.writeFile(path.join(root, 'CWV_Report_example_com_2026-09-19.xlsx'), 'latest-excel');
  await fs.writeFile(path.join(root, '.env'), 'EXAMPLE_SECRET=must-not-upload');
  await fs.writeFile(path.join(root, 'service-account.json'), '{"private_key":"must-not-upload"}');
  return rows;
}

test('uploads all report dates privately, exposes metadata only, and keeps local secrets out', async t => {
  const root = await directory(t);
  const rows = await reports(root);
  const { blob, writes } = memoryStore();
  const result = await uploadReports({ root, blob, log: () => {} });
  assert.equal(result.reportCount, 2);
  assert.equal(writes.at(-1), CATALOG, 'Catalog is published after report files');
  assert.equal(writes.some(name => /service-account|\.env/.test(name)), false);
  const storage = createReportStorage({ env: { VERCEL: '1' }, blob });
  const sites = await storage.listSites();
  assert.equal(sites[0].latestReport, 'CWV_Report_example_com_2026-09-19.xlsx');
  assert.equal(sites[0].dataPath, undefined);
  assert.equal(sites[0].reports, undefined);
  assert.deepEqual(await storage.readRows('example_com'), rows);
  assert.equal((await storage.readReport('example_com', sites[0].latestReport)).toString(), 'latest-excel');
  await assert.rejects(storage.readRows('../example'), /Invalid website/);
  await assert.rejects(storage.readReport('example_com', '../service-account.json'), /Invalid report file/);
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'EXAMPLE_SECRET=must-not-upload');
});

test('failed upload preserves the previous catalog and cannot publish a partial dataset', async t => {
  const root = await directory(t);
  await reports(root);
  const { blob } = memoryStore();
  await uploadReports({ root, blob, log: () => {} });
  const previous = await blob.readJson(CATALOG);
  const failing = { ...blob, write: async () => { throw new Error('Simulated upload failure'); } };
  await assert.rejects(uploadReports({ root, blob: failing, log: () => {} }), /Simulated upload failure/);
  assert.deepEqual(await blob.readJson(CATALOG), previous);
});

test('missing private storage fails clearly and dry-run requires no token', async t => {
  const root = await directory(t);
  await reports(root);
  const blob = createBlobStore({ env: {}, sdk: {} });
  assert.equal((await uploadReports({ root, blob, dryRun: true, log: () => {} })).reportCount, 2);
  await assert.rejects(uploadReports({ root, blob, log: () => {} }), /BLOB_READ_WRITE_TOKEN/);
  const storage = createReportStorage({ env: { VERCEL: '1' }, blob });
  await assert.rejects(storage.listSites(), /Private storage is not configured/);
  await assert.rejects(blob.read('https://external.example/key'), /Invalid private storage path/);
});

test('shared cache survives new instances and isolates Google report keys', async t => {
  const root = await directory(t);
  const values = new Map();
  const remote = { read: async key => values.get(key) || null, write: async (key, data) => values.set(key, data) };
  const first = createReportCache({ file: path.join(root, 'first.json'), remote });
  await first.get('property:30d', async () => ({ pages: new Map([['/', { pageViews: 51 }]]) }));
  const second = createReportCache({ file: path.join(root, 'second.json'), remote });
  const data = await second.get('property:30d', () => { throw new Error('Should read shared saved report'); });
  assert.equal(data.cache.status, 'fresh');
  assert.equal(data.pages.get('/').pageViews, 51);
  await assert.rejects(second.get('property:7d', async () => { throw new Error('Different range needs its own report'); }), /Different range/);
  assert.notEqual(cachePath('analytics', 'a'), cachePath('analytics', 'b'));
});
