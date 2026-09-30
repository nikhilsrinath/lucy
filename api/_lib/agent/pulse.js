import { supabaseAdmin } from '../supabaseAdmin.js';
import { todayIn, DEFAULT_TZ } from '../../../src/shared/dates.js';

/**
 * Daily Pulse — Buddy asks, the person answers in their own words, Buddy
 * turns the answer into proposals, the founder sees the company's pulse.
 *
 * Channel-neutral. This module only keeps the log (public.pulse_checkins,
 * 0070): who was asked on which day and channel, what they replied, and which
 * ai_actions the reply produced. It asks nobody and understands nothing:
 *
 *   ask       a channel adapter (Telegram today; email or the dashboard later)
 *             delivers the question and calls recordAsk();
 *   answer    the reply is an ordinary Buddy message whose context source is
 *             `pulse:<checkin id>` — the prompt then reads it as a check-in
 *             answer and proposes the updates through the normal tools, cards
 *             and approvals (prompt.js pulseBlock). The adapter calls
 *             recordAnswer() with the reply and the proposals it produced;
 *   see       Buddy's team_pulse tool (tools/pulse.js) reads the log with the
 *             founder's own token (RLS: owners/admins see the org).
 *
 * No scores, no rankings: what people said and what it changed.
 */

const db = () => supabaseAdmin();
export const ANSWER_WINDOW_MS = 18 * 60 * 60 * 1000;

export function pulseDate(tz) {
  return todayIn(tz || DEFAULT_TZ);
}

export function pulseQuestion(firstName) {
  const hi = firstName ? `Hey ${firstName}` : 'Hey';
  return `${hi} 👋 How did your day go?\n\nTell me in your own words: what you finished, anything you're stuck on, or news from a client. I'll update StartupBuddy for you to confirm.`;
}

/** Records that a person was asked today. Null when they already were (one check-in a day). */
export async function recordAsk({ orgId, userId, employeeId = null, date, channel, question }) {
  const { data, error } = await db().from('pulse_checkins')
    .upsert({ org_id: orgId, user_id: userId, employee_id: employeeId, pulse_date: date, channel, question, status: 'asked' },
      { onConflict: 'org_id,user_id,pulse_date', ignoreDuplicates: true })
    .select().maybeSingle();
  if (error) throw error;
  return data || null;
}

/** Whether today's check-in was already sent to this person. */
export async function alreadyAsked({ orgId, userId, date }) {
  const { data } = await db().from('pulse_checkins').select('id').eq('org_id', orgId).eq('user_id', userId).eq('pulse_date', date).maybeSingle();
  return !!data;
}

/** The check-in this person may still be answering, if any. */
export async function openCheckin({ id, orgId, userId }) {
  if (!id) return null;
  const { data } = await db().from('pulse_checkins').select('*').eq('id', id).eq('org_id', orgId).eq('user_id', userId).maybeSingle();
  if (!data || Date.now() - Date.parse(data.asked_at) > ANSWER_WINDOW_MS) return null;
  return data;
}

/** The question could not be delivered: nothing to answer. */
export async function markSkipped(id) {
  await db().from('pulse_checkins').update({ status: 'skipped' }).eq('id', id).eq('status', 'asked');
}

/** Appends a reply (a person may answer in several messages) and the proposals it produced. */
export async function recordAnswer(row, { response, actionIds = [] }) {
  const text = String(response || '').trim().slice(0, 2000);
  const merged = row.response ? `${row.response}\n${text}`.slice(-4000) : text;
  const ids = [...new Set([...(row.action_ids || []), ...actionIds.filter(Boolean)])].slice(0, 50);
  const { data, error } = await db().from('pulse_checkins')
    .update({ status: 'answered', response: merged, action_ids: ids, answered_at: new Date().toISOString() })
    .eq('id', row.id).select().maybeSingle();
  if (error) throw error;
  return data;
}
