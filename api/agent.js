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
import { requireUser, HttpError, sendError, methodIs, readJsonBody } from './_lib/auth.js';
import { logAiUsage, bumpAiUsage } from './_lib/aiUsage.js';
import { bearerToken } from './_lib/agent/db.js';
import * as buddy from './_lib/agent/buddy.js';
import { AGENT_MODEL, newUsage, describeUsage } from './_lib/agent/model.js';

export default async function handler(req, res) {
  if (!methodIs(req, res, 'POST')) return undefined;
  let streaming = false;
  try {
    const body = await readJsonBody(req);
    const user = await requireUser(req);
    const ctx = await buddy.openSession({ user, token: bearerToken(req), orgId: body.org_id, body });

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
      case 'chat':
        break;
      default:
        throw new HttpError(400, `Unknown mode: ${body.mode}`);
    }

    const message = String(body.message || '').trim();
    if (!message && !body.resume) throw new HttpError(400, 'Missing message');

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.status(200);
    streaming = true;
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

