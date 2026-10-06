const https = require('https');
const path = require('path');
const { google } = require('googleapis');
const ROOT = path.resolve(__dirname, '..');
const clients = new Map();
const family = process.env.GOOGLE_API_IP_FAMILY === 'auto' ? 0 : process.env.GOOGLE_API_IP_FAMILY === '6' ? 6 : 4;
const proxyConfigured = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(key => Boolean(process.env[key]));
const agent = new https.Agent({ keepAlive: true, family, maxSockets: 12, maxFreeSockets: 4 });
const requestOptions = { timeout: 10000, ...(!proxyConfigured ? { agent } : {}) };

function getGoogleAuth(scopes) {
  const keyFile = path.resolve(ROOT, process.env.GOOGLE_SERVICE_ACCOUNT_KEY || 'service-account.json');
  const key = `${keyFile}:${scopes.join(',')}`;
  if (!clients.has(key)) clients.set(key, new google.auth.GoogleAuth({
    keyFile, scopes,
    clientOptions: { transporterOptions: { ...requestOptions, retryConfig: { retry: 1, noResponseRetries: 1 } } },
  }));
  return clients.get(key);
}

module.exports = { getGoogleAuth, requestOptions };
