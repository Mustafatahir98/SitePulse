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

This routing fix does not upload private report JSON/Excel files or Google credentials. A clean GitHub deployment still needs persistent report storage and integration credentials configured before it can show the local website data. Vercel cache writes use temporary storage until a shared store is configured.

Repository visibility is separate from deployment routing. A public GitHub repository exposes committed source. To keep the repository private, use GitHub repository Settings → General → Danger Zone → Change repository visibility → Private.
