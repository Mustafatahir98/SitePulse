# SitePulse

A website reporting tool with an authenticated dashboard for page performance, Google Analytics, Search Console and Microsoft Clarity insights. The scraper collects page metadata and PageSpeed results, generates Excel reports, and supports report email and Google Sheets export.

## Local setup

Use Node.js 20 or later and npm. From the repository directory:

```sh
npm ci
```

Copy `.env.example` to `.env` and fill in your integration settings. On PowerShell:

```powershell
Copy-Item .env.example .env
```

Keep your Google service-account JSON private. Set `GOOGLE_SERVICE_ACCOUNT_KEY` to its path, and grant the account access to the Analytics and Search Console properties you want to report on. The current integrations and sitemap configuration target Lotus; update the configuration in `index.js`, `dashboard/server.js` and `dashboard/search-console.js` for other websites.

Create the dashboard administrator account and start the server:

```sh
npm run dashboard:setup -- admin
npm run dashboard
```

Setup asks for a hidden password twice. Open http://localhost:4173 and sign in. See [login setup](dashboard/LOGIN.md) for session and hosting details.

## Generate website reports

Configure the sitemap list in `index.js`, PageSpeed credentials and the optional email/Sheets settings before running:

```sh
npm start
```

This runs the scraper and its configured report email/Google Sheets actions. The dashboard reads `oldScrapedData_<site>.json` and `CWV_Report_<site>_<date>.xlsx` from the project root. Existing generated data can be copied into a fresh checkout, or generated with the scraper.

Generated reports, cache files, screenshots and client data are excluded from Git. A fresh checkout needs its own report data before the dashboard can show websites. The `Cron` scripts are existing Windows wrappers with machine-specific paths; adapt those paths before scheduling them.

## Verification

```sh
npm test
```

The tests cover login protection, caching, failure handling, and desktop/mobile behavior. Browser tests use isolated dummy credentials and stubbed Google APIs. See [report reliability](dashboard/RELIABILITY.md) for loading and caching behavior.

## Hosting

The dashboard exports a Node.js request handler and also runs as a local HTTP server. It is not yet configured as a complete Vercel deployment: routing, persistent report/cache storage and scraper scheduling need hosting configuration. Use HTTPS for a live dashboard and set credentials through your hosting provider's environment settings.

Never commit `.env`, service-account credentials, login secrets or private client reports. `.env.example` contains placeholders only.
