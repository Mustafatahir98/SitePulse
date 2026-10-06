const axios = require('axios');
const cheerio = require('cheerio');
const { parseStringPromise } = require('xml2js');
const ExcelJS = require('exceljs');
const fs = require('fs/promises');
const path = require('path');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const http = require('http');
const https = require('https');

require('dotenv').config();

const OLD_DATA_FILE = path.join(__dirname, 'oldScrapedData.json');

// Reuse sockets instead of opening a fresh TLS connection for every page.
// This is both faster and much less prone to transient socket disconnects.
const networkClient = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 12 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 12 }),
  timeout: 45000,
  maxRedirects: 10,
  headers: { 'User-Agent': 'Core-Web-Vitals-Reporter/1.0' },
});

function isTransientNetworkError(error) {
  const status = error.response?.status;
  return status === 408
    || status === 425
    || status === 429
    || status >= 500
    || ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EPIPE', 'EAI_AGAIN']
      .includes(error.code);
}

async function getWithRetry(url, config = {}, options = {}) {
  const attempts = options.attempts || 4;
  const label = options.label || 'Request';

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await networkClient.get(url, config);
    } catch (error) {
      if (!isTransientNetworkError(error) || attempt === attempts - 1) throw error;
      const delayMs = Math.min(1000 * (2 ** attempt) + Math.floor(Math.random() * 500), 8000);
      console.warn(`  ${label} temporary network retry ${attempt + 1}/${attempts - 1} in ${Math.ceil(delayMs / 1000)}s`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`${label} failed after ${attempts} attempts`);
}

const PAGESPEED_CATEGORY_NAMES = {
  performance: 'Performance',
  accessibility: 'Accessibility',
  'best-practices': 'Best Practices',
  seo: 'SEO',
};

function extractPageSpeedDiagnostics(categories, audits) {
  const diagnostics = new Map();

  Object.entries(categories).forEach(([categoryKey, category]) => {
    (category.auditRefs || []).forEach(ref => {
      const audit = audits[ref.id];
      if (!audit || audit.score == null || typeof audit.score !== 'number') return;

      const score = Math.round(audit.score * 100);
      const existing = diagnostics.get(ref.id);
      const categoryName = PAGESPEED_CATEGORY_NAMES[categoryKey] || category?.title || categoryKey;
      const categoriesForAudit = existing?.categories || [];
      if (!categoriesForAudit.includes(categoryName)) categoriesForAudit.push(categoryName);

      diagnostics.set(ref.id, {
        id: ref.id,
        title: audit.title || ref.id,
        description: audit.description || '',
        displayValue: audit.displayValue || '',
        score,
        severity: score < 50 ? 'critical' : score < 90 ? 'warning' : 'passed',
        categories: categoriesForAudit,
        savingsMs: Math.round(audit.details?.overallSavingsMs || 0),
        savingsBytes: Math.round(audit.details?.overallSavingsBytes || 0),
        itemCount: Array.isArray(audit.details?.items) ? audit.details.items.length : 0,
      });
    });
  });

  const severityOrder = { critical: 0, warning: 1, passed: 2 };
  return [...diagnostics.values()].sort((a, b) =>
    severityOrder[a.severity] - severityOrder[b.severity] || a.score - b.score || a.title.localeCompare(b.title)
  );
}

// ─────────────────────────────────────────────
//  PageSpeed / Core Web Vitals
// ─────────────────────────────────────────────

const PSI_MAX_PAGE_CONCURRENCY = 4;
const PSI_MAX_REQUEST_CONCURRENCY = 4;
const PSI_MIN_PAGE_CONCURRENCY = 1;
const PSI_MAX_ATTEMPTS = 4;
const PSI_RECOVERY_ROUNDS = 2;
const psiPressure = {
  pageConcurrency: PSI_MAX_PAGE_CONCURRENCY,
  lastPressureAt: 0,
  lastReductionAt: 0,
  successesSincePressure: 0,
};

let activePageSpeedRequests = 0;
const pageSpeedRequestQueue = [];

function runWithPageSpeedLimit(task) {
  return new Promise((resolve, reject) => {
    pageSpeedRequestQueue.push({ task, resolve, reject });

    const drain = () => {
      while (activePageSpeedRequests < PSI_MAX_REQUEST_CONCURRENCY && pageSpeedRequestQueue.length) {
        const next = pageSpeedRequestQueue.shift();
        activePageSpeedRequests += 1;
        Promise.resolve()
          .then(next.task)
          .then(next.resolve, next.reject)
          .finally(() => {
            activePageSpeedRequests -= 1;
            drain();
          });
      }
    };

    drain();
  });
}

function isRetryablePageSpeedError(error) {
  const status = error.response?.status;
  const reason = error.response?.data?.error?.errors?.[0]?.reason;
  return status === 408
    || status === 425
    || status === 429
    || status >= 500
    || (status === 403 && ['rateLimitExceeded', 'userRateLimitExceeded', 'backendError'].includes(reason))
    || error.retryable === true
    || ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(error.code);
}

function retryDelayMs(error, attempt) {
  const retryAfter = error.response?.headers?.['retry-after'];
  let retryAfterMs = 0;

  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    retryAfterMs = Number.isFinite(seconds)
      ? seconds * 1000
      : Math.max(0, Date.parse(retryAfter) - Date.now());
  }

  const exponentialMs = 2000 * (2 ** attempt);
  const jitterMs = Math.floor(Math.random() * 1000);
  return Math.min(Math.max(retryAfterMs, exponentialMs) + jitterMs, 30000);
}

function notePageSpeedPressure() {
  const now = Date.now();
  psiPressure.successesSincePressure = 0;

  // Simultaneous mobile/desktop failures count as one pressure event.
  if (now - psiPressure.lastReductionAt >= 5000
      && psiPressure.pageConcurrency > PSI_MIN_PAGE_CONCURRENCY) {
    psiPressure.pageConcurrency -= 1;
    psiPressure.lastReductionAt = now;
    console.warn(`  PageSpeed pressure detected; reducing page concurrency to ${psiPressure.pageConcurrency}.`);
  }

  psiPressure.lastPressureAt = now;
}

function notePageSpeedSuccess() {
  psiPressure.successesSincePressure += 1;
  const pressureHasCooled = Date.now() - psiPressure.lastPressureAt >= 30000;

  if (pressureHasCooled
      && psiPressure.successesSincePressure >= 12
      && psiPressure.pageConcurrency < PSI_MAX_PAGE_CONCURRENCY) {
    psiPressure.pageConcurrency += 1;
    psiPressure.successesSincePressure = 0;
    console.log(`  PageSpeed API stable; increasing page concurrency to ${psiPressure.pageConcurrency}.`);
  }
}

async function fetchPageSpeedData(url, strategy = 'mobile') {
  const API_KEY  = process.env.PAGESPEED_API_KEY;
  const endpoint = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

  if (!API_KEY) throw new Error('PAGESPEED_API_KEY is missing from .env');

  const params = new URLSearchParams();
  params.append('url', url);
  params.append('strategy', strategy);
  params.append('key', API_KEY);
  params.append('category', 'performance');
  params.append('category', 'accessibility');
  params.append('category', 'best-practices');
  params.append('category', 'seo');

  try {
    let response;
    let lastError;

    for (let attempt = 0; attempt < PSI_MAX_ATTEMPTS; attempt += 1) {
      try {
        response = await runWithPageSpeedLimit(() => networkClient.get(
          `${endpoint}?${params.toString()}`,
          { timeout: 90000 }
        ));
        const responseLhr = response.data?.lighthouseResult;
        if (!responseLhr || responseLhr.runtimeError || responseLhr.categories?.performance?.score == null) {
          const incompleteError = new Error(
            responseLhr?.runtimeError?.message || 'PageSpeed returned an incomplete Lighthouse result'
          );
          incompleteError.retryable = true;
          throw incompleteError;
        }
        notePageSpeedSuccess();
        break;
      } catch (error) {
        lastError = error;
        if (!isRetryablePageSpeedError(error) || attempt === PSI_MAX_ATTEMPTS - 1) throw error;

        notePageSpeedPressure();
        const delayMs = retryDelayMs(error, attempt);
        console.warn(`  PageSpeed retry ${attempt + 1}/${PSI_MAX_ATTEMPTS - 1} [${strategy}] in ${Math.round(delayMs / 1000)}s: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    if (!response) throw lastError || new Error('PageSpeed request failed');

    const data       = response.data;
    const lhr        = data.lighthouseResult;
    const categories = lhr?.categories || {};
    const audits     = lhr?.audits     || {};
    const loadingExp = data.loadingExperience?.metrics || {};

    const catScore = (key) => {
      const s = categories[key]?.score;
      return s != null ? Math.round(s * 100) : 'N/A';
    };

    const auditDisplay = (key) => audits[key]?.displayValue ?? 'N/A';

    const auditScore = (key) => {
      const s = audits[key]?.score;
      return s != null ? Math.round(s * 100) : 'N/A';
    };

    const metricValue = (key) => {
      const m = loadingExp[key];
      if (!m) return 'N/A';
      const val = m.percentile != null ? m.percentile : 'N/A';
      return `${val} (${m.category || ''})`;
    };

    const metricCategory = (key) => {
      const m = loadingExp[key];
      return m?.category ?? null;
    };

    return {
      performanceScore:   catScore('performance'),
      accessibilityScore: catScore('accessibility'),
      bestPracticesScore: catScore('best-practices'),
      seoScore:           catScore('seo'),

      lcpFieldData:  metricValue('LARGEST_CONTENTFUL_PAINT_MS'),
      fidFieldData:  metricValue('FIRST_INPUT_DELAY_MS'),
      clsFieldData:  metricValue('CUMULATIVE_LAYOUT_SHIFT_SCORE'),
      inpFieldData:  metricValue('INTERACTION_TO_NEXT_PAINT'),
      fcpFieldData:  metricValue('FIRST_CONTENTFUL_PAINT_MS'),
      ttfbFieldData: metricValue('EXPERIMENTAL_TIME_TO_FIRST_BYTE'),

      lcpFieldCategory:  metricCategory('LARGEST_CONTENTFUL_PAINT_MS'),
      fidFieldCategory:  metricCategory('FIRST_INPUT_DELAY_MS'),
      clsFieldCategory:  metricCategory('CUMULATIVE_LAYOUT_SHIFT_SCORE'),
      inpFieldCategory:  metricCategory('INTERACTION_TO_NEXT_PAINT'),
      fcpFieldCategory:  metricCategory('FIRST_CONTENTFUL_PAINT_MS'),
      ttfbFieldCategory: metricCategory('EXPERIMENTAL_TIME_TO_FIRST_BYTE'),

      lcpLab:        auditDisplay('largest-contentful-paint'),
      clsLab:        auditDisplay('cumulative-layout-shift'),
      fcpLab:        auditDisplay('first-contentful-paint'),
      ttiLab:        auditDisplay('interactive'),
      tbtLab:        auditDisplay('total-blocking-time'),
      speedIndexLab: auditDisplay('speed-index'),

      lcpScore: auditScore('largest-contentful-paint'),
      clsScore: auditScore('cumulative-layout-shift'),
      fcpScore: auditScore('first-contentful-paint'),
      ttiScore: auditScore('interactive'),
      tbtScore: auditScore('total-blocking-time'),
      speedIndexScore: auditScore('speed-index'),

      // Keep PageSpeed audit results so the dashboard can show the actual
      // issues behind each category score, not only the headline CWV values.
      diagnostics: extractPageSpeedDiagnostics(categories, audits),

      overallCategory:       data.loadingExperience?.overall_category  ?? 'N/A',
      originOverallCategory: data.originLoadingExperience?.overall_category ?? 'N/A',
    };
  } catch (error) {
    console.error(`  PageSpeed error [${strategy}] ${url}: ${error.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
//  Sitemap
// ─────────────────────────────────────────────

// -----------------------------------------------------------------------------
//  AI recommendations (one Groq request covers mobile and desktop)
// -----------------------------------------------------------------------------

const AI_SUGGESTION_LIMIT = 4;

function compactDiagnostics(pageSpeed) {
  return (Array.isArray(pageSpeed?.diagnostics) ? pageSpeed.diagnostics : [])
    .filter(audit => audit.severity !== 'passed')
    .slice(0, 8)
    .map(audit => ({
      id: audit.id,
      title: audit.title,
      score: audit.score,
      severity: audit.severity,
      displayValue: audit.displayValue || undefined,
      savingsMs: audit.savingsMs || undefined,
      savingsBytes: audit.savingsBytes || undefined,
      itemCount: audit.itemCount || undefined,
    }));
}

function normalizeAiSuggestions(value) {
  const normalizeDevice = suggestions => (Array.isArray(suggestions) ? suggestions : [])
    .slice(0, AI_SUGGESTION_LIMIT)
    .map(suggestion => ({
      title: String(suggestion?.title || '').trim(),
      issue: String(suggestion?.issue || '').trim(),
      impact: String(suggestion?.impact || '').trim(),
      recommendation: String(suggestion?.recommendation || '').trim(),
      priority: ['high', 'medium', 'low'].includes(String(suggestion?.priority).toLowerCase())
        ? String(suggestion.priority).toLowerCase()
        : 'medium',
    }))
    .filter(suggestion => suggestion.title && suggestion.recommendation);

  return {
    mobile: normalizeDevice(value?.mobile),
    desktop: normalizeDevice(value?.desktop),
  };
}

function parseJsonResponse(content) {
  const text = String(content || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('Groq returned an invalid JSON response');
  }
}

async function fetchAiSuggestions(url, mobilePageSpeed, desktopPageSpeed) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const input = {
    url,
    mobile: {
      performanceScore: mobilePageSpeed?.performanceScore,
      diagnostics: compactDiagnostics(mobilePageSpeed),
    },
    desktop: {
      performanceScore: desktopPageSpeed?.performanceScore,
      diagnostics: compactDiagnostics(desktopPageSpeed),
    },
  };

  if (!input.mobile.diagnostics.length && !input.desktop.diagnostics.length) {
    return { mobile: [], desktop: [] };
  }

  const requestBody = {
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
    messages: [
      {
        role: 'system',
        content: `You are a senior web performance engineer. Create concise, implementation-ready recommendations using only the supplied PageSpeed audits. Never invent page elements, measurements, technologies, or causes that are not supported by the input. Return valid JSON only, shaped as {"mobile":[],"desktop":[]}. Each device array may contain at most ${AI_SUGGESTION_LIMIT} objects with exactly these string fields: title, issue, impact, recommendation, priority. Priority must be high, medium, or low. Do not use Markdown. If a device has no failed audits, return an empty array for it.`,
      },
      { role: 'user', content: JSON.stringify(input) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
    max_completion_tokens: 1400,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await networkClient.post(
        'https://api.groq.com/openai/v1/chat/completions',
        requestBody,
        {
          timeout: 45000,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );
      return normalizeAiSuggestions(parseJsonResponse(response.data?.choices?.[0]?.message?.content));
    } catch (error) {
      const status = error.response?.status;
      if ((status === 429 || isTransientNetworkError(error)) && attempt === 0) {
        const retryAfter = status === 429
          ? Math.min(Number(error.response?.headers?.['retry-after']) || 3, 15)
          : 2;
        console.warn(`  AI request temporary network retry for ${url} in ${retryAfter}s`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      console.warn(`  AI suggestions skipped for ${url}: ${error.message}`);
      return null;
    }
  }

  return null;
}

async function fetchSitemap(url, visited = new Set()) {
  if (visited.has(url)) return [];
  visited.add(url);

  try {
    const response = await getWithRetry(
      url,
      { timeout: 30000, responseType: 'text' },
      { attempts: 4, label: 'Sitemap' }
    );
    const sitemap  = await parseStringPromise(response.data);

    if (Array.isArray(sitemap.urlset?.url)) {
      return sitemap.urlset.url
        .map(entry => entry.loc?.[0])
        .filter(Boolean);
    }

    const childSitemaps = (sitemap.sitemapindex?.sitemap || [])
      .map(entry => entry.loc?.[0])
      .filter(Boolean);
    const pageUrls = [];

    // Fetch child sitemaps sequentially so a large sitemap index cannot cause
    // another burst of requests or make individual child failures invisible.
    for (const childUrl of childSitemaps) {
      pageUrls.push(...await fetchSitemap(childUrl, visited));
    }

    return pageUrls;
  } catch (error) {
    console.error(`Error fetching sitemap ${url}: ${error.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────
//  Meta scraping
// ─────────────────────────────────────────────

function getSchemaTypes($) {
  let types = [];
  $('script[type="application/ld+json"]').each((i, elem) => {
    try {
      const data = JSON.parse($(elem).html());
      if (data['@graph']) {
        data['@graph'].forEach(item => { if (item['@type']) types.push(item['@type']); });
      } else if (data['@type']) {
        types.push(data['@type']);
      }
    } catch (e) { /* ignore */ }
  });
  return types.join(', ');
}

async function scrapePage(url) {
  try {
    const response = await getWithRetry(
      url,
      { timeout: 30000, responseType: 'text' },
      { attempts: 4, label: 'Page scrape' }
    );
    const $        = cheerio.load(response.data);
    const robots   = $('meta[name="robots"]').attr('content');
    return {
      url,
      locale:        $('meta[property="og:locale"]').attr('content'),
      type:          $('meta[property="og:type"]').attr('content'),
      title:         $('meta[property="og:title"]').attr('content'),
      description:   $('meta[property="og:description"]').attr('content'),
      siteName:      $('meta[property="og:site_name"]').attr('content'),
      updatedTime:   $('meta[property="og:updated_time"]').attr('content'),
      image:         $('meta[property="og:image"]').attr('content'),
      imageWidth:    $('meta[property="og:image:width"]').attr('content'),
      imageHeight:   $('meta[property="og:image:height"]').attr('content'),
      imageAlt:      $('meta[property="og:image:alt"]').attr('content'),
      imageType:     $('meta[property="og:image:type"]').attr('content'),
      video:         $('meta[property="og:video"]').attr('content'),
      videoDuration: $('meta[property="video:duration"]').attr('content'),
      schema:        getSchemaTypes($),
      robots,
      isIndexable:   !(robots && /noindex/i.test(robots)),
    };
  } catch (error) {
    console.error(`  Scrape error ${url}: ${error.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
//  Old data
// ─────────────────────────────────────────────

async function saveNewData(data, hostname) {
  const file = path.join(__dirname, `oldScrapedData_${hostname.replace(/\W+/g, '_')}.json`);
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function readOldData(hostname) {
  try {
    const file = path.join(__dirname, `oldScrapedData_${hostname.replace(/\W+/g, '_')}.json`);
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────
//  Style helpers
// ─────────────────────────────────────────────

function scoreColor(score) {
  if (score === 'N/A' || score == null) return null;
  const n = Number(score);
  if (isNaN(n)) return null;
  if (n >= 80) return '00C851';
  if (n >= 50) return 'FFBB33';
  return 'FF4444';
}

function categoryColor(cat) {
  if (!cat || cat === 'N/A') return null;
  const c = String(cat).toUpperCase();
  if (c === 'FAST')    return '00C851';
  if (c === 'AVERAGE') return 'FFBB33';
  return 'FF4444';
}

function applyScoreStyle(cell, score) {
  const color = scoreColor(score);
  if (color) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + color } };
    cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
  }
  cell.alignment = { horizontal: 'center' };
}

function applyCategoryStyle(cell) {
  const color = categoryColor(cell.value);
  if (color) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + color } };
    cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
  }
  cell.alignment = { horizontal: 'center' };
}

function styleHeader(row, bgArgb) {
  row.font      = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 10 };
  row.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height    = 30;
}

function parseLabValue(displayValue) {
  if (!displayValue || displayValue === 'N/A') return null;
  const str = String(displayValue).trim();
  const match = str.match(/^([\d.]+)\s*(s|ms)?/i);
  if (!match) return null;
  const num  = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  if (unit === 's')  return num * 1000;
  if (unit === 'ms') return num;
  return num;
}

function cwvLabColor(metric, displayValue) {
  const v = parseLabValue(displayValue);
  if (v === null) return null;
  const thresholds = {
    lcp:        { good: 2500,  mid: 4000  },
    fcp:        { good: 1800,  mid: 3000  },
    tbt:        { good: 200,   mid: 600   },
    tti:        { good: 3800,  mid: 7300  },
    speedIndex: { good: 3400,  mid: 5800  },
    cls:        { good: 0.1,   mid: 0.25  },
  };
  const t = thresholds[metric];
  if (!t) return null;
  if (v <= t.good) return '00C851';
  if (v <= t.mid)  return 'FFBB33';
  return 'FF4444';
}

function applyCwvLabStyle(cell, metric, displayValue) {
  const color = cwvLabColor(metric, displayValue);
  if (color) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + color } };
    cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
  }
  cell.alignment = { horizontal: 'center' };
}

function applyFieldMetricStyle(cell, displayValue, storedCategory) {
  let cat = storedCategory;
  if (!cat && displayValue) {
    const m = String(displayValue).match(/\(([^)]+)\)/);
    if (m) cat = m[1];
  }
  const color = categoryColor(cat);
  if (color) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + color } };
    cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
  }
  cell.alignment = { horizontal: 'center' };
}

// ─────────────────────────────────────────────
//  Google Sheets Integration
// ─────────────────────────────────────────────

async function getGoogleSheetsClient() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyFile) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY missing in .env');

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

function buildCwvRows(allResults) {
  const headers = [
    'URL',
    'Overall CWV (Field)',
    'Performance (Mobile)',
    'Performance (Desktop)',
    'Accessibility (Mobile)',
    'Best Practices (Mobile)',
    'SEO (Mobile)',
    'LCP Lab (Mobile)',
    'CLS Lab (Mobile)',
    'FCP Lab (Mobile)',
    'TBT Lab (Mobile)',
    'TTI Lab (Mobile)',
    'Speed Index (Mobile)',
    'LCP (Field)',
    'CLS (Field)',
    'FID (Field)',
    'INP (Field)',
    'Run Date',
  ];

  const date = new Date().toISOString().slice(0, 10);

  const dataRows = allResults.map(item => {
    const m = item.mobilePageSpeed  || {};
    const d = item.desktopPageSpeed || {};
    return [
      item.url                                                   ?? '',
      m.overallCategory                                          ?? '',
      m.performanceScore   != null ? String(m.performanceScore)   : '',
      d.performanceScore   != null ? String(d.performanceScore)   : '',
      m.accessibilityScore != null ? String(m.accessibilityScore) : '',
      m.bestPracticesScore != null ? String(m.bestPracticesScore) : '',
      m.seoScore           != null ? String(m.seoScore)           : '',
      m.lcpLab             ?? '',
      m.clsLab             ?? '',
      m.fcpLab             ?? '',
      m.tbtLab             ?? '',
      m.ttiLab             ?? '',
      m.speedIndexLab      ?? '',
      m.lcpFieldData       ?? '',
      m.clsFieldData       ?? '',
      m.fidFieldData       ?? '',
      m.inpFieldData       ?? '',
      date,
    ];
  });

  return [headers, ...dataRows];
}

async function ensureSheet(sheetsClient, spreadsheetId, title) {
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === title);
  if (existing) return existing.properties.sheetId;

  const res = await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title } } }],
    },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

async function writeRowsToSheet(sheetsClient, spreadsheetId, sheetTitle, rows) {
  const range = `'${sheetTitle}'!A1`;

  await sheetsClient.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${sheetTitle}'`,
  });

  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  console.log(`  ✓ Written ${rows.length - 1} data rows → tab: "${sheetTitle}"`);
}

async function formatHeaderRow(sheetsClient, spreadsheetId, sheetId, colCount) {
  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: colCount },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.176, green: 0.416, blue: 0.624 },
                textFormat:      { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                horizontalAlignment: 'CENTER',
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        {
          autoResizeDimensions: {
            dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: colCount },
          },
        },
      ],
    },
  });
}

async function uploadToGoogleSheets(allResults, hostname) {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!spreadsheetId) {
    console.warn('  ⚠️  GOOGLE_SPREADSHEET_ID not set — skipping Google Sheets upload.');
    return;
  }

  console.log(`\n📊 Uploading CWV Summary to Google Sheets...`);

  let sheetsClient;
  try {
    sheetsClient = await getGoogleSheetsClient();
  } catch (e) {
    console.error(`  Google Sheets auth error: ${e.message}`);
    return;
  }

  const rows      = buildCwvRows(allResults);
  const colCount  = rows[0].length;
  const dateStamp = new Date().toISOString().slice(0, 10);

  // ── Tab 1: CWV Master (always latest) ──────────────────────────
  const masterTitle = `CWV Master — ${hostname}`;
  try {
    const masterSheetId = await ensureSheet(sheetsClient, spreadsheetId, masterTitle);
    await writeRowsToSheet(sheetsClient, spreadsheetId, masterTitle, rows);
    await formatHeaderRow(sheetsClient, spreadsheetId, masterSheetId, colCount);
    console.log(`  ✓ Master tab updated: "${masterTitle}"`);
  } catch (e) {
    console.error(`  Master tab error: ${e.message}`);
  }

  // ── Tab 2: CWV YYYY-MM-DD (dated backup) ───────────────────────
  const backupTitle = `CWV ${dateStamp} — ${hostname}`;
  try {
    const backupSheetId = await ensureSheet(sheetsClient, spreadsheetId, backupTitle);
    await writeRowsToSheet(sheetsClient, spreadsheetId, backupTitle, rows);
    await formatHeaderRow(sheetsClient, spreadsheetId, backupSheetId, colCount);
    console.log(`  ✓ Backup tab created: "${backupTitle}"`);
  } catch (e) {
    console.error(`  Backup tab error: ${e.message}`);
  }

  console.log(`  🔗 https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}

// ─────────────────────────────────────────────
//  Excel report
// ─────────────────────────────────────────────

async function createExcelReport(allResults, filePath, hostname) {
  const oldData  = await readOldData(hostname);
  const workbook = new ExcelJS.Workbook();

  // ── Sheet 1: CWV Summary ────────────────────────────────────────
  const s1 = workbook.addWorksheet('CWV Summary');
  s1.columns = [
    { header: 'URL',                      key: 'url',          width: 55 },
    { header: 'Overall CWV (Field)',       key: 'overall',      width: 20 },
    { header: 'Performance (Mobile)',      key: 'mPerf',        width: 20 },
    { header: 'Performance (Desktop)',     key: 'dPerf',        width: 20 },
    { header: 'Accessibility (Mobile)',    key: 'mAccess',      width: 22 },
    { header: 'Best Practices (Mobile)',   key: 'mBest',        width: 22 },
    { header: 'SEO (Mobile)',              key: 'mSeo',         width: 16 },
    { header: 'LCP Lab (Mobile)',          key: 'mLcp',         width: 18 },
    { header: 'CLS Lab (Mobile)',          key: 'mCls',         width: 18 },
    { header: 'FCP Lab (Mobile)',          key: 'mFcp',         width: 18 },
    { header: 'TBT Lab (Mobile)',          key: 'mTbt',         width: 18 },
    { header: 'TTI Lab (Mobile)',          key: 'mTti',         width: 18 },
    { header: 'Speed Index (Mobile)',      key: 'mSpeed',       width: 20 },
    { header: 'LCP (Field)',               key: 'lcpField',     width: 25 },
    { header: 'CLS (Field)',               key: 'clsField',     width: 25 },
    { header: 'FID (Field)',               key: 'fidField',     width: 25 },
    { header: 'INP (Field)',               key: 'inpField',     width: 25 },
  ];
  styleHeader(s1.getRow(1), 'FF2D6A9F');

  allResults.forEach(item => {
    const m   = item.mobilePageSpeed  || {};
    const d   = item.desktopPageSpeed || {};
    const row = s1.addRow({
      url:      item.url,
      overall:  m.overallCategory,
      mPerf:    m.performanceScore,
      dPerf:    d.performanceScore,
      mAccess:  m.accessibilityScore,
      mBest:    m.bestPracticesScore,
      mSeo:     m.seoScore,
      mLcp:     m.lcpLab,
      mCls:     m.clsLab,
      mFcp:     m.fcpLab,
      mTbt:     m.tbtLab,
      mTti:     m.ttiLab,
      mSpeed:   m.speedIndexLab,
      lcpField: m.lcpFieldData,
      clsField: m.clsFieldData,
      fidField: m.fidFieldData,
      inpField: m.inpFieldData,
    });
    row.font = { name: 'Arial', size: 9 };

    applyCategoryStyle(row.getCell('overall'));
    applyScoreStyle(row.getCell('mPerf'),   m.performanceScore);
    applyScoreStyle(row.getCell('dPerf'),   d.performanceScore);
    applyScoreStyle(row.getCell('mAccess'), m.accessibilityScore);
    applyScoreStyle(row.getCell('mBest'),   m.bestPracticesScore);
    applyScoreStyle(row.getCell('mSeo'),    m.seoScore);

    applyCwvLabStyle(row.getCell('mLcp'),   'lcp',        m.lcpLab);
    applyCwvLabStyle(row.getCell('mCls'),   'cls',        m.clsLab);
    applyCwvLabStyle(row.getCell('mFcp'),   'fcp',        m.fcpLab);
    applyCwvLabStyle(row.getCell('mTbt'),   'tbt',        m.tbtLab);
    applyCwvLabStyle(row.getCell('mTti'),   'tti',        m.ttiLab);
    applyCwvLabStyle(row.getCell('mSpeed'), 'speedIndex', m.speedIndexLab);

    applyFieldMetricStyle(row.getCell('lcpField'), m.lcpFieldData, m.lcpFieldCategory);
    applyFieldMetricStyle(row.getCell('clsField'), m.clsFieldData, m.clsFieldCategory);
    applyFieldMetricStyle(row.getCell('fidField'), m.fidFieldData, m.fidFieldCategory);
    applyFieldMetricStyle(row.getCell('inpField'), m.inpFieldData, m.inpFieldCategory);
  });
  s1.autoFilter = { from: 'A1', to: 'Q1' };
  s1.views = [{ state: 'frozen', ySplit: 1 }];

  // ── Sheet 2: Meta Data ──────────────────────────────────────────
  const s2      = workbook.addWorksheet('Meta Data');
  const metaCols = [
    { header: 'URL',            key: 'url',           width: 50 },
    { header: 'Title',          key: 'title',         width: 40 },
    { header: 'Description',    key: 'description',   width: 60 },
    { header: 'Locale',         key: 'locale',        width: 12 },
    { header: 'Type',           key: 'type',          width: 15 },
    { header: 'Site Name',      key: 'siteName',      width: 20 },
    { header: 'Updated Time',   key: 'updatedTime',   width: 22 },
    { header: 'Image',          key: 'image',         width: 40 },
    { header: 'Image Width',    key: 'imageWidth',    width: 14 },
    { header: 'Image Height',   key: 'imageHeight',   width: 14 },
    { header: 'Image Alt',      key: 'imageAlt',      width: 30 },
    { header: 'Image Type',     key: 'imageType',     width: 14 },
    { header: 'Video',          key: 'video',         width: 40 },
    { header: 'Video Duration', key: 'videoDuration', width: 16 },
    { header: 'Schema Types',   key: 'schema',        width: 30 },
    { header: 'Robots',         key: 'robots',        width: 20 },
    { header: 'Indexable',      key: 'isIndexable',   width: 12 },
  ];
  s2.columns = metaCols;
  styleHeader(s2.getRow(1), 'FF2D6A9F');

  allResults.forEach(newItem => {
    const row     = s2.addRow(newItem);
    row.font      = { name: 'Arial', size: 9 };
    const oldItem = oldData.find(o => o.url === newItem.url);
    if (oldItem) {
      metaCols.forEach(({ key }) => {
        const nv = newItem[key] != null ? String(newItem[key]).trim() : '';
        const ov = oldItem[key] != null ? String(oldItem[key]).trim() : '';
        if (nv !== ov) {
          row.getCell(key).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
        }
      });
    }
  });
  s2.autoFilter = { from: 'A1', to: 'Q1' };
  s2.views = [{ state: 'frozen', ySplit: 1 }];

  // ── Sheet 3: Desktop PSI ────────────────────────────────────────
  const s3 = workbook.addWorksheet('Desktop PSI');
  buildPsiSheet(s3, allResults, 'desktop', 'FF4A4A8A');

  await workbook.xlsx.writeFile(filePath);
  console.log(`\n✓ Excel saved: ${filePath}`);
}

function buildPsiSheet(sheet, allResults, strategy, headerColor) {
  sheet.columns = [
    { header: 'URL',             key: 'url',               width: 55 },
    { header: 'Performance',     key: 'performanceScore',  width: 16 },
    { header: 'Accessibility',   key: 'accessibilityScore',width: 18 },
    { header: 'Best Practices',  key: 'bestPracticesScore',width: 18 },
    { header: 'SEO',             key: 'seoScore',          width: 12 },
    { header: 'LCP (Lab)',       key: 'lcpLab',            width: 16 },
    { header: 'CLS (Lab)',       key: 'clsLab',            width: 16 },
    { header: 'FCP (Lab)',       key: 'fcpLab',            width: 16 },
    { header: 'TBT (Lab)',       key: 'tbtLab',            width: 16 },
    { header: 'TTI (Lab)',       key: 'ttiLab',            width: 16 },
    { header: 'Speed Index',     key: 'speedIndexLab',     width: 16 },
    { header: 'LCP (Field)',     key: 'lcpFieldData',      width: 25 },
    { header: 'CLS (Field)',     key: 'clsFieldData',      width: 25 },
    { header: 'FID (Field)',     key: 'fidFieldData',      width: 25 },
    { header: 'INP (Field)',     key: 'inpFieldData',      width: 25 },
    { header: 'Overall CWV',    key: 'overallCategory',   width: 18 },
  ];
  styleHeader(sheet.getRow(1), headerColor);

  allResults.forEach(item => {
    const psi = (strategy === 'desktop' ? item.desktopPageSpeed : item.mobilePageSpeed) || {};
    const row = sheet.addRow({ url: item.url, ...psi });
    row.font = { name: 'Arial', size: 9 };

    ['performanceScore', 'accessibilityScore', 'bestPracticesScore', 'seoScore'].forEach(k => {
      applyScoreStyle(row.getCell(k), psi[k]);
    });

    applyCwvLabStyle(row.getCell('lcpLab'),      'lcp',        psi.lcpLab);
    applyCwvLabStyle(row.getCell('clsLab'),      'cls',        psi.clsLab);
    applyCwvLabStyle(row.getCell('fcpLab'),      'fcp',        psi.fcpLab);
    applyCwvLabStyle(row.getCell('tbtLab'),      'tbt',        psi.tbtLab);
    applyCwvLabStyle(row.getCell('ttiLab'),      'tti',        psi.ttiLab);
    applyCwvLabStyle(row.getCell('speedIndexLab'),'speedIndex', psi.speedIndexLab);

    applyFieldMetricStyle(row.getCell('lcpFieldData'), psi.lcpFieldData, psi.lcpFieldCategory);
    applyFieldMetricStyle(row.getCell('clsFieldData'), psi.clsFieldData, psi.clsFieldCategory);
    applyFieldMetricStyle(row.getCell('fidFieldData'), psi.fidFieldData, psi.fidFieldCategory);
    applyFieldMetricStyle(row.getCell('inpFieldData'), psi.inpFieldData, psi.inpFieldCategory);

    applyCategoryStyle(row.getCell('overallCategory'));
  });

  sheet.autoFilter = { from: 'A1', to: 'P1' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

// ─────────────────────────────────────────────
//  Email
// ─────────────────────────────────────────────

async function convertExcelToHTML(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const ws = workbook.getWorksheet('CWV Summary');

  let html = `<style>
    body { font-family: Arial, sans-serif }
    table { border-collapse: collapse; font-size: 12px }
    th { background: #2D6A9F; color: #fff; padding: 8px 10px; text-align: center }
    td { border: 1px solid #ddd; padding: 6px 8px }
    tr:nth-child(even) td { background: #f5f5f5 }
  </style><table><tr>`;

  ws.getRow(1).eachCell(c => { html += `<th>${c.value}</th>`; });
  html += '</tr>';

  ws.eachRow((row, rn) => {
    if (rn === 1) return;
    html += '<tr>';
    row.eachCell({ includeEmpty: true }, cell => {
      let style = '';
      const argb = cell.fill?.fgColor?.argb;
      if (argb && argb !== 'FF000000') {
        const hex  = '#' + argb.slice(2);
        const dark = ['FF00C851', 'FFFF4444', 'FFFFBB33', 'FF2D6A9F'].includes(argb);
        style = ` style="background:${hex};color:${dark ? '#fff' : '#000'};font-weight:bold;text-align:center"`;
      }
      const val = cell.value instanceof Date ? cell.value.toLocaleDateString() : (cell.value ?? '');
      html += `<td${style}>${val}</td>`;
    });
    html += '</tr>';
  });
  return html + '</table>';
}

async function sendEmailWithAttachment(filePath, hostname) {
  const htmlTable   = await convertExcelToHTML(filePath);
  const transporter = nodemailer.createTransport({
    host:   'smtp-mail.outlook.com',
    port:   587,
    secure: false,
    auth:   { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    tls:    { rejectUnauthorized: false },
  });
  await transporter.sendMail({
    from:    `"Mustafa" <${process.env.EMAIL_USER}>`,
    to:      'mustafa@stratskye.com',
    subject: `CWV & PageSpeed Report — ${hostname} — ${new Date().toISOString().slice(0, 10)}`,
    text:    `Attached is the latest Core Web Vitals report for ${hostname}.`,
    html:    htmlTable,
    attachments: [{ filename: path.basename(filePath), path: filePath }],
  });
  console.log(`✓ Email sent for ${hostname}`);
}

// ─────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────

function runAdaptivePageQueue(items, worker) {
  if (!items.length) return Promise.resolve([]);

  const results = new Array(items.length);
  let nextIndex = 0;
  let active = 0;
  let settled = 0;

  return new Promise(resolve => {
    const launchAvailable = () => {
      while (nextIndex < items.length && active < psiPressure.pageConcurrency) {
        const index = nextIndex;
        nextIndex += 1;
        active += 1;

        Promise.resolve(worker(items[index], index))
          .then(result => { results[index] = result; })
          .catch(error => {
            console.error(`  Page worker failed for ${items[index]}: ${error.message}`);
            results[index] = null;
          })
          .finally(() => {
            active -= 1;
            settled += 1;

            if (settled === items.length) resolve(results);
            else launchAvailable();
          });
      }
    };

    launchAvailable();
  });
}

async function recoverMissingPageSpeed(results) {
  for (let round = 1; round <= PSI_RECOVERY_ROUNDS; round += 1) {
    const missing = results.filter(item => item && (!item.mobilePageSpeed || !item.desktopPageSpeed));
    if (!missing.length) return;

    const cooldownMs = 10000 * round;
    console.warn(
      `\nRecovering PageSpeed data for ${missing.length} page(s) `
      + `(round ${round}/${PSI_RECOVERY_ROUNDS}) after ${cooldownMs / 1000}s cooldown...`
    );
    await new Promise(resolve => setTimeout(resolve, cooldownMs));

    const retryTasks = [];
    for (const item of missing) {
      if (!item.mobilePageSpeed) {
        retryTasks.push(
          fetchPageSpeedData(item.url, 'mobile')
            .then(result => { item.mobilePageSpeed = result; })
        );
      }
      if (!item.desktopPageSpeed) {
        retryTasks.push(
          fetchPageSpeedData(item.url, 'desktop')
            .then(result => { item.desktopPageSpeed = result; })
        );
      }
    }
    await Promise.all(retryTasks);
  }

  const unresolved = results.filter(item => item && (!item.mobilePageSpeed || !item.desktopPageSpeed));
  if (unresolved.length) {
    console.error(`\nPageSpeed could not complete for ${unresolved.length} page(s):`);
    unresolved.forEach(item => {
      const strategies = [
        !item.mobilePageSpeed && 'mobile',
        !item.desktopPageSpeed && 'desktop',
      ].filter(Boolean).join(', ');
      console.error(`  [${strategies}] ${item.url}`);
    });
  }
}

async function main() {
  if (!process.env.PAGESPEED_API_KEY) {
    throw new Error('PAGESPEED_API_KEY is missing from .env');
  }

  const sitemapUrls = [
    // 'https://whatthetruck.tv/post-sitemap.xml'
    'https://lotuspsychiatryandwellness.com/sitemap.xml',
    // 'https://lotuspsychiatryandwellness.com/page-sitemap.xml',
    // 'https://www.talkiatry.com/sitemap.xml',
    // 'https://mypsychiatrist.com/page-sitemap.xml',
    // 'https://mytmstherapy.com/page-sitemap.xml',
    // 'https://www.doctorsam.com/page-sitemap.xml',
    // 'https://www.delraybeachpsychiatrist.com/page-sitemap.xml',
    // 'https://neupathmind.com/page-sitemap.xml',
    // 'https://m1performancegroup.com/page-sitemap.xml',
    // 'https://milhousingnetwork.com/page-sitemap.xml'
  ];

  const grouped = sitemapUrls.reduce((acc, su) => {
    const host   = new URL(su).hostname;
    acc[host]    = [...(acc[host] || []), su];
    return acc;
  }, {});

  for (const [hostname, urls] of Object.entries(grouped)) {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(` Processing: ${hostname}`);
    console.log(`${'═'.repeat(50)}`);

    const safeHost = hostname.replace(/\W+/g, '_');
    const date     = new Date().toISOString().slice(0, 10);
    const filePath = path.join(__dirname, `CWV_Report_${safeHost}_${date}.xlsx`);

    let pageUrls = [];
    for (const su of urls) {
      pageUrls = [...pageUrls, ...await fetchSitemap(su)];
    }
    pageUrls = [...new Set(pageUrls)];

    if (!pageUrls.length) { console.log('No URLs found.'); continue; }
    console.log(`Found ${pageUrls.length} URLs. Running analysis...\n`);

    console.log(`Starting rolling queue at ${psiPressure.pageConcurrency} concurrent pages (max ${PSI_MAX_PAGE_CONCURRENCY}).`);

    const results = await runAdaptivePageQueue(pageUrls, async (url, index) => {
      console.log(`  [${index + 1}/${pageUrls.length}] ${url}`);

      // Mobile and desktop run in parallel, while the global PSI limiter keeps
      // total API pressure within a safe bound across all pages.
      const [metaResult, mobile, desktop] = await Promise.all([
        scrapePage(url),
        fetchPageSpeedData(url, 'mobile'),
        fetchPageSpeedData(url, 'desktop'),
      ]);
      const meta = metaResult || { url };

      const aiSuggestions = await fetchAiSuggestions(url, mobile, desktop);

      return {
        ...meta,
        mobilePageSpeed:  mobile,
        desktopPageSpeed: desktop,
        aiSuggestions,
      };
    });

    // Preserve every sitemap URL even if an unexpected page-worker error
    // occurred; the recovery pass can still obtain its PageSpeed data.
    const allResults = results.map((result, index) => result || {
      url: pageUrls[index],
      mobilePageSpeed: null,
      desktopPageSpeed: null,
      aiSuggestions: null,
    });
    await recoverMissingPageSpeed(allResults);

    if (allResults.length > 0) {
      await createExcelReport(allResults, filePath, hostname);
      await saveNewData(allResults, hostname);

      // ── Email (non-fatal — script continues even if email fails) ──
      try {
        await sendEmailWithAttachment(filePath, hostname);
      } catch (e) {
        console.warn(`  ⚠️  Email failed (skipping): ${e.message}`);
      }

      // ── Google Sheets ──────────────────────────────────────────────
      await uploadToGoogleSheets(allResults, hostname);

      console.log(`\n✓ Done: CWV_Report_${safeHost}_${date}.xlsx`);
    } else {
      console.log('No results to save.');
    }
  }
}

main().catch(console.error);
