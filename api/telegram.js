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
 *   GET from a scheduler the Buddy worker (api/_lib/autonomy/worker.js),
 *                        authenticated by CRON_SECRET. Kept here so a cron
 *                        still pointing at /api/telegram keeps working: the
 *                        Daily Pulse is now one of the worker's jobs. The
 *                        canonical path is GET /api/agent.
 *
 * The adapter only speaks Telegram. Every message is answered by the same
 * Buddy as the web app (api/_lib/agent/buddy.js), acting as the linked
 * person with their own permissions — see api/_lib/telegram/handler.js.
 */
import { readJsonBody } from './_lib/auth.js';
import { cronAuthorized } from './_lib/cron.js';
import { verifyWebhookSecret } from './_lib/telegram/bot.js';
import { processUpdate } from './_lib/telegram/handler.js';
import { manage } from './_lib/telegram/manage.js';
import { runWorker } from './_lib/autonomy/worker.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method === 'GET') {
    if (!cronAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    try {
      const out = await runWorker({ budgetMs: 45_000 });
      return res.status(200).json({ success: true, worker: { claimed: out.claimed, processed: out.processed, byStatus: out.byStatus, legacy: !!out.legacy } });
    } catch (err) {
      console.error('[telegram] cron', err?.message || err);
      return res.status(500).json({ success: false, error: 'Worker run failed' });
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
