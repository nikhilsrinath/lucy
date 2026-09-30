import { getTool, allowed, undoableFor } from './registry.js';
import { onlyKnown } from './helpers.js';
import { applyPlan, undoPlan, sameInstant } from './executor.js';
import { forget, KINDS } from './resolvers.js';
import * as actionLog from './actions.js';
import {
  loadAction, transition, patchAction, toCard, effectiveStatus, withEvent,
  MAX_PENDING_PER_CHAT, UNDO_WINDOW_MS,
} from './actions.js';
import { confirmPlan, undoPlanAction, proposePlan, failedSteps } from './plans.js';

/**
 * The write path, from a tool call to a row on screen.
 *
 *   propose()  model args → resolve → validate → preview → ai_actions (proposed)
 *   confirm()  the user's tap → re-check everything → execute as the user
 *   undo()     within 10 minutes, restore what the action changed
 *   retry()    a failed action (or a plan's failed steps) proposed afresh
 *
 * A plan (plans.js) is one action with several steps; confirm, undo and
 * retry route it there, so every surface calls the same four functions.
 *
 * Lifecycle, as recorded on the row's timeline (actions.events):
 *   proposed → [edited] → approved → executing → completed | partial | failed
 *   proposed → cancelled | expired          executed → undone
 * (status column: proposed · confirmed = approved/executing · executed ·
 * failed · cancelled · expired · undone — unchanged since 0068.)
 *
 * Nothing in here writes to a business table except confirm() and undo(),
 * and both only after loading an ai_actions row that belongs to the caller.
 */

const TABLE_KIND = Object.fromEntries(Object.entries(KINDS).map(([k, d]) => [d.table, k]));

/* ── propose ──────────────────────────────────────────────────────────────── */

/**
 * Returns one of
 *   { kind: 'card',   card }                         — proposed, awaiting a tap
 *   { kind: 'choice', choice }                       — several records matched
 *   { kind: 'input',  input }                        — one required field missing
 *   { kind: 'none',   message, offer }               — nothing matched
 *   { kind: 'error',  message }                      — the model should rethink
 * `stops` says whether the turn ends here (everything but 'error').
 */
export async function propose(tool, rawArgs, ctx, { chatId, messageId, reason = null, parentId = null } = {}) {
  if (!tool || tool.kind !== 'write') return { kind: 'error', message: 'Not a write tool.' };
  if (!allowed(tool, ctx)) {
    return { kind: 'none', stops: true, message: `Your role can't ${verbOf(tool)} from here, so I can't do that for you.` };
  }
  const args = onlyKnown(rawArgs, tool.params);

  let r;
  try {
    r = await tool.resolve(args, ctx);
  } catch (err) {
    console.error(`[agent] ${tool.name}.resolve`, err);
    return { kind: 'error', message: 'Could not look that up.' };
  }
  const resume = { tool: tool.name, args };
  if (r.needs?.kind === 'choice') return { kind: 'choice', stops: true, choice: { ...r.needs, resume } };
  if (r.needs?.kind === 'input') return { kind: 'input', stops: true, input: { ...r.needs, resume } };
  if (r.needs?.kind === 'none') return { kind: 'none', stops: true, message: r.needs.message, offer: r.needs.offer || null };
  if (r.error) return { kind: r.fatal ? 'none' : 'error', stops: !!r.fatal, message: r.error };

  const problems = await tool.validate(r.args, ctx);
  if (problems.length) return { kind: 'none', stops: true, message: problems[0], problems };

  // ctx.actionStore lets the eval harness capture proposals without a database.
  const store = ctx.actionStore || actionLog;
  if (chatId && await store.countPending(ctx, chatId) >= MAX_PENDING_PER_CHAT) {
    return { kind: 'none', stops: true, message: `There are already ${MAX_PENDING_PER_CHAT} changes waiting for your confirmation in this chat — confirm or cancel those first.` };
  }

  const preview = await tool.preview(r.args, ctx);
  if (r.notes?.length) preview.notes = [...(preview.notes || []), ...r.notes];
  preview.undoable = undoableFor(tool, r.args, ctx);
  preview.entities = r.entities || [];
  const why = reason ? String(reason).trim().slice(0, 240) : '';
  if (why) preview.reason = why;

  try {
    const row = await store.insertProposal(ctx, {
      chatId, messageId, tool, args: r.args, targets: r.targets, preview,
      reason: why || null, source: ctx.source || null, parentId,
    });
    return { kind: 'card', stops: true, card: toCard(row), entities: r.entities || [] };
  } catch (err) {
    if (err.code === 'no_table') return { kind: 'none', stops: true, message: err.message };
    console.error('[agent] insertProposal', err);
    return { kind: 'none', stops: true, message: 'I could not prepare that change just now. Try again in a moment.' };
  }
}

function verbOf(tool) {
  const a = tool.permission?.action;
  return a === 'create' ? `create ${tool.module} records` : a === 'delete' ? `delete ${tool.module} records` : `change ${tool.module} records`;
}

/** What the model is told about a proposal. It must not claim the change is done. */
export function modelView(out) {
  switch (out.kind) {
    case 'card': return out.card.kind === 'plan'
      ? { status: 'proposed', plan: out.card.title, steps: (out.card.steps || []).length, note: 'Shown to the user as a plan card to review, edit and approve. NOTHING is done yet — do not say it is done. At most one short line.' }
      : { status: 'proposed', card: out.card.title, note: 'Shown to the user as a confirmation card. NOT done yet — do not say it is done.' };
    case 'choice': return { status: 'needs_choice', note: 'The user is being shown the matching records to pick from. Stop here.' };
    case 'input': return { status: 'needs_input', question: out.input.question, note: 'The user is being asked this. Stop here.' };
    case 'none': return { status: 'stopped', message: out.message, note: 'This was said to the user. Stop here.' };
    default: return { status: 'error', message: out.message };
  }
}

/* ── confirm ──────────────────────────────────────────────────────────────── */

function arrayTargetKey(args) {
  for (const k of ['tasks', 'clients']) if (Array.isArray(args[k])) return k;
  return null;
}

function applyChoices(row, { selected, edits }) {
  let args = { ...row.args };
  const key = arrayTargetKey(args);
  if (key && Array.isArray(selected)) {
    const keep = new Set(selected);
    args[key] = args[key].filter((id) => keep.has(id));
  }
  if (edits && typeof edits === 'object') {
    const editable = new Set((row.preview?.fields || []).map((f) => f.key));
    for (const [k, v] of Object.entries(edits)) if (editable.has(k)) args[k] = v;
  }
  return args;
}

function stale(targetRef, freshTargets) {
  const before = new Map((targetRef?.items || []).map((t) => [t.id, t.version]));
  for (const t of freshTargets || []) {
    const was = before.get(t.id);
    if (was && t.version && was !== t.version && !sameInstant(was, t.version)) return true;
  }
  return false;
}

/**
 * The user's tap. Idempotent on the action id: whatever state the action is
 * already past, that state is returned rather than acted on again.
 */
export async function confirm(ctx, id, { selected = null, edits = null } = {}) {
  const row = await loadAction(id, ctx.user.id);
  if (!row || row.org_id !== ctx.orgId) return { status: 'not_found', message: 'That change is no longer available.' };

  const status = effectiveStatus(row);
  if (status === 'expired' && row.status === 'proposed') {
    await transition(id, 'proposed', { status: 'expired', decided_at: new Date().toISOString() });
    return { status: 'expired', card: toCard({ ...row, status: 'expired' }), message: 'This proposal expired. Ask again and I will prepare it fresh.' };
  }
  if (status !== 'proposed') return { status, card: toCard(row) };
  if (row.kind === 'plan' || row.tool === 'plan') return confirmPlan(ctx, row, { selected, edits });

  const tool = getTool(row.tool);
  if (!allowed(tool, ctx)) {
    const done = await transition(id, 'proposed', { status: 'failed', decided_at: new Date().toISOString(), error: 'Your permissions changed; this is no longer allowed.', events: withEvent(row, 'failed', 'permission') });
    return { status: 'failed', card: toCard(done || row) };
  }

  // Everything re-checked against the database as it is now.
  const args = applyChoices(row, { selected, edits });
  const key = arrayTargetKey(args);
  if (key && !args[key].length) return { status: 'invalid', message: 'Nothing is selected.' };
  const r = await tool.resolve(args, ctx);
  if (r.needs || r.error) {
    return { status: 'invalid', message: r.needs?.message || r.needs?.question || r.error || 'That no longer matches anything.' };
  }
  const problems = await tool.validate(r.args, ctx);
  if (problems.length) return { status: 'invalid', message: problems[0] };

  if (stale(row.target_ref, r.targets)) {
    // Someone changed the record after the card was drawn. Draw it again
    // from the current row rather than overwrite their change.
    const preview = await tool.preview(r.args, ctx);
    preview.undoable = undoableFor(tool, r.args, ctx);
    preview.entities = r.entities || [];
    preview.notes = ['This changed since I first proposed it — here it is again with the current values.'];
    if (row.reason) preview.reason = row.reason;
    const fresh = await actionLog.insertProposal(ctx, { chatId: row.chat_id, messageId: row.message_id, tool, args: r.args, targets: r.targets, preview, reason: row.reason, source: row.source });
    await transition(id, 'proposed', { status: 'expired', decided_at: new Date().toISOString(), error: 'Changed since proposed; re-previewed.', events: withEvent(row, 'expired', 'changed since proposed') });
    return { status: 'repreviewed', card: toCard(fresh), replaces: id };
  }

  const edited = !!(edits && Object.keys(edits).length) || (Array.isArray(selected) && key && selected.length !== (row.args[key] || []).length);
  const claimed = await transition(id, 'proposed', {
    status: 'confirmed', decided_at: new Date().toISOString(), args: r.args,
    edits: edited ? { fields: edits || null, selected: selected || null } : null,
    events: withEvent({ events: withEvent({ events: edited ? withEvent(row, 'edited') : row.events }, 'approved') }, 'executing'),
  });
  if (!claimed) {
    const now = await loadAction(id, ctx.user.id);
    return { status: effectiveStatus(now), card: toCard(now) };
  }

  let outcome;
  try {
    const plan = await tool.plan(r.args, ctx);
    outcome = await applyPlan(ctx.dbFor(id), plan, { stopOnError: tool.stopOnError ?? plan.length <= 1 });
  } catch (err) {
    console.error(`[agent] execute ${tool.name}`, err);
    outcome = { results: [{ ok: false, error: 'The change could not be saved.' }], warnings: [], ok: false };
  }

  const anyDone = outcome.results.some((x) => x.ok !== false);
  for (const res of outcome.results) if (TABLE_KIND[res.table]) forget(ctx, TABLE_KIND[res.table]);
  const summary = tool.summary(outcome, r.args, ctx);
  const followUp = anyDone && tool.after ? await tool.after(outcome, ctx).catch(() => null) : null;
  const undoable = anyDone && undoableFor(tool, r.args, ctx)
    && !!(tool.undoPlan ? tool.undoPlan(outcome.results, r.args) : undoPlan(outcome.results));
  const firstError = outcome.results.find((x) => x.ok === false);
  const entities = anyDone && tool.entitiesOf ? tool.entitiesOf(outcome) : row.preview?.entities || [];

  const saved = await patchAction(id, {
    status: anyDone ? 'executed' : 'failed',
    executed_at: anyDone ? new Date().toISOString() : null,
    before_state: outcome.results.map((x) => x.before ?? null),
    after_state: outcome.results.map((x) => x.after ?? null),
    result: {
      summary, followUp, undoable, warnings: outcome.warnings,
      itemsDone: outcome.results.filter((x) => x.ok !== false && !x.followUp).length,
      href: entities[0]?.href || tool.href?.(r.args) || null,
      // Which tables moved, so the confirming tab refreshes exactly those.
      tables: [...new Set(outcome.results.filter((x) => x.ok !== false && x.table).map((x) => x.table))],
      results: outcome.results,
    },
    error: anyDone ? null : firstError?.error || 'The change could not be saved.',
    events: withEvent(claimed, anyDone ? (firstError ? 'partial' : 'completed') : 'failed', firstError?.error || null),
  });
  return { status: saved.status, card: toCard(saved), entities };
}

export async function cancel(ctx, id) {
  const row = await loadAction(id, ctx.user.id);
  if (!row || row.org_id !== ctx.orgId) return { status: 'not_found' };
  const done = await transition(id, 'proposed', { status: 'cancelled', decided_at: new Date().toISOString(), events: withEvent(row, 'cancelled') });
  const now = done || await loadAction(id, ctx.user.id);
  return { status: effectiveStatus(now), card: toCard(now) };
}

/**
 * Undo an executed action, if the window is open and nothing has touched the
 * rows since. Runs as the user, attributed to the same action.
 */
export async function undo(ctx, id) {
  const row = await loadAction(id, ctx.user.id);
  if (!row || row.org_id !== ctx.orgId) return { status: 'not_found', message: 'That change is no longer available.' };
  if (row.status === 'undone') return { status: 'undone', card: toCard(row) };
  if (row.status !== 'executed' || !row.result?.undoable) return { status: 'invalid', message: 'This change cannot be undone.' };
  if (row.kind === 'plan' || row.tool === 'plan') return undoPlanAction(ctx, row);
  if (Date.now() - Date.parse(row.executed_at) > UNDO_WINDOW_MS) {
    return { status: 'invalid', message: 'The 10-minute undo window has closed. Change it back from its page, or ask me to.' };
  }
  // A tool may undo differently from the generic reversal — an invoice draft
  // is cancelled rather than deleted, so its number stays in the GST series.
  const tool = getTool(row.tool);
  const plan = tool?.undoPlan ? tool.undoPlan(row.result.results, row.args) : undoPlan(row.result.results);
  if (!plan) return { status: 'invalid', message: 'This change cannot be undone.' };
  const outcome = await applyPlan(ctx.dbFor(id), plan, { stopOnError: false });
  for (const res of outcome.results) if (TABLE_KIND[res.table]) forget(ctx, TABLE_KIND[res.table]);
  if (!outcome.results.some((x) => x.ok !== false)) {
    const first = outcome.results.find((x) => x.ok === false);
    return {
      status: 'invalid',
      message: first?.code === 'stale' ? 'It has been changed since, so I left it alone rather than overwrite that.' : first?.error || 'Could not undo it.',
    };
  }
  const saved = await patchAction(id, {
    status: 'undone', undone_at: new Date().toISOString(),
    result: { ...row.result, undoResults: outcome.results },
    events: withEvent(row, 'undone'),
  });
  return { status: 'undone', card: toCard(saved) };
}

/* ── retry ────────────────────────────────────────────────────────────────── */

/**
 * A failed action, proposed again from what it was asked to do — re-resolved
 * and re-validated against the data as it is now, as a new card the person
 * confirms. For a plan, only the steps that did not go through. Never
 * executes anything by itself.
 */
export async function retry(ctx, id) {
  const row = await loadAction(id, ctx.user.id);
  if (!row || row.org_id !== ctx.orgId) return { status: 'not_found', message: 'That change is no longer available.' };
  const isPlan = row.kind === 'plan' || row.tool === 'plan';
  const retriable = row.status === 'failed' || (isPlan && row.status === 'executed' && row.result?.partial);
  if (!retriable) return { status: 'invalid', message: 'Only a change that failed can be retried.' };

  const ids = { chatId: row.chat_id, messageId: row.message_id };
  let out;
  if (isPlan) {
    const steps = row.status === 'failed' ? (row.args?.steps || []).map((s) => ({ tool: s.tool, why: s.why, args: s.raw })) : failedSteps(row);
    if (!steps.length) return { status: 'invalid', message: 'There is nothing left to retry.' };
    if (steps.length === 1) {
      out = await propose(getTool(steps[0].tool), steps[0].args, ctx, { ...ids, reason: steps[0].why, parentId: id });
    } else {
      out = await proposePlan({ goal: row.args?.goal || row.preview?.goal || 'Retry', summary: `Retrying ${steps.length} steps that did not go through.`, steps }, ctx, ids);
    }
  } else {
    out = await propose(getTool(row.tool), row.args, ctx, { ...ids, reason: row.reason, parentId: id });
  }
  if (out.kind === 'card') {
    await patchAction(id, { events: withEvent(row, 'retried', out.card.action_id) }).catch(() => null);
    return { status: 'proposed', card: out.card, entities: out.entities || [] };
  }
  if (out.kind === 'choice' || out.kind === 'input') {
    return { status: 'invalid', message: out.choice?.question || out.input?.question || 'I need a detail first — ask me again in the chat.' };
  }
  return { status: 'invalid', message: out.message || 'That cannot be prepared again right now.' };
}
