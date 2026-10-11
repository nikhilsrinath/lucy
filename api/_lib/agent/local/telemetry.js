import { supabaseAdmin } from '../../supabaseAdmin.js';

/**
 * What the router decided, for learning from real use — without keeping what
 * people said.
 *
 * One line per message goes to the platform log, and one row to
 * buddy_route_events (0074) when the table exists. Neither holds message
 * text, names, amounts or arguments. What is kept:
 *
 *   intent, route (local | clarify | llm | shadow), confidence, whether a
 *   question was asked, whether the model was used, latency, whether it
 *   worked, an error category, and a SIGNATURE — the concepts the message
 *   was read as and how many words were left unexplained
 *   ("INVOICE+UNPAID|r1"). A signature that keeps reaching the model, or
 *   keeps being corrected, is a phrasing the lexicon is missing; it is found
 *   without anybody's sentence being stored.
 *
 * `corrected_to` records the intent a person chose when asked "did you
 * mean…?" — the only ground truth there is. Nothing is learned automatically:
 * the lexicon and the eval set are changed by people, from these counts.
 *
 * Best effort by design: a failure here never fails the turn it describes.
 * Retention is the database's (0074 keeps 90 days).
 */

let tableMissing = false;

export const ERROR_KINDS = ['tool_failed', 'permission', 'not_found', 'model_failed', 'model_timeout', 'render_failed', 'other'];

export function routeEvent(ctx, e) {
  return {
    org_id: ctx.orgId,
    user_id: ctx.actor?.kind === 'user' ? ctx.user?.id || null : null,
    channel: ctx.channel || 'chat',
    intent: String(e.intent || 'OPEN_ENDED').slice(0, 64),
    route: e.route,
    reason_code: e.reasonCode ? String(e.reasonCode).slice(0, 40) : null,
    confidence: Number.isFinite(e.confidence) ? Math.round(e.confidence * 100) / 100 : null,
    clarified: !!e.clarified,
    llm_used: !!e.llmUsed,
    latency_ms: Math.max(0, Math.round(e.latencyMs || 0)),
    ok: e.ok !== false,
    error_kind: ERROR_KINDS.includes(e.errorKind) ? e.errorKind : e.errorKind ? 'other' : null,
    signature: e.signature ? String(e.signature).slice(0, 200) : null,
    corrected_to: e.correctedTo ? String(e.correctedTo).slice(0, 64) : null,
    tokens: Number.isFinite(e.tokens) ? Math.round(e.tokens) : null,
  };
}

/** Logs one routing outcome. Never throws; never awaited by the reply. */
export function logRoute(ctx, e) {
  let row;
  try {
    row = routeEvent(ctx, e);
    console.info(`[router] ${JSON.stringify({ ...row, user_id: undefined })}`);
  } catch { return; }
  if (tableMissing || ctx.routeLog === false || process.env.BUDDY_ROUTER_LOG === 'off') return;
  if (typeof ctx.routeLog === 'function') { try { ctx.routeLog(row); } catch { /* a test hook */ } return; }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  Promise.resolve()
    .then(() => supabaseAdmin().from('buddy_route_events').insert(row))
    .then(({ error }) => {
      if (!error) return;
      // A database without 0074: stop trying for the life of this instance.
      if (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|not find the table/i.test(error.message || '')) tableMissing = true;
      else console.warn('[router] event not logged:', error.message);
    })
    .catch((err) => console.warn('[router] event not logged:', err?.message || err));
}
