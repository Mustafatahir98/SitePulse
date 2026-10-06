// /**
//  * diagnostics.js
//  * ──────────────────────────────────────────────────────────────────
//  * Reads sitemap URLs → calls PageSpeed Insights API (mobile+desktop)
//  * → downloads the PageSpeed screenshot thumbnail from API response
//  * → extracts detailed audit diagnostics
//  * → saves Diagnostics_<host>_<date>.xlsx
//  * → emails the report via Gmail
//  *
//  * .env required:
//  *   PAGESPEED_API_KEY=...
//  *   GMAIL_USER=mustafa@stratskye.com
//  *   GMAIL_PASS=your_gmail_app_password   ← 16-char Google App Password
//  * ──────────────────────────────────────────────────────────────────
//  */

// const axios                  = require('axios');
// const { parseStringPromise } = require('xml2js');
// const ExcelJS                = require('exceljs');
// const fs                     = require('fs/promises');
// const path                   = require('path');
// const nodemailer             = require('nodemailer');

// require('dotenv').config();

// // ─────────────────────────────────────────────
// //  Config
// // ─────────────────────────────────────────────

// const SITEMAPS = [
//   'https://theacctaxco.com/post-sitemap.xml',
//   'https://theacctaxco.com/page-sitemap.xml',
//   // Add more sitemaps here
// ];

// const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');

// // ─────────────────────────────────────────────
// //  Sitemap
// // ─────────────────────────────────────────────

// async function fetchSitemap(url) {
//   try {
//     const res = await axios.get(url, { timeout: 15000 });
//     const xml = await parseStringPromise(res.data);
//     return xml.urlset.url.map(u => u.loc[0]);
//   } catch (e) {
//     console.error(`Sitemap error ${url}: ${e.message}`);
//     return [];
//   }
// }

// // ─────────────────────────────────────────────
// //  PageSpeed — diagnostics + screenshot
// // ─────────────────────────────────────────────

// const DIAGNOSTIC_AUDITS = [
//   // Performance
//   { key: 'render-blocking-resources',    category: 'Performance',    label: 'Render-Blocking Resources' },
//   { key: 'uses-optimized-images',        category: 'Performance',    label: 'Unoptimized Images' },
//   { key: 'uses-responsive-images',       category: 'Performance',    label: 'Oversized Images' },
//   { key: 'offscreen-images',             category: 'Performance',    label: 'Offscreen Images (Lazy Load)' },
//   { key: 'uses-webp-images',             category: 'Performance',    label: 'Next-Gen Image Formats' },
//   { key: 'unused-css-rules',             category: 'Performance',    label: 'Unused CSS' },
//   { key: 'unused-javascript',            category: 'Performance',    label: 'Unused JavaScript' },
//   { key: 'uses-text-compression',        category: 'Performance',    label: 'Text Compression Missing' },
//   { key: 'uses-long-cache-ttl',          category: 'Performance',    label: 'Inefficient Cache Policy' },
//   { key: 'server-response-time',         category: 'Performance',    label: 'Slow Server Response (TTFB)' },
//   { key: 'redirects',                    category: 'Performance',    label: 'Multiple Redirects' },
//   { key: 'third-party-summary',          category: 'Performance',    label: 'Third-Party Impact' },
//   { key: 'total-byte-weight',            category: 'Performance',    label: 'Excessive Page Weight' },
//   { key: 'dom-size',                     category: 'Performance',    label: 'Large DOM Size' },
//   { key: 'bootup-time',                  category: 'Performance',    label: 'JavaScript Boot-Up Time' },
//   { key: 'mainthread-work-breakdown',    category: 'Performance',    label: 'Main Thread Work' },
//   { key: 'font-display',                 category: 'Performance',    label: 'Font Display Not Set' },
//   { key: 'uses-rel-preload',             category: 'Performance',    label: 'Missing Preload Hints' },
//   // Accessibility
//   { key: 'color-contrast',               category: 'Accessibility',  label: 'Low Color Contrast' },
//   { key: 'image-alt',                    category: 'Accessibility',  label: 'Images Missing Alt Text' },
//   { key: 'label',                        category: 'Accessibility',  label: 'Form Inputs Missing Labels' },
//   { key: 'link-name',                    category: 'Accessibility',  label: 'Links Missing Accessible Name' },
//   { key: 'button-name',                  category: 'Accessibility',  label: 'Buttons Missing Accessible Name' },
//   { key: 'document-title',              category: 'Accessibility',  label: 'Missing Page Title' },
//   { key: 'html-has-lang',               category: 'Accessibility',  label: 'HTML Missing Lang Attribute' },
//   { key: 'heading-order',               category: 'Accessibility',  label: 'Incorrect Heading Order' },
//   // Best Practices
//   { key: 'uses-https',                   category: 'Best Practices', label: 'Not Using HTTPS' },
//   { key: 'no-vulnerable-libraries',      category: 'Best Practices', label: 'Vulnerable JS Libraries' },
//   { key: 'deprecations',                 category: 'Best Practices', label: 'Deprecated APIs' },
//   { key: 'errors-in-console',            category: 'Best Practices', label: 'Browser Console Errors' },
//   { key: 'image-aspect-ratio',           category: 'Best Practices', label: 'Incorrect Image Aspect Ratio' },
//   // SEO
//   { key: 'meta-description',             category: 'SEO',            label: 'Missing Meta Description' },
//   { key: 'hreflang',                     category: 'SEO',            label: 'Invalid hreflang' },
//   { key: 'canonical',                    category: 'SEO',            label: 'Canonical URL Issues' },
//   { key: 'robots-txt',                   category: 'SEO',            label: 'robots.txt Invalid' },
//   { key: 'tap-targets',                  category: 'SEO',            label: 'Tap Targets Too Small' },
//   { key: 'font-size',                    category: 'SEO',            label: 'Font Size Too Small' },
//   { key: 'crawlable-anchors',            category: 'SEO',            label: 'Links Not Crawlable' },
//   { key: 'link-text',                    category: 'SEO',            label: 'Non-Descriptive Link Text' },
// ];

// function scoreToImpact(score) {
//   if (score == null) return 'N/A';
//   if (score <= 49)   return '🔴 High';
//   if (score <= 74)   return '🟡 Medium';
//   if (score <= 89)   return '🟠 Low';
//   return '✅ Pass';
// }

// /**
//  * Calls PSI API and returns:
//  *  - scores      : { performance, accessibility, bestPractices, seo }
//  *  - issues      : [ { url, strategy, category, issue, impact, score, detail, description } ]
//  *  - screenshotB64 : base64 PNG string from Lighthouse (or null)
//  */
// async function fetchDiagnostics(url, strategy = 'mobile') {
//   const API_KEY  = process.env.PAGESPEED_API_KEY;
//   const endpoint = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

//   const params = new URLSearchParams();
//   params.append('url', url);
//   params.append('strategy', strategy);
//   params.append('key', API_KEY);
//   params.append('category', 'performance');
//   params.append('category', 'accessibility');
//   params.append('category', 'best-practices');
//   params.append('category', 'seo');

//   try {
//     const res  = await axios.get(`${endpoint}?${params.toString()}`, { timeout: 60000 });
//     const data = res.data;
//     const lhr  = data.lighthouseResult;
//     const cats = lhr?.categories || {};
//     const auds = lhr?.audits     || {};

//     const catScore = (k) => {
//       const s = cats[k]?.score;
//       return s != null ? Math.round(s * 100) : 'N/A';
//     };

//     // ── Extract PageSpeed screenshot from Lighthouse audits ──────
//     // 'screenshot-thumbnails' or 'final-screenshot' audit contains base64 image
//     let screenshotB64  = null;
//     let screenshotMime = 'image/jpeg';

//     const finalShot = auds['final-screenshot'];
//     if (finalShot?.details?.data) {
//       // data is like "data:image/jpeg;base64,/9j/..."
//       const raw = finalShot.details.data;
//       screenshotMime = raw.match(/data:(.*?);/)?.[1] || 'image/jpeg';
//       screenshotB64  = raw.replace(/^data:.*?;base64,/, '');
//     }

//     // Build issues list
//     const issues = [];
//     DIAGNOSTIC_AUDITS.forEach(({ key, category, label }) => {
//       const a = auds[key];
//       if (!a) return;
//       const score = a.score != null ? Math.round(a.score * 100) : null;
//       if (score !== null && score < 90) {
//         issues.push({
//           url,
//           strategy,
//           category,
//           issue:       label,
//           impact:      scoreToImpact(score),
//           score,
//           detail:      a.displayValue  || '—',
//           description: a.description   || '—',
//         });
//       }
//     });

//     return {
//       scores: {
//         performance:   catScore('performance'),
//         accessibility: catScore('accessibility'),
//         bestPractices: catScore('best-practices'),
//         seo:           catScore('seo'),
//       },
//       issues,
//       screenshotB64,
//       screenshotMime,
//     };
//   } catch (e) {
//     console.error(`  PSI error [${strategy}] ${url}: ${e.message}`);
//     return null;
//   }
// }

// // ─────────────────────────────────────────────
// //  Save screenshot PNG to disk
// // ─────────────────────────────────────────────

// async function saveScreenshot(b64, mime, outDir, url, strategy) {
//   if (!b64) return null;
//   try {
//     const ext      = mime.includes('png') ? 'png' : 'jpg';
//     const safeName = url.replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '_').slice(0, 100);
//     const filePath = path.join(outDir, `${safeName}_${strategy}.${ext}`);
//     await fs.writeFile(filePath, Buffer.from(b64, 'base64'));
//     return filePath;
//   } catch (e) {
//     console.error(`  Screenshot save error: ${e.message}`);
//     return null;
//   }
// }

// // ─────────────────────────────────────────────
// //  Style helpers
// // ─────────────────────────────────────────────

// function scoreArgb(score) {
//   if (score === 'N/A' || score == null || isNaN(Number(score))) return null;
//   const n = Number(score);
//   if (n >= 80) return 'FF00C851';
//   if (n >= 50) return 'FFFFBB33';
//   return 'FFFF4444';
// }

// function impactArgb(impact) {
//   if (!impact) return null;
//   if (impact.includes('High'))   return 'FFFF4444';
//   if (impact.includes('Medium')) return 'FFFFBB33';
//   if (impact.includes('Low'))    return 'FFFF8C00';
//   return null;
// }

// function styleHeader(row, bgArgb) {
//   row.font      = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 10 };
//   row.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
//   row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
//   row.height    = 32;
// }

// function colorCell(cell, argb) {
//   if (!argb) return;
//   cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
//   cell.font      = { ...cell.font, color: { argb: 'FFFFFFFF' }, bold: true, name: 'Arial', size: 9 };
//   cell.alignment = { horizontal: 'center', vertical: 'middle' };
// }

// // ─────────────────────────────────────────────
// //  Excel report
// // ─────────────────────────────────────────────

// async function createDiagnosticsReport(allData, filePath) {
//   const workbook = new ExcelJS.Workbook();

//   // ── Sheet 1: Summary ────────────────────────────────────────────
//   const s1 = workbook.addWorksheet('📊 Summary');
//   s1.columns = [
//     { header: 'URL',                      key: 'url',         width: 55 },
//     { header: 'Perf (Mobile)',            key: 'mPerf',       width: 16 },
//     { header: 'Accessibility (Mobile)',   key: 'mAccess',     width: 20 },
//     { header: 'Best Practices (Mobile)', key: 'mBest',       width: 20 },
//     { header: 'SEO (Mobile)',             key: 'mSeo',        width: 14 },
//     { header: 'Perf (Desktop)',           key: 'dPerf',       width: 16 },
//     { header: 'Accessibility (Desktop)', key: 'dAccess',     width: 20 },
//     { header: 'Best Practices (Desktop)',key: 'dBest',       width: 20 },
//     { header: 'SEO (Desktop)',            key: 'dSeo',        width: 14 },
//     { header: 'Total Issues',             key: 'totalIssues', width: 14 },
//     { header: '🔴 High',                  key: 'highCount',   width: 12 },
//     { header: '🟡 Medium',                key: 'medCount',    width: 12 },
//     { header: '🟠 Low',                   key: 'lowCount',    width: 12 },
//     { header: 'Screenshot (Mobile)',      key: 'shotMobile',  width: 22 },
//     { header: 'Screenshot (Desktop)',     key: 'shotDesktop', width: 22 },
//   ];
//   styleHeader(s1.getRow(1), 'FF1A3C5E');

//   allData.forEach(({ url, mobileShot, desktopShot, mobile, desktop }) => {
//     const mS       = mobile?.scores  || {};
//     const dS       = desktop?.scores || {};
//     const allIssues = [...(mobile?.issues || []), ...(desktop?.issues || [])];

//     const row = s1.addRow({
//       url,
//       mPerf:       mS.performance,
//       mAccess:     mS.accessibility,
//       mBest:       mS.bestPractices,
//       mSeo:        mS.seo,
//       dPerf:       dS.performance,
//       dAccess:     dS.accessibility,
//       dBest:       dS.bestPractices,
//       dSeo:        dS.seo,
//       totalIssues: allIssues.length,
//       highCount:   allIssues.filter(i => i.impact.includes('High')).length,
//       medCount:    allIssues.filter(i => i.impact.includes('Medium')).length,
//       lowCount:    allIssues.filter(i => i.impact.includes('Low')).length,
//       shotMobile:  mobileShot  ? '✅ Saved' : '❌ N/A',
//       shotDesktop: desktopShot ? '✅ Saved' : '❌ N/A',
//     });
//     row.font = { name: 'Arial', size: 9 };

//     ['mPerf','mAccess','mBest','mSeo','dPerf','dAccess','dBest','dSeo'].forEach(k => {
//       const cell = row.getCell(k);
//       colorCell(cell, scoreArgb(cell.value));
//       if (!scoreArgb(cell.value)) cell.alignment = { horizontal: 'center' };
//     });

//     const tc = row.getCell('totalIssues');
//     tc.alignment = { horizontal: 'center' };
//     const n = Number(tc.value);
//     if (n > 10) colorCell(tc, 'FFFF4444');
//     else if (n > 5) colorCell(tc, 'FFFFBB33');

//     ['highCount','medCount','lowCount'].forEach(k => {
//       row.getCell(k).alignment = { horizontal: 'center' };
//     });
//   });

//   s1.autoFilter = { from: 'A1', to: 'O1' };
//   s1.views = [{ state: 'frozen', ySplit: 1 }];

//   // ── Sheet 2: All Issues ─────────────────────────────────────────
//   const s2 = workbook.addWorksheet('🔍 All Issues');
//   s2.columns = [
//     { header: 'URL',          key: 'url',         width: 50 },
//     { header: 'Strategy',     key: 'strategy',    width: 12 },
//     { header: 'Category',     key: 'category',    width: 16 },
//     { header: 'Issue',        key: 'issue',       width: 38 },
//     { header: 'Impact',       key: 'impact',      width: 16 },
//     { header: 'Score',        key: 'score',       width: 10 },
//     { header: 'Detail',       key: 'detail',      width: 35 },
//     { header: 'Description',  key: 'description', width: 70 },
//   ];
//   styleHeader(s2.getRow(1), 'FF6B2D6A');

//   const impactOrder = { '🔴 High': 0, '🟡 Medium': 1, '🟠 Low': 2 };
//   const allIssuesSorted = allData
//     .flatMap(d => [...(d.mobile?.issues || []), ...(d.desktop?.issues || [])])
//     .sort((a, b) => (impactOrder[a.impact] ?? 9) - (impactOrder[b.impact] ?? 9));

//   allIssuesSorted.forEach(issue => {
//     const row = s2.addRow(issue);
//     row.font = { name: 'Arial', size: 9 };
//     colorCell(row.getCell('impact'), impactArgb(issue.impact));
//     colorCell(row.getCell('score'),  scoreArgb(issue.score));
//     row.getCell('url').font         = { name: 'Arial', size: 9, color: { argb: 'FF0563C1' } };
//     row.getCell('description').alignment = { wrapText: true };
//     row.getCell('detail').alignment      = { wrapText: true };
//     row.getCell('strategy').alignment    = { horizontal: 'center' };
//   });

//   s2.autoFilter = { from: 'A1', to: 'H1' };
//   s2.views = [{ state: 'frozen', ySplit: 1 }];

//   // ── Sheets 3-6: Per Category ────────────────────────────────────
//   const catConfig = [
//     { name: 'Performance',    color: 'FF2D6A9F' },
//     { name: 'Accessibility',  color: 'FF2E7D32' },
//     { name: 'Best Practices', color: 'FF6A2D9F' },
//     { name: 'SEO',            color: 'FF9F6A2D' },
//   ];

//   catConfig.forEach(({ name, color }) => {
//     const sheet = workbook.addWorksheet(name);
//     sheet.columns = [
//       { header: 'URL',         key: 'url',         width: 50 },
//       { header: 'Strategy',    key: 'strategy',    width: 12 },
//       { header: 'Issue',       key: 'issue',       width: 38 },
//       { header: 'Impact',      key: 'impact',      width: 16 },
//       { header: 'Score',       key: 'score',       width: 10 },
//       { header: 'Detail',      key: 'detail',      width: 38 },
//       { header: 'Description', key: 'description', width: 70 },
//     ];
//     styleHeader(sheet.getRow(1), color);

//     allIssuesSorted.filter(i => i.category === name).forEach(issue => {
//       const row = sheet.addRow(issue);
//       row.font = { name: 'Arial', size: 9 };
//       colorCell(row.getCell('impact'), impactArgb(issue.impact));
//       colorCell(row.getCell('score'),  scoreArgb(issue.score));
//       row.getCell('url').font              = { name: 'Arial', size: 9, color: { argb: 'FF0563C1' } };
//       row.getCell('description').alignment = { wrapText: true };
//       row.getCell('detail').alignment      = { wrapText: true };
//       row.getCell('strategy').alignment    = { horizontal: 'center' };
//     });

//     sheet.autoFilter = { from: 'A1', to: 'G1' };
//     sheet.views = [{ state: 'frozen', ySplit: 1 }];
//   });

//   // ── Sheet 7: Screenshots Index ──────────────────────────────────
//   const s7 = workbook.addWorksheet('📸 Screenshots');
//   s7.columns = [
//     { header: 'URL',               key: 'url',         width: 55 },
//     { header: 'Mobile Shot',       key: 'mShot',       width: 18 },
//     { header: 'Mobile Path',       key: 'mPath',       width: 80 },
//     { header: 'Desktop Shot',      key: 'dShot',       width: 18 },
//     { header: 'Desktop Path',      key: 'dPath',       width: 80 },
//   ];
//   styleHeader(s7.getRow(1), 'FF444444');

//   allData.forEach(({ url, mobileShot, desktopShot }) => {
//     const row = s7.addRow({
//       url,
//       mShot: mobileShot  ? '✅ OK' : '❌ N/A',
//       mPath: mobileShot  || '—',
//       dShot: desktopShot ? '✅ OK' : '❌ N/A',
//       dPath: desktopShot || '—',
//     });
//     row.font = { name: 'Arial', size: 9 };
//     ['mShot','dShot'].forEach(k => row.getCell(k).alignment = { horizontal: 'center' });
//   });

//   s7.views = [{ state: 'frozen', ySplit: 1 }];

//   await workbook.xlsx.writeFile(filePath);
//   console.log(`\n✓ Report saved: ${filePath}`);
// }

// // ─────────────────────────────────────────────
// //  Email via Gmail
// // ─────────────────────────────────────────────

// async function buildEmailHTML(allData) {
//   const totalPages  = allData.length;
//   const totalIssues = allData.reduce((s, d) =>
//     s + (d.mobile?.issues?.length || 0) + (d.desktop?.issues?.length || 0), 0);
//   const highCount   = allData.reduce((s, d) => {
//     const issues = [...(d.mobile?.issues || []), ...(d.desktop?.issues || [])];
//     return s + issues.filter(i => i.impact.includes('High')).length;
//   }, 0);

//   // Summary table
//   let rows = '';
//   allData.forEach(({ url, mobile, desktop }) => {
//     const m = mobile?.scores  || {};
//     const d = desktop?.scores || {};

//     const sc = (v) => {
//       if (v === 'N/A' || v == null) return `<td style="text-align:center">N/A</td>`;
//       const n = Number(v);
//       const bg = n >= 80 ? '#00C851' : n >= 50 ? '#FFBB33' : '#FF4444';
//       return `<td style="background:${bg};color:#fff;font-weight:bold;text-align:center;padding:5px 8px">${v}</td>`;
//     };

//     rows += `<tr>
//       <td style="padding:5px 8px;font-size:11px">${url}</td>
//       ${sc(m.performance)} ${sc(m.accessibility)} ${sc(m.bestPractices)} ${sc(m.seo)}
//       ${sc(d.performance)} ${sc(d.accessibility)} ${sc(d.bestPractices)} ${sc(d.seo)}
//     </tr>`;
//   });

//   return `
//   <div style="font-family:Arial,sans-serif;max-width:1200px;margin:0 auto">
//     <h2 style="color:#1A3C5E">🔍 PageSpeed Diagnostics Report</h2>
//     <p style="color:#555">Generated: ${new Date().toLocaleString()}</p>

//     <table style="border-collapse:collapse;margin-bottom:20px">
//       <tr>
//         <td style="background:#1A3C5E;color:#fff;padding:12px 20px;border-radius:4px;text-align:center;margin:5px">
//           <div style="font-size:28px;font-weight:bold">${totalPages}</div>
//           <div>Pages Scanned</div>
//         </td>
//         <td style="width:10px"></td>
//         <td style="background:#6B2D6A;color:#fff;padding:12px 20px;border-radius:4px;text-align:center">
//           <div style="font-size:28px;font-weight:bold">${totalIssues}</div>
//           <div>Total Issues</div>
//         </td>
//         <td style="width:10px"></td>
//         <td style="background:#FF4444;color:#fff;padding:12px 20px;border-radius:4px;text-align:center">
//           <div style="font-size:28px;font-weight:bold">${highCount}</div>
//           <div>High Priority</div>
//         </td>
//       </tr>
//     </table>

//     <h3 style="color:#1A3C5E">Score Summary</h3>
//     <table border="1" style="border-collapse:collapse;font-size:11px;width:100%">
//       <tr style="background:#1A3C5E;color:#fff">
//         <th style="padding:8px;text-align:left">URL</th>
//         <th style="padding:8px">Perf (M)</th>
//         <th style="padding:8px">Access (M)</th>
//         <th style="padding:8px">BP (M)</th>
//         <th style="padding:8px">SEO (M)</th>
//         <th style="padding:8px">Perf (D)</th>
//         <th style="padding:8px">Access (D)</th>
//         <th style="padding:8px">BP (D)</th>
//         <th style="padding:8px">SEO (D)</th>
//       </tr>
//       ${rows}
//     </table>
//     <p style="color:#888;font-size:11px;margin-top:20px">
//       Full details with all issues are in the attached Excel file.<br>
//       Screenshots saved in /snapshots/ folder on the server.
//     </p>
//   </div>`;
// }

// async function sendEmail(filePath, allData) {
//   const html = await buildEmailHTML(allData);

//   const transporter = nodemailer.createTransport({
//     host:   'smtp.gmail.com',
//     port:   587,
//     secure: false,
//     auth: {
//       user: process.env.GMAIL_USER,
//       pass: process.env.GMAIL_PASS,   // Google App Password (16 chars)
//     },
//   });

//   await transporter.sendMail({
//     from:    `"PSI Diagnostics" <${process.env.GMAIL_USER}>`,
//     to:      'mustafa@stratskye.com',
//     subject: `PageSpeed Diagnostics Report — ${new Date().toISOString().slice(0, 10)}`,
//     html,
//     attachments: [{
//       filename: path.basename(filePath),
//       path:     filePath,
//     }],
//   });

//   console.log('✓ Email sent to mustafa@stratskye.com');
// }

// // ─────────────────────────────────────────────
// //  Main
// // ─────────────────────────────────────────────

// async function main() {
//   const grouped = SITEMAPS.reduce((acc, su) => {
//     const host = new URL(su).hostname;
//     acc[host]  = [...(acc[host] || []), su];
//     return acc;
//   }, {});

//   for (const [hostname, urls] of Object.entries(grouped)) {
//     console.log(`\n${'═'.repeat(52)}`);
//     console.log(` Diagnostics: ${hostname}`);
//     console.log(`${'═'.repeat(52)}`);

//     // Snapshot output folder
//     const snapshotDir = path.join(SNAPSHOT_DIR, hostname.replace(/\W+/g, '_'));
//     await fs.mkdir(snapshotDir, { recursive: true });

//     // Collect URLs
//     let pageUrls = [];
//     for (const su of urls) pageUrls = [...pageUrls, ...await fetchSitemap(su)];
//     pageUrls = [...new Set(pageUrls)];

//     if (!pageUrls.length) { console.log('No URLs found.'); continue; }
//     console.log(`Found ${pageUrls.length} URLs. Running PSI analysis...\n`);

//     const allData   = [];
//     const BATCH     = 2;

//     for (let i = 0; i < pageUrls.length; i += BATCH) {
//       const batch = pageUrls.slice(i, i + BATCH);

//       for (const url of batch) {
//         const idx = pageUrls.indexOf(url) + 1;
//         console.log(`  [${idx}/${pageUrls.length}] ${url}`);

//         // Fetch mobile + desktop in parallel
//         const [mobile, desktop] = await Promise.all([
//           fetchDiagnostics(url, 'mobile'),
//           fetchDiagnostics(url, 'desktop'),
//         ]);

//         // Save PageSpeed screenshots from API response
//         const mobileShot  = await saveScreenshot(
//           mobile?.screenshotB64, mobile?.screenshotMime, snapshotDir, url, 'mobile'
//         );
//         const desktopShot = await saveScreenshot(
//           desktop?.screenshotB64, desktop?.screenshotMime, snapshotDir, url, 'desktop'
//         );

//         const mIssues = mobile?.issues?.length  ?? 0;
//         const dIssues = desktop?.issues?.length ?? 0;
//         console.log(`     Issues: ${mIssues} mobile / ${dIssues} desktop | Shots: M:${mobileShot ? '✅' : '❌'} D:${desktopShot ? '✅' : '❌'}`);

//         allData.push({ url, mobileShot, desktopShot, mobile, desktop });
//       }

//       if (i + BATCH < pageUrls.length) await new Promise(r => setTimeout(r, 2000));
//     }

//     if (!allData.length) { console.log('No data collected.'); continue; }

//     // Save Excel
//     const safeHost = hostname.replace(/\W+/g, '_');
//     const date     = new Date().toISOString().slice(0, 10);
//     const filePath = path.join(__dirname, `Diagnostics_${safeHost}_${date}.xlsx`);

//     await createDiagnosticsReport(allData, filePath);

//     // Send email
//     await sendEmail(filePath, allData);

//     // Final summary
//     const total = allData.reduce((s, d) =>
//       s + (d.mobile?.issues?.length || 0) + (d.desktop?.issues?.length || 0), 0);
//     const high  = allData.reduce((s, d) => {
//       return s + [...(d.mobile?.issues || []), ...(d.desktop?.issues || [])]
//         .filter(i => i.impact.includes('High')).length;
//     }, 0);

//     console.log(`\n${'─'.repeat(52)}`);
//     console.log(` ✓ Done: ${hostname}`);
//     console.log(`   Pages   : ${allData.length}`);
//     console.log(`   Issues  : ${total} total / ${high} high priority`);
//     console.log(`   Shots   : ${snapshotDir}`);
//     console.log(`   Report  : Diagnostics_${safeHost}_${date}.xlsx`);
//     console.log(`${'─'.repeat(52)}`);
//   }
// }

// main().catch(console.error);