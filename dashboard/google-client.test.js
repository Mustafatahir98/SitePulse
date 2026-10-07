const test = require('node:test');
const assert = require('node:assert/strict');
const { google } = require('googleapis');
const { getGoogleAuth } = require('./google-client');

test('deployment credentials fail clearly without falling back to an excluded local file', t => {
  const before = { VERCEL: process.env.VERCEL, GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON };
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.VERCEL = '1';
  for (const value of ['', '{invalid', 'null', '{}']) {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = value;
    assert.throws(() => getGoogleAuth(['test-scope']), error => error.code === 'GOOGLE_CONFIGURATION_ERROR' && error.status === 503 && /GOOGLE_SERVICE_ACCOUNT_JSON/.test(error.message));
  }
});

test('accepts pasted JSON with escaped private-key newlines', t => {
  const before = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const original = google.auth.GoogleAuth;
  t.after(() => {
    google.auth.GoogleAuth = original;
    if (before === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = before;
  });
  google.auth.GoogleAuth = class { constructor(options) { this.options = options; } };
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ type: 'service_account', client_email: 'test@example.com', private_key: 'line-one\\nline-two\\n' });
  const client = getGoogleAuth(['escaped-key-test']);
  assert.equal(client.options.credentials.private_key, 'line-one\nline-two\n');
});
