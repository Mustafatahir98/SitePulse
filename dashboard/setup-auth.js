const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { hashPassword } = require('./auth');

function hiddenPrompt(label) {
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    function finish() {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    }
    function onKey(text, key = {}) {
      if (key.ctrl && key.name === 'c') { finish(); reject(new Error('Setup cancelled.')); }
      else if (key.name === 'return' || key.name === 'enter') { finish(); resolve(value); }
      else if (key.name === 'backspace') value = value.slice(0, -1);
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    }
    process.stdin.on('keypress', onKey);
  });
}

async function main() {
  if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal to enter a hidden password.');
  const username = process.argv[2] || 'admin';
  if (!/^[a-zA-Z0-9_.@-]{1,100}$/.test(username)) throw new Error('Username must use letters, numbers, dots, underscores, @ or hyphens (up to 100 characters).');
  readline.emitKeypressEvents(process.stdin);
  const password = await hiddenPrompt('Password (hidden, at least 12 characters): ');
  if (password.length < 12 || password.length > 1024) throw new Error('Use a password between 12 and 1024 characters.');
  const confirmation = await hiddenPrompt('Confirm password (hidden): ');
  if (password !== confirmation) throw new Error('Passwords did not match.');
  const envPath = path.resolve(__dirname, '..', '.env');
  let content = await fs.readFile(envPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const settings = {
    DASHBOARD_USERNAME: username,
    DASHBOARD_PASSWORD_HASH: await hashPassword(password),
    DASHBOARD_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  };
  for (const [name, value] of Object.entries(settings)) {
    const pattern = new RegExp(`^(?:export\\s+)?${name}\\s*=.*$`, 'gm');
    content = content.replace(pattern, '').replace(/\s+$/, '');
    content += `\n${name}=${value}\n`;
  }
  await fs.writeFile(envPath, content, { mode: 0o600 });
  console.log(`Login configured for ${username}. Run npm run dashboard (or restart the running server).`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
