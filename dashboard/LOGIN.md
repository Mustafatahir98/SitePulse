# Dashboard login

One administrator account protects the dashboard, report APIs, and Excel downloads.

Run in an interactive terminal:

```sh
npm run dashboard:setup -- admin
npm run dashboard
```

Replace `admin` with your preferred username. Setup asks for a hidden password twice (at least 12 characters). It saves a scrypt password hash and a random session secret in the existing root `.env`, preserving other settings. No default password exists. Until configured, the server blocks report access.

Open http://localhost:4173. Sessions expire after eight hours. Sign out clears the browser cookie. Run setup again and restart to change credentials and invalidate all previous sessions. Keep `.env` and service-account credentials private.

## Vercel

The server exports a request handler and login uses a signed, HttpOnly, SameSite=Strict cookie with Secure enabled in production. Set `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD_HASH`, and `DASHBOARD_SESSION_SECRET` in Vercel environment settings using the values generated in your local `.env`. Set `DASHBOARD_ORIGIN` to the exact HTTPS site origin if a proxy changes the Host header (no trailing slash).

Full Vercel deployment still needs function routing, bundled report data or persistent storage, and changes to the scraper/cache file writes. This login change does not deploy the project.

The built-in attempt limiter allows five attempts per IP per 15 minutes per running instance. For a public Vercel deployment, add a shared rate limiter or platform firewall rule because separate instances do not share this counter. Signed sessions need no in-memory session store. Sign out clears the current browser's cookie; a copied cookie remains valid until expiry or credential rotation.

## Verification

```sh
node --test dashboard/auth.test.js dashboard/report-cache.test.js dashboard/ui.test.js
```
