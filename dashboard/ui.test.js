const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const puppeteer = require('puppeteer');
const { hashPassword } = require('./auth');

test('dashboard renders before slow GA, preserves saved data on failure, and works on mobile', { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'corevitals-ui-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  Object.assign(process.env, {
    DASHBOARD_USERNAME: 'ui-test', DASHBOARD_PASSWORD_HASH: await hashPassword('ui-test-password-only'),
    DASHBOARD_SESSION_SECRET: 'ui-test-secret-longer-than-thirty-two-characters', DASHBOARD_CACHE_DIR: directory,
    CLARITY_PROJECT_ID: 'ui-test-project', CLARITY_API_TOKEN: 'ui-test-token-only',
  });
  const originalFetch = global.fetch;
  let clarityCalls = 0;
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://www.clarity.ms/')) {
      clarityCalls++;
      return { ok: true, status: 200, json: async () => [{ metricName: 'Traffic', information: [{ sessions: '42' }] }] };
    }
    return originalFetch(url, options);
  };
  t.after(() => { global.fetch = originalFetch; });
  const { google } = require('googleapis');
  google.auth.GoogleAuth = class {};
  let gaCalls = 0;
  let failGA = false;
  let partialGA = true;
  google.analyticsdata = () => ({ properties: { runReport: async ({ requestBody }) => {
    gaCalls++;
    await new Promise(resolve => setTimeout(resolve, 2400));
    if (failGA) throw Object.assign(new Error('Simulated upstream connection reset'), { code: 'ECONNRESET' });
    if (partialGA && requestBody.metrics[0].name === 'userEngagementDuration') throw new Error('Optional metric group delayed');
    return { data: { metricHeaders: requestBody.metrics.map(metric => ({ name: metric.name })), rows: [{ dimensionValues: [{ value: '/' }], metricValues: requestBody.metrics.map(() => ({ value: '123' })) }], totals: [{ metricValues: requestBody.metrics.map(() => ({ value: '123' })) }] } };
  } } });
  google.searchconsole = () => ({ searchanalytics: { query: async ({ requestBody }) => {
    if (requestBody.dimensions[0] === 'country') throw new Error('Simulated unavailable optional section');
    const dimension = requestBody.dimensions[0];
    const key = dimension === 'date' ? requestBody.startDate : dimension === 'page' ? 'https://lotuspsychiatryandwellness.com/' : dimension === 'device' ? 'MOBILE' : 'example search';
    return { data: { rows: [{ keys: dimension ? [key] : [], clicks: 12, impressions: 120, ctr: .1, position: 4 }] } };
  } } });
  const handler = require('./server');
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(origin + '/login');
  await page.type('#username', 'ui-test');
  await page.type('#password', 'ui-test-password-only');
  await Promise.all([page.waitForNavigation(), page.click('#loginButton')]);
  await page.waitForSelector('#report:not(.hidden)');
  const start = Date.now();
  await page.click('[data-site="lotuspsychiatryandwellness_com"]');
  await page.waitForFunction(() => document.getElementById('siteName').textContent.includes('Lotus') && !document.getElementById('report').classList.contains('hidden'));
  assert.ok(Date.now() - start < 2000, 'Local report should not wait for slow GA');
  await page.waitForSelector('.metric-loading');
  await page.waitForFunction(() => document.getElementById('dataStatus').dataset.state === 'ready');
  assert.equal(gaCalls, 2, 'Two metric groups, no duplicate report requests');
  assert.match(await page.$eval('#analyticsStatus', node => node.textContent), /Some detail metrics are delayed/);
  partialGA = false;
  await page.click('#retryAnalytics');
  await page.waitForFunction(() => document.getElementById('dataStatus').dataset.state === 'ready' && !document.getElementById('analyticsStatus').textContent.includes('detail metrics'));
  await page.screenshot({ path: path.join(__dirname, '..', 'temp-file', 'dashboard-refined-desktop.png'), fullPage: true });
  failGA = true;
  await page.click('#retryAnalytics');
  await page.waitForFunction(() => document.getElementById('dataStatus').dataset.state === 'stale');
  assert.match(await page.$eval('#analyticsStatus', node => node.textContent), /saved analytics/);
  assert.ok(await page.$('.traffic-metric'), 'Report remains visible on failed refresh');
  await page.click('#clarityButton');
  await page.waitForSelector('.clarity-section');
  assert.match(await page.$eval('#clarityDialogContent', node => node.textContent), /Traffic.*42/);
  assert.match(await page.$eval('#clarityDialogContent', node => node.textContent), /Updated/);
  await page.click('#clarityDialogClose');
  await page.click('#clarityButton');
  await page.waitForSelector('.clarity-section');
  assert.equal(clarityCalls, 1, 'Reopening Clarity uses saved data without consuming another API call');
  await page.click('#clarityDialogClose');
  await page.click('#searchConsoleButton');
  await page.waitForSelector('.sc-tiles');
  assert.match(await page.$eval('#scBody', node => node.textContent), /countries/);
  await page.click('[data-sc-tab="countries"]');
  assert.match(await page.$eval('#scBreakdown', node => node.textContent), /temporarily delayed/);
  await page.click('#searchDialogClose');
  await page.waitForFunction(() => !document.getElementById('searchDialog').open);
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(__dirname, '..', 'temp-file', 'dashboard-refined-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No whole-page horizontal overflow on mobile');
  await page.click('#menuButton');
  await page.waitForFunction(() => document.getElementById('menuButton').getAttribute('aria-expanded') === 'true');
  assert.equal(await page.$eval('#menuButton', node => node.getAttribute('aria-expanded')), 'true');
  assert.deepEqual(errors, [], 'No browser runtime errors');
});
