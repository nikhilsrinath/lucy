/**
 * Telegram — one function, three callers (the Vercel function count is finite):
 *
 *   POST from Telegram   the bot webhook. Authenticated ONLY by the
 *                        X-Telegram-Bot-Api-Secret-Token header matching
 *                        TELEGRAM_WEBHOOK_SECRET (set with setWebhook — see
 *                        scripts/telegram-setup.js). Always answers 200 once
 *                        authenticated, so Telegram never redelivers an update
 *                        whose effects may already exist; each update_id is
 *                        processed once (api/_lib/telegram/store.js).
 *   POST from the app    { mode, org_id, … } with the user's bearer token —
 *                        Settings → Telegram (api/_lib/telegram/manage.js).
 *   GET from Vercel Cron Daily Pulse, authenticated by CRON_SECRET.
 *
 * The adapter only speaks Telegram. Every message is answered by the same
 * Buddy as the web app (api/_lib/agent/buddy.js), acting as the linked
 * person with their own permissions — see api/_lib/telegram/handler.js.
 */
import { timingSafeEqual } from 'node:crypto';
import { readJsonBody } from './_lib/auth.js';
import { verifyWebhookSecret } from './_lib/telegram/bot.js';
import { processUpdate } from './_lib/telegram/handler.js';
import { manage } from './_lib/telegram/manage.js';
import { runDailyPulse } from './_lib/telegram/pulse.js';

export const config = { maxDuration: 60 };

function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET || '';
  const got = req.headers?.authorization || '';
  const want = `Bearer ${secret}`;
  return secret.length >= 16 && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    if (!cronAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    try {
      return res.status(200).json({ success: true, pulse: await runDailyPulse() });
    } catch (err) {
      console.error('[telegram] cron', err?.message || err);
      return res.status(500).json({ success: false, error: 'Daily Pulse run failed' });
    }
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (req.headers?.['x-telegram-bot-api-secret-token'] !== undefined) {
    if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });
    try {
      const update = await readJsonBody(req);
      await processUpdate(update);
    } catch (err) {
      // Logged, never redelivered: a retry could repeat a turn that half-ran.
      console.error('[telegram] webhook', err?.message || err);
    }
    return res.status(200).json({ ok: true });
  }

  return manage(req, res);
}
