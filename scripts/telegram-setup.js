/**
 * Points the StartupBuddy Telegram bot at a deployment, once per environment.
 *
 *   node scripts/telegram-setup.js https://your-app.example.com
 *   node scripts/telegram-setup.js --info        (show the current webhook)
 *   node scripts/telegram-setup.js --delete      (remove the webhook)
 *
 * Registers https://<host>/api/telegram as the webhook with
 * TELEGRAM_WEBHOOK_SECRET as its secret_token (Telegram then sends it in
 * X-Telegram-Bot-Api-Secret-Token and api/telegram.js refuses anything
 * without it), limits updates to the three kinds the adapter handles, drops
 * anything queued while no webhook was set, and publishes the command menus.
 *
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in the environment
 * or in .env — the same values the deployment has.
 */
import { readFileSync } from 'node:fs';

function loadEnv() {
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (!match) continue;
      let value = (match[2] || '').trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (!process.env[match[1]]) process.env[match[1]] = value;
    }
  } catch { /* no .env: the environment must carry the values */ }
}

loadEnv();
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!token) { console.error('TELEGRAM_BOT_TOKEN is not set.'); process.exit(1); }

async function tg(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

const arg = process.argv[2] || '';

if (arg === '--info') {
  console.log(await tg('getWebhookInfo'));
  process.exit(0);
}
if (arg === '--delete') {
  console.log('deleteWebhook:', await tg('deleteWebhook', { drop_pending_updates: true }));
  process.exit(0);
}
if (!/^https:\/\/[^\s/]+/.test(arg)) {
  console.error('Usage: node scripts/telegram-setup.js https://your-app.example.com   (HTTPS required)');
  process.exit(1);
}
if (!secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
  console.error('TELEGRAM_WEBHOOK_SECRET must be 16–256 characters of A–Z, a–z, 0–9, _ or -.  e.g.  openssl rand -hex 32');
  process.exit(1);
}

const me = await tg('getMe');
const url = `${arg.replace(/\/+$/, '')}/api/telegram`;
await tg('setWebhook', {
  url,
  secret_token: secret,
  allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  drop_pending_updates: true,
  max_connections: 20,
});

await tg('setMyCommands', {
  scope: { type: 'all_private_chats' },
  commands: [
    { command: 'help', description: 'What I can do' },
    { command: 'me', description: 'Who you are linked as' },
    { command: 'company', description: 'Switch company' },
    { command: 'pulse', description: 'Daily check-in on/off' },
    { command: 'new', description: 'Start a fresh conversation' },
    { command: 'unlink', description: 'Unlink this Telegram account' },
  ],
});
await tg('setMyCommands', {
  scope: { type: 'all_group_chats' },
  commands: [
    { command: 'buddy', description: 'Ask Buddy something' },
    { command: 'help', description: 'How to use Buddy here' },
  ],
});

console.log(`Webhook set for @${me.username} → ${url}`);
console.log(await tg('getWebhookInfo'));
