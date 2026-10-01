import { AgentError, friendlyDbError } from './db.js';
import { sendOrgMail } from '../mailer.js';
import { deliverPrivate, deliverGroup, DeliveryError } from '../telegram/outbound.js';
import * as jobs from '../autonomy/jobs.js';
import { startFollowup, cancelWorkflow } from '../autonomy/workflows.js';

/**
 * Applies a write plan as the user.
 *
 * Tools do not write. They return a plan — a list of the row operations the
 * change amounts to — and this file carries it out through the caller's own
 * Supabase client. That keeps the parts every write needs in one place:
 *
 *   · optimistic concurrency: an update or delete names the `updated_at` it
 *     was proposed against, and matches nothing if the row has moved since;
 *   · a before/after record of every row touched, which is what Undo restores
 *     and what the AI activity log shows;
 *   · dry run: the same plan, returned instead of applied.
 *
 * Operations (any may carry `key`, echoed on its result so a tool's own
 * undoPlan can find it, and `then`, whose ops may have their own `then`):
 *   { op: 'insert', table, row, refresh?, then?: (inserted) => ops[] }
 *   { op: 'insertMany', table, rows }
 *   { op: 'update', table, id, version, patch, before }
 *   { op: 'delete', table, id, version, before }
 *   { op: 'rpc',    fn, params }
 *   { op: 'email',  orgId, userId, to, subject, text, fromName }
 *   { op: 'telegram', orgId, employeeId, text, senderName, orgName, fromBuddy? }
 *   { op: 'telegram_group', orgId, text, mentionEmployeeId?, orgName, fromBuddy, senderName }   (0073)
 *   { op: 'job',      orgId, kind, dedupeKey, runAt, actor, payload }   (0072)
 *   { op: 'cancel_job', orgId, jobId }
 *   { op: 'workflow', orgId, taskId, assigneeId, initiator, goal, settings }
 *   { op: 'workflow_cancel', orgId, workflowId }
 *
 * `allowDelete: false` (a linked company person, who never deletes) refuses
 * every delete op, including one a follow-up or an undo would run — the
 * database refuses it as well (0071); this says so plainly first.
 *
 * An email leaves the building: it cannot be undone, so an action whose plan
 * sent one has no Undo. Put it first in a plan, so a failed send stops the
 * bookkeeping that would claim it went out.
 *
 * A Telegram message is the same: it goes to one company person's private
 * chat with the bot, resolved again from the person id at the moment of
 * sending (telegram/outbound.js), and it cannot be unsent. It counts as done
 * only once Telegram returns the message id.
 *
 * Scheduling ops (job, workflow — 0072) write Buddy's own queue with the
 * service role, always in the company the tool took from the verified
 * session (op.orgId = ctx.orgId), never from the model. The business rows a
 * follow-through is about (the task) are written before them, as the user.
 *
 * `then` runs follow-ups that need the new row's id (a project allocation for
 * a cash entry). A follow-up failing leaves the main write standing and is
 * reported as a warning — the card says so rather than pretending either way.
 */

export async function applyPlan(db, plan, { dryRun = false, stopOnError = true, allowDelete = true } = {}) {
  if (dryRun) return { dryRun: true, ops: plan.map(describeOp) };
  const apply = (op) => {
    if (op.op === 'delete' && !allowDelete) throw new AgentError(DELETE_REFUSED, { code: 'denied' });
    return applyOp(db, op);
  };
  const results = [];
  const warnings = [];

  // Follow-ups run after their parent and may have follow-ups of their own. A
  // failed follow-up is a warning; the parent stands. `refresh` re-reads the
  // parent afterwards, so `after` carries what triggers computed from the
  // follow-ups (a document's totals once its line items exist).
  const followUps = async (op, done) => {
    if (!op.then || done.after === undefined || done.after === null) return;
    for (const follow of op.then(done.after) || []) {
      try {
        const res = { ...(await apply(follow)), followUp: true, key: follow.key || null };
        results.push(res);
        await followUps(follow, res);
      } catch (err) {
        warnings.push(err instanceof AgentError ? err.message : friendlyDbError(err));
      }
    }
    if (op.refresh && done.id) {
      const { data } = await db.from(op.table).select('*').eq('id', done.id).maybeSingle();
      if (data) done.after = data;
    }
  };

  for (const op of plan) {
    try {
      const done = { ...(await apply(op)), key: op.key || null };
      results.push(done);
      await followUps(op, done);
    } catch (err) {
      const failure = {
        op: op.op, table: op.table, id: op.id || null, ok: false,
        code: err.code || 'failed',
        ...(err instanceof AgentError && err.detail ? { detail: err.detail } : {}),
        error: err instanceof AgentError ? err.message : friendlyDbError(err),
      };
      results.push(failure);
      if (stopOnError) break;
    }
  }
  return { results, warnings, ok: results.length > 0 && results.every((r) => r.ok !== false) };
}

export const DELETE_REFUSED = 'Deleting requires admin access.';

function describeOp(op) {
  const { then: _then, ...rest } = op;
  return rest;
}

async function applyOp(db, op) {
  switch (op.op) {
    case 'insert': {
      const { data, error } = await db.from(op.table).insert(op.row).select().maybeSingle();
      if (error) throw error;
      // An insert RLS refuses is an error; one that succeeds but is invisible
      // afterwards (insert allowed, select not) still happened.
      return { op: 'insert', table: op.table, id: data?.id || null, before: null, after: data || op.row, ok: true };
    }
    case 'insertMany': {
      if (!op.rows?.length) return { op: 'insertMany', table: op.table, ids: [], before: null, after: [], ok: true };
      const { data, error } = await db.from(op.table).insert(op.rows).select();
      if (error) throw error;
      return { op: 'insertMany', table: op.table, ids: (data || []).map((r) => r.id), before: null, after: data || [], ok: true };
    }
    case 'update': {
      let q = db.from(op.table).update(op.patch).eq('id', op.id);
      if (op.version) q = q.eq('updated_at', op.version);
      const { data, error } = await q.select().maybeSingle();
      if (error) throw error;
      if (!data) await explainMiss(db, op);
      return { op: 'update', table: op.table, id: op.id, before: op.before || null, after: data, ok: true };
    }
    case 'delete': {
      let q = db.from(op.table).delete().eq('id', op.id);
      if (op.version) q = q.eq('updated_at', op.version);
      const { data, error } = await q.select().maybeSingle();
      if (error) throw error;
      if (!data) await explainMiss(db, op);
      return { op: 'delete', table: op.table, id: op.id, before: op.before || data, after: null, ok: true };
    }
    case 'email': {
      try {
        const sent = await sendOrgMail(op);
        return { op: 'email', table: null, id: null, before: null, after: { to: op.to, subject: op.subject, messageId: sent.messageId }, ok: true };
      } catch (err) {
        throw new AgentError(err?.message || 'The email could not be sent.', { code: 'email' });
      }
    }
    case 'telegram': {
      try {
        const sent = await deliverPrivate(op);
        return { op: 'telegram', table: null, id: null, before: null, after: sent, ok: true };
      } catch (err) {
        // A DeliveryError's message is written for the person; anything else is not.
        // Its code (blocked, revoked, telegram…) tells a job's retry whether trying again can help.
        throw new AgentError(err instanceof DeliveryError ? err.message : 'Telegram couldn’t deliver this message.', { code: 'telegram', detail: err instanceof DeliveryError ? err.code : 'telegram' });
      }
    }
    case 'telegram_group': {
      try {
        const sent = await deliverGroup(op);
        return { op: 'telegram_group', table: null, id: null, before: null, after: sent, ok: true };
      } catch (err) {
        throw new AgentError(err instanceof DeliveryError ? err.message : 'Telegram couldn’t post this in the group.', { code: 'telegram', detail: err instanceof DeliveryError ? err.code : 'telegram' });
      }
    }
    case 'job': {
      const job = await jobs.enqueue({ orgId: op.orgId, kind: op.kind, dedupeKey: op.dedupeKey, runAt: op.runAt, actor: op.actor, payload: op.payload, source: op.source || 'action' });
      if (!job.id) throw new AgentError('Could not schedule that.', { code: 'schedule' });
      return { op: 'job', table: null, id: null, before: null, after: { job_id: job.id, org_id: op.orgId, kind: op.kind, run_at: new Date(op.runAt).toISOString() }, ok: true };
    }
    case 'cancel_job': {
      const ids = await jobs.cancel({ orgId: op.orgId, ids: [op.jobId], reason: 'undone' });
      if (!ids.length) throw new AgentError('It has already run, so it cannot be undone.', { code: 'stale' });
      return { op: 'cancel_job', table: null, id: null, before: null, after: { job_id: op.jobId }, ok: true };
    }
    case 'workflow': {
      if (!op.taskId) throw new AgentError('There is no task to follow through.', { code: 'schedule' });
      const wf = await startFollowup({
        orgId: op.orgId, taskId: op.taskId, assigneeId: op.assigneeId, initiator: op.initiator,
        goal: op.goal || null, settings: op.settings || {}, sourceActionId: op.actionId || null,
      });
      return { op: 'workflow', table: null, id: null, before: null, after: { workflow_id: wf.workflowId, job_ids: wf.jobIds, restarted: wf.restarted, task_id: op.taskId }, ok: true };
    }
    case 'workflow_cancel': {
      const out = await cancelWorkflow({ orgId: op.orgId, workflowId: op.workflowId, reason: 'stopped on request' });
      if (!out.workflow) throw new AgentError('I am not following that through any more.', { code: 'gone' });
      return { op: 'workflow_cancel', table: null, id: null, before: null, after: { workflow_id: op.workflowId, jobs_cancelled: out.jobs.length }, ok: true };
    }
    case 'rpc': {
      const { data, error } = await db.rpc(op.fn, op.params);
      if (error) throw error;
      return { op: 'rpc', fn: op.fn, after: data ?? null, ok: true };
    }
    default:
      throw new AgentError(`Unknown operation ${op.op}`);
  }
}

/**
 * An update or delete that matched no row. Three reasons, and the person
 * deserves to know which: the row is gone, it changed since the card was
 * drawn, or their role cannot write it.
 */
async function explainMiss(db, op) {
  const { data: now } = await db.from(op.table).select('id, updated_at').eq('id', op.id).maybeSingle();
  if (!now) throw new AgentError('That record no longer exists, or you can no longer see it.', { code: 'gone' });
  if (op.version && now.updated_at !== op.version && !sameInstant(now.updated_at, op.version)) {
    throw new AgentError('It was changed by someone else after this was proposed.', { code: 'stale' });
  }
  throw new AgentError('Your role does not allow that change.', { code: 'denied' });
}

/**
 * Two timestamptz strings for the same instant ("…+00:00" vs "…Z"), to the
 * microsecond Postgres keeps — Date.parse alone would drop the last three
 * digits and call two different versions equal.
 */
export function sameInstant(a, b) {
  const ma = micros(a);
  return ma !== null && ma === micros(b);
}

function micros(ts) {
  const m = String(ts || '').match(/^(.*?T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/);
  if (!m) return null;
  const base = Date.parse(m[1] + (m[3] || 'Z'));
  if (!Number.isFinite(base)) return null;
  return base * 1000 + Number((m[2] || '').padEnd(6, '0').slice(0, 6));
}

/**
 * The plan that undoes an executed one, from what it recorded.
 *
 * An update is reversed by writing back the columns it changed — only if the
 * row still carries the version this action left it at, so an undo never
 * overwrites somebody's later edit. An insert is reversed by deleting the row
 * it created. A delete cannot be undone here and makes the whole action
 * irreversible. Follow-ups (allocations) go with their parent row.
 */
export function undoPlan(results) {
  const plan = [];
  for (const r of [...(results || [])].reverse()) {
    if (r.ok === false || r.followUp) continue;
    if (r.op === 'update') {
      plan.push({ op: 'update', table: r.table, id: r.id, version: r.after?.updated_at || null, patch: r.before || {}, before: pick(r.after, Object.keys(r.before || {})) });
    } else if (r.op === 'insert') {
      plan.push({ op: 'delete', table: r.table, id: r.id, version: r.after?.updated_at || null, before: r.after });
    } else if (r.op === 'job') {
      // A scheduled job not yet run is cancelled; one that ran cannot be undone.
      plan.push({ op: 'cancel_job', orgId: r.after?.org_id, jobId: r.after?.job_id });
    } else if (r.op === 'delete' || r.op === 'email' || r.op === 'telegram' || r.op === 'telegram_group' || r.op === 'workflow' || r.op === 'workflow_cancel') {
      return null;
    }
  }
  return plan.length ? plan : null;
}

/** Whether a plan deletes a row. */
export function hasDelete(plan) {
  return (plan || []).some((op) => op?.op === 'delete');
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k] ?? null;
  return out;
}
