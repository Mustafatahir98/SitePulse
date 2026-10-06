const fs = require('fs/promises');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

async function main() {
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
  const credentialPath = path.resolve(ROOT, process.env.GOOGLE_SERVICE_ACCOUNT_KEY || 'service-account.json');
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : JSON.parse(await fs.readFile(credentialPath, 'utf8'));
  if (credentials.type !== 'service_account' || !credentials.client_email || !credentials.private_key) throw new Error('Invalid Google service-account file.');
  const settings = {
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(credentials),
    GA4_PROPERTY_LOTUSPSYCHIATRYANDWELLNESS_COM: process.env.GA4_PROPERTY_LOTUSPSYCHIATRYANDWELLNESS_COM || '534285283',
  };
  for (const key of ['CLARITY_PROJECT_ID', 'CLARITY_API_TOKEN']) if (process.env[key]) settings[key] = process.env[key];
  const output = path.join(ROOT, '.env.vercel-integrations');
  await fs.writeFile(output, Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  console.log('Created .env.vercel-integrations locally. Add its integration settings to Vercel Production and redeploy. This private file is ignored by Git and Vercel upload.');
}

if (require.main === module) main().catch(() => { console.error('Could not prepare integration settings. Check your private Google service-account file.'); process.exitCode = 1; });
