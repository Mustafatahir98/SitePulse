const path = require('path');
const os = require('os');
const { google } = require('googleapis');
const { createReportCache } = require('./report-cache');
const { getGoogleAuth, requestOptions: googleRequestOptions } = require('./google-client');
const ROOT = path.resolve(__dirname, '..');
const PROPERTY = 'https://lotuspsychiatryandwellness.com/';
const SITE = 'lotuspsychiatryandwellness_com';
const CACHE_DIR = process.env.DASHBOARD_CACHE_DIR || (process.env.VERCEL ? path.join(os.tmpdir(), 'sitepulse-cache') : path.join(ROOT, 'temp-file'));
const CACHE_FILE = path.join(CACHE_DIR, 'search-console-cache.json');
const FRESH_CACHE_MS = 2 * 60 * 1000;
const reportCache = createReportCache({ file: CACHE_FILE, freshMs: FRESH_CACHE_MS });
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

// Search Console returns every dimension sorted by clicks, so a row's own key is the only reliable order.
const cell = row => ({
  key: row.keys?.[0] ?? '',
  clicks: row.clicks || 0,
  impressions: row.impressions || 0,
  ctr: row.ctr || 0,
  position: row.position || 0,
});

function isSearchConsoleConfigured(siteId) {
  return siteId === SITE;
}

function reportOptions(params, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const range = params.get('range') || '28d';
  const days = { '7d': 7, '28d': 28, '90d': 90 }[range];
  const endDate = days ? today : params.get('end') || '';
  const startDate = days ? shift(endDate, 1 - days) : params.get('start') || '';
  if ((!days && range !== 'custom') || !validDate(startDate) || !validDate(endDate) || startDate > endDate || endDate > today || (Date.parse(endDate) - Date.parse(startDate)) / 86400000 > 487) {
    throw Object.assign(new Error('Choose a valid date range of up to 488 days ending no later than today (Pacific time).'), { status: 400 });
  }
  const page = params.get('page') || '';
  if (page) {
    let url;
    try { url = new URL(page); } catch (_) { /* handled below */ }
    if (!url || url.origin !== new URL(PROPERTY).origin || url.username || url.password || page.length > 4096) {
      throw Object.assign(new Error('Choose a page from the Lotus website.'), { status: 400 });
    }
  }
  return { startDate, endDate, page };
}

async function getSearchReport(siteId, params) {
  if (!isSearchConsoleConfigured(siteId)) throw Object.assign(new Error('Search Console is not configured for this website.'), { status: 404 });
  const options = reportOptions(params);
  return reportCache.get(JSON.stringify(options), () => loadReport(options), { force: params.get('refresh') === '1' });
}

// Search Console omits days it has no data for, so rebuild a gap-free daily series.
// Nothing is invented past the last day with data: `final` data lags real time by a
// couple of days, and padding that tail with zeros would read as a traffic collapse.
function buildSeries(rows, startDate) {
  const byDate = new Map(rows.map(row => [row.keys?.[0], row]));
  const lastDataDate = rows.reduce((last, row) => (row.keys?.[0] > last ? row.keys[0] : last), '') || null;
  const series = [];
  for (let date = startDate; lastDataDate && date <= lastDataDate; date = shift(date, 1)) {
    const row = byDate.get(date);
    series.push({
      date,
      clicks: row?.clicks || 0,
      impressions: row?.impressions || 0,
      ctr: row?.ctr || 0,
      // A day with no impressions has no average position; a 0 would plot as a perfect rank.
      position: row?.impressions ? row.position : null,
    });
  }
  return { series, lastDataDate };
}

async function loadReport({ startDate, endDate, page }) {
  const auth = getGoogleAuth(['https://www.googleapis.com/auth/webmasters.readonly']);
  const client = google.searchconsole({ version: 'v1', auth });
  const query = async (dimensions, start = startDate, end = endDate, rowLimit = 1000) => {
    const response = await client.searchanalytics.query({ siteUrl: PROPERTY, requestBody: {
      startDate: start, endDate: end, dimensions, type: 'web', dataState: 'all', rowLimit,
      ...(page ? { dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: page }] }] } : {}),
    } }, { ...googleRequestOptions, retry: true, retryConfig: {
      retry: 1, noResponseRetries: 1, httpMethodsToRetry: ['POST'], retryDelay: 1000,
      onRetryAttempt: error => console.warn('Search Console retry:', error.code || error.response?.status || 'network error'),
    } });
    return response.data;
  };
  const length = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1;
  const previousStart = shift(startDate, -length);
  const previousEnd = shift(startDate, -1);
  const sections = ['totals', 'series', 'queries', 'pages', 'countries', 'devices', 'previous', 'previousPages'];
  const results = await Promise.allSettled([
    query([]),
    query(['date']),
    query(['query']),
    query(['page'], startDate, endDate, 25000),
    query(['country']),
    query(['device']),
    query([], previousStart, previousEnd),
    query(['page'], previousStart, previousEnd, 25000),
  ]);
  if (results[0].status === 'rejected') throw results[0].reason;
  const unavailableSections = sections.filter((_, index) => results[index].status === 'rejected');
  const [totalsData, seriesData, queriesData, pagesData, countriesData, devicesData, previousData, previousPagesData] = results.map(result => result.status === 'fulfilled' ? result.value : {});
  const { series, lastDataDate } = buildSeries(seriesData.rows || [], startDate);
  return {
    property: PROPERTY,
    page,
    startDate,
    endDate,
    previousStart,
    previousEnd,
    lastDataDate,
    firstIncompleteDate: seriesData.metadata?.firstIncompleteDate || seriesData.metadata?.first_incomplete_date || null,
    generatedAt: new Date().toISOString(),
    unavailableSections,
    totals: totalsData.rows?.[0] ? cell({ ...totalsData.rows[0], keys: [''] }) : null,
    previous: previousData.rows?.[0] ? cell({ ...previousData.rows[0], keys: [''] }) : null,
    series,
    queries: (queriesData.rows || []).map(cell),
    pages: (pagesData.rows || []).map(cell),
    previousPages: (previousPagesData.rows || []).map(cell),
    countries: (countriesData.rows || []).map(cell),
    devices: (devicesData.rows || []).map(cell),
  };
}

module.exports = { getSearchReport, reportOptions, isSearchConsoleConfigured };
