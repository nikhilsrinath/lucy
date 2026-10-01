import { supabaseAdmin } from '../supabaseAdmin.js';
import { shiftDays } from '../../../src/shared/dates.js';
import { openBuddySession } from '../agent/channelSession.js';
import { loadPolicy } from './policy.js';
import * as jobs from './jobs.js';
import * as workflows from './workflows.js';
import { atLocal, localNow } from './time.js';
import { orgBasics } from '../telegram/store.js';
import { groupPostsOn } from './handlers.js';
import { jlog } from './log.js';

/**
 * OBSERVATION — deterministic, no model. Once per worker run, per company
 * where Buddy can act (Telegram on, autonomy not switched off), turn what the
 * database says into jobs:
 *
 *   task due within remind_days_before  → task_due_soon  task_due_soon:<task>:<deadline>
 *   task past its deadline              → task_overdue   task_overdue:<task>:<deadline>
 *     (only deadlines within overdue_window_days: old slippage is not chased)
 *   tasks overdue ≥ escalate_after_days → founder_digest digest:<date>
 *   Daily Pulse on                      → pulse_due      pulse:<date>, at the company's pulse hour
 *   a workflow whose checkpoint is due  → re-enqueued by its own key (a safety net
 *                                         if scheduling the next step failed)
 *
 * Keys are deterministic, so running this every minute or once a day makes
 * the same jobs: an event is enqueued once, whatever wakes the worker.
 * Tasks a workflow follows through are left to the workflow. Only people who
 * can actually be messaged (a live Telegram link with a private chat) get
 * reminder jobs — nothing is enqueued just to be skipped.
 *
 * The tasks are read through each company's Buddy principal (RLS), never
 * with the service role; the service role only lists which companies have
 * Telegram on and who is reachable there (the adapter's own tables).
 */

const db = () => supabaseAdmin();

async function candidateOrgs() {
  const { data, error } = await db().from('org_telegram').select('org_id, enabled, pulse_enabled, pulse_hour').eq('enabled', true);
  if (error) throw new jobs.TransientError(`org list failed: ${error.message}`, 'db');
  return data || [];
}

/** Person ids in this company Buddy can reach privately on Telegram. */
async function reachablePeople(orgId) {
  const { data: links } = await db().from('telegram_links').select('employee_id, user_id, dm_chat_id, telegram_user_id')
    .eq('org_id', orgId).is('revoked_at', null);
  const live = (links || []).filter((l) => l.dm_chat_id && String(l.dm_chat_id) === String(l.telegram_user_id));
  const ids = new Set(live.filter((l) => l.employee_id).map((l) => l.employee_id));
  const users = live.filter((l) => l.user_id).map((l) => l.user_id);
  if (users.length) {
    const { data: emps } = await db().from('employees').select('id, user_id').eq('org_id', orgId).in('user_id', users);
    for (const e of emps || []) ids.add(e.id);
  }
  return ids;
}

export async function observeOrg(org, { now = new Date(), session = openBuddySession } = {}) {
  const orgId = org.org_id;
  const made = [];
  const add = async (job) => {
    const r = await jobs.enqueue({ orgId, source: 'observe', ...job });
    if (r.created) made.push(job.kind);
  };

  // Daily Pulse rides the same queue: one job per company per day, due at
  // the company's pulse hour (sendPulse keeps its own one-a-day rule too).
  // It is an existing feature with its own switch, so it does not depend on
  // the autonomy policy or on a Buddy session.
  if (org.pulse_enabled) {
    const { tz } = await orgBasics(orgId);
    const day = localNow(tz || undefined, now).date;
    await add({ kind: 'pulse_due', dedupeKey: `pulse:${day}`, payload: { date: day }, runAt: atLocal(day, org.pulse_hour ?? 18, 0, tz || undefined) });
  }

  const policy = await loadPolicy(orgId);
  if (!policy.ready || !policy.enabled) return { orgId, enqueued: made.length, kinds: made, skipped: policy.ready ? 'autonomy_off' : 'not_migrated' };
  const s = policy.settings;
  let ctx;
  try {
    ctx = await session({ orgId });
  } catch (err) {
    jlog('observe.session_failed', { org_id: orgId, error: err?.message });
    return { orgId, enqueued: made.length, kinds: made, skipped: 'no_session' };
  }
  const today = ctx.today;

  // Tasks: due soon, overdue, and overdue long enough to tell the founder.
  const horizon = shiftDays(today, s.remind_days_before);
  // Work that slipped long ago is not chased out of the blue: only deadlines
  // within overdue_window_days are followed up or escalated.
  const { data: tasks, error } = await ctx.db.from('tasks').select('id, org_id, title, status, deadline, assignee_id')
    .lte('deadline', horizon).gte('deadline', shiftDays(today, -s.overdue_window_days)).neq('status', 'done')
    .order('deadline', { ascending: true }).limit(1000);
  if (error) throw new jobs.TransientError(`task read failed: ${error.message}`, 'db');
  const followed = new Set((await workflows.liveWorkflows(orgId)).map((w) => w.task_id));
  const reachable = await reachablePeople(orgId);
  // With group posts on (0073), anyone assigned can be reminded: in the group.
  const viaGroup = await groupPostsOn(orgId);
  const canReach = (id) => !!id && (viaGroup || reachable.has(id));
  let escalations = 0;
  for (const t of tasks || []) {
    if (t.org_id !== orgId || t.status === 'done' || !t.deadline || followed.has(t.id)) continue;
    const payload = { task_id: t.id, deadline: t.deadline };
    if (t.deadline >= today) {
      if (s.deadline_reminders && canReach(t.assignee_id)) {
        await add({ kind: 'task_due_soon', dedupeKey: `task_due_soon:${t.id}:${t.deadline}`, payload });
      }
    } else {
      if (s.overdue_followups && canReach(t.assignee_id)) {
        await add({ kind: 'task_overdue', dedupeKey: `task_overdue:${t.id}:${t.deadline}`, payload });
      }
      if (s.escalate && t.deadline <= shiftDays(today, -s.escalate_after_days)) escalations += 1;
    }
  }
  if (escalations) await add({ kind: 'founder_digest', dedupeKey: `digest:${today}`, payload: { date: today } });

  // Workflows whose next checkpoint is due: re-enqueue by its own key.
  for (const wf of await workflows.liveWorkflows(orgId)) {
    const nx = wf.state?.next;
    if (!nx?.key || !wf.next_check_at || Date.parse(wf.next_check_at) > now.getTime()) continue;
    await add({ kind: 'workflow_check_due', dedupeKey: nx.key, workflowId: wf.id, payload: { workflow_id: wf.id, phase: nx.phase }, runAt: nx.run_at });
  }

  return { orgId, enqueued: made.length, kinds: made };
}

export async function observeAll({ now = new Date(), session } = {}) {
  const orgs = await candidateOrgs();
  const out = { orgs: orgs.length, enqueued: 0, results: [] };
  for (const org of orgs) {
    try {
      const r = await observeOrg(org, { now, session });
      out.enqueued += r.enqueued || 0;
      out.results.push(r);
    } catch (err) {
      jlog('observe.org_failed', { org_id: org.org_id, error: err?.message });
      out.results.push({ orgId: org.org_id, error: 'failed' });
    }
  }
  jlog('observe.done', { orgs: out.orgs, enqueued: out.enqueued });
  return out;
}
