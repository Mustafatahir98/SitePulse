const fs = require('fs/promises');
const path = require('path');
const { createBlobStore, CATALOG } = require('./blob-store');
const ROOT = path.resolve(__dirname, '..');

function validateCatalog(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.sites)) throw new Error('Invalid report catalog. Run npm run reports:upload again.');
  const seen = new Set();
  for (const site of value.sites) {
    if (!/^[a-z0-9_]+$/i.test(site.id) || seen.has(site.id) || !Array.isArray(site.reports) || typeof site.name !== 'string' || typeof site.host !== 'string' || !site.dataPath?.startsWith(`sitepulse/reports/${site.id}/`) || site.dataPath.includes('..')) throw new Error('Invalid report catalog site.');
    seen.add(site.id);
    for (const report of site.reports) {
      if (!/^CWV_Report_[a-z0-9_]+_\d{4}-\d{2}-\d{2}\.xlsx$/i.test(report.name) || !report.pathname?.startsWith(`sitepulse/reports/${site.id}/`) || report.pathname.includes('..')) throw new Error('Invalid report file reference.');
    }
  }
  return value;
}

function createReportStorage({ env = process.env, root = ROOT, blob = createBlobStore({ env }), clock = Date.now } = {}) {
  const cloud = env.DASHBOARD_REPORT_STORAGE === 'blob' || Boolean(env.VERCEL);
  let cachedCatalog;
  let catalogUntil = 0;
  let catalogLoad;
  const rowCache = new Map();
  const rowLoads = new Map();
  async function catalog() {
    if (cachedCatalog && clock() < catalogUntil) return cachedCatalog;
    if (catalogLoad) return catalogLoad;
    catalogLoad = (async () => {
      const value = await blob.readJson(CATALOG, { fresh: true });
      if (!value) throw Object.assign(new Error('No reports have been uploaded. Run npm run reports:upload on the computer with the report files.'), { status: 503 });
      cachedCatalog = validateCatalog(value);
      catalogUntil = clock() + 30000;
      return cachedCatalog;
    })().finally(() => { catalogLoad = null; });
    return catalogLoad;
  }
  function label(host) {
    return host.replace(/_com$|_tv$|_org$|_net$|_co$/i, '').split('_').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
  }
  async function listSites() {
    if (cloud) {
      const { sites } = await catalog();
      return sites.map(({ id, name, host, pageCount, updatedAt, latestReport }) => ({ id, name, host, pageCount, updatedAt, latestReport }));
    }
    const files = await fs.readdir(root);
    return Promise.all(files.filter(file => /^oldScrapedData_.+\.json$/i.test(file)).map(async file => {
      const id = file.replace(/^oldScrapedData_/, '').replace(/\.json$/i, '');
      const [raw, stat] = await Promise.all([fs.readFile(path.join(root, file), 'utf8'), fs.stat(path.join(root, file))]);
      const rows = JSON.parse(raw);
      const host = rows[0]?.url ? new URL(rows[0].url).hostname.replace(/^www\./, '') : id.replace(/_/g, '.');
      const latestReport = files.filter(name => name.startsWith(`CWV_Report_${id}_`) && name.endsWith('.xlsx')).sort().reverse()[0] || null;
      return { id, name: rows.find(row => row.siteName)?.siteName || label(id), host, pageCount: rows.length,
        updatedAt: latestReport?.match(/(\d{4}-\d{2}-\d{2})\.xlsx$/)?.[1] || stat.mtime.toISOString(), latestReport };
    }));
  }
  async function readRows(siteId) {
    if (!/^[a-z0-9_]+$/i.test(siteId)) throw Object.assign(new Error('Invalid website.'), { status: 400 });
    if (!cloud) return JSON.parse(await fs.readFile(path.join(root, `oldScrapedData_${siteId}.json`), 'utf8'));
    const site = (await catalog()).sites.find(item => item.id === siteId);
    if (!site) throw Object.assign(new Error('Site not found.'), { status: 404 });
    if (rowCache.has(site.dataPath)) return rowCache.get(site.dataPath);
    if (!rowLoads.has(site.dataPath)) rowLoads.set(site.dataPath, blob.readJson(site.dataPath).then(rows => {
      if (!Array.isArray(rows)) throw new Error('Report data is missing or invalid.');
      if (rowCache.size >= 10) rowCache.delete(rowCache.keys().next().value);
      rowCache.set(site.dataPath, rows);
      return rows;
    }).finally(() => rowLoads.delete(site.dataPath)));
    return rowLoads.get(site.dataPath);
  }
  async function readReport(siteId, filename) {
    if (!/^CWV_Report_[a-z0-9_]+_\d{4}-\d{2}-\d{2}\.xlsx$/i.test(filename)) throw Object.assign(new Error('Invalid report file.'), { status: 400 });
    if (!cloud) return fs.readFile(path.join(root, filename));
    const site = (await catalog()).sites.find(item => item.id === siteId);
    const report = site?.reports.find(item => item.name === filename);
    if (!report) throw Object.assign(new Error('Report not found.'), { status: 404 });
    const content = await blob.read(report.pathname);
    if (!content) throw Object.assign(new Error('Report not found.'), { status: 404 });
    return content;
  }
  return { listSites, readRows, readReport };
}

module.exports = { createReportStorage, validateCatalog };
