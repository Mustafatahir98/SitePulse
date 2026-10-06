const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const TTL = 8 * 60 * 60;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${key.toString('hex')}`;
}

function createAuth(env = process.env) {
  const username = env.DASHBOARD_USERNAME || 'admin';
  const passwordHash = env.DASHBOARD_PASSWORD_HASH || '';
  const secret = env.DASHBOARD_SESSION_SECRET || '';
  const configured = /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash) && secret.length >= 32;
  const secure = env.NODE_ENV === 'production' || Boolean(env.VERCEL);
  const cookieName = secure ? '__Host-cwv_session' : 'cwv_session';
  const attempts = new Map();
  const sign = value => crypto.createHmac('sha256', secret).update(`${passwordHash}:${value}`).digest('base64url');
  const equal = (a, b) => {
    const first = crypto.createHash('sha256').update(a).digest();
    const second = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(first, second);
  };
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  function authenticated(req) {
    if (!configured) return false;
    const value = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!value || value.length > 512) return false;
    const parts = value.split('.');
    if (parts.length !== 3) return false;
    const [expires, nonce, signature] = parts;
    const expiry = Number(expires);
    const now = Math.floor(Date.now() / 1000);
    return Number.isSafeInteger(expiry) && expiry > now && expiry <= now + TTL && /^[a-f0-9]{32}$/.test(nonce) && equal(sign(`${expires}.${nonce}`), signature);
  }
  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  async function handle(req, res, pathname) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (pathname === '/api/auth/login' || pathname === '/api/auth/logout') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        send(res, 405, { error: 'Use POST for this action.' });
        return true;
      }
      const expectedOrigin = env.DASHBOARD_ORIGIN || `${secure ? 'https' : 'http'}://${req.headers.host}`;
      if (req.headers.origin !== expectedOrigin) {
        send(res, 403, { error: 'Request origin is not allowed.' });
        return true;
      }
      if (pathname === '/api/auth/logout') {
        res.setHeader('Set-Cookie', cookie('', 0));
        send(res, 200, { ok: true });
        return true;
      }
      if (!configured) {
        send(res, 503, { error: 'Login has not been configured. Ask the administrator to run dashboard:setup.' });
        return true;
      }
      // On Vercel, the platform supplies this header; elsewhere use the socket address.
      const ip = env.VERCEL ? req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress : req.socket?.remoteAddress;
      const now = Date.now();
      for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
      const entry = attempts.get(ip) || { count: 0, until: now + 15 * 60 * 1000 };
      if (entry.count >= 5 || attempts.size >= 10000) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.until - now) / 1000))));
        send(res, 429, { error: 'Too many attempts. Please try again later.' });
        return true;
      }
      entry.count += 1;
      attempts.set(ip, entry);
      let body;
      try {
        if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('JSON required');
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) throw new Error('Body too large');
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body.username !== 'string' || typeof body.password !== 'string' || body.password.length > 1024) throw new Error('Invalid credentials');
      } catch (_) {
        send(res, 400, { error: 'Enter a valid username and password.' });
        return true;
      }
      const [, salt, expected] = passwordHash.split(':');
      const actual = await scrypt(body.password, salt, 64);
      const passwordMatches = crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
      if (!equal(body.username, username) || !passwordMatches) {
        send(res, 401, { error: 'Incorrect username or password.' });
        return true;
      }
      attempts.delete(ip);
      const payload = `${Math.floor(Date.now() / 1000) + TTL}.${crypto.randomBytes(16).toString('hex')}`;
      res.setHeader('Set-Cookie', cookie(`${payload}.${sign(payload)}`, TTL));
      send(res, 200, { ok: true });
      return true;
    }
    if (pathname === '/login' && authenticated(req)) {
      res.writeHead(302, { Location: '/' });
      res.end();
      return true;
    }
    if (['/login', '/login.js', '/login.css', '/lotus.webp'].includes(pathname)) return false;
    if (!configured) {
      send(res, 503, { error: 'Dashboard login is not configured. Run npm run dashboard:setup.' });
      return true;
    }
    if (!authenticated(req)) {
      if (pathname.startsWith('/api/')) send(res, 401, { error: 'Please sign in to continue.' });
      else { res.writeHead(302, { Location: '/login' }); res.end(); }
      return true;
    }
    return false;
  }
  return { handle, authenticated };
}

module.exports = { createAuth, hashPassword };
