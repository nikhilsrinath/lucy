import { createHash } from 'node:crypto';
import { supabaseAdmin } from '../supabaseAdmin.js';
import { shiftDays, formatDate } from '../../../src/shared/dates.js';
import { DEFAULT_SETTINGS, cleanSettings } from './policy.js';
import * as jobs from './jobs.js';
import * as workflows from './workflows.js';
import { act } from './act.js';
import { quietUntil, atLocal, daysBetween } from './time.js';
import { jlog } from './log.js';
import { runChat } from '../agent/loop.js';
import { bumpAiUsage, logAiUsage } from '../aiUsage.js';
import { AGENT_MODEL } from '../agent/model.js';
import { sendPulse } from '../telegram/pulse.js';

/**
 * What Buddy does when a job becomes due — one handler per event kind.
 *
 * OBSERVATION is deterministic: the job exists because code (observe.js, a
 * workflow, a tool) saw a date arrive. Each handler first re-reads the
 * current truth through the job's session (RLS applies) and drops events that
 * no longer matter — the task was done, its deadline moved, a workflow owns
 * it — recording why, so the same event is never reconsidered.
 *
 * ACTION always goes through act() → the one pipeline → the policy decides
 * whether it runs now or waits for approval. Messages are templated from
 * the record: no model call is needed to say "X is due tomorrow".
 *
 * REASONING (the model) is used only where meaning is needed: a scheduled
 * check a person asked Buddy to make ("on Friday see whether the deck is done
 * and tell me") runs the same Buddy loop, bounded, then stops.
 *
 * A handler returns { status: 'completed', result, actionIds } or
 * { status: 'deferred', runAt }; it throws jobs.PermanentError /
 * jobs.TransientError to fail or retry.
 */

const db = () => supabaseAdmin();
const LIVE = ['active', 'escalated'];
const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';
const done = (result = {}, actionIds = []) => ({ status: 'completed', result, actionIds: actionIds.filter(Boolean) });
const skipped = (reason, extra = {}) => done({ skipped: reason, ...extra });

/* ── guards ───────────────────────────────────────────────────────────────── */

/**
 * A job may only name records of its own company. Jobs are created by the
 * server, so a foreign id means a bug or tampering: refused, logged, never
 * read. (The session's RLS would hide the record anyway; this makes the
 * refusal explicit in the job's audit instead of looking like "not found".)
 */
export async function guardCompany(table, id, orgId) {
  if (!id) return;
  const { data } = await db().from(table).select('org_id').eq('id', id).maybeSingle();
  if (data && data.org_id !== orgId) {
    jlog('job.cross_company_denied', { org_id: orgId, kind: table });
    throw new jobs.PermanentError(`refused: that ${table.replace(/s$/, '')} is not in this company`, 'cross_company');
  }
}

async function readTask(ctx, id) {
  const { data, error } = await ctx.db.from('tasks')
    .select('id, org_id, title, status, deadline, assignee_id, assignee_label, updated_at').eq('id', id).maybeSingle();
  if (error) throw new jobs.TransientError(`task read failed: ${error.message}`, 'db');
  return data && data.org_id === ctx.orgId ? data : null;
}

async function readPerson(ctx, id) {
  if (!id) return null;
  const { data } = await ctx.db.from('employees').select('id, org_id, full_name, user_id, exited_at').eq('id', id).maybeSingle();
  return data && data.org_id === ctx.orgId ? data : null;
}

/** The company owner's person record — who hears about things nobody else owns. */
async function ownerPerson(ctx) {
  const { data } = await ctx.db.from('employees').select('id, org_id, full_name, user_id, exited_at, is_owner').eq('is_owner', true).limit(1);
  const row = data?.[0];
  return row && row.org_id === ctx.orgId && !row.exited_at ? row : null;
}

async function liveWorkflowTaskIds(orgId) {
  const { data } = await db().from('buddy_workflows').select('task_id').eq('org_id', orgId).in('status', LIVE);
  return new Set((data || []).map((r) => r.task_id));
}

/* ── one routine message ──────────────────────────────────────────────────── */

/** Autonomous Telegram messages this person got from Buddy in the last day. */
export async function messagesToday(orgId, personId, now = new Date()) {
  const since = new Date(now.getTime() - 86400000).toISOString();
  const { data } = await db().from('ai_actions').select('id, args, executed_at')
    .eq('org_id', orgId).eq('tool', 'send_telegram_message').eq('autonomous', true).eq('status', 'executed')
    .gte('executed_at', since).limit(100);
  return (data || []).filter((r) => r.args?.recipient_person_id === personId).length;
}

/**
 * Sends one routine message as Buddy, unless it is quiet hours (the job
 * waits) or this person already had their share today (suppressed, not
 * retried — no spam). Returns act()'s result, or { deferred } / { suppressed }.
 */
async function sendRoutine(env, ctx, { recipientId, text, key, workflowId = null, reason = null, respectQuiet = true, respectCap = true }) {
  const settings = env.settings;
  if (respectQuiet) {
    const until = quietUntil(settings, ctx.tz, env.now);
    if (until) return { status: 'deferred', runAt: until };
  }
  if (respectCap && await messagesToday(ctx.orgId, recipientId, env.now) >= settings.max_messages_per_person_per_day) {
    jlog('message.suppressed', { job_id: env.job.id, org_id: ctx.orgId, reason: 'daily_cap' });
    return { status: 'suppressed' };
  }
  return act(ctx, 'send_telegram_message', { recipient_person_id: recipientId, message: text }, {
    key, reason, workflowId, notify: env.notifyApprover,
  });
}

/**
 * What a single-message event makes of a send. Delivered, waiting for
 * approval, or nothing to send to (no Telegram) all complete the job; a
 * hiccup retries; a refusal or a lost outcome fails it for good.
 */
function messageOutcome(res, extra = {}) {
  switch (res.status) {
    case 'deferred': return { status: 'deferred', runAt: res.runAt, result: { deferred: 'quiet_hours', ...extra } };
    case 'suppressed': return skipped('daily_message_cap', extra);
    case 'executed': return done({ sent: true, reused: !!res.reused, ...extra }, [res.actionId]);
    case 'awaiting_approval': return done({ approval_requested: true, ...extra }, [res.actionId]);
    case 'not_actionable': return skipped('not_deliverable', { note: res.message, ...extra });
    case 'expired': case 'cancelled': case 'undone': return skipped(`approval_${res.status}`, extra);
    case 'refused': throw new jobs.PermanentError(`refused by policy (${res.decision?.rule})`, 'refused');
    case 'unknown': throw new jobs.PermanentError(res.message, 'outcome_unknown');
    case 'failed':
      if (res.transient) throw new jobs.TransientError(res.message || 'delivery failed', 'delivery');
      throw new jobs.PermanentError(res.message || 'delivery failed', 'delivery');
    default: throw new jobs.PermanentError(`unexpected outcome ${res.status}`);
  }
}

/* ── the handlers ─────────────────────────────────────────────────────────── */

const when = (deadline, today) => (deadline === today ? 'today' : deadline === shiftDays(today, 1) ? 'tomorrow' : `on ${formatDate(deadline)}`);

/** task_due_soon { task_id, deadline } — remind the assignee before the deadline. */
async function taskDueSoon(job, env) {
  const { task_id: taskId, deadline } = job.payload;
  await guardCompany('tasks', taskId, job.org_id);
  const ctx = await env.buddy();
  const task = await readTask(ctx, taskId);
  if (!task) return skipped('task_gone');
  if (task.status === 'done') return skipped('already_done');
  if (task.deadline !== deadline) return skipped('deadline_changed');
  if (!task.assignee_id) return skipped('unassigned');
  if ((await liveWorkflowTaskIds(job.org_id)).has(taskId)) return skipped('followed_by_workflow');
  const person = await readPerson(ctx, task.assignee_id);
  const text = `⏰ Hi ${first(person?.full_name)}, a reminder: “${task.title}” is due ${when(deadline, ctx.today)}. `
    + 'Reply here when it’s done, or tell me if anything is blocking it.';
  return messageOutcome(await sendRoutine(env, ctx, { recipientId: task.assignee_id, text, key: `ev:${job.dedupe_key}`, reason: `Due ${deadline}` }), { task_id: taskId });
}

/** task_overdue { task_id, deadline } — one follow-up with the assignee per missed deadline. */
async function taskOverdue(job, env) {
  const { task_id: taskId, deadline } = job.payload;
  await guardCompany('tasks', taskId, job.org_id);
  const ctx = await env.buddy();
  const task = await readTask(ctx, taskId);
  if (!task) return skipped('task_gone');
  if (task.status === 'done') return skipped('already_done');
  if (task.deadline !== deadline) return skipped('deadline_changed');
  if (!task.assignee_id) return skipped('unassigned');
  if ((await liveWorkflowTaskIds(job.org_id)).has(taskId)) return skipped('followed_by_workflow');
  const person = await readPerson(ctx, task.assignee_id);
  const text = `Hi ${first(person?.full_name)}, “${task.title}” was due ${formatDate(deadline)} and isn’t marked done yet. `
    + 'Is it finished, or do you need more time? Reply here and I’ll update it.';
  return messageOutcome(await sendRoutine(env, ctx, { recipientId: task.assignee_id, text, key: `ev:${job.dedupe_key}`, reason: `Overdue since ${deadline}` }), { task_id: taskId });
}

/**
 * founder_digest { date } — tasks overdue past the escalation threshold, to
 * the owner, in one message a day, and only when the list CHANGED since the
 * last digest: the same unchanged problem is never repeated.
 */
async function founderDigest(job, env) {
  const ctx = await env.buddy();
  const s = env.settings;
  const cutoff = shiftDays(ctx.today, -s.escalate_after_days);
  const { data, error } = await ctx.db.from('tasks').select('id, org_id, title, status, deadline, assignee_id, assignee_label')
    .lte('deadline', cutoff).gte('deadline', shiftDays(ctx.today, -s.overdue_window_days)).neq('status', 'done')
    .order('deadline', { ascending: true }).limit(200);
  if (error) throw new jobs.TransientError(`task read failed: ${error.message}`, 'db');
  const owned = await liveWorkflowTaskIds(job.org_id);
  const rows = (data || []).filter((t) => t.org_id === ctx.orgId && t.status !== 'done' && t.deadline && !owned.has(t.id));
  if (!rows.length) return skipped('nothing_overdue');
  const hash = createHash('sha256').update(rows.map((t) => `${t.id}:${t.deadline}`).sort().join('|')).digest('hex').slice(0, 32);
  const last = await jobs.lastCompleted(job.org_id, 'founder_digest');
  if (last?.result?.hash === hash) return skipped('unchanged_since_last_digest', { hash });
  const owner = await ownerPerson(ctx);
  if (!owner) return skipped('no_owner_record', { hash });
  const lines = rows.slice(0, 8).map((t) => `• “${t.title}”${t.assignee_label ? ` — ${t.assignee_label}` : ''}, due ${formatDate(t.deadline)}`);
  const text = `📋 ${rows.length} task${rows.length === 1 ? ' is' : 's are'} overdue by ${s.escalate_after_days}+ days:\n${lines.join('\n')}`
    + `${rows.length > 8 ? `\n…and ${rows.length - 8} more.` : ''}\nReply here if you want me to chase anyone or move a deadline.`;
  const res = await sendRoutine(env, ctx, { recipientId: owner.id, text, key: `ev:${job.dedupe_key}`, reason: 'Overdue work', respectCap: false });
  return messageOutcome(res, { hash, tasks: rows.length });
}

/** reminder_due { recipient_person_id, text, initiator } — a reminder someone scheduled. */
async function reminderDue(job, env) {
  const p = job.payload;
  await guardCompany('employees', p.recipient_person_id, job.org_id);
  const initiator = p.initiator || { kind: 'buddy' };
  const stillThere = await workflows.initiatorActive({
    org_id: job.org_id, initiator_kind: initiator.kind, initiator_user_id: initiator.userId || null, initiator_employee_id: initiator.employeeId || null,
  });
  if (!stillThere) return skipped('initiator_gone');
  const ctx = await env.buddy();
  const self = initiator.employeeId && initiator.employeeId === p.recipient_person_id;
  const text = `⏰ Reminder${self || !initiator.name ? '' : ` from ${first(initiator.name)}`}: ${String(p.text || '').slice(0, 600)}`;
  // The person chose this time: quiet hours do not apply.
  return messageOutcome(await sendRoutine(env, ctx, {
    recipientId: p.recipient_person_id, text, key: `ev:${job.dedupe_key}`, reason: 'Scheduled reminder', respectQuiet: false,
  }));
}

/** pulse_due { date } — the Daily Pulse, now one job per company per day. */
async function pulseDue(job) {
  try {
    const out = await sendPulse({ orgId: job.org_id });
    return done({ pulse: out });
  } catch (err) {
    throw new jobs.TransientError(`pulse failed: ${err?.message || err}`, 'pulse');
  }
}

/* ── workflows ────────────────────────────────────────────────────────────── */

/**
 * workflow_check_due { workflow_id, phase } — one checkpoint of a
 * follow-through, then the next one scheduled:
 *
 *   kickoff   tell the assignee (who asked, what, by when)
 *   due       on the deadline day: a reminder
 *   overdue   the day after: a follow-up with the assignee
 *   escalate  escalate_after_days after the deadline: tell whoever asked
 *   watch     daily and silent, until it is done (then tell whoever asked)
 *
 * The task is re-read at every checkpoint: done → the workflow completes;
 * deadline moved → the plan follows the new date; gone → cancelled.
 */
async function workflowCheck(job, env) {
  const { workflow_id: wfId, phase } = job.payload;
  await guardCompany('buddy_workflows', wfId, job.org_id);
  const wf = await workflows.loadWorkflow(job.org_id, wfId);
  if (!wf) return skipped('workflow_gone');
  if (!LIVE.includes(wf.status)) return skipped(`workflow_${wf.status}`);
  if (!(await workflows.initiatorActive(wf))) {
    await workflows.cancelWorkflow({ orgId: wf.org_id, workflowId: wf.id, reason: 'initiator_gone' });
    return skipped('initiator_gone');
  }
  const ctx = await env.buddy();
  const task = await readTask(ctx, wf.task_id);
  if (!task) {
    await workflows.cancelWorkflow({ orgId: wf.org_id, workflowId: wf.id, reason: 'task_gone' });
    return skipped('task_gone');
  }
  const s = { ...env.settings, ...cleanSettings(wf.policy) };
  const today = ctx.today;
  const D = task.deadline;
  const gen = Number(wf.state?.generation) || 0;
  const assigneeId = task.assignee_id || wf.assignee_employee_id;
  const assignee = await readPerson(ctx, assigneeId);
  const initiator = wf.initiator_employee_id ? await readPerson(ctx, wf.initiator_employee_id) : null;
  const escalateTo = initiator && initiator.id !== assigneeId ? initiator : await ownerPerson(ctx);
  const state = { ...(wf.state || {}) };
  const actionIds = [];
  const at = (date, h = s.reminder_hour) => atLocal(date, h, 0, ctx.tz);
  const send = async (recipient, text, step, opts = {}) => {
    if (!recipient) return { status: 'not_actionable', message: 'nobody to tell' };
    const res = await sendRoutine(env, ctx, { recipientId: recipient.id, text, key: `wf:${wf.id}:${step}:${D || 'none'}:${gen}`, workflowId: wf.id, reason: wf.goal || task.title, ...opts });
    if (res.actionId) actionIds.push(res.actionId);
    // A hiccup retries the checkpoint (nothing is scheduled until it
    // succeeds); a lost outcome is final. Anything else — no Telegram, a
    // blocked bot, an approval request — is recorded and the follow-through
    // goes on, so the escalation still happens.
    if (res.status === 'failed' && res.transient) throw new jobs.TransientError(res.message || 'delivery failed', 'delivery');
    if (res.status === 'unknown') throw new jobs.PermanentError(res.message, 'outcome_unknown');
    state.log = [...(state.log || []), { step, at: env.now.toISOString(), result: res.status }].slice(-20);
    return res;
  };

  if (task.status === 'done') {
    if (s.notify_on_complete && escalateTo && initiator && initiator.id !== assigneeId) {
      const res = await send(initiator, `✅ ${first(assignee?.full_name)} marked “${task.title}” done.`, 'done', { respectCap: false });
      if (res.status === 'deferred') return { status: 'deferred', runAt: res.runAt, result: { deferred: 'quiet_hours' } };
    }
    await workflows.saveWorkflow(wf, { status: 'completed', completed_at: env.now.toISOString(), next_check_at: null, state: { ...state, completed_at: env.now.toISOString() } });
    return done({ workflow: 'completed' }, actionIds);
  }

  let next = null;
  let res = null;
  const nextFromDeadline = () => {
    if (!D) return { phase: 'watch', runAt: at(shiftDays(today, 1)) };
    if (D > today) return { phase: 'due', runAt: at(D) };
    if (D === today) return { phase: 'overdue', runAt: at(shiftDays(D, 1)) };
    return { phase: 'overdue', runAt: env.now };
  };

  switch (phase) {
    case 'kickoff': {
      const by = D ? ` by ${D === today ? 'today' : formatDate(D)}` : '';
      const who = initiator && initiator.id !== assigneeId ? `${first(initiator.full_name)} asked me to make sure` : 'I’ll make sure';
      res = await send(assignee, `👋 Hi ${first(assignee?.full_name)}, ${who} “${task.title}” gets done${by}. `
        + `${D && D > today ? 'I’ll remind you on the day. ' : ''}If anything blocks you, just reply here.`, 'kickoff');
      next = nextFromDeadline();
      if (next.phase === 'overdue' && D && D < today) next = { phase: 'overdue', runAt: env.now };
      break;
    }
    case 'due': {
      if (!D || D > today) { next = nextFromDeadline(); break; }
      if (D === today) {
        res = await send(assignee, `⏰ Hi ${first(assignee?.full_name)}, “${task.title}” is due today. Reply here when it’s done, or tell me if you need more time.`, 'due');
      }
      next = { phase: 'overdue', runAt: D === today ? at(shiftDays(D, 1)) : env.now };
      break;
    }
    case 'overdue': {
      if (!D || D >= today) { next = nextFromDeadline(); break; }
      res = await send(assignee, `Hi ${first(assignee?.full_name)}, “${task.title}” was due ${formatDate(D)} and isn’t marked done yet. `
        + 'Is it finished, or do you need more time? Reply here and I’ll update it.', 'overdue');
      state.followups = (Number(state.followups) || 0) + (res.status === 'executed' ? 1 : 0);
      next = s.escalate
        ? { phase: 'escalate', runAt: at(shiftDays(D, s.escalate_after_days)) }
        : { phase: 'watch', runAt: at(shiftDays(today, 1)) };
      break;
    }
    case 'escalate': {
      if (!D || D >= today) { next = nextFromDeadline(); break; }
      const late = daysBetween(D, today);
      if (late < s.escalate_after_days) { next = { phase: 'escalate', runAt: at(shiftDays(D, s.escalate_after_days)) }; break; }
      const said = (state.log || []).filter((l) => l.result === 'executed').map((l) => l.step);
      const history = said.includes('overdue') ? ` I reminded ${first(assignee?.full_name)} and followed up after the deadline.` : '';
      res = await send(escalateTo, `⚠️ “${task.title}” (${assignee?.full_name || task.assignee_label || 'unassigned'}) is ${late} day${late === 1 ? '' : 's'} overdue — it was due ${formatDate(D)}.${history} `
        + 'Want me to move the deadline, reassign it, or keep chasing?', 'escalate', { respectCap: false });
      if (res.status !== 'deferred') {
        state.escalated_at = env.now.toISOString();
        await workflows.saveWorkflow(wf, { status: 'escalated', state });
      }
      next = { phase: 'watch', runAt: at(shiftDays(today, 1)) };
      break;
    }
    case 'watch': {
      state.watch_days = (Number(state.watch_days) || 0) + 1;
      if (D && D >= today) {
        // The deadline was moved to the future: follow it through again.
        if (wf.status === 'escalated') await workflows.saveWorkflow(wf, { status: 'active' });
        state.watch_days = 0;
        next = nextFromDeadline();
        break;
      }
      next = state.watch_days >= 14 ? null : { phase: 'watch', runAt: at(shiftDays(today, 1)) };
      break;
    }
    default:
      throw new jobs.PermanentError(`unknown workflow phase ${phase}`, 'invalid');
  }

  if (res?.status === 'deferred') return { status: 'deferred', runAt: res.runAt, result: { deferred: 'quiet_hours', phase } };
  state.deadline_seen = D || null;
  await workflows.saveWorkflow(wf, { state, next_check_at: next ? new Date(next.runAt).toISOString() : null });
  if (next) await workflows.scheduleCheck(wf, { phase: next.phase, runAt: next.runAt, deadline: D || 'none' });
  return done({ phase, message: res?.status || null, next: next?.phase || null }, actionIds);
}

/* ── a scheduled check: Buddy reasons ─────────────────────────────────────── */

/**
 * buddy_review { instruction, report_to } — "on Friday, check whether the
 * deck is done and tell me". The same Buddy loop as a chat message, in the
 * asker's own session (their permissions), bounded to one turn; writes it
 * proposes go through the policy like any job's. Its answer is sent to the
 * asker on Telegram by Buddy. Metered against the plan's AI limit.
 */
async function buddyReview(job, env) {
  const p = job.payload || {};
  const ctx = await env.actor();
  const used = await bumpAiUsage(ctx.orgId, 'buddy');
  if (used > ctx.aiLimit) return skipped('ai_limit_reached');
  const texts = [];
  const actionIds = [];
  const emit = (event, data) => {
    if (event === 'text' && data?.text) texts.push(data.text);
    if (event === 'notice' && data?.text) texts.push(data.text);
    if (event === 'card' && data?.card?.action_id) actionIds.push(data.card.action_id);
  };
  const message = `SCHEDULED CHECK — you are running on your own, not in a conversation. The user asked you on ${p.asked_on || 'an earlier day'} to do this today:\n`
    + `"${String(p.instruction || '').slice(0, 500)}"\nLook up what you need, do what the instruction asks, then write a short report (at most 5 lines) addressed to them.`;
  try {
    await runChat(ctx, { message, history: [], chatId: `job:${job.id}`, messageId: job.id }, emit, { callModelImpl: env.callModel });
    await logAiUsage({ orgId: ctx.orgId, user: ctx.user?.id ? ctx.user : null, surface: 'copilot', model: AGENT_MODEL });
  } catch (err) {
    await logAiUsage({ orgId: ctx.orgId, user: ctx.user?.id ? ctx.user : null, surface: 'copilot', outcome: 'failed', model: AGENT_MODEL });
    throw new jobs.TransientError(`the model call failed: ${err?.message || err}`, 'model');
  }
  const report = texts.join('\n').replace(/\[\[show:v\d+\]\]/g, '').trim().slice(0, 1500);
  if (!report) return done({ report: null }, actionIds);
  const to = p.report_to || ctx.employeeId;
  if (!to) return done({ report_delivered: false, reason: 'no_person_record' }, actionIds);
  const buddyCtx = await env.buddy();
  // A report to the person who asked for it goes to them as is — the
  // recipient-access check (withheldFor) still applies.
  buddyCtx.autonomy.selfReport = to;
  const res = await sendRoutine(env, buddyCtx, { recipientId: to, text: `🔎 ${report}`, key: `ev:${job.dedupe_key}:report`, reason: 'Scheduled check', respectQuiet: false, respectCap: false });
  if (res.actionId) actionIds.push(res.actionId);
  const out = messageOutcome(res, { report_chars: report.length });
  out.actionIds = [...new Set([...(out.actionIds || []), ...actionIds])];
  return out;
}

export const HANDLERS = {
  task_due_soon: taskDueSoon,
  task_overdue: taskOverdue,
  founder_digest: founderDigest,
  reminder_due: reminderDue,
  pulse_due: pulseDue,
  workflow_check_due: workflowCheck,
  buddy_review: buddyReview,
};

export const EVENT_KINDS = Object.keys(HANDLERS);
export { DEFAULT_SETTINGS };
