import { buildAgentContext } from './context.js';
import { runChat, runResume } from './loop.js';
import { confirm, cancel, undo, retry } from './pipeline.js';
import { loadMany, toCard, recentFor } from './actions.js';
import { computeInsights } from './insights.js';

/**
 * Buddy — the one entry point to the AI operating layer.
 *
 * Every surface calls these functions and nothing below them: the web chat
 * and the voice call today (through api/agent.js), and later Telegram, email
 * or any integration. A new channel is an adapter that authenticates its
 * person, opens a session with its `channel` name, and renders the events and
 * cards it gets back in its own way. It never needs its own tools, prompt,
 * approval flow or audit trail:
 *
 *   openSession   who is asking, in which company, with which permissions
 *   chat          one message → events (text, card, plan card, choice,
 *                 question, view, notice) — see loop.js for the event list
 *   resume        a tapped chip back into its tool, no model
 *   confirm       the approval tap: re-checked, executed as the user, logged
 *   cancel / undo / retry / status
 *   insights      "Buddy noticed" — grounded, rationed, no model call
 *   activity      what Buddy proposed and did, with its lifecycle
 *
 * Invariants every channel inherits: the model never writes; every write is a
 * proposal in ai_actions until the person approves it; execution runs through
 * the person's own database token (RLS, the permission matrix, app guards);
 * the audit log attributes it to the action; "done" is said only after the
 * database confirmed it.
 */

export async function openSession({ user, token, orgId, body = {}, channel = null }) {
  const ctx = await buildAgentContext({ user, token, orgId, body: channel ? { ...body, channel } : body });
  return ctx;
}

export const chat = (ctx, turn, emit, opts) => runChat(ctx, turn, emit, opts);
export const resume = (ctx, resumeArgs, emit, ids) => runResume(ctx, resumeArgs, emit, ids);

export { confirm, cancel, undo, retry };

/** The latest state of these cards, limited to this company. */
export async function status(ctx, ids) {
  const rows = await loadMany(ids, ctx.user.id);
  return rows.filter((r) => r.org_id === ctx.orgId).map(toCard);
}

export async function insights(ctx, { limit = 5, skip = [] } = {}) {
  const clean = (Array.isArray(skip) ? skip : []).filter((x) => typeof x === 'string').slice(0, 100).map((x) => x.slice(0, 200));
  return computeInsights(ctx, { limit, skip: clean });
}

export async function activity(ctx, { limit = 20 } = {}) {
  return (await recentFor(ctx, { limit })).map(toCard);
}
