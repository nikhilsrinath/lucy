import { AgentError, friendlyDbError } from './db.js';
import { sendOrgMail } from '../mailer.js';

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
 *
 * `allowDelete: false` (a linked company person, who never deletes) refuses
 * every delete op, including one a follow-up or an undo would run — the
 * database refuses it as well (0071); this says so plainly first.
 *
 * An email leaves the building: it cannot be undone, so an action whose plan
 * sent one has no Undo. Put it first in a plan, so a failed send stops the
 * bookkeeping that would claim it went out.
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
    } else if (r.op === 'delete' || r.op === 'email') {
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
