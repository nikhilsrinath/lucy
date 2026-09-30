import { supabaseAdmin } from '../supabaseAdmin.js';

/**
 * public.buddy_jobs (0072) — the durable job/event queue.
 *
 * A job is one meaningful business event that has become (or will become)
 * due: a task due tomorrow, a workflow checkpoint, a scheduled reminder, the
 * Daily Pulse. It lives in Postgres, so it survives function restarts and
 * deploys; nothing here is held in memory between invocations.
 *
 *   enqueue   idempotent on (org, dedupe_key): the same event enqueued twice
 *             — two cron runs, a retry, a sweep that sees the same deadline —
 *             is one job.
 *   claim     buddy_claim_jobs(): FOR UPDATE SKIP LOCKED + a lease, so a job
 *             is handed to exactly one worker; an expired lease (a crashed
 *             worker) makes it claimable again, as a new attempt.
 *   finish    fenced on (status = processing, locked_by = this worker): a
 *             worker whose lease expired and was overtaken cannot overwrite
 *             the newer attempt's outcome.
 *
 * Written only with the service role, only by the engine.
 */

const db = () => supabaseAdmin();

export const KIND_RE = /^[a-z][a-z0-9_]{2,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PAYLOAD_BYTES = 8000;
export const LEASE_SECONDS = 120;

/** A failure that retrying cannot fix (not found, not allowed, invalid). */
export class PermanentError extends Error {
  constructor(message, code = 'permanent') {
    super(message);
    this.code = code;
    this.permanent = true;
  }
}

/** A failure worth retrying (network, Telegram 5xx/429, a database hiccup). */
export class TransientError extends Error {
  constructor(message, code = 'transient') {
    super(message);
    this.code = code;
    this.permanent = false;
  }
}

/** 1 min, 4 min, 16 min, ~1 h, ~4 h — capped at 6 h. */
export function backoffMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(6 * 3600_000, 60_000 * 4 ** (n - 1));
}

function validate(job) {
  if (!UUID.test(String(job.orgId || ''))) throw new PermanentError('enqueue: bad org id', 'invalid');
  if (!KIND_RE.test(String(job.kind || ''))) throw new PermanentError('enqueue: bad kind', 'invalid');
  const key = String(job.dedupeKey || '');
  if (key.length < 3 || key.length > 300) throw new PermanentError('enqueue: bad dedupe key', 'invalid');
  const payload = job.payload || {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new PermanentError('enqueue: payload must be an object', 'invalid');
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) throw new PermanentError('enqueue: payload too large', 'invalid');
  const actor = job.actor || { kind: 'buddy' };
  if (!['user', 'person', 'buddy'].includes(actor.kind)) throw new PermanentError('enqueue: bad actor', 'invalid');
  if (actor.kind === 'user' && !UUID.test(String(actor.userId || ''))) throw new PermanentError('enqueue: user actor needs a user id', 'invalid');
  if (actor.kind === 'person' && !UUID.test(String(actor.employeeId || ''))) throw new PermanentError('enqueue: person actor needs an employee id', 'invalid');
  return { key, payload, actor };
}

/**
 * Adds a job unless one with this dedupe key already exists for the company.
 * Returns { id, created }.
 */
export async function enqueue(job, { client = db() } = {}) {
  const { key, payload, actor } = validate(job);
  const row = {
    org_id: job.orgId,
    kind: job.kind,
    dedupe_key: key,
    run_at: job.runAt ? new Date(job.runAt).toISOString() : new Date().toISOString(),
    max_attempts: job.maxAttempts || 5,
    actor_kind: actor.kind,
    actor_user_id: actor.kind === 'user' ? actor.userId : null,
    actor_employee_id: actor.kind === 'person' ? actor.employeeId : null,
    workflow_id: job.workflowId || null,
    payload,
    source: job.source || null,
  };
  const { data, error } = await client.from('buddy_jobs')
    .upsert(row, { onConflict: 'org_id,dedupe_key', ignoreDuplicates: true }).select('id');
  if (error) throw new TransientError(`enqueue failed: ${error.message}`, 'db');
  if (data?.length) return { id: data[0].id, created: true };
  const { data: existing } = await client.from('buddy_jobs').select('id')
    .eq('org_id', job.orgId).eq('dedupe_key', key).maybeSingle();
  return { id: existing?.id || null, created: false };
}

/** Due jobs for this worker (see public.buddy_claim_jobs). */
export async function claim({ worker, limit = 10, leaseSeconds = LEASE_SECONDS, orgId = null, ids = null }, { client = db() } = {}) {
  const { data, error } = await client.rpc('buddy_claim_jobs', {
    p_worker: worker, p_limit: limit, p_lease_seconds: leaseSeconds, p_org: orgId, p_ids: ids,
  });
  if (error) throw new TransientError(`claim failed: ${error.message}`, 'db');
  return data || [];
}

/**
 * Records a job's outcome — only if this worker still holds it.
 *
 *   { status: 'completed', result?, actionIds? }
 *   { status: 'failed',    error, result? }              permanent
 *   { status: 'retry',     error, runAt }                 transient, attempts left
 *   { status: 'deferred',  runAt, result? }               not now (quiet hours):
 *                                                        back to pending, the
 *                                                        attempt is not counted
 * Returns the updated row, or null if the lease was lost.
 */
export async function finish(job, worker, outcome, { client = db() } = {}) {
  const now = new Date().toISOString();
  const patch = { lease_until: null, locked_by: null };
  if (outcome.status === 'completed') {
    Object.assign(patch, { status: 'completed', finished_at: now, result: outcome.result ?? null, last_error: null });
  } else if (outcome.status === 'failed') {
    Object.assign(patch, { status: 'failed', finished_at: now, result: outcome.result ?? null, last_error: clip(outcome.error) });
  } else if (outcome.status === 'retry') {
    Object.assign(patch, { status: 'retry', run_at: new Date(outcome.runAt).toISOString(), last_error: clip(outcome.error) });
  } else if (outcome.status === 'deferred') {
    Object.assign(patch, { status: 'pending', run_at: new Date(outcome.runAt).toISOString(), attempts: Math.max(0, (job.attempts || 1) - 1), result: outcome.result ?? null });
  } else {
    throw new Error(`finish: unknown status ${outcome.status}`);
  }
  if (outcome.actionIds?.length) patch.action_ids = [...new Set([...(job.action_ids || []), ...outcome.actionIds])].slice(0, 50);
  const { data, error } = await client.from('buddy_jobs').update(patch)
    .eq('id', job.id).eq('status', 'processing').eq('locked_by', worker).select().maybeSingle();
  if (error) throw new TransientError(`finish failed: ${error.message}`, 'db');
  return data || null;
}

/** Cancels the pending jobs of a workflow (or these ids) in a company. */
export async function cancel({ orgId, workflowId = null, ids = null, reason = 'cancelled' }, { client = db() } = {}) {
  let q = client.from('buddy_jobs').update({ status: 'cancelled', finished_at: new Date().toISOString(), last_error: clip(reason) })
    .eq('org_id', orgId).in('status', ['pending', 'retry']);
  if (workflowId) q = q.eq('workflow_id', workflowId);
  if (ids) q = q.in('id', ids);
  const { data, error } = await q.select('id');
  if (error) throw new TransientError(`cancel failed: ${error.message}`, 'db');
  return (data || []).map((r) => r.id);
}

/** The latest completed job of a kind in a company (e.g. the last digest sent). */
export async function lastCompleted(orgId, kind, { client = db() } = {}) {
  const { data } = await client.from('buddy_jobs').select('id, result, finished_at')
    .eq('org_id', orgId).eq('kind', kind).eq('status', 'completed')
    .order('finished_at', { ascending: false }).limit(1);
  return data?.[0] || null;
}

const clip = (s) => (s ? String(s).slice(0, 1000) : null);
