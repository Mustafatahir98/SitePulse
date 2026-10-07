const https = require('https');
const path = require('path');
const { google } = require('googleapis');
const ROOT = path.resolve(__dirname, '..');
const clients = new Map();
const family = process.env.GOOGLE_API_IP_FAMILY === 'auto' ? 0 : process.env.GOOGLE_API_IP_FAMILY === '6' ? 6 : 4;
const proxyConfigured = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(key => Boolean(process.env[key]));
const agent = new https.Agent({ keepAlive: true, family, maxSockets: 12, maxFreeSockets: 4 });
const requestOptions = { timeout: 10000, ...(!proxyConfigured ? { agent } : {}) };

function configurationError(message) {
  return Object.assign(new Error(message), { code: 'GOOGLE_CONFIGURATION_ERROR', status: 503 });
}

function getGoogleAuth(scopes) {
  const keyFile = path.resolve(ROOT, process.env.GOOGLE_SERVICE_ACCOUNT_KEY || 'service-account.json');
  let credentials;
  if (process.env.VERCEL && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw configurationError('Google credentials are missing from this deployment. Set GOOGLE_SERVICE_ACCOUNT_JSON in Vercel Production and redeploy.');
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
    catch (_) { throw configurationError('GOOGLE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON. Update the Vercel environment variable and redeploy.'); }
    if (credentials?.type !== 'service_account' || typeof credentials.client_email !== 'string' || !credentials.client_email || typeof credentials.private_key !== 'string' || !credentials.private_key) throw configurationError('GOOGLE_SERVICE_ACCOUNT_JSON is missing required service-account fields. Update the Vercel environment variable and redeploy.');
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  }
  const key = `${credentials ? 'environment' : keyFile}:${scopes.join(',')}`;
  if (!clients.has(key)) clients.set(key, new google.auth.GoogleAuth({
    ...(credentials ? { credentials } : { keyFile }), scopes,
    clientOptions: { transporterOptions: { ...requestOptions, retryConfig: { retry: 1, noResponseRetries: 1 } } },
  }));
  return clients.get(key);
}

module.exports = { getGoogleAuth, requestOptions };
