import * as bot from './bot.js';
import * as store from './store.js';
import * as pulse from '../agent/pulse.js';
import { verifyPerson, ChannelAccessError } from '../agent/channelSession.js';
import { supabaseAdmin } from '../supabaseAdmin.js';
import { currentState, pushHistory } from './conversation.js';

/**
 * Daily Pulse over Telegram: delivering the question. The log and the
 * meaning live in api/_lib/agent/pulse.js; the answer is an ordinary Buddy
 * turn (handler.js marks it as a check-in reply while the check-in is open).
 *
 * Only to linked people with a private chat, who have not opted out
 * (/pulse off), and who still pass verifyPerson — a check-in never goes to
 * someone whose access ended, and never into a group.
 */

function hourIn(tz) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: tz || 'Asia/Kolkata' }).format(new Date())) % 24;
  } catch { return new Date().getUTCHours(); }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Asks today's check-in in one company. `force` (the admin's "Send now")
 * ignores the schedule but never the one-per-day rule.
 */
export async function sendPulse({ orgId, force = false }) {
  const settings = await store.orgSettings(orgId);
  if (!settings.enabled) return { sent: 0, skipped: 0, failed: 0, reason: 'Telegram is off for this company.' };
  if (!force && !settings.pulse_enabled) return { sent: 0, skipped: 0, failed: 0, reason: 'Daily Pulse is off.' };
  const org = await store.orgBasics(orgId);
  if (!force && hourIn(org.tz) < settings.pulse_hour) return { sent: 0, skipped: 0, failed: 0, reason: 'Not yet time.' };
  const date = pulse.pulseDate(org.tz);

  // Daily Pulse is for StartupBuddy users for now: pulse_checkins keys on the
  // user, and a company person linked without a login has none (0071).
  const links = (await store.linksForOrg(orgId)).filter((l) => l.user_id && l.dm_chat_id && !l.pulse_opt_out);
  const out = { sent: 0, skipped: 0, failed: 0 };
  for (const link of links) {
    let row = null;
    try {
      try { await verifyPerson({ userId: link.user_id, orgId }); } catch (err) {
        if (!(err instanceof ChannelAccessError)) throw err;
        if (err.ended) await store.revokeLink(link.id, `access_${err.reason}`);
        out.skipped += 1;
        continue;
      }
      if (await pulse.alreadyAsked({ orgId, userId: link.user_id, date })) { out.skipped += 1; continue; }
      const { data: emp } = await supabaseAdmin().from('employees').select('id, full_name')
        .eq('org_id', orgId).eq('user_id', link.user_id).maybeSingle();
      const question = pulse.pulseQuestion((emp?.full_name || link.telegram_name || '').split(' ')[0]);
      row = await pulse.recordAsk({ orgId, userId: link.user_id, employeeId: emp?.id || null, date, channel: 'telegram', question });
      if (!row) { out.skipped += 1; continue; }
      await bot.sendMessage(link.dm_chat_id, bot.esc(question));

      // The DM now answers this company's check-in.
      const conv = await store.loadConversation(link.dm_chat_id, link.telegram_user_id);
      const state = currentState(conv, orgId);
      state.pulse = { id: row.id, asked_at: row.asked_at };
      pushHistory(state, 'assistant', question);
      state.at = Date.now();
      await store.saveConversation(link.dm_chat_id, link.telegram_user_id, orgId, state);
      out.sent += 1;
      await pause(60); // well under Telegram's ~30 messages/second
    } catch (err) {
      out.failed += 1;
      console.warn(`[telegram] pulse to link ${link.id} failed:`, err?.message || err);
      if (row) await pulse.markSkipped(row.id).catch(() => null);
    }
  }
  console.info(`[telegram] pulse org ${orgId}: ${JSON.stringify(out)}`);
  return out;
}

/** The scheduled run: every company with Daily Pulse on whose local hour has come. */
export async function runDailyPulse() {
  const orgs = await store.orgsWithPulse();
  const totals = { orgs: orgs.length, sent: 0, skipped: 0, failed: 0 };
  for (const { org_id: orgId } of orgs) {
    try {
      const r = await sendPulse({ orgId });
      totals.sent += r.sent; totals.skipped += r.skipped; totals.failed += r.failed;
    } catch (err) {
      totals.failed += 1;
      console.error(`[telegram] pulse org ${orgId}:`, err?.message || err);
    }
  }
  return totals;
}
