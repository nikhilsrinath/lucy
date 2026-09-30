import { getTool, allowed, deletes } from '../agent/registry.js';
import { propose } from '../agent/pipeline.js';
import * as actionLog from '../agent/actions.js';
import { reviewUrl } from '../telegram/render.js';
import { jlog } from './log.js';

/**
 * Buddy doing one thing on its own, as one ordinary action.
 *
 *   act(ctx, tool, args, { key })
 *     → the same pipeline.propose() every channel uses: resolve → validate →
 *       preview → ai_actions, with the job's autonomy context, so the policy
 *       decides (server-side) whether it runs now through the same confirm()
 *       a tap runs, or waits as an approval request.
 *
 * Idempotent on `key` (ai_actions.idempotency_key, unique per company). A
 * retried job finds what its earlier attempt did before doing anything:
 *
 *   executed                → done, nothing repeated
 *   proposed                → still waiting for approval
 *   confirmed (in flight)   → the earlier attempt died mid-execution; its
 *                             outcome is unknown, so a side effect (a sent
 *                             message) is NEVER repeated — reported instead
 *   failed, transient       → a fresh attempt under key#n
 *   failed, permanent / cancelled / expired / undone → final, not repeated
 *
 * Returns { status, actionId?, card?, reused?, message?, decision? } with
 * status executed | failed | awaiting_approval | unknown | refused |
 * not_actionable | expired | cancelled | undone.
 */

const store = (ctx) => ctx.actionStore || actionLog;

function nextKey(key, priorKey) {
  const m = /#(\d+)$/.exec(priorKey || '');
  return `${key}#${m ? Number(m[1]) + 1 : 1}`;
}

export async function act(ctx, toolName, rawArgs, { key = null, reason = null, workflowId = null, notify = null } = {}) {
  const job = ctx.autonomy?.job || null;
  const tool = getTool(toolName);
  let attemptKey = key;

  if (key) {
    const prior = await store(ctx).latestByKey(ctx.orgId, key);
    if (prior) {
      const st = actionLog.effectiveStatus(prior);
      const base = { reused: true, actionId: prior.id, card: actionLog.toCard(prior) };
      if (st === 'executed') return { status: 'executed', ...base };
      if (st === 'proposed') return { status: 'awaiting_approval', ...base };
      if (st === 'confirmed') return { status: 'unknown', ...base, message: 'An earlier attempt was interrupted while carrying this out; not repeating it.' };
      if (st === 'failed' && !prior.result?.transient) return { status: 'failed', ...base, message: prior.error || 'It failed.', transient: false };
      if (st !== 'failed') return { status: st, ...base };
      attemptKey = nextKey(key, prior.idempotency_key);
    }
  }

  // Refused before anything is proposed — recorded, so the audit shows Buddy
  // tried and was stopped, and why.
  const refusal = !tool ? 'unknown_tool'
    : tool.kind !== 'write' ? 'not_an_action'
      : deletes(tool) ? 'deletion_restricted'
        : !allowed(tool, ctx) ? 'permission' : null;
  if (refusal) {
    const actionId = await recordRefusal(ctx, tool || { name: String(toolName).slice(0, 64), module: null, risk: 'high' }, rawArgs, { decision: 'forbidden', rule: refusal }, attemptKey);
    jlog('action.refused', { job_id: job?.id, org_id: ctx.orgId, tool: toolName, rule: refusal, action_id: actionId });
    return { status: 'refused', actionId, decision: { decision: 'forbidden', rule: refusal } };
  }

  const out = await propose(tool, rawArgs, ctx, {
    chatId: job ? `job:${job.id}` : null,
    messageId: attemptKey,
    reason,
    autonomy: { trigger: 'job', jobId: job?.id || null, workflowId, idempotencyKey: attemptKey, source: job ? `job:${job.kind}` : null },
  });

  if (out.kind === 'none' && out.decision?.decision === 'forbidden') {
    const actionId = await recordRefusal(ctx, tool, rawArgs, out.decision, attemptKey);
    jlog('action.refused', { job_id: job?.id, org_id: ctx.orgId, tool: tool.name, rule: out.decision.rule, action_id: actionId });
    return { status: 'refused', actionId, decision: out.decision };
  }
  if (out.kind !== 'card') {
    return { status: 'not_actionable', message: out.message || out.choice?.question || out.input?.question || 'Nothing to do.' };
  }

  const actionId = out.card.action_id;
  if (out.auto) {
    let status = out.status || out.card.status;
    let transient = false;
    if (status === 'failed') {
      const row = key ? await store(ctx).latestByKey(ctx.orgId, key) : null;
      transient = !!row?.result?.transient;
    }
    if (status === 'repreviewed') {
      // The record moved between proposing and executing: try again later.
      status = 'failed';
      transient = true;
    }
    jlog('action.autonomous', { job_id: job?.id, org_id: ctx.orgId, tool: tool.name, action_id: actionId, status, rule: out.card.policy_rule });
    return { status, actionId, card: out.card, transient, message: out.card.error || null };
  }

  // The policy wants a person: the proposal stays open as an approval
  // request, and whoever can approve it is told where to find it.
  jlog('action.approval_requested', { job_id: job?.id, org_id: ctx.orgId, tool: tool.name, action_id: actionId });
  if (notify) {
    await notify({ actionId, title: out.card.title, key: `${key || actionId}:approval` }).catch((err) => {
      jlog('action.approval_notice_failed', { job_id: job?.id, org_id: ctx.orgId, action_id: actionId, error: err?.message });
    });
  }
  return { status: 'awaiting_approval', actionId, card: out.card };
}

/** The line an approver receives. No details of the change: they are in the app. */
export function approvalNotice() {
  return 'I prepared a change that needs your approval before I do it.';
}

export function approvalLink(actionId) {
  return reviewUrl(actionId);
}

async function recordRefusal(ctx, tool, args, decision, key) {
  try {
    const job = ctx.autonomy?.job || null;
    const row = await store(ctx).insertProposal(ctx, {
      chatId: job ? `job:${job.id}` : null, messageId: key, tool, args: args && typeof args === 'object' ? args : {},
      targets: [], preview: { title: `Refused: ${tool.name}`, refused: decision.rule },
      reason: null, source: job ? `job:${job.kind}` : null,
      autonomy: { autonomous: false, decision, jobId: job?.id || null, idempotencyKey: key },
    });
    await actionLog.patchAction(row.id, {
      status: 'failed', decided_at: new Date().toISOString(), error: `Not allowed on its own (${decision.rule}).`,
      events: actionLog.withEvent(row, 'refused', decision.rule),
    });
    return row.id;
  } catch (err) {
    jlog('action.refusal_log_failed', { org_id: ctx.orgId, tool: tool?.name, error: err?.message });
    return null;
  }
}
