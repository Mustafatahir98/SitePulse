const path = require('path');
const os = require('os');
const { createReportCache } = require('./report-cache');
const { createBlobCache } = require('./blob-cache');

function createClarityReports({ env = process.env, fetchReport = fetch, cache } = {}) {
  const root = path.resolve(__dirname, '..');
  const directory = env.DASHBOARD_CACHE_DIR || (env.VERCEL ? path.join(os.tmpdir(), 'sitepulse-cache') : path.join(root, 'temp-file'));
  // Three ranges refreshed twice daily leave room within Clarity's 10-call daily quota.
  const reports = cache || createReportCache({
    file: path.join(directory, 'clarity-cache.json'), freshMs: 12 * 60 * 60 * 1000,
    maxAgeMs: 3 * 86400000, remote: createBlobCache('clarity', { env }),
  });
  return async function getClarityReport(siteId, days = 3) {
    const projectId = siteId === 'lotuspsychiatryandwellness_com' ? env.CLARITY_PROJECT_ID : '';
    const token = env.CLARITY_API_TOKEN;
    if (!projectId || !token) throw Object.assign(new Error('Clarity is not configured for this website. Set CLARITY_PROJECT_ID and CLARITY_API_TOKEN in Vercel Production and redeploy.'), { status: 503 });
    const numOfDays = [1, 2, 3].includes(Number(days)) ? Number(days) : 3;
    return reports.get(`${projectId}:${numOfDays}`, async () => {
      const response = await fetchReport(`https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=${numOfDays}`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error('Clarity API request failed.'), { status: response.status });
      if (!Array.isArray(payload)) throw Object.assign(new Error('Clarity returned an invalid report.'), { status: 502 });
      return { projectId, numOfDays, insights: payload };
    });
  };
}

module.exports = { createClarityReports };
