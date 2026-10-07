const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { createBlobStore, cachePath, CATALOG } = require('./blob-store');
const { validateCatalog } = require('./report-storage');
const ROOT = path.resolve(__dirname, '..');

async function uploadReports({ root = ROOT, blob = createBlobStore(), dryRun = false, log = console.log } = {}) {
  const files = await fs.readdir(root);
  const dataFiles = files.filter(name => /^oldScrapedData_[a-z0-9_]+\.json$/i.test(name));
  if (!dataFiles.length) throw new Error('No website report JSON files found in this project.');
  const planned = [];
  for (const file of dataFiles) {
    const id = file.slice('oldScrapedData_'.length, -'.json'.length);
    const raw = await fs.readFile(path.join(root, file));
    const rows = JSON.parse(raw.toString('utf8'));
    if (!Array.isArray(rows) || !rows.length || rows.some(row => !row || typeof row.url !== 'string' || !/^https?:$/.test(new URL(row.url).protocol))) throw new Error(`Invalid website report: ${file}`);
    const stat = await fs.stat(path.join(root, file));
    const host = new URL(rows[0].url).hostname.replace(/^www\./, '');
    const name = rows.find(row => row.siteName)?.siteName || host;
    const reports = files.filter(name => name.startsWith(`CWV_Report_${id}_`) && /^CWV_Report_[a-z0-9_]+_\d{4}-\d{2}-\d{2}\.xlsx$/i.test(name)).sort().reverse();
    const latestReport = reports[0] || null;
    planned.push({ id, name, host, pageCount: rows.length, raw, reports, latestReport,
      updatedAt: latestReport?.match(/(\d{4}-\d{2}-\d{2})\.xlsx$/)?.[1] || stat.mtime.toISOString() });
  }
  if (dryRun) {
    planned.forEach(site => log(`${site.id}: ${site.pageCount} pages, ${site.reports.length} Excel reports; latest ${site.latestReport || 'none'}`));
    log('Dry run complete. No files uploaded.');
    return { siteCount: planned.length, reportCount: planned.reduce((sum, site) => sum + site.reports.length, 0) };
  }
  if (!blob.configured()) throw new Error('Add BLOB_READ_WRITE_TOKEN to local .env, save it, then run npm run reports:upload. Do not share this token in chat.');
  const previous = await blob.readJson(CATALOG, { fresh: true });
  if (previous) validateCatalog(previous);
  const sites = new Map((previous?.sites || []).map(site => [site.id, site]));
  const generation = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  for (const site of planned) {
    const base = `sitepulse/reports/${site.id}/${generation}`;
    const dataPath = `${base}/data.json`;
    await blob.write(dataPath, site.raw);
    const reports = [];
    for (const name of site.reports) {
      const pathname = `${base}/${name}`;
      await blob.write(pathname, await fs.readFile(path.join(root, name)), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reports.push({ name, pathname });
    }
    const { raw, ...metadata } = site;
    sites.set(site.id, { ...metadata, reports, dataPath });
    log(`Uploaded ${site.id}: ${site.pageCount} pages, ${reports.length} Excel reports.`);
  }
  // Publish the manifest only after every referenced report is uploaded.
  const catalog = validateCatalog({ version: 1, uploadedAt: new Date().toISOString(), sites: [...sites.values()] });
  await blob.writeJson(CATALOG, catalog, true);
  let cacheEntries = 0;
  for (const [namespace, file] of [['analytics', 'analytics-cache.json'], ['search-console', 'search-console-cache.json'], ['clarity', 'clarity-cache.json']]) {
    try {
      const entries = JSON.parse(await fs.readFile(path.join(root, 'temp-file', file), 'utf8'));
      for (const [key, entry] of entries) {
        if (!entry?.data || !Number.isFinite(entry.time) || Date.now() - entry.time > 7 * 86400000) continue;
        await blob.writeJson(cachePath(namespace, key), { key, ...entry }, true);
        cacheEntries++;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') log(`Saved ${namespace} cache could not be synced; live reports will still load.`);
    }
  }
  log(`Report catalog published. ${cacheEntries} saved integration responses synced. Local files unchanged.`);
  return { siteCount: planned.length, reportCount: planned.reduce((sum, site) => sum + site.reports.length, 0), cacheEntries };
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
  uploadReports({ dryRun: process.argv.includes('--dry-run') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { uploadReports };
