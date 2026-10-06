const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createAuth, hashPassword } = require('./auth');

const password = 'test-password-for-auth-only';
async function start(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function config() {
  return { DASHBOARD_USERNAME: 'admin', DASHBOARD_PASSWORD_HASH: await hashPassword(password), DASHBOARD_SESSION_SECRET: 'test-secret-that-is-at-least-thirty-two-characters' };
}
function login(origin, value = password) {
  return { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: value }) };
}

test('dashboard integration: redirects, protects all APIs/downloads, signs in and signs out', async t => {
  Object.assign(process.env, await config());
  const handler = require('./server');
  const origin = await start(t, handler);
  for (const route of ['/api/sites', '/api/sites/example/download', '/api/sites/example/search-console', '/api/sites/example/analytics/download', '/api/sites/example/clarity']) {
    assert.equal((await fetch(origin + route)).status, 401, route);
  }
  const blocked = await fetch(origin, { redirect: 'manual' });
  assert.equal(blocked.status, 302);
  assert.equal(blocked.headers.get('location'), '/login');
  const sourcePaths = ['/index.js', '/dashboard/server.js', '/service-account.json', '/.env', '/package.json', '/README.md'];
  for (const route of sourcePaths) {
    const result = await fetch(origin + route, { redirect: 'manual' });
    assert.equal(result.status, 302, route);
    assert.equal(result.headers.get('location'), '/login', route);
  }
  assert.equal((await fetch(origin + '/login')).status, 200);
  assert.equal((await fetch(origin + '/login.js')).status, 200);
  assert.equal((await fetch(origin + '/api/auth/login', login(origin, 'incorrect'))).status, 401);
  assert.equal((await fetch(origin + '/api/auth/login', login('https://other.example'))).status, 403);
  const signedIn = await fetch(origin + '/api/auth/login', login(origin));
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=28800/);
  const headers = { Cookie: cookie.split(';')[0] };
  const page = await fetch(origin, { headers });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="logoutButton"/);
  assert.match(page.headers.get('cache-control'), /no-store/);
  for (const route of sourcePaths) assert.equal((await fetch(origin + route, { headers })).status, 404, route);
  const loggedIn = await fetch(origin + '/login', { headers, redirect: 'manual' });
  assert.equal(loggedIn.headers.get('location'), '/');
  const logout = await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { ...headers, Origin: origin } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(origin + '/api/sites')).status, 401);
});

test('missing configuration blocks data instead of opening the dashboard', async t => {
  const auth = createAuth({});
  const origin = await start(t, async (req, res) => {
    if (!await auth.handle(req, res, new URL(req.url, 'http://localhost').pathname)) res.end('public login');
  });
  assert.equal((await fetch(origin + '/api/sites')).status, 503);
  assert.equal((await fetch(origin + '/login')).status, 200);
  assert.equal((await fetch(origin + '/api/auth/login', login(origin))).status, 503);
});

test('login accepts Vercel parsed request bodies and rejects oversized bodies', async t => {
  const auth = createAuth(await config());
  const origin = await start(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    await auth.handle(req, res, '/api/auth/login');
  });
  assert.equal((await fetch(origin, login(origin))).status, 200);
  const oversized = login(origin, 'x'.repeat(5000));
  assert.equal((await fetch(origin, oversized)).status, 400);
});

test('repeated incorrect attempts are limited and unsupported methods rejected', async t => {
  const auth = createAuth(await config());
  const origin = await start(t, (req, res) => auth.handle(req, res, '/api/auth/login'));
  assert.equal((await fetch(origin)).status, 405);
  for (let index = 0; index < 5; index++) assert.equal((await fetch(origin, login(origin, 'incorrect'))).status, 401);
  const limited = await fetch(origin, login(origin));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('production cookie is secure and rejects tampering, expiry and old credentials', async t => {
  const env = { ...await config(), NODE_ENV: 'production', DASHBOARD_ORIGIN: 'https://reports.example' };
  const auth = createAuth(env);
  const origin = await start(t, (req, res) => auth.handle(req, res, '/api/auth/login'));
  const response = await fetch(origin, login(env.DASHBOARD_ORIGIN));
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^__Host-cwv_session=/);
  assert.match(cookie, /; Secure/);
  const value = cookie.split(';')[0];
  assert.equal(auth.authenticated({ headers: { cookie: value } }), true);
  assert.equal(auth.authenticated({ headers: { cookie: value + 'x' } }), false);
  const payload = `${Math.floor(Date.now() / 1000) - 1}.${crypto.randomBytes(16).toString('hex')}`;
  const signature = crypto.createHmac('sha256', env.DASHBOARD_SESSION_SECRET).update(`${env.DASHBOARD_PASSWORD_HASH}:${payload}`).digest('base64url');
  assert.equal(auth.authenticated({ headers: { cookie: `__Host-cwv_session=${payload}.${signature}` } }), false);
  const rotated = createAuth({ ...env, DASHBOARD_PASSWORD_HASH: await hashPassword('a-new-password-for-testing') });
  assert.equal(rotated.authenticated({ headers: { cookie: value } }), false);
});
