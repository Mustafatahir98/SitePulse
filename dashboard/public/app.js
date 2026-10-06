const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (response.status === 401 && response.url.includes('/api/sites')) {
    location.replace('/login');
    throw new Error('Your session has expired. Please sign in again.');
  }
  return response;
};

document.getElementById('logoutButton').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await originalFetch('/api/auth/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Sign out failed. Please try again.');
    location.replace('/login');
  } catch (error) {
    button.textContent = 'Try signing out again';
    button.disabled = false;
  }
});

const state = {
  sites: [], activeSite: null, rows: [], analytics: null, trafficRange: '30d', customStart: '', customEnd: '',
  device: 'mobile', query: '', filter: 'all', page: 1, perPage: 12,
  sc: {
    range: '28d', start: '', end: '', page: '', data: null, error: '', loading: false, requestId: 0,
    refreshError: '', tab: 'queries', view: 'chart', search: '', expanded: false, sort: { key: 'clicks', dir: 'desc' }, cursor: null,
  },
  clarity: { days: 3, data: null, error: '', loading: false, requestId: 0 },
};
const warmedSearchConsoleSites = new Set();

const el = id => document.getElementById(id);
const cleanText = value => String(value ?? 'N/A').replace(/Â/g, '').replace(/\u00a0/g, ' ');
const numberValue = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const scoreClass = score => score == null ? 'na' : score >= 90 ? 'good' : score >= 50 ? 'needs' : 'poor';
const initials = name => name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const plainAuditText = value => cleanText(value)
  .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();
const auditCategoryText = value => Array.isArray(value) ? value.join(' · ') : cleanText(value || '');
const formatInteger = value => numberValue(value)?.toLocaleString() ?? 'N/A';
const formatDecimal = value => numberValue(value)?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? 'N/A';
const formatPercent = value => numberValue(value) == null ? 'N/A' : `${(Number(value) * 100).toFixed(1)}%`;
const formatDuration = value => {
  const seconds = numberValue(value);
  if (seconds == null) return 'N/A';
  if (seconds < 60) return `${seconds.toFixed(1)} sec`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
};
const formatCurrency = value => {
  const amount = numberValue(value);
  if (amount == null) return 'N/A';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.analytics?.currencyCode || 'USD' }).format(amount);
};

function scorePill(value) {
  const score = numberValue(value);
  return `<span class="score-pill ${scoreClass(score)}">${score ?? 'N/A'}</span>`;
}

function average(key) {
  const values = state.rows.map(row => numberValue(row[`${state.device}PageSpeed`]?.[key])).filter(value => value != null);
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function renderSites() {
  el('siteList').innerHTML = state.sites.map(site => `
    <button class="site-button ${site.id === state.activeSite?.id ? 'active' : ''}" data-site="${site.id}">
      <span class="site-icon">${escapeHtml(initials(site.name))}</span>
      <span class="site-copy"><strong>${escapeHtml(site.name)}</strong><span>${escapeHtml(site.host)}</span></span>
      <span class="site-count">${site.pageCount}</span>
    </button>`).join('');
  document.querySelectorAll('[data-site]').forEach(button => button.addEventListener('click', () => loadSite(button.dataset.site)));
}

function renderSummary() {
  const metrics = [
    ['Average performance', average('performanceScore'), 'Across all audited pages'],
    ['Accessibility', average('accessibilityScore'), 'Average accessibility score'],
    ['Best practices', average('bestPracticesScore'), 'Security and web standards'],
    ['SEO health', average('seoScore'), `${state.rows.filter(row => row.isIndexable !== false).length} indexable pages`],
  ];
  if (state.analytics?.enabled) {
    metrics.push([
      'Page views',
      state.analytics.status === 'available' ? state.analytics.totals?.pageViews : null,
      state.analytics.status === 'available'
        ? `${state.analytics.totals?.activeUsers ?? 0} active users · ${state.analytics.range}`
        : state.analytics.status === 'loading' ? 'Connecting to Google Analytics…' : 'Analytics connection delayed',
      'traffic',
    ]);
  }
  el('summaryGrid').innerHTML = metrics.map(([label, value, sub, type]) => `
    <article class="summary-card"><div class="label">${label}</div><div class="value">${value ?? '—'}</div>
    <div class="sub">${sub}</div>${type === 'traffic' ? '' : `<div class="score-bar"><i class="${scoreClass(value)}" style="width:${value ?? 0}%"></i></div>`}</article>`).join('');
}

function filteredRows() {
  return state.rows.filter(row => {
    const haystack = `${row.title || ''} ${row.url}`.toLowerCase();
    const score = numberValue(row[`${state.device}PageSpeed`]?.performanceScore);
    const status = scoreClass(score);
    return haystack.includes(state.query.toLowerCase()) && (state.filter === 'all' || status === state.filter);
  });
}

function renderRows() {
  const rows = filteredRows();
  const totalPages = Math.max(1, Math.ceil(rows.length / state.perPage));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * state.perPage;
  const visible = rows.slice(start, start + state.perPage);
  el('reportRows').innerHTML = visible.map((row, index) => {
    const psi = row[`${state.device}PageSpeed`] || {};
    const url = new URL(row.url);
    return `<tr>
      <td class="page-cell"><div class="page-title">${escapeHtml(row.title || (url.pathname === '/' ? 'Homepage' : url.pathname))}</div><div class="page-path">${escapeHtml(url.pathname)}</div></td>
      <td class="metric traffic-metric">${row.traffic ? formatInteger(row.traffic.pageViews) : state.analytics?.status === 'loading' ? '<span class="metric-loading" aria-label="Loading page views"></span>' : '—'}</td><td class="metric traffic-metric">${row.traffic ? formatInteger(row.traffic.activeUsers) : state.analytics?.status === 'loading' ? '<span class="metric-loading" aria-label="Loading active users"></span>' : '—'}</td>
      <td>${scorePill(psi.performanceScore)}</td><td>${scorePill(psi.accessibilityScore)}</td><td>${scorePill(psi.bestPracticesScore)}</td><td>${scorePill(psi.seoScore)}</td>
      <td><div class="row-actions">${state.activeSite?.analytics ? `<button class="ga-button" data-ga-detail="${state.rows.indexOf(row)}" aria-label="View Google Analytics details">Traffic</button>` : ''}${state.activeSite?.searchConsole ? `<button class="sc-row-button" data-sc-detail="${state.rows.indexOf(row)}" aria-label="View Search Console data for this page">Search</button>` : ''}<button class="detail-button" data-detail="${state.rows.indexOf(row)}" aria-label="View performance details">Details</button></div></td></tr>`;
  }).join('');
  el('emptyState').classList.toggle('hidden', rows.length !== 0);
  el('pageInfo').textContent = rows.length ? `Showing ${start + 1}–${Math.min(start + state.perPage, rows.length)} of ${rows.length} pages` : '0 pages';
  el('prevPage').disabled = state.page === 1;
  el('nextPage').disabled = state.page === totalPages;
  document.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => showDetails(state.rows[Number(button.dataset.detail)])));
  document.querySelectorAll('[data-ga-detail]').forEach(button => button.addEventListener('click', () => showAnalyticsDetails(state.rows[Number(button.dataset.gaDetail)])));
  document.querySelectorAll('[data-sc-detail]').forEach(button => button.addEventListener('click', () => openSearchConsole(state.rows[Number(button.dataset.scDetail)].url)));
}

function showAnalyticsDetails(row) {
  const traffic = row.traffic;
  const title = escapeHtml(row.title || 'Page analytics');
  const range = escapeHtml(state.analytics?.range || 'Selected range');
  const sections = [
    ['Traffic overview', [
      ['Page views', formatInteger(traffic?.pageViews)],
      ['Active users', formatInteger(traffic?.activeUsers)],
      ['Total users', formatInteger(traffic?.totalUsers)],
      ['New users', formatInteger(traffic?.newUsers)],
      ['Sessions', formatInteger(traffic?.sessions)],
      ['Views / session', formatDecimal(traffic?.screenPageViewsPerSession)],
      ['Sessions / user', formatDecimal(traffic?.sessionsPerUser)],
    ]],
    ['Engagement', [
      ['Engaged sessions', formatInteger(traffic?.engagedSessions)],
      ['Engagement rate', formatPercent(traffic?.engagementRate)],
      ['Bounce rate', formatPercent(traffic?.bounceRate)],
      ['Avg. session duration', formatDuration(traffic?.averageSessionDuration)],
      ['Avg. engagement / user', formatDuration(traffic?.averageEngagementTime)],
      ['Total engagement time', formatDuration(traffic?.userEngagementDuration)],
    ]],
    ['Events & outcomes', [
      ['Event count', formatInteger(traffic?.eventCount)],
      ['Events / user', formatDecimal(traffic?.eventCountPerUser)],
      ['Events / session', formatDecimal(traffic?.eventsPerSession)],
      ['Key events', formatInteger(traffic?.keyEvents)],
      ['Session key event rate', formatPercent(traffic?.sessionKeyEventRate)],
      ['Transactions', formatInteger(traffic?.transactions)],
      ['Purchase revenue', formatCurrency(traffic?.purchaseRevenue)],
      ['Total revenue', formatCurrency(traffic?.totalRevenue)],
    ]],
  ];
  const body = traffic ? sections.map(([heading, metrics]) => `
    <div class="dialog-section analytics-section"><h3>${heading}</h3><div class="detail-grid">${metrics.map(([label, value]) => `<div class="detail-metric"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div></div>`).join('') : `
    <div class="analytics-unavailable"><strong>Google Analytics data is not available.</strong><span>${escapeHtml(state.analytics?.error || 'GA4 is not configured for this website or the report could not be loaded.')}</span></div>`;
  el('dialogContent').innerHTML = `<div class="dialog-body"><div class="dialog-kicker">Google Analytics 4 · ${range}</div><h2>${title}</h2><a class="dialog-url" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">${escapeHtml(row.url)} ↗</a>${body}</div>`;
  el('detailDialog').showModal();
}

function showDetails(row) {
  const psi = row[`${state.device}PageSpeed`] || {};
  const metrics = [['Performance', psi.performanceScore], ['Accessibility', psi.accessibilityScore], ['Best practices', psi.bestPracticesScore], ['SEO', psi.seoScore], ['LCP', cleanText(psi.lcpLab)], ['CLS', cleanText(psi.clsLab)], ['FCP', cleanText(psi.fcpLab)], ['TBT', cleanText(psi.tbtLab)]];
  const metadata = [['Indexable', row.isIndexable === false ? 'No' : 'Yes'], ['Robots', row.robots], ['Schema', row.schema], ['Locale', row.locale], ['Type', row.type], ['Updated', row.updatedTime]];
  const diagnostics = Array.isArray(psi.diagnostics) ? psi.diagnostics : [];
  const aiSuggestions = row.aiSuggestions?.[state.device];
  const aiSuggestionsHtml = Array.isArray(aiSuggestions) && aiSuggestions.length ? `
    <div class="ai-suggestion-list">${aiSuggestions.map(suggestion => `
      <article class="ai-suggestion ${escapeHtml(suggestion.priority || 'medium')}">
        <div class="ai-suggestion-head">
          <strong>${escapeHtml(suggestion.title)}</strong>
          <span>${escapeHtml(suggestion.priority || 'medium')} priority</span>
        </div>
        ${suggestion.issue ? `<p><b>Issue</b>${escapeHtml(suggestion.issue)}</p>` : ''}
        ${suggestion.impact ? `<p><b>Impact</b>${escapeHtml(suggestion.impact)}</p>` : ''}
        <p><b>Recommended fix</b>${escapeHtml(suggestion.recommendation)}</p>
      </article>`).join('')}</div>` : row.aiSuggestions
    ? `<div class="ai-suggestion-empty"><strong>No AI recommendations needed.</strong><span>This device has no failed PageSpeed audits requiring a suggestion.</span></div>`
    : `<div class="ai-suggestion-empty"><strong>AI suggestions are not available for this scan.</strong><span>Add GROQ_API_KEY and run the report again.</span></div>`;
  const counts = diagnostics.reduce((result, audit) => {
    result[audit.severity] = (result[audit.severity] || 0) + 1;
    return result;
  }, { critical: 0, warning: 0, passed: 0 });
  const diagnosticsHtml = diagnostics.length ? `
    <div class="diagnostic-summary">
      <span class="diagnostic-count critical"><i></i><strong>${counts.critical}</strong> Critical</span>
      <span class="diagnostic-count warning"><i></i><strong>${counts.warning}</strong> Needs attention</span>
      <span class="diagnostic-count passed"><i></i><strong>${counts.passed}</strong> Passed</span>
    </div>
    <div class="diagnostic-list">${diagnostics.map(audit => `
      <details class="diagnostic-item ${escapeHtml(audit.severity)}" ${audit.severity === 'critical' ? 'open' : ''}>
        <summary>
          <span class="severity-dot"></span>
          <span class="diagnostic-title"><strong>${escapeHtml(audit.title)}</strong><small>${escapeHtml(auditCategoryText(audit.categories))}${audit.displayValue ? ` · ${escapeHtml(cleanText(audit.displayValue))}` : ''}</small></span>
          <span class="audit-score">${escapeHtml(audit.score)}</span>
          <span class="chevron">⌄</span>
        </summary>
        <div class="diagnostic-description">${escapeHtml(plainAuditText(audit.description) || 'PageSpeed did not provide additional detail for this audit.')}
          ${(audit.savingsMs || audit.savingsBytes || audit.itemCount) ? `<div class="audit-savings">${audit.savingsMs ? `<span>Potential saving: ${audit.savingsMs} ms</span>` : ''}${audit.savingsBytes ? `<span>${Math.round(audit.savingsBytes / 1024)} KB reducible</span>` : ''}${audit.itemCount ? `<span>${audit.itemCount} affected item${audit.itemCount === 1 ? '' : 's'}</span>` : ''}</div>` : ''}
        </div>
      </details>`).join('')}</div>` : `
    <div class="diagnostic-unavailable"><strong>Diagnostics is scan mein available nahi hain.</strong><span>Is report ko naye scraper version se dobara run karein; next scan mein PageSpeed ke red, yellow aur green audits yahan aa jayenge.</span></div>`;
  el('dialogContent').innerHTML = `<div class="dialog-body"><h2>${escapeHtml(row.title || 'Page details')}</h2><a class="dialog-url" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">${escapeHtml(row.url)} ↗</a>
    <div class="dialog-section"><h3>${state.device} performance</h3><div class="detail-grid">${metrics.map(([label, value]) => `<div class="detail-metric"><span>${label}</span><strong>${escapeHtml(value ?? 'N/A')}</strong></div>`).join('')}</div></div>
    <div class="dialog-section diagnostics-section"><h3>PageSpeed diagnostics</h3>${diagnosticsHtml}</div>
    <div class="dialog-section ai-section"><h3>AI recommendations</h3>${aiSuggestionsHtml}</div>
    <div class="dialog-section"><h3>Page metadata</h3><div class="meta-grid">${metadata.map(([label, value]) => `<div class="meta-item"><span>${label}</span><strong>${escapeHtml(value || 'N/A')}</strong></div>`).join('')}</div></div></div>`;
  el('detailDialog').showModal();
}

function renderReport() {
  const site = state.activeSite;
  el('siteName').textContent = site.name;
  el('siteUrl').textContent = site.host;
  el('siteUrl').href = `https://${site.host}`;
  el('downloadButton').href = `/api/sites/${site.id}/download`;
  el('downloadButton').classList.toggle('hidden', !site.latestReport);
  el('searchConsoleButton').classList.toggle('hidden', !site.searchConsole);
  el('searchConsoleExcelButton').href = `/api/sites/${site.id}/search-console/download?range=28d`;
  el('searchConsoleExcelButton').classList.toggle('hidden', !site.searchConsole);
  el('analyticsExcelButton').href = `/api/sites/${site.id}/analytics/download?${trafficQuery()}`;
  el('analyticsExcelButton').classList.toggle('hidden', !state.analytics?.enabled);
  el('clarityButton').classList.toggle('hidden', !site.clarity);
  const date = new Date(site.updatedAt);
  el('reportMeta').textContent = `${site.pageCount} pages · ${state.device[0].toUpperCase() + state.device.slice(1)} data · Updated ${date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
  renderSummary();
  renderRows();
  renderSites();
  renderAnalyticsStatus();
}

function trafficQuery() {
  const params = new URLSearchParams({ range: state.trafficRange });
  if (state.trafficRange === 'custom') {
    params.set('start', state.customStart);
    params.set('end', state.customEnd);
  }
  return params.toString();
}

let siteRequestId = 0;
let analyticsRequestId = 0;
let siteController;
let analyticsController;
const analyticsViews = new Map();
const searchViews = new Map();

function renderAnalyticsStatus() {
  const analytics = state.analytics;
  el('dataStatus').classList.toggle('hidden', !analytics?.enabled);
  const loading = analytics?.status === 'loading' || analytics?.refreshing;
  el('dataStatus').dataset.state = loading ? 'loading' : analytics?.status === 'available' ? analytics.cache?.status === 'stale' ? 'stale' : 'ready' : 'error';
  const fetched = analytics?.cache?.fetchedAt;
  const saved = fetched ? new Date(fetched).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  el('analyticsStatus').textContent = analytics?.status === 'loading' ? 'Performance report ready. Analytics is loading separately…'
    : analytics?.refreshing ? 'Updating analytics. Your saved report remains visible.'
    : analytics?.status !== 'available' ? analytics?.error || 'Analytics connection delayed. Please retry.'
    : analytics?.cache?.status === 'stale' ? `Showing saved analytics from ${saved}. ${analytics.cache.refreshError ? 'Live connection delayed.' : 'Updating in the background.'}`
    : `Google Analytics · ${analytics.range || 'Selected period'}${saved ? ` · Updated ${saved}` : ''}${analytics.unavailableSections?.length ? ' · Some detail metrics are delayed' : ''}`;
  el('retryAnalytics').disabled = Boolean(loading);
  el('retryAnalytics').textContent = loading ? 'Updating…' : analytics?.status === 'available' ? 'Refresh analytics' : 'Retry connection';
}

function applyAnalytics(payload) {
  state.analytics = payload;
  state.rows.forEach(row => {
    const pathname = new URL(row.url).pathname.replace(/\/+$/, '') || '/';
    row.traffic = payload.status === 'available' ? payload.pages?.[pathname] || { pageViews: 0, activeUsers: 0 } : null;
  });
  renderSummary();
  renderRows();
  renderAnalyticsStatus();
}

async function loadAnalytics(force = false, followup = false) {
  const site = state.activeSite;
  if (!site?.analytics) return;
  const query = trafficQuery();
  const key = `${site.id}:${query}`;
  const requestId = ++analyticsRequestId;
  analyticsController?.abort();
  analyticsController = new AbortController();
  const controller = analyticsController;
  const timeout = setTimeout(() => controller.abort(), 35000);
  state.analytics.refreshing = true;
  renderAnalyticsStatus();
  try {
    const response = await fetch(`/api/sites/${site.id}/analytics?${query}${force ? '&refresh=1' : ''}`, { signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Analytics could not be loaded.');
    if (requestId !== analyticsRequestId || site.id !== state.activeSite?.id || query !== trafficQuery()) return;
    analyticsViews.set(key, payload);
    applyAnalytics(payload);
    if (payload.cache?.refreshing && !followup) setTimeout(() => {
      if (requestId === analyticsRequestId && site.id === state.activeSite?.id && query === trafficQuery()) loadAnalytics(true, true);
    }, 1500);
  } catch (error) {
    if (requestId !== analyticsRequestId || site.id !== state.activeSite?.id) return;
    if (state.analytics.status === 'available') {
      state.analytics.refreshing = false;
      state.analytics.cache = { ...state.analytics.cache, status: 'stale', refreshError: true };
      renderAnalyticsStatus();
    } else applyAnalytics({ enabled: true, status: 'unavailable', error: error.name === 'AbortError' ? 'Google Analytics is taking longer than expected. Please retry.' : error.message });
  } finally { clearTimeout(timeout); }
}

el('retryAnalytics').addEventListener('click', () => loadAnalytics(true));

async function loadSite(id, preserveView = false) {
  const requestId = ++siteRequestId;
  siteController?.abort();
  analyticsController?.abort();
  analyticsRequestId++;
  state.sc.requestId++;
  el('searchDialog').close();
  siteController = new AbortController();
  el('errorState').classList.add('hidden');
  if (!preserveView) {
    el('loadingState').classList.remove('hidden');
    el('report').classList.add('hidden');
  }
  try {
    const response = await fetch(`/api/sites/${id}`, { signal: siteController.signal });
    if (!response.ok) throw new Error('This website report could not be loaded.');
    const data = await response.json();
    if (requestId !== siteRequestId) return;
    state.activeSite = data.site;
    state.rows = data.rows;
    state.analytics = analyticsViews.get(`${id}:${trafficQuery()}`) || data.analytics;
    if (state.analytics.status === 'available') applyAnalytics(state.analytics);
    if (data.site.searchConsole && !warmedSearchConsoleSites.has(data.site.id)) {
      warmedSearchConsoleSites.add(data.site.id);
      const warmKey = `${data.site.id}:range=28d`;
      fetch(`/api/sites/${data.site.id}/search-console?range=28d`).then(async response => {
        if (response.ok) searchViews.set(warmKey, await response.json());
        else warmedSearchConsoleSites.delete(data.site.id);
      }).catch(() => warmedSearchConsoleSites.delete(data.site.id));
    }
    if (!preserveView) {
      state.page = 1;
      state.query = '';
      state.filter = 'all';
      el('searchInput').value = '';
      el('statusFilter').value = 'all';
    }
    renderReport();
    el('report').classList.remove('hidden');
    closeMenu();
    void loadAnalytics();
  } catch (error) {
    if (requestId !== siteRequestId || error.name === 'AbortError') return;
    el('errorMessage').textContent = error.message;
    el('errorState').classList.remove('hidden');
  } finally {
    if (requestId === siteRequestId) el('loadingState').classList.add('hidden');
  }
}

function closeMenu() {
  el('sidebar').classList.remove('open');
  el('drawerBackdrop').classList.add('hidden');
  el('menuButton').setAttribute('aria-expanded', 'false');
}

async function init() {
  try {
    const response = await fetch('/api/sites');
    if (!response.ok) throw new Error('Website list could not be loaded.');
    state.sites = await response.json();
    if (!state.sites.length) throw new Error('No generated website reports were found.');
    renderSites();
    await loadSite(state.sites[0].id);
  } catch (error) {
    el('loadingState').classList.add('hidden');
    el('errorMessage').textContent = error.message;
    el('errorState').classList.remove('hidden');
  }
}

/* ---------------------------------------------------------------- Search Console */

const SC_RANGES = [['7d', '7 days'], ['28d', '28 days'], ['90d', '3 months'], ['custom', 'Custom']];
const SC_TABS = [['queries', 'Queries'], ['pages', 'Pages'], ['countries', 'Countries'], ['devices', 'Devices']];
const SC_METRICS = [
  { key: 'clicks', label: 'Clicks', tile: 'Total clicks' },
  { key: 'impressions', label: 'Impressions', tile: 'Total impressions' },
  { key: 'ctr', label: 'CTR', tile: 'Average CTR' },
  { key: 'position', label: 'Position', tile: 'Average position' },
];
const SC_HEADINGS = { queries: 'Query', pages: 'Page', countries: 'Country', devices: 'Device' };
// Search Console reports countries as ISO 3166-1 alpha-3; Intl.DisplayNames only speaks alpha-2.
const SC_ALPHA3 = 'abwAW afgAF agoAO aiaAI alaAX albAL andAD areAE argAR armAM asmAS ataAQ atfTF atgAG ausAU autAT azeAZ bdiBI belBE benBJ besBQ bfaBF bgdBD bgrBG bhrBH bhsBS bihBA blmBL blrBY blzBZ bmuBM bolBO braBR brbBB brnBN btnBT bvtBV bwaBW cafCF canCA cckCC cheCH chlCL chnCN civCI cmrCM codCD cogCG cokCK colCO comKM cpvCV criCR cubCU cuwCW cxrCX cymKY cypCY czeCZ deuDE djiDJ dmaDM dnkDK domDO dzaDZ ecuEC egyEG eriER eshEH espES estEE ethET finFI fjiFJ flkFK fraFR froFO fsmFM gabGA gbrGB geoGE ggyGG ghaGH gibGI ginGN glpGP gmbGM gnbGW gnqGQ grcGR grdGD grlGL gtmGT gufGF gumGU guyGY hkgHK hmdHM hndHN hrvHR htiHT hunHU idnID imnIM indIN iotIO irlIE irnIR irqIQ islIS isrIL itaIT jamJM jeyJE jorJO jpnJP kazKZ kenKE kgzKG khmKH kirKI knaKN korKR kwtKW laoLA lbnLB lbrLR lbyLY lcaLC lieLI lkaLK lsoLS ltuLT luxLU lvaLV macMO mafMF marMA mcoMC mdaMD mdgMG mdvMV mexMX mhlMH mkdMK mliML mltMT mmrMM mneME mngMN mnpMP mozMZ mrtMR msrMS mtqMQ musMU mwiMW mysMY mytYT namNA nclNC nerNE nfkNF ngaNG nicNI niuNU nldNL norNO nplNP nruNR nzlNZ omnOM pakPK panPA pcnPN perPE phlPH plwPW pngPG polPL priPR prkKP prtPT pryPY psePS pyfPF qatQA reuRE rouRO rusRU rwaRW sauSA sdnSD senSN sgpSG sgsGS shnSH sjmSJ slbSB sleSL slvSV smrSM somSO spmPM srbRS ssdSS stpST surSR svkSK svnSI sweSE swzSZ sxmSX sycSC syrSY tcaTC tcdTD tgoTG thaTH tjkTJ tklTK tkmTM tlsTL tonTO ttoTT tunTN turTR tuvTV twnTW tzaTZ ugaUG ukrUA umiUM uryUY usaUS uzbUZ vatVA vctVC venVE vgbVG virVI vnmVN vutVU wlfWF wsmWS yemYE zafZA zmbZM zweZW';
const SC_COUNTRIES = new Map(SC_ALPHA3.split(' ').map(entry => [entry.slice(0, 3), entry.slice(3)]));
const scRegionNames = (() => {
  try { return new Intl.DisplayNames(undefined, { type: 'region' }); } catch (_) { return null; }
})();

const scCount = value => Math.round(Number(value) || 0).toLocaleString();
const scCtr = value => `${((Number(value) || 0) * 100).toFixed(2)}%`;
const scPosition = value => (Number(value) || 0).toFixed(1);
const scFormat = { clicks: scCount, impressions: scCount, ctr: scCtr, position: scPosition };
const scDate = date => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const scCompact = value => (Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(Math.abs(value) >= 10000 ? 0 : 1)}K` : String(Math.round(value)));
const scTick = (metric, value) => (metric === 'ctr' ? `${(value * 100).toFixed(1)}%` : metric === 'position' ? value.toFixed(1) : scCompact(value));

function scCountryName(code) {
  if (!code || code === 'zzz') return 'Unknown region';
  const alpha2 = SC_COUNTRIES.get(code.toLowerCase());
  if (!alpha2) return code.toUpperCase();
  try { return scRegionNames?.of(alpha2) || alpha2; } catch (_) { return alpha2; }
}

function scRowLabel(tab, key) {
  if (tab === 'countries') return scCountryName(key);
  if (tab === 'devices') return key.charAt(0) + key.slice(1).toLowerCase();
  if (tab === 'pages') {
    try { const url = new URL(key); return `${url.pathname}${url.search}`; } catch (_) { return key; }
  }
  return key;
}

function scDelta(metric, current, previous) {
  if (current == null || previous == null) return '<span class="sc-delta flat">No comparison available</span>';
  const now = Number(current) || 0;
  const before = Number(previous) || 0;
  let change;
  let text;
  if (metric === 'position') {
    change = now - before;
    text = `${Math.abs(change).toFixed(1)} positions`;
  } else if (metric === 'ctr') {
    change = (now - before) * 100;
    text = `${Math.abs(change).toFixed(2)} pp`;
  } else {
    if (!before) return '<span class="sc-delta flat">No data in previous period</span>';
    change = ((now - before) / before) * 100;
    text = `${Math.abs(change).toFixed(1)}%`;
  }
  const step = metric === 'ctr' ? 0.005 : metric === 'position' ? 0.05 : 0.05;
  if (Math.abs(change) < step) return '<span class="sc-delta flat">Flat vs previous period</span>';
  const rose = change > 0;
  // A rising average position is a worse rank, so direction and sentiment part ways here.
  const good = metric === 'position' ? !rose : rose;
  return `<span class="sc-delta ${good ? 'good' : 'bad'}"><i aria-hidden="true">${rose ? '▲' : '▼'}</i>${rose ? '+' : '−'}${text} vs previous period</span>`;
}

function scNiceCeil(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 2.5, 5, 10].find(step => value <= step * magnitude) || 10) * magnitude;
}

function scBuildChart(series, metric, width) {
  const height = 152;
  const pad = { top: 14, right: 52, bottom: 22, left: 52 };
  const plotWidth = Math.max(40, width - pad.left - pad.right);
  const plotHeight = height - pad.top - pad.bottom;
  const values = series.map(point => point[metric]);
  const defined = values.filter(value => value != null);
  if (!defined.length) return { svg: '<p class="sc-chart-empty">No data for this metric.</p>', scale: null };

  // Rank charts count downward from the best position, so they never start at zero.
  const inverted = metric === 'position';
  const low = inverted ? Math.max(1, Math.floor(Math.min(...defined)) - 1) : 0;
  const high = inverted
    ? Math.max(Math.ceil(Math.max(...defined)) + 1, low + 1)
    : Math.max(scNiceCeil(Math.max(...defined)), low + (metric === 'ctr' ? 0.01 : 1));
  const span = high - low || 1;
  const xOf = index => pad.left + (series.length < 2 ? plotWidth / 2 : (index / (series.length - 1)) * plotWidth);
  const yOf = value => (inverted
    ? pad.top + ((value - low) / span) * plotHeight
    : pad.top + plotHeight - ((value - low) / span) * plotHeight);
  const indexAt = offset => Math.round(((offset - pad.left) / (plotWidth || 1)) * Math.max(1, series.length - 1));

  const ticks = [low, (low + high) / 2, high];
  const grid = ticks.map(tick => `<line class="sc-grid" x1="${pad.left}" x2="${(pad.left + plotWidth).toFixed(1)}" y1="${yOf(tick).toFixed(1)}" y2="${yOf(tick).toFixed(1)}"/>`).join('');
  const tickLabels = ticks.map(tick => `<text class="sc-tick" x="${pad.left - 8}" y="${(yOf(tick) + 3.5).toFixed(1)}" text-anchor="end">${escapeHtml(scTick(metric, tick))}</text>`).join('');

  let path = '';
  let pen = false;
  series.forEach((point, index) => {
    const value = point[metric];
    if (value == null) { pen = false; return; }
    path += `${pen ? 'L' : 'M'}${xOf(index).toFixed(1)} ${yOf(value).toFixed(1)}`;
    pen = true;
  });
  // An area under a broken line would fill the gaps it is meant to show, so rank charts skip it.
  const area = !inverted && defined.length === series.length && series.length > 1
    ? `<path class="sc-area" d="${path}L${xOf(series.length - 1).toFixed(1)} ${(pad.top + plotHeight).toFixed(1)}L${xOf(0).toFixed(1)} ${(pad.top + plotHeight).toFixed(1)}Z"/>`
    : '';

  const lastIndex = values.reduce((last, value, index) => (value == null ? last : index), -1);
  const endValue = values[lastIndex];
  const endLabel = lastIndex >= 0
    ? `<text class="sc-end-label" x="${(xOf(lastIndex) + 9).toFixed(1)}" y="${Math.min(Math.max(yOf(endValue) + 4, pad.top + 8), pad.top + plotHeight).toFixed(1)}">${escapeHtml(scFormat[metric](endValue))}</text>`
    : '';
  const endDot = lastIndex >= 0 ? `<circle class="sc-end" cx="${xOf(lastIndex).toFixed(1)}" cy="${yOf(endValue).toFixed(1)}" r="4"/>` : '';

  const axisIndexes = series.length > 2 ? [0, Math.floor((series.length - 1) / 2), series.length - 1] : series.map((_, index) => index);
  const anchors = ['start', 'middle', 'end'];
  const xLabels = axisIndexes.map((index, position) => {
    const anchor = axisIndexes.length === 1 ? 'middle' : anchors[position] || 'middle';
    const label = new Date(`${series[index].date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<text class="sc-tick" x="${xOf(index).toFixed(1)}" y="${height - 6}" text-anchor="${anchor}">${escapeHtml(label)}</text>`;
  }).join('');

  const summary = `${SC_METRICS.find(item => item.key === metric).label} per day from ${scDate(series[0].date)} to ${scDate(series.at(-1).date)}. Latest ${scFormat[metric](endValue)}.`;
  const svg = `<svg class="sc-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(summary)}">`
    + `${grid}${tickLabels}${area}<path class="sc-line" d="${path}"/>${endDot}${endLabel}${xLabels}`
    + `<g class="sc-cursor" opacity="0"><line x1="0" x2="0" y1="${pad.top}" y2="${(pad.top + plotHeight).toFixed(1)}"/><circle r="4" cx="0" cy="0"/></g>`
    + `<rect class="sc-hit" x="0" y="0" width="${width}" height="${height}"/></svg>`;
  return { svg, scale: { xOf, yOf, indexAt } };
}

let scCharts = [];
let scSeries = [];

// Below ~200px of chart width the SVG is scaled down by max-width, so viewBox units
// and CSS pixels stop matching; the cursor maths converts between the two.
function scUnitScale(svg) {
  const rendered = svg.getBoundingClientRect().width;
  return rendered ? Number(svg.getAttribute('width')) / rendered : 1;
}

function scMountTrend(data) {
  scCharts = [];
  scSeries = data.series;
  const trend = el('scTrend');
  if (!trend) return;
  trend.querySelectorAll('.sc-chart-host').forEach(host => {
    const metric = host.dataset.scMetric;
    const chart = scBuildChart(scSeries, metric, Math.max(200, Math.round(host.clientWidth)));
    host.innerHTML = chart.svg;
    const svg = host.querySelector('svg');
    if (!svg || !chart.scale) return;
    const entry = {
      metric,
      svg,
      ...chart.scale,
      cursor: svg.querySelector('.sc-cursor'),
      line: svg.querySelector('.sc-cursor line'),
      dot: svg.querySelector('.sc-cursor circle'),
    };
    scCharts.push(entry);
    svg.addEventListener('pointermove', event => {
      const rect = svg.getBoundingClientRect();
      scSetCursor(entry.indexAt((event.clientX - rect.left) * scUnitScale(svg)));
    });
    svg.addEventListener('pointerleave', scHideCursor);
  });
  if (state.sc.cursor != null) scSetCursor(state.sc.cursor);
}

function scSetCursor(index) {
  if (!scCharts.length || !scSeries.length) return;
  const clamped = Math.max(0, Math.min(scSeries.length - 1, index));
  state.sc.cursor = clamped;
  const point = scSeries[clamped];
  scCharts.forEach(chart => {
    const value = point[chart.metric];
    const x = chart.xOf(clamped).toFixed(1);
    chart.cursor.setAttribute('opacity', '1');
    chart.line.setAttribute('x1', x);
    chart.line.setAttribute('x2', x);
    chart.dot.setAttribute('opacity', value == null ? '0' : '1');
    if (value != null) {
      chart.dot.setAttribute('cx', x);
      chart.dot.setAttribute('cy', chart.yOf(value).toFixed(1));
    }
  });
  const tooltip = el('scTooltip');
  const trend = el('scTrend');
  if (!tooltip || !trend) return;
  tooltip.innerHTML = `<strong>${escapeHtml(scDate(point.date))}</strong>`
    + SC_METRICS.map(metric => `<span><i>${metric.label}</i>${escapeHtml(point[metric.key] == null ? 'No data' : scFormat[metric.key](point[metric.key]))}</span>`).join('');
  tooltip.classList.remove('hidden');
  const first = scCharts[0];
  const anchor = first.svg.getBoundingClientRect().left - trend.getBoundingClientRect().left + first.xOf(clamped) / scUnitScale(first.svg);
  tooltip.style.left = `${Math.max(4, Math.min(trend.clientWidth - tooltip.offsetWidth - 4, anchor - tooltip.offsetWidth / 2))}px`;
}

function scHideCursor() {
  state.sc.cursor = null;
  scCharts.forEach(chart => chart.cursor.setAttribute('opacity', '0'));
  el('scTooltip')?.classList.add('hidden');
}

function scMetaHtml(data) {
  const parts = [`${scDate(data.startDate)} – ${scDate(data.endDate)}`, `vs ${scDate(data.previousStart)} – ${scDate(data.previousEnd)}`];
  parts.push(data.unavailableSections?.includes('series') ? 'Daily trend temporarily delayed' : data.lastDataDate
    ? `Latest data through ${scDate(data.lastDataDate)}`
    : 'No Search Console data in this range yet');
  if (data.firstIncompleteDate) parts.push(`Fresh data from ${scDate(data.firstIncompleteDate)} is still processing`);
  const fetchedAt = data.cache?.fetchedAt || data.generatedAt;
  if (fetchedAt) parts.push(`Updated ${new Date(fetchedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
  if (data.cache?.status === 'stale') parts.push('Showing last successful report while refreshing');
  return `<p class="sc-meta">${parts.map(escapeHtml).join(' · ')}</p>`;
}

function scTilesHtml(data) {
  return `<div class="sc-tiles">${SC_METRICS.map(metric => `
    <article class="sc-tile">
      <div class="label">${metric.tile}</div>
      <div class="value">${data.totals ? escapeHtml(scFormat[metric.key](data.totals[metric.key])) : 'N/A'}</div>
      ${scDelta(metric.key, data.totals?.[metric.key], data.previous?.[metric.key])}
    </article>`).join('')}</div>`;
}

function scTrendTableHtml(data) {
  return `<div class="sc-table-wrap"><table class="sc-table">
    <thead><tr><th>Date</th>${SC_METRICS.map(metric => `<th class="num">${metric.label}</th>`).join('')}</tr></thead>
    <tbody>${data.series.map(point => `<tr><td>${escapeHtml(scDate(point.date))}</td>${SC_METRICS.map(metric =>
      `<td class="num">${point[metric.key] == null ? '—' : escapeHtml(scFormat[metric.key](point[metric.key]))}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function scTrendHtml(data) {
  const toggle = `<div class="sc-view-toggle" role="group" aria-label="Trend view">${[['chart', 'Chart'], ['table', 'Table']]
    .map(([value, label]) => `<button type="button" data-sc-view="${value}" class="${state.sc.view === value ? 'active' : ''}" aria-pressed="${state.sc.view === value}">${label}</button>`).join('')}</div>`;
  const content = data.unavailableSections?.includes('series')
    ? '<div class="sc-notice"><strong>Daily trend is temporarily delayed.</strong><span>The search totals above are available. Retry the connection to update this section.</span></div>'
    : !data.series.length
    ? '<div class="sc-notice"><strong>No daily data in this range.</strong><span>Search Console has not finalised any days for the dates you picked.</span></div>'
    : state.sc.view === 'table'
      ? scTrendTableHtml(data)
      : `<div class="sc-trend" id="scTrend" tabindex="0" role="group" aria-label="Daily Search Console trend. Use the left and right arrow keys to step through days.">
          ${SC_METRICS.map(metric => `<figure class="sc-chart"><figcaption>${metric.label}</figcaption><div class="sc-chart-host" data-sc-metric="${metric.key}"></div></figure>`).join('')}
          <div class="sc-tooltip hidden" id="scTooltip" role="status"></div>
        </div>`;
  return `<section class="sc-section"><div class="sc-section-head"><h3>Daily trend</h3>${toggle}</div>${content}</section>`;
}

function scSortedRows(data) {
  const { tab, search, sort } = state.sc;
  const term = search.trim().toLowerCase();
  const rows = (data[tab] || []).map(row => ({ ...row, label: scRowLabel(tab, row.key) }));
  const filtered = term ? rows.filter(row => `${row.label} ${row.key}`.toLowerCase().includes(term)) : rows;
  return filtered.sort((a, b) => (sort.dir === 'asc' ? a[sort.key] - b[sort.key] : b[sort.key] - a[sort.key]));
}

function scBreakdownHtml(data) {
  const sc = state.sc;
  const tabs = SC_TABS.filter(([key]) => !(sc.page && key === 'pages'));
  const heading = SC_HEADINGS[sc.tab];
  const rows = scSortedRows(data);
  const visible = sc.expanded ? rows : rows.slice(0, 25);
  const peak = rows.reduce((most, row) => Math.max(most, row.clicks), 0) || 1;
  const head = `<div class="sc-section-head">
    <div class="sc-tabs" role="tablist" aria-label="Search Console breakdown">${tabs.map(([key, label]) =>
      `<button type="button" role="tab" aria-selected="${sc.tab === key}" data-sc-tab="${key}" class="${sc.tab === key ? 'active' : ''}">${label}</button>`).join('')}</div>
    <label class="sc-search"><span aria-hidden="true">⌕</span><input id="scSearch" type="search" placeholder="Filter ${heading.toLowerCase()}…" value="${escapeHtml(sc.search)}" aria-label="Filter ${heading.toLowerCase()} rows"></label>
  </div>`;
  if (data.unavailableSections?.includes(sc.tab)) {
    return `<section class="sc-section">${head}<div class="sc-notice"><strong>${escapeHtml(heading)} data is temporarily delayed.</strong><span>This section could not be retrieved from Google. Other available sections remain visible.</span></div></section>`;
  }
  if (!rows.length) {
    return `<section class="sc-section">${head}<div class="sc-notice"><strong>Nothing to show.</strong><span>${sc.search ? 'No rows match this filter.' : 'Search Console reported no rows for this dimension and date range.'}</span></div></section>`;
  }
  const table = `<div class="sc-table-wrap"><table class="sc-table">
    <thead><tr><th>${heading}</th>${SC_METRICS.map(metric =>
      `<th class="num"><button type="button" data-sc-sort="${metric.key}">${metric.label}${sc.sort.key === metric.key ? `<i aria-hidden="true">${sc.sort.dir === 'asc' ? '↑' : '↓'}</i>` : ''}</button></th>`).join('')}</tr></thead>
    <tbody>${visible.map(row => `<tr>
      <td class="sc-dim">${sc.tab === 'pages'
        ? `<a href="${escapeHtml(row.key)}" target="_blank" rel="noreferrer" title="${escapeHtml(row.key)}">${escapeHtml(row.label)}</a>`
        : `<span title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span>`}</td>
      <td class="num"><span>${escapeHtml(scCount(row.clicks))}</span><i class="sc-bar" style="width:${((row.clicks / peak) * 100).toFixed(1)}%"></i></td>
      <td class="num">${escapeHtml(scCount(row.impressions))}</td>
      <td class="num">${escapeHtml(scCtr(row.ctr))}</td>
      <td class="num">${escapeHtml(scPosition(row.position))}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
  const capped = (data[sc.tab] || []).length >= 1000
    ? '<span class="sc-note">Search Console returns at most 1,000 rows per dimension, and it withholds rare queries entirely.</span>'
    : '';
  const foot = `<div class="sc-table-foot"><span>Showing ${visible.length} of ${rows.length} rows</span>
    ${rows.length > 25 ? `<button type="button" id="scExpand">${sc.expanded ? 'Show top 25' : `Show all ${rows.length}`}</button>` : ''}${capped}</div>`;
  return `<section class="sc-section">${head}${table}${foot}</section>`;
}

function scRenderBreakdown() {
  const host = el('scBreakdown');
  if (!host || !state.sc.data) return;
  const refocus = document.activeElement?.id === 'scSearch';
  host.innerHTML = scBreakdownHtml(state.sc.data);
  host.querySelectorAll('[data-sc-tab]').forEach(button => button.addEventListener('click', () => {
    Object.assign(state.sc, { tab: button.dataset.scTab, search: '', expanded: false, sort: { key: 'clicks', dir: 'desc' } });
    scRenderBreakdown();
  }));
  host.querySelectorAll('[data-sc-sort]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.scSort;
    const dir = state.sc.sort.key === key
      ? (state.sc.sort.dir === 'asc' ? 'desc' : 'asc')
      : (key === 'position' ? 'asc' : 'desc');
    state.sc.sort = { key, dir };
    scRenderBreakdown();
  }));
  el('scExpand')?.addEventListener('click', () => { state.sc.expanded = !state.sc.expanded; scRenderBreakdown(); });
  const search = el('scSearch');
  search?.addEventListener('input', event => {
    state.sc.search = event.target.value;
    state.sc.expanded = false;
    scRenderBreakdown();
  });
  if (refocus && search) {
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
}

function renderSearchBody() {
  const body = el('scBody');
  if (!body) return;
  const sc = state.sc;
  body.classList.toggle('is-loading', sc.loading);
  // Hold the previous report at reduced opacity while refetching, so the panel never jumps.
  if (sc.loading && sc.data) return;
  if (sc.loading) {
    body.innerHTML = '<div class="sc-placeholder"><div class="spinner"></div><p>Loading Search Console data…</p></div>';
    return;
  }
  if (sc.error) {
    body.innerHTML = `<div class="sc-notice"><strong>Search connection delayed</strong><span>${escapeHtml(sc.error)}</span><button id="scRetry" class="sc-retry" type="button">Retry connection</button></div>`;
    el('scRetry').addEventListener('click', () => loadSearchConsole(true));
    return;
  }
  if (!sc.data) return;
  scHideCursor();
  const refreshNote = sc.refreshError
    ? `<p class="sc-refresh-note">Live refresh is temporarily delayed; the last successful Search Console report remains visible.</p>`
    : '';
  const partialNote = sc.data.unavailableSections?.length ? `<p class="sc-refresh-note">Some sections are delayed: ${escapeHtml(sc.data.unavailableSections.join(', '))}. Available search data is shown below.</p>` : '';
  body.innerHTML = `${refreshNote}${partialNote}${scMetaHtml(sc.data)}${scTilesHtml(sc.data)}${scTrendHtml(sc.data)}<div id="scBreakdown"></div>`;
  body.querySelectorAll('[data-sc-view]').forEach(button => button.addEventListener('click', () => {
    state.sc.view = button.dataset.scView;
    renderSearchBody();
  }));
  const trend = el('scTrend');
  trend?.addEventListener('keydown', event => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    const jump = { Home: 0, End: scSeries.length - 1 }[event.key];
    if (step == null && jump == null) return;
    event.preventDefault();
    scSetCursor(step == null ? jump : (state.sc.cursor ?? scSeries.length - 1) + step);
  });
  trend?.addEventListener('blur', scHideCursor);
  scRenderBreakdown();
  if (sc.view === 'chart') scMountTrend(sc.data);
}

function renderSearchShell() {
  const site = state.activeSite;
  const target = state.sc.page || `https://${site.host}`;
  el('searchDialogContent').innerHTML = `
    <div class="sc-head">
      <div class="dialog-kicker">Google Search Console</div>
      <h2 id="scTitle">${escapeHtml(state.sc.page ? 'Page search performance' : `${site.name} search performance`)}</h2>
      <a class="dialog-url" href="${escapeHtml(target)}" target="_blank" rel="noreferrer">${escapeHtml(target)} ↗</a>
      <div class="sc-filters">
        <div class="sc-range" role="group" aria-label="Date range">${SC_RANGES.map(([value, label]) =>
          `<button type="button" data-sc-range="${value}" class="${state.sc.range === value ? 'active' : ''}" aria-pressed="${state.sc.range === value}">${label}</button>`).join('')}</div>
        <div id="scCustom" class="sc-custom ${state.sc.range === 'custom' ? '' : 'hidden'}">
          <input id="scStart" type="date" aria-label="Start date" value="${escapeHtml(state.sc.start)}" required>
          <input id="scEnd" type="date" aria-label="End date" value="${escapeHtml(state.sc.end)}" required>
          <button id="scApply" type="button">Apply</button>
        </div>
        <a id="scDownload" class="sc-download">Download page comparison Excel ↓</a>
      </div>
    </div>
    <div id="scBody" class="sc-body" aria-live="polite"></div>`;

  el('searchDialogContent').querySelectorAll('[data-sc-range]').forEach(button => button.addEventListener('click', () => {
    const range = button.dataset.scRange;
    state.sc.range = range;
    el('searchDialogContent').querySelectorAll('[data-sc-range]').forEach(item => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    el('scCustom').classList.toggle('hidden', range !== 'custom');
    // A custom range is incomplete until both dates are in, so it waits for Apply.
    if (range !== 'custom') loadSearchConsole();
  }));
  el('scApply').addEventListener('click', () => {
    const start = el('scStart');
    const end = el('scEnd');
    start.setCustomValidity('');
    if (!start.value || !end.value) {
      start.reportValidity();
      end.reportValidity();
      return;
    }
    if (start.value > end.value) {
      start.setCustomValidity('Start date must be on or before the end date.');
      start.reportValidity();
      return;
    }
    state.sc.start = start.value;
    state.sc.end = end.value;
    loadSearchConsole();
  });
}

function searchConsoleQuery(force = false, includePage = true) {
  const sc = state.sc;
  const params = new URLSearchParams({ range: sc.range });
  if (sc.range === 'custom') {
    params.set('start', sc.start);
    params.set('end', sc.end);
  }
  if (includePage && sc.page) params.set('page', sc.page);
  if (force) params.set('refresh', '1');
  return params;
}

function updateSearchConsoleDownload() {
  const link = el('scDownload');
  if (link) link.href = `/api/sites/${state.activeSite.id}/search-console/download?${searchConsoleQuery(false, false)}`;
}

let searchController;
async function loadSearchConsole(force = false) {
  const sc = state.sc;
  const params = searchConsoleQuery(force);
  const key = `${state.activeSite.id}:${searchConsoleQuery(false)}`;
  if (sc.viewKey !== key) {
    sc.viewKey = key;
    sc.data = searchViews.get(key) || null;
    sc.refreshError = '';
  }
  updateSearchConsoleDownload();
  const requestId = ++sc.requestId;
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  const timeout = setTimeout(() => controller.abort(), 35000);
  sc.loading = true;
  sc.error = '';
  renderSearchBody();
  try {
    const response = await fetch(`/api/sites/${state.activeSite.id}/search-console?${params}`, { signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Search Console data could not be loaded.');
    if (requestId !== sc.requestId) return;
    sc.data = payload;
    if (searchViews.size >= 50) searchViews.delete(searchViews.keys().next().value);
    searchViews.set(key, payload);
    sc.refreshError = payload.cache?.refreshError ? 'refresh-failed' : '';
    sc.expanded = false;
    sc.cursor = null;
    if (!force && payload.cache?.status === 'stale') {
      setTimeout(() => {
        if (el('searchDialog').open && requestId === sc.requestId) loadSearchConsole(true);
      }, 500);
    }
  } catch (error) {
    if (requestId !== sc.requestId) return;
    if (sc.data) sc.refreshError = error.message;
    else sc.error = error.name === 'AbortError' ? 'Google Search Console is taking longer than expected. Please retry.' : error.message;
  } finally {
    clearTimeout(timeout);
  }
  if (requestId !== sc.requestId) return;
  sc.loading = false;
  renderSearchBody();
}

function clarityTableHtml(insight) {
  const rows = Array.isArray(insight.information) ? insight.information : [];
  if (!rows.length) return '<div class="clarity-empty">No information returned for this metric.</div>';
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return `<div class="sc-table-wrap clarity-table-wrap"><table class="sc-table"><thead><tr>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(column => `<td>${escapeHtml(row[column] == null ? '—' : row[column])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderClarityBody() {
  const host = el('clarityDialogContent');
  if (!host) return;
  const clarity = state.clarity;
  if (clarity.loading) {
    host.innerHTML = '<div class="clarity-head"><div class="dialog-kicker">Microsoft Clarity</div><h2 id="clarityTitle">Visitor insights</h2></div><div class="sc-placeholder"><div class="spinner"></div><p>Loading Clarity data…</p></div>';
    return;
  }
  if (clarity.error) {
    host.innerHTML = `<div class="clarity-head"><div class="dialog-kicker">Microsoft Clarity</div><h2 id="clarityTitle">Visitor insights</h2></div><div class="sc-notice"><strong>Clarity data is unavailable.</strong><span>${escapeHtml(clarity.error)}</span></div>`;
    return;
  }
  if (!clarity.data) return;
  const insights = Array.isArray(clarity.data.insights) ? clarity.data.insights : [];
  host.innerHTML = `<div class="clarity-head"><div><div class="dialog-kicker">Microsoft Clarity</div><h2 id="clarityTitle">Visitor insights</h2><p class="sc-meta">Last ${clarity.data.numOfDays} days · Project ${escapeHtml(clarity.data.projectId)}</p></div><div class="clarity-days" role="group" aria-label="Clarity date range">${[1, 2, 3].map(days => `<button type="button" data-clarity-days="${days}" class="${days === clarity.days ? 'active' : ''}">${days}d</button>`).join('')}</div></div><div class="clarity-body">${insights.length ? insights.map(insight => `<section class="clarity-section"><h3>${escapeHtml(insight.metricName || 'Insight')}</h3>${clarityTableHtml(insight)}</section>`).join('') : '<div class="sc-notice"><strong>No insights returned.</strong><span>Clarity has no export data for this period.</span></div>'}</div>`;
  host.querySelectorAll('[data-clarity-days]').forEach(button => button.addEventListener('click', () => {
    clarity.days = Number(button.dataset.clarityDays);
    loadClarity();
  }));
}

async function loadClarity() {
  const clarity = state.clarity;
  const requestId = ++clarity.requestId;
  clarity.loading = true;
  clarity.error = '';
  renderClarityBody();
  try {
    const response = await fetch(`/api/sites/${state.activeSite.id}/clarity?days=${clarity.days}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Clarity data could not be loaded.');
    if (requestId !== clarity.requestId) return;
    clarity.data = payload;
  } catch (error) {
    if (requestId !== clarity.requestId) return;
    clarity.data = null;
    clarity.error = error.message;
  }
  clarity.loading = false;
  renderClarityBody();
}

function openClarity() {
  if (!state.activeSite?.clarity) return;
  Object.assign(state.clarity, { data: null, error: '', days: 3 });
  renderClarityBody();
  el('clarityDialog').showModal();
  loadClarity();
}

function openSearchConsole(page = '') {
  if (!state.activeSite?.searchConsole) return;
  Object.assign(state.sc, { page, tab: 'queries', search: '', expanded: false, sort: { key: 'clicks', dir: 'desc' }, data: null, viewKey: null, loading: true, error: '', refreshError: '', cursor: null });
  renderSearchShell();
  updateSearchConsoleDownload();
  el('searchDialog').showModal();
  loadSearchConsole();
  clearInterval(scRefreshTimer);
  scRefreshTimer = setInterval(() => {
    if (el('searchDialog').open && !state.sc.loading) loadSearchConsole();
  }, 10 * 60 * 1000);
}

let scResizeTimer;
let scRefreshTimer;
window.addEventListener('resize', () => {
  clearTimeout(scResizeTimer);
  scResizeTimer = setTimeout(() => {
    if (el('searchDialog').open && state.sc.view === 'chart' && state.sc.data) scMountTrend(state.sc.data);
  }, 150);
});

el('searchConsoleButton').addEventListener('click', () => openSearchConsole());
el('searchDialogClose').addEventListener('click', () => el('searchDialog').close());
el('searchDialog').addEventListener('click', event => { if (event.target === el('searchDialog')) el('searchDialog').close(); });
el('searchDialog').addEventListener('close', () => {
  searchController?.abort();
  scCharts = [];
  state.sc.cursor = null;
  clearInterval(scRefreshTimer);
});
el('clarityButton').addEventListener('click', openClarity);
el('clarityDialogClose').addEventListener('click', () => el('clarityDialog').close());
el('clarityDialog').addEventListener('click', event => { if (event.target === el('clarityDialog')) el('clarityDialog').close(); });

el('searchInput').addEventListener('input', event => { state.query = event.target.value; state.page = 1; renderRows(); });
el('statusFilter').addEventListener('change', event => { state.filter = event.target.value; state.page = 1; renderRows(); });
el('trafficRange').addEventListener('change', event => {
  state.trafficRange = event.target.value;
  const custom = state.trafficRange === 'custom';
  el('customDateControls').classList.toggle('hidden', !custom);
  if (!custom && state.activeSite) loadSite(state.activeSite.id, true);
});
el('applyTrafficRange').addEventListener('click', () => {
  const startInput = el('trafficStartDate');
  const endInput = el('trafficEndDate');
  startInput.setCustomValidity('');
  if (!startInput.value || !endInput.value) {
    startInput.reportValidity();
    endInput.reportValidity();
    return;
  }
  if (startInput.value > endInput.value) {
    startInput.setCustomValidity('Start date must be before the end date.');
    startInput.reportValidity();
    return;
  }
  state.customStart = startInput.value;
  state.customEnd = endInput.value;
  if (state.activeSite) loadSite(state.activeSite.id, true);
});
document.querySelectorAll('[data-device]').forEach(button => button.addEventListener('click', () => {
  state.device = button.dataset.device;
  document.querySelectorAll('[data-device]').forEach(item => item.classList.toggle('active', item === button));
  state.page = 1;
  renderReport();
}));
el('prevPage').addEventListener('click', () => { state.page -= 1; renderRows(); });
el('nextPage').addEventListener('click', () => { state.page += 1; renderRows(); });
el('dialogClose').addEventListener('click', () => el('detailDialog').close());
el('detailDialog').addEventListener('click', event => { if (event.target === el('detailDialog')) el('detailDialog').close(); });
el('menuButton').addEventListener('click', () => {
  const open = el('sidebar').classList.toggle('open');
  el('drawerBackdrop').classList.toggle('hidden', !open);
  el('menuButton').setAttribute('aria-expanded', String(open));
});
el('drawerBackdrop').addEventListener('click', closeMenu);

init();
