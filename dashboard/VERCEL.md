# Vercel deployment

`vercel.json` builds only `dashboard/server.js` as a Node.js function and sends every request through that handler. The project root is not published as static files. Frontend files are bundled into the function and served from `dashboard/public` by the existing login guard.

In the Vercel project, use the repository root as Root Directory. Remove any manual Output Directory override pointing to `.` or the repository root. The explicit `builds` configuration selects the dashboard entrypoint. Deploy the latest GitHub commit.

Set these environment variables in Vercel before signing in, using the values from your private local `.env`:

- `DASHBOARD_USERNAME`
- `DASHBOARD_PASSWORD_HASH`
- `DASHBOARD_SESSION_SECRET`
- `DASHBOARD_ORIGIN` only if needed: the exact HTTPS site origin, no trailing slash.

Never paste secret values into repository files, commit messages or public issues. Without valid login configuration, report access returns 503; the login page remains available.

After deployment, check `/`, `/login`, `/index.js`, `/dashboard/server.js`, `/service-account.json` and `/.env`. Unauthenticated visitors should see login or a blocked response; server source and credentials must never appear. Frontend JavaScript and CSS are visible to browsers as expected.

## Private report storage

Create a Private Blob store from this project's Storage tab and connect it to Production with a read-write token. Add that project's `BLOB_READ_WRITE_TOKEN` value to your private local `.env`, then run:

```sh
npm run reports:upload -- --dry-run
npm run reports:upload
```

The uploader sends the root website JSON files, every matching Excel report and recent Google caches. It leaves local files unchanged and never uploads `.env` or service-account credentials. Reports use immutable versioned paths; the catalog updates only after report uploads complete. Existing cloud sites not in the local upload are retained. Old uploaded versions remain in the store until you explicitly remove them.

On Vercel, the dashboard reads the private catalog and reports automatically. `BLOB_READ_WRITE_TOKEN` must be included in the deployment's environment. Data and Excel downloads pass through the login guard; private Blob URLs require authentication too. Catalog metadata is cached for 30 seconds, so a new upload can take up to 30 seconds to appear. For local cloud testing, set `DASHBOARD_REPORT_STORAGE=blob`; otherwise the local dashboard continues to read local files.

## Google and Clarity

Run locally:

```sh
npm run dashboard:export-env
```

This creates the private ignored `.env.vercel-integrations` file. Add its values to Vercel Production: `GOOGLE_SERVICE_ACCOUNT_JSON`, `GA4_PROPERTY_LOTUSPSYCHIATRYANDWELLNESS_COM`, and, if configured locally, `CLARITY_PROJECT_ID` and `CLARITY_API_TOKEN`. Redeploy after changing environment settings. Google credentials are read from the server-only JSON environment variable on Vercel; local setup can continue using the service-account file.

Analytics and Search Console caches persist in private Blob storage per report key, in addition to temporary instance files. Copied cache entries carry their original timestamps. They cannot replace a working Google integration after they expire or when a different range is selected. The scraper still runs locally; run `npm run reports:upload` after generating new report files to publish them to the live dashboard.

Repository visibility is separate from deployment routing. A public GitHub repository exposes committed source. To keep the repository private, use GitHub repository Settings → General → Danger Zone → Change repository visibility → Private.
