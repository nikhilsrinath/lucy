/**
 * EdgeAI agent — POST /api/agent { mode, org_id, ... }
 *
 *   chat     { message, history, chat_id, message_id, context, resume?, pending? }
 *            → text/event-stream of agent events (see api/_lib/agent/loop.js)
 *   confirm  { action_id, selected?, edits? }  → execute a proposed change
 *   cancel   { action_id }
 *   undo     { action_id }                     → within 10 minutes
 *   status   { ids }                           → the latest state of these cards
 *   retry    { action_id }                     → a failed action proposed afresh (a new card)
 *   insights { skip?, limit? }                 → "Buddy noticed" cards (no model, not metered)
 *   activity { limit? }                        → what Buddy proposed and did, newest first
 *   autonomy                                   → the company's autonomy policy + catalogue
 *   autonomy_update { enabled?, rules?, settings? }  owner/admin only
 *   autonomy_activity { limit? }               → owner/admin: Buddy's own jobs and actions
 *
 * GET (a scheduler, CRON_SECRET) runs the Buddy worker: the durable job queue
 * of the Autonomous Buddy Engine (api/_lib/autonomy/worker.js).
 *
 * Everything goes through api/_lib/agent/buddy.js, the channel-neutral entry
 * point the Telegram adapter (api/telegram.js) calls the same way.
 *
 * One function with modes rather than one per verb: the Vercel function count
 * is finite and every mode shares the same authentication and context.
 *
 * The agent acts as the signed-in user. Every read and every write it makes
 * goes through a Supabase client carrying the caller's own access token, so
 * RLS, the permission matrix and every app.* guard apply exactly as they do
 * in the UI. The service role is used only for ai_actions and the AI meter.
 */
import { requireUser, requireOrgRole, HttpError, sendError, methodIs, readJsonBody } from './_lib/auth.js';
import { logAiUsage, bumpAiUsage } from './_lib/aiUsage.js';
import { bearerToken } from './_lib/agent/db.js';
import * as buddy from './_lib/agent/buddy.js';
import { toCard } from './_lib/agent/actions.js';
import { AGENT_MODEL, newUsage, describeUsage } from './_lib/agent/model.js';
import { cronAuthorized } from './_lib/cron.js';
import { runWorker, recentJobs } from './_lib/autonomy/worker.js';
import { loadPolicy, savePolicy, catalogue } from './_lib/autonomy/policy.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // The worker. Only a scheduler holding CRON_SECRET may wake it; it takes
    // no input — what to do comes from the database, not the request.
    if (!cronAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    try {
      const out = await runWorker({ budgetMs: 45_000 });
      return res.status(200).json({ success: true, worker: { claimed: out.claimed, processed: out.processed, byStatus: out.byStatus, legacy: !!out.legacy } });
    } catch (err) {
      console.error('[agent] worker', err?.message || err);
      return res.status(500).json({ success: false, error: 'Worker run failed' });
    }
  }
  if (!methodIs(req, res, 'POST')) return undefined;
  let streaming = false;
  const t0 = Date.now();
  const mark = {};
  try {
    const body = await readJsonBody(req);
    const user = await requireUser(req);
    mark.auth = Date.now() - t0;

    // A chat turn starts streaming as soon as the caller is authenticated, so
    // the app shows "Thinking…" while the session, usage and company context
    // are prepared, instead of a blank wait. Anything that goes wrong after
    // this point reaches the client as an `error` event (it already handles
    // them); a missing message is still refused up front.
    const chatTurn = body.mode === 'chat';
    if (chatTurn && !String(body.message || '').trim() && !body.resume) throw new HttpError(400, 'Missing message');
    if (chatTurn) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.status(200);
      streaming = true;
      res.write(`event: status\ndata: ${JSON.stringify({ text: 'Thinking…' })}\n\n`);
    }
    const ctx = await buddy.openSession({ user, token: bearerToken(req), orgId: body.org_id, body });
    mark.session = Date.now() - t0;

    switch (body.mode) {
      case 'confirm': {
        if (!body.action_id) throw new HttpError(400, 'Missing action_id');
        return res.status(200).json({ success: true, ...(await buddy.confirm(ctx, body.action_id, { selected: body.selected, edits: body.edits })) });
      }
      case 'cancel':
        return res.status(200).json({ success: true, ...(await buddy.cancel(ctx, body.action_id)) });
      case 'undo':
        return res.status(200).json({ success: true, ...(await buddy.undo(ctx, body.action_id)) });
      case 'retry':
        if (!body.action_id) throw new HttpError(400, 'Missing action_id');
        return res.status(200).json({ success: true, ...(await buddy.retry(ctx, body.action_id)) });
      case 'status':
        return res.status(200).json({ success: true, cards: await buddy.status(ctx, body.ids) });
      case 'insights':
        return res.status(200).json({ success: true, insights: await buddy.insights(ctx, { limit: Number(body.limit) || 5, skip: body.skip }) });
      case 'activity':
        return res.status(200).json({ success: true, actions: await buddy.activity(ctx, { limit: Number(body.limit) || 20 }) });
      case 'autonomy': {
        const policy = await loadPolicy(ctx.orgId);
        return res.status(200).json({ success: true, policy: publicPolicy(policy), tools: catalogue(policy) });
      }
      case 'autonomy_update': {
        // Governance: owners and admins only, checked here; the row is
        // written with the service role (no client may write it).
        await requireOrgRole(user.id, ctx.orgId, 'admin');
        const policy = await savePolicy(ctx.orgId, { enabled: body.enabled, rules: body.rules, settings: body.settings }, user.id);
        return res.status(200).json({ success: true, policy: publicPolicy(policy), tools: catalogue(policy) });
      }
      case 'autonomy_activity': {
        await requireOrgRole(user.id, ctx.orgId, 'admin');
        const limit = Number(body.limit) || 30;
        // Read with the admin's own token: RLS lets owners/admins see their company's.
        const [jobsList, actionsRes] = await Promise.all([
          recentJobs(ctx.db, ctx.orgId, { limit }),
          ctx.db.from('ai_actions').select('*').eq('org_id', ctx.orgId).or('autonomous.eq.true,actor_kind.eq.buddy')
            .order('proposed_at', { ascending: false }).limit(Math.min(100, limit)),
        ]);
        return res.status(200).json({ success: true, jobs: jobsList, actions: (actionsRes.data || []).map(toCard) });
      }
      case 'chat':
        break;
      default:
        throw new HttpError(400, `Unknown mode: ${body.mode}`);
    }

    const message = String(body.message || '').trim();
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const ids = { chatId: body.chat_id, messageId: body.message_id };

    // A tapped chip goes straight back into its tool: no model, no quota.
    if (body.resume) {
      await buddy.resume(ctx, body.resume, emit, ids);
      emit('done', {});
      return res.end();
    }

    // Metered per message, before the model is called — see api/nvidia.js.
    const used = await bumpAiUsage(ctx.orgId);
    mark.usage = Date.now() - t0;
    console.info(`[agent] setup ${JSON.stringify({ org: ctx.orgId, auth_ms: mark.auth, session_ms: mark.session, usage_ms: mark.usage })}`);
    if (used > ctx.aiLimit) {
      await logAiUsage({ orgId: ctx.orgId, user, surface: 'copilot', outcome: 'blocked' });
      emit('notice', { text: `Your plan's AI message limit (${ctx.aiLimit}) has been reached.` });
      emit('done', {});
      return res.end();
    }

    // Tokens across every model call of this message, logged even when it
    // fails part-way (the calls before the failure were still billed).
    const usage = newUsage();
    const tokens = () => (usage.calls ? { promptTokens: usage.prompt, completionTokens: usage.output } : {});
    try {
      await buddy.chat(ctx, { message, history: body.history, chatId: body.chat_id, messageId: body.message_id }, emit, { usage });
      console.info(`[agent] tokens: ${describeUsage(usage)}`);
      await logAiUsage({ orgId: ctx.orgId, user, surface: 'copilot', model: AGENT_MODEL, ...tokens() });
    } catch (err) {
      console.error('[agent] chat', err?.message || err, err?.detail || '');
      if (usage.calls) console.info(`[agent] tokens (failed): ${describeUsage(usage)}`);
      await logAiUsage({ orgId: ctx.orgId, user, surface: 'copilot', outcome: 'failed', model: AGENT_MODEL, ...tokens() });
      emit('error', { message: err?.status ? 'The AI service is unavailable right now. Try again in a moment.' : 'Something went wrong on my side.' });
    }
    emit('done', {});
    return res.end();
  } catch (err) {
    if (streaming) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: err instanceof HttpError ? err.message : 'Something went wrong on my side.' })}\n\n`);
      return res.end();
    }
    return sendError(res, err, 'agent');
  }
}

/** The policy as the app sees it (no internals). */
function publicPolicy(p) {
  return { enabled: p.enabled, rules: p.rules, settings: p.settings, version: p.version, source: p.source, ready: p.ready };
}
