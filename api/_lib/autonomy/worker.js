import { randomBytes } from 'node:crypto';
import { loadPolicy } from './policy.js';
import * as jobs from './jobs.js';
import { HANDLERS } from './handlers.js';
import { observeAll } from './observe.js';
import { sessionFor } from './session.js';
import { act, approvalNotice, approvalLink } from './act.js';
import { jlog } from './log.js';
import { runDailyPulse } from '../telegram/pulse.js';

/**
 * The worker: woken by Vercel Cron (and any other authenticated scheduler),
 * it does a bounded amount of work and stops. There is no long-running
 * process and no loop waiting for things to happen — the next wake-up
 * continues from what the database holds.
 *
 *   1. observe   deterministic sweep → jobs (observe.js)
 *   2. claim     due jobs, a few at a time, each to exactly this worker
 *   3. run       the job's handler, in the job's own verified session
 *   4. finish    completed | failed | retry (backoff) | deferred — fenced on
 *                this worker's lease
 *
 * until the time budget is spent or nothing is due. `kick` runs specific
 * jobs right away (a follow-through Buddy was just asked for) through the
 * same claim, so it can never race the cron.
 */

const newWorkerId = () => `w-${String(process.env.VERCEL_REGION || 'local').replace(/[^A-Za-z0-9_.:-]/g, '')}-${randomBytes(5).toString('hex')}`;

const isMissing = (err) => /buddy_claim_jobs|buddy_jobs|does not exist|schema cache|PGRST20[25]|42P01|42883/i.test(`${err?.code || ''} ${err?.message || ''}`);

/** Everything a handler may need for one job — sessions opened lazily, once. */
function envFor(job, { now, callModel }) {
  let policyP = null;
  const memo = {};
  const env = {
    job,
    now,
    callModel,
    settings: null,
    async policy() {
      policyP = policyP || loadPolicy(job.org_id);
      return policyP;
    },
    async buddy() {
      memo.buddy = memo.buddy || sessionFor(job, { as: { kind: 'buddy' }, policy: await env.policy() });
      return memo.buddy;
    },
    async actor() {
      memo.actor = memo.actor || sessionFor(job, { policy: await env.policy() });
      return memo.actor;
    },
    /**
     * Tells whoever can approve a request Buddy raised: the user the job
     * acts for, or the company owner. A plain line and a link — the change
     * itself is shown in the app. Never recursive: the notice itself does
     * not raise another notice.
     */
    async notifyApprover({ actionId, key }) {
      const ctx = await env.buddy();
      let to = null;
      if (job.actor_kind === 'user' && job.actor_user_id) {
        const { data } = await ctx.db.from('employees').select('id').eq('user_id', job.actor_user_id).limit(1);
        to = data?.[0]?.id || null;
      }
      if (!to) {
        const { data } = await ctx.db.from('employees').select('id').eq('is_owner', true).limit(1);
        to = data?.[0]?.id || null;
      }
      if (!to) return null;
      const link = approvalLink(actionId);
      return act(ctx, 'send_telegram_message', {
        recipient_person_id: to,
        message: `${approvalNotice()}${link ? ` Review it here: ${link}` : ' Open Buddy in StartupBuddy to review it.'}`,
      }, { key, reason: 'Approval needed' });
    },
  };
  return env;
}

/** Runs one claimed job to an outcome and records it. */
export async function processJob(job, worker, { now = new Date(), callModel } = {}) {
  const started = Date.now();
  jlog('job.start', { job_id: job.id, org_id: job.org_id, kind: job.kind, attempt: job.attempts, max_attempts: job.max_attempts, worker });
  const handler = HANDLERS[job.kind];
  let outcome;
  try {
    if (!handler) throw new jobs.PermanentError(`no handler for ${job.kind}`, 'unknown_kind');
    const env = envFor(job, { now, callModel });
    const policy = await env.policy();
    if (!policy.enabled && job.kind !== 'pulse_due') {
      // The kill switch stops everything Buddy does on its own; the job ends.
      outcome = { status: 'completed', result: { skipped: 'autonomy_off' } };
    } else {
      env.settings = policy.settings;
      outcome = await handler(job, env);
    }
  } catch (err) {
    const permanent = err?.permanent === true;
    const exhausted = (job.attempts || 1) >= (job.max_attempts || 5);
    const error = String(err?.message || err).slice(0, 500);
    outcome = permanent || exhausted
      ? { status: 'failed', error, result: { code: err?.code || 'error', attempts: job.attempts } }
      : { status: 'retry', error, runAt: new Date(Date.now() + jobs.backoffMs(job.attempts)) };
    if (!(err instanceof jobs.PermanentError) && !(err instanceof jobs.TransientError)) {
      console.error('[buddy] job error', job.id, err?.stack || err);
    }
  }
  const saved = await jobs.finish(job, worker, outcome).catch((err) => {
    jlog('job.finish_failed', { job_id: job.id, org_id: job.org_id, error: err?.message });
    return null;
  });
  jlog(`job.${outcome.status}`, {
    job_id: job.id, org_id: job.org_id, kind: job.kind, status: outcome.status, attempt: job.attempts,
    ms: Date.now() - started, error: outcome.error, code: outcome.result?.code, run_at: outcome.runAt ? new Date(outcome.runAt).toISOString() : undefined,
    reason: outcome.result?.skipped || outcome.result?.deferred, action_id: outcome.actionIds?.[0],
  });
  if (!saved) jlog('job.lease_lost', { job_id: job.id, org_id: job.org_id, worker });
  return { id: job.id, kind: job.kind, status: outcome.status, result: outcome.result || null, error: outcome.error || null, recorded: !!saved };
}

/**
 * One worker run. Returns a summary (counts only — no company data).
 * `observe: false` skips the sweep; `orgId` / `ids` narrow the claim.
 */
export async function runWorker({
  now = new Date(), budgetMs = 45_000, batch = 10, observe = true, orgId = null, ids = null, callModel, worker = newWorkerId(),
} = {}) {
  const deadline = Date.now() + budgetMs;
  const summary = { worker, observed: null, claimed: 0, processed: 0, byStatus: {}, jobs: [] };
  if (observe) {
    try {
      summary.observed = await observeAll({ now });
    } catch (err) {
      if (isMissing(err)) return legacy(summary, err);
      jlog('observe.failed', { error: err?.message });
    }
  }
  while (Date.now() < deadline) {
    let claimed;
    try {
      claimed = await jobs.claim({ worker, limit: batch, orgId, ids });
    } catch (err) {
      if (isMissing(err) && observe) return legacy(summary, err);
      jlog('claim.failed', { worker, error: err?.message });
      break;
    }
    if (!claimed.length) break;
    summary.claimed += claimed.length;
    for (const job of claimed) {
      if (Date.now() >= deadline) {
        // Out of time: hand it back untouched rather than start it late.
        await jobs.finish(job, worker, { status: 'deferred', runAt: new Date() }).catch(() => null);
        continue;
      }
      const r = await processJob(job, worker, { now, callModel });
      summary.processed += 1;
      summary.byStatus[r.status] = (summary.byStatus[r.status] || 0) + 1;
      summary.jobs.push({ id: r.id, kind: r.kind, status: r.status });
    }
    if (ids) break;
  }
  jlog('worker.done', { worker, claimed: summary.claimed, processed: summary.processed, ms: budgetMs - (deadline - Date.now()) });
  summary.jobs = summary.jobs.slice(0, 50);
  return summary;
}

/**
 * Runs these just-created jobs now (bounded), e.g. the kickoff message of a
 * follow-through someone just asked for. Never throws: the cron picks up
 * anything this could not finish.
 */
export async function kick(orgId, ids, { budgetMs = 8000, callModel } = {}) {
  if (!ids?.length) return { processed: 0, jobs: [] };
  try {
    return await runWorker({ observe: false, orgId, ids, budgetMs, callModel });
  } catch (err) {
    jlog('kick.failed', { org_id: orgId, error: err?.message });
    return { processed: 0, jobs: [], error: 'failed' };
  }
}

/**
 * A database without 0072: the engine cannot run, but the Daily Pulse the
 * cron used to send must not stop. Runs the pre-0072 pulse.
 */
async function legacy(summary, err) {
  jlog('worker.legacy_mode', { error: err?.message });
  try {
    summary.legacyPulse = await runDailyPulse();
  } catch (e) {
    summary.legacyPulse = { error: e?.message || 'failed' };
  }
  summary.legacy = true;
  return summary;
}

/** Owner/admin view: what Buddy scheduled and did on its own, newest first. */
export async function recentJobs(client, orgId, { limit = 30 } = {}) {
  const { data } = await client.from('buddy_jobs')
    .select('id, kind, status, run_at, attempts, max_attempts, last_error, result, action_ids, source, created_at, finished_at')
    .eq('org_id', orgId).order('created_at', { ascending: false }).limit(Math.min(100, Math.max(1, limit)));
  return data || [];
}

