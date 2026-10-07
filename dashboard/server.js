const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { google } = require('googleapis');
const ExcelJS = require('exceljs');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { getSearchReport, isSearchConsoleConfigured } = require('./search-console');
const { getGoogleAuth, requestOptions: googleRequestOptions } = require('./google-client');
const auth = require('./auth').createAuth();
const reportStorage = require('./report-storage').createReportStorage();
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.DASHBOARD_PORT) || 4173;
const ANALYTICS_CACHE_MS = 10 * 60 * 1000;
const { createReportCache } = require('./report-cache');
const CACHE_DIR = process.env.DASHBOARD_CACHE_DIR || (process.env.VERCEL ? path.join(os.tmpdir(), 'sitepulse-cache') : path.join(ROOT, 'temp-file'));
const analyticsCache = createReportCache({ file: path.join(CACHE_DIR, 'analytics-cache.json'), freshMs: ANALYTICS_CACHE_MS, remote: require('./blob-cache').createBlobCache('analytics') });
const getClarityReport = require('./clarity').createClarityReports();
const GA4_PROPERTIES = {
  lotuspsychiatryandwellness_com: process.env.GA4_PROPERTY_LOTUSPSYCHIATRYANDWELLNESS_COM || '534285283',
};
const CLARITY_PROJECTS = {
  lotuspsychiatryandwellness_com: process.env.CLARITY_PROJECT_ID || '',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function normalizePagePath(value) {
  if (!value) return '/';
  let pathname = value;
  try {
    pathname = value.startsWith('http') ? new URL(value).pathname : value.split('?')[0];
  } catch (_) {
    pathname = value;
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : '/';
}

function getAnalyticsDateRange(searchParams) {
  const preset = searchParams.get('range') || '30d';
  const presets = {
    '1d': { startDate: 'yesterday', endDate: 'yesterday', label: 'Yesterday' },
    '7d': { startDate: '7daysAgo', endDate: 'yesterday', label: 'Last 7 days' },
    '30d': { startDate: '30daysAgo', endDate: 'yesterday', label: 'Last 30 days' },
  };
  if (presets[preset]) return presets[preset];
  if (preset !== 'custom') throw new Error('Invalid traffic date range.');

  const startDate = searchParams.get('start') || '';
  const endDate = searchParams.get('end') || '';
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    throw new Error('Choose a valid custom start and end date.');
  }
  return { startDate, endDate, label: `${startDate} to ${endDate}` };
}

async function getAnalyticsReport(siteId, dateRange, force = false) {
  const propertyId = GA4_PROPERTIES[siteId];
  if (!propertyId) return { enabled: false, status: 'not-configured', range: null, totals: null, pages: new Map() };
  // Google resolves relative dates in the property's timezone. Partition relative
  // report keys by day so yesterday's cached report is not labelled as today's.
  const day = /Ago|yesterday/.test(dateRange.startDate) ? new Date().toISOString().slice(0, 10) : '';
  const cacheKey = `${propertyId}:${dateRange.startDate}:${dateRange.endDate}:${day}`;
  return analyticsCache.get(cacheKey, () => loadAnalyticsReport(siteId, dateRange), { force });
}

async function loadAnalyticsReport(siteId, dateRange) {
  const propertyId = GA4_PROPERTIES[siteId];

  const auth = getGoogleAuth(['https://www.googleapis.com/auth/analytics.readonly']);
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  const metricGroups = [
    [
      'screenPageViews', 'activeUsers', 'totalUsers', 'newUsers', 'sessions',
      'engagedSessions', 'engagementRate', 'bounceRate', 'averageSessionDuration',
      'screenPageViewsPerSession',
    ],
    [
      'userEngagementDuration', 'sessionsPerUser', 'eventCount', 'eventCountPerUser',
      'eventsPerSession', 'keyEvents', 'sessionKeyEventRate', 'totalRevenue',
      'transactions', 'purchaseRevenue',
    ],
  ];
  const results = await Promise.allSettled(metricGroups.map(metrics => analyticsData.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate: dateRange.startDate, endDate: dateRange.endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: metrics.map(name => ({ name })),
      metricAggregations: ['TOTAL'],
      limit: '100000',
    },
  }, {
    ...googleRequestOptions,
    retry: true,
    retryConfig: {
      // runReport is read-only, so retrying this POST is safe.
      retry: 1,
      noResponseRetries: 1,
      httpMethodsToRetry: ['POST'],
      retryDelay: 1000,
      onRetryAttempt: error => console.warn(
        `GA4 report retry for ${siteId} (${error.config?.retryConfig?.currentRetryAttempt}/1):`,
        error.code || error.response?.status || 'network error',
      ),
    },
  })));
  if (results[0].status === 'rejected') throw results[0].reason;
  const unavailableSections = results[1].status === 'rejected' ? ['engagement and revenue details'] : [];
  const responses = results.filter(result => result.status === 'fulfilled').map(result => result.value);

  const pages = new Map();
  const totals = {};
  for (const response of responses) {
    const metricNames = (response.data.metricHeaders || []).map(header => header.name);
    for (const row of response.data.rows || []) {
      const pagePath = normalizePagePath(row.dimensionValues?.[0]?.value);
      const current = pages.get(pagePath) || {};
      metricNames.forEach((name, index) => {
        current[name] = Number(row.metricValues?.[index]?.value || 0);
      });
      pages.set(pagePath, current);
    }
    const totalValues = response.data.totals?.[0]?.metricValues || [];
    metricNames.forEach((name, index) => {
      totals[name] = Number(totalValues[index]?.value || 0);
    });
  }

  for (const page of pages.values()) {
    page.pageViews = page.screenPageViews || 0;
    page.averageEngagementTime = page.userEngagementDuration == null ? null : page.activeUsers
      ? page.userEngagementDuration / page.activeUsers : 0;
  }
  const data = {
    enabled: true,
    status: 'available',
    unavailableSections,
    range: dateRange.label,
    currencyCode: responses.find(response => response.data.metadata?.currencyCode)?.data.metadata.currencyCode || 'USD',
    totals: {
      ...totals,
      pageViews: totals.screenPageViews || 0,
    },
    pages,
  };
  return data;
}

async function getSites() {
  const sites = await reportStorage.listSites();
  return sites.map(site => ({ ...site,
    searchConsole: isSearchConsoleConfigured(site.id), analytics: Boolean(GA4_PROPERTIES[site.id]),
    clarity: Boolean(CLARITY_PROJECTS[site.id] && process.env.CLARITY_API_TOKEN),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

async function serveFile(res, filePath, downloadName) {
  try {
    const data = await fs.readFile(filePath);
    const extension = path.extname(filePath);
    const headers = {
      'Content-Type': MIME[extension] || 'application/octet-stream',
      'Cache-Control': 'private, no-store',
    };
    if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName}"`;
    res.writeHead(200, headers);
    res.end(data);
  } catch (error) {
    json(res, error.code === 'ENOENT' ? 404 : 500, { error: 'File could not be loaded.' });
  }
}

function addExcelSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns;
  sheet.addRows(rows);
  sheet.autoFilter = { from: 'A1', to: sheet.getRow(1).getCell(columns.length).address };
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF173C2D' } };
    cell.alignment = { vertical: 'middle' };
  });
  sheet.getRow(1).height = 24;
  return sheet;
}

async function sendWorkbook(res, workbook, filename) {
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  res.writeHead(200, {
    'Content-Type': MIME['.xlsx'],
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

async function loadSiteRows(siteId) {
  return reportStorage.readRows(siteId);
}

function searchMetricMap(rows) {
  return new Map((rows || []).map(row => [normalizePagePath(row.key), row]));
}

function previousAnalyticsRange(dateRange) {
  const today = new Date().toISOString().slice(0, 10);
  const shiftDate = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const relativeDays = { '7daysAgo': 7, '30daysAgo': 30 }[dateRange.startDate];
  const endDate = dateRange.endDate === 'yesterday' ? shiftDate(today, -1) : dateRange.endDate;
  const startDate = dateRange.startDate === 'yesterday'
    ? shiftDate(today, -1)
    : relativeDays ? shiftDate(today, -relativeDays) : dateRange.startDate;
  const days = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1;
  const previousEnd = shiftDate(startDate, -1);
  const previousStart = shiftDate(previousEnd, 1 - days);
  return { startDate: previousStart, endDate: previousEnd, label: `${previousStart} to ${previousEnd}` };
}

async function buildSearchConsoleWorkbook(site, params) {
  const report = await getSearchReport(site.id, params);
  if (report.unavailableSections?.some(section => ['pages', 'previousPages'].includes(section))) {
    throw Object.assign(new Error('Page comparison is temporarily unavailable. Retry after the search connection recovers.'), { status: 502 });
  }
  const siteRows = await loadSiteRows(site.id);
  const current = searchMetricMap(report.pages);
  const previous = searchMetricMap(report.previousPages);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Core Web Vitals Dashboard';
  workbook.created = new Date();

  addExcelSheet(workbook, 'Page comparison', [
    { header: 'Page', key: 'title', width: 36 },
    { header: 'URL', key: 'url', width: 65 },
    { header: 'Clicks', key: 'clicks', width: 13 },
    { header: 'Previous clicks', key: 'previousClicks', width: 17 },
    { header: 'Clicks change', key: 'clicksChange', width: 15 },
    { header: 'Impressions', key: 'impressions', width: 15 },
    { header: 'Previous impressions', key: 'previousImpressions', width: 20 },
    { header: 'Impressions change', key: 'impressionsChange', width: 19 },
    { header: 'CTR', key: 'ctr', width: 12, style: { numFmt: '0.00%' } },
    { header: 'Previous CTR', key: 'previousCtr', width: 15, style: { numFmt: '0.00%' } },
    { header: 'Position', key: 'position', width: 12, style: { numFmt: '0.00' } },
    { header: 'Previous position', key: 'previousPosition', width: 17, style: { numFmt: '0.00' } },
  ], siteRows.map(row => {
    const now = current.get(normalizePagePath(row.url)) || {};
    const before = previous.get(normalizePagePath(row.url)) || {};
    return {
      title: row.title || '', url: row.url,
      clicks: now.clicks || 0, previousClicks: before.clicks || 0,
      clicksChange: (now.clicks || 0) - (before.clicks || 0),
      impressions: now.impressions || 0, previousImpressions: before.impressions || 0,
      impressionsChange: (now.impressions || 0) - (before.impressions || 0),
      ctr: now.ctr || 0, previousCtr: before.ctr || 0,
      position: now.position || 0, previousPosition: before.position || 0,
    };
  }));

  addExcelSheet(workbook, 'Daily trend', [
    { header: 'Date', key: 'date', width: 15 },
    { header: 'Clicks', key: 'clicks', width: 13 },
    { header: 'Impressions', key: 'impressions', width: 15 },
    { header: 'CTR', key: 'ctr', width: 12, style: { numFmt: '0.00%' } },
    { header: 'Position', key: 'position', width: 12, style: { numFmt: '0.00' } },
  ], report.series);

  addExcelSheet(workbook, 'Queries', [
    { header: 'Query', key: 'key', width: 55 },
    { header: 'Clicks', key: 'clicks', width: 13 },
    { header: 'Impressions', key: 'impressions', width: 15 },
    { header: 'CTR', key: 'ctr', width: 12, style: { numFmt: '0.00%' } },
    { header: 'Position', key: 'position', width: 12, style: { numFmt: '0.00' } },
  ], report.queries);

  addExcelSheet(workbook, 'Report info', [
    { header: 'Field', key: 'field', width: 28 },
    { header: 'Value', key: 'value', width: 65 },
  ], [
    { field: 'Property', value: report.property },
    { field: 'Current period', value: `${report.startDate} to ${report.endDate}` },
    { field: 'Comparison period', value: `${report.previousStart} to ${report.previousEnd}` },
    { field: 'Latest available date', value: report.lastDataDate || 'No data' },
    { field: 'First incomplete date', value: report.firstIncompleteDate || 'None reported' },
    { field: 'Generated at', value: report.generatedAt },
  ]);
  return workbook;
}

async function buildAnalyticsWorkbook(site, dateRange) {
  const comparisonRange = previousAnalyticsRange(dateRange);
  const [report, previousReport] = await Promise.all([
    getAnalyticsReport(site.id, dateRange),
    getAnalyticsReport(site.id, comparisonRange),
  ]);
  if (report.status !== 'available') throw Object.assign(new Error('Google Analytics is not configured for this website.'), { status: 404 });
  const siteRows = await loadSiteRows(site.id);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Core Web Vitals Dashboard';
  workbook.created = new Date();
  const metricColumns = [
    ['Page views', 'pageViews'], ['Active users', 'activeUsers'], ['Total users', 'totalUsers'],
    ['New users', 'newUsers'], ['Sessions', 'sessions'], ['Engaged sessions', 'engagedSessions'],
    ['Engagement rate', 'engagementRate', '0.00%'], ['Bounce rate', 'bounceRate', '0.00%'],
    ['Avg session duration', 'averageSessionDuration', '0.00'], ['Views / session', 'screenPageViewsPerSession', '0.00'],
    ['Engagement duration', 'userEngagementDuration', '0.00'], ['Sessions / user', 'sessionsPerUser', '0.00'],
    ['Event count', 'eventCount'], ['Events / user', 'eventCountPerUser', '0.00'],
    ['Events / session', 'eventsPerSession', '0.00'], ['Key events', 'keyEvents'],
    ['Session key event rate', 'sessionKeyEventRate', '0.00%'], ['Transactions', 'transactions'],
    ['Purchase revenue', 'purchaseRevenue', '0.00'], ['Total revenue', 'totalRevenue', '0.00'],
  ];
  const emptyMetrics = Object.fromEntries(metricColumns.map(([, key]) => [key, report.totals[key] == null ? null : 0]));
  addExcelSheet(workbook, 'Page analytics', [
    { header: 'Page', key: 'title', width: 36 },
    { header: 'URL', key: 'url', width: 65 },
    ...metricColumns.map(([header, key, numFmt]) => ({ header, key, width: 18, ...(numFmt ? { style: { numFmt } } : {}) })),
  ], siteRows.map(row => ({
    title: row.title || '',
    url: row.url,
    ...emptyMetrics,
    ...(report.pages.get(normalizePagePath(row.url)) || {}),
  })));
  const comparisonMetrics = [
    ['Page views', 'pageViews'], ['Active users', 'activeUsers'], ['Sessions', 'sessions'],
    ['Engaged sessions', 'engagedSessions'], ['Key events', 'keyEvents'], ['Transactions', 'transactions'],
  ];
  addExcelSheet(workbook, 'Period comparison', [
    { header: 'Page', key: 'title', width: 36 },
    { header: 'URL', key: 'url', width: 65 },
    ...comparisonMetrics.flatMap(([label, key]) => [
      { header: label, key, width: 17 },
      { header: `Previous ${label.toLowerCase()}`, key: `previous_${key}`, width: 20 },
      { header: `${label} change`, key: `change_${key}`, width: 18 },
    ]),
  ], siteRows.map(row => {
    const pagePath = normalizePagePath(row.url);
    const now = report.pages.get(pagePath) || {};
    const before = previousReport.pages.get(pagePath) || {};
    const values = { title: row.title || '', url: row.url };
    comparisonMetrics.forEach(([, key]) => {
      values[key] = report.totals[key] == null ? null : now[key] || 0;
      values[`previous_${key}`] = previousReport.totals[key] == null ? null : before[key] || 0;
      values[`change_${key}`] = values[key] == null || values[`previous_${key}`] == null ? null : values[key] - values[`previous_${key}`];
    });
    return values;
  }));
  addExcelSheet(workbook, 'Report info', [
    { header: 'Field', key: 'field', width: 28 },
    { header: 'Value', key: 'value', width: 65 },
  ], [
    { field: 'Property', value: GA4_PROPERTIES[site.id] },
    { field: 'Date range', value: dateRange.label },
    { field: 'Comparison range', value: comparisonRange.label },
    { field: 'Analytics fetched at', value: report.cache?.fetchedAt || '' },
    { field: 'Analytics cache status', value: report.cache?.status || 'live' },
    { field: 'Delayed sections', value: report.unavailableSections?.join(', ') || 'None' },
    { field: 'Generated at', value: new Date().toISOString() },
  ]);
  return workbook;
}

async function handler(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (await auth.handle(req, res, requestUrl.pathname)) return;

    if (requestUrl.pathname === '/api/sites') {
      return json(res, 200, await getSites());
    }

    const searchDownloadMatch = requestUrl.pathname.match(/^\/api\/sites\/([a-z0-9_]+)\/search-console\/download$/i);
    if (searchDownloadMatch) {
      try {
        const sites = await getSites();
        const site = sites.find(item => item.id === searchDownloadMatch[1]);
        if (!site?.searchConsole) return json(res, 404, { error: 'Search Console is not configured for this website.' });
        const workbook = await buildSearchConsoleWorkbook(site, requestUrl.searchParams);
        const date = new Date().toISOString().slice(0, 10);
        return sendWorkbook(res, workbook, `Search_Console_${site.id}_${date}.xlsx`);
      } catch (error) {
        console.error('Search Console Excel export failed:', error.message);
        return json(res, error.status || 502, { error: 'Search Console Excel could not be generated.' });
      }
    }

    const analyticsDownloadMatch = requestUrl.pathname.match(/^\/api\/sites\/([a-z0-9_]+)\/analytics\/download$/i);
    if (analyticsDownloadMatch) {
      try {
        const sites = await getSites();
        const site = sites.find(item => item.id === analyticsDownloadMatch[1]);
        if (!site) return json(res, 404, { error: 'Site not found.' });
        const dateRange = getAnalyticsDateRange(requestUrl.searchParams);
        const workbook = await buildAnalyticsWorkbook(site, dateRange);
        const date = new Date().toISOString().slice(0, 10);
        return sendWorkbook(res, workbook, `Google_Analytics_${site.id}_${date}.xlsx`);
      } catch (error) {
        console.error('Google Analytics Excel export failed:', error.message);
        return json(res, error.status || 502, { error: 'Google Analytics Excel could not be generated.' });
      }
    }

    const searchMatch = requestUrl.pathname.match(/^\/api\/sites\/([a-z0-9_]+)\/search-console$/i);
    if (searchMatch) {
      try {
        return json(res, 200, await getSearchReport(searchMatch[1], requestUrl.searchParams));
      } catch (error) {
        const status = error.status || error.response?.status || Number(error.code);
        console.error('Search Console report failed:', error.code || status || '', error.message);
        const message = status === 403
          ? 'Search Console access denied. Add the dashboard service-account email to this property and enable the Search Console API in its Google Cloud project.'
          : error.code === 'GOOGLE_CONFIGURATION_ERROR' || [400, 404].includes(error.status) ? error.message : 'Search Console data is temporarily unavailable. Please try again.';
        return json(res, [400, 403, 404, 503].includes(status) ? status : 502, { error: message });
      }
    }

    const clarityMatch = requestUrl.pathname.match(/^\/api\/sites\/([a-z0-9_]+)\/clarity$/i);
    if (clarityMatch) {
      try {
        return json(res, 200, await getClarityReport(clarityMatch[1], requestUrl.searchParams.get('days')));
      } catch (error) {
        const status = error.status || Number(error.code);
        console.error('Clarity report failed:', error.code || status || '', error.message);
        const message = status === 503 ? error.message : status === 401 || status === 403
          ? 'Clarity access denied. Check the API token and project permissions.'
          : status === 429
            ? 'Clarity daily API limit reached. Try again tomorrow.'
            : 'Clarity data is temporarily unavailable. Please try again.';
        return json(res, [401, 403, 404, 429, 503].includes(status) ? status : 502, { error: message });
      }
    }

    const analyticsMatch = requestUrl.pathname.match(/^\/api\/sites\/([a-z0-9_]+)\/analytics$/i);
    if (analyticsMatch) {
      const site = (await getSites()).find(item => item.id === analyticsMatch[1]);
      if (!site) return json(res, 404, { error: 'Site not found.' });
      let range;
      try { range = getAnalyticsDateRange(requestUrl.searchParams); }
      catch (error) { return json(res, 400, { error: error.message }); }
      try {
        const report = await getAnalyticsReport(site.id, range, requestUrl.searchParams.get('refresh') === '1');
        return json(res, 200, { ...report, pages: Object.fromEntries(report.pages) });
      } catch (error) {
        if (error.code === 'GOOGLE_CONFIGURATION_ERROR') {
          console.error('GA4 configuration failed:', error.message);
          return json(res, 503, { error: error.message });
        }
        const status = error.response?.status || Number(error.code);
        console.error('GA4 report failed:', error.code || status || '', error.message);
        const message = status === 403 ? 'Google Analytics access denied. Check this property and service-account permissions.'
          : status === 429 ? 'Google Analytics request limit reached. Please retry shortly.'
          : 'Google Analytics connection is temporarily unavailable. Your performance report is ready; retry analytics shortly.';
        return json(res, [403, 429].includes(status) ? status : 502, { error: message });
      }
    }

    const siteMatch = requestUrl.pathname.match(/^\/api\/sites\/([a-z0-9_]+)$/i);
    if (siteMatch) {
      const sites = await getSites();
      const site = sites.find(item => item.id === siteMatch[1]);
      if (!site) return json(res, 404, { error: 'Site not found.' });
      const rows = await loadSiteRows(site.id);
      return json(res, 200, { site, rows: rows.map(row => ({ ...row, traffic: null })), analytics: {
        enabled: Boolean(GA4_PROPERTIES[site.id]), status: GA4_PROPERTIES[site.id] ? 'loading' : 'not-configured', totals: null,
      } });
    }

    const downloadMatch = requestUrl.pathname.match(/^\/api\/sites\/([a-z0-9_]+)\/download$/i);
    if (downloadMatch) {
      const sites = await getSites();
      const site = sites.find(item => item.id === downloadMatch[1]);
      if (!site?.latestReport) return json(res, 404, { error: 'No Excel report is available.' });
      const data = await reportStorage.readReport(site.id, site.latestReport);
      res.writeHead(200, { 'Content-Type': MIME['.xlsx'], 'Content-Disposition': `attachment; filename="${site.latestReport}"`, 'Cache-Control': 'private, no-store' });
      return res.end(data);
    }

    const relative = requestUrl.pathname === '/' ? 'index.html' : requestUrl.pathname === '/login' ? 'login.html' : requestUrl.pathname.slice(1);
    const publicPath = path.resolve(PUBLIC, relative);
    if (!publicPath.startsWith(PUBLIC + path.sep) && publicPath !== path.join(PUBLIC, 'index.html')) {
      return json(res, 403, { error: 'Forbidden.' });
    }
    return serveFile(res, publicPath);
  } catch (error) {
    console.error(error);
    return json(res, error.status || 500, { error: error.status === 503 ? error.message : 'Dashboard request failed.' });
  }
}

if (require.main === module) {
  http.createServer(handler).listen(PORT, () => {
    console.log(`CWV dashboard running at http://localhost:${PORT}`);
  });
}

module.exports = handler;
