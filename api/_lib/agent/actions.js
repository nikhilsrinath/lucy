import { supabaseAdmin } from '../supabaseAdmin.js';
import { AGENT_PROMPT_VERSION } from './prompt.js';

/**
 * public.ai_actions (0068) — every change EdgeAI proposed, and what became of it.
 *
 * Written only here, with the service role: the table grants the browser
 * SELECT on its own rows and nothing else, because a log of what the AI did
 * that the user can edit is not a log. This is the one place the agent uses
 * the service role for anything but the AI meter; the writes the actions
 * describe go through the user's own token (executor.js).
 *
 * The row id is the idempotency key. Confirming moves proposed → confirmed
 * in a single conditional UPDATE, so a double tap, a retry or two open tabs
 * can confirm it exactly once.
 */

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;
export const UNDO_WINDOW_MS = 10 * 60 * 1000;
export const MAX_PENDING_PER_CHAT = 5;

const db = () => supabaseAdmin();

/*
 * 0069 adds kind, channel, reason, source, approval_required, edits, events
 * and parent_id. On a database without it PostgREST refuses any write naming
 * them, so a write is retried once without them and the rest of the process
 * stops sending them. Nothing is lost that the older schema could hold.
 */
const EXTENDED = ['kind', 'channel', 'reason', 'source', 'approval_required', 'edits', 'events', 'parent_id'];
let extended = true;
const missingColumn = (error) => error && (error.code === 'PGRST204' || error.code === '42703'
  || /column .* does not exist|could not find the .* column/i.test(error.message || ''));
const narrow = (row) => {
  if (extended) return row;
  const out = { ...row };
  for (const k of EXTENDED) delete out[k];
  return out;
};
async function tolerant(write, row) {
  const first = await write(narrow(row));
  if (!first.error || !extended || !missingColumn(first.error)) return first;
  extended = false;
  console.warn('[agent] ai_actions has no 0069 columns; logging without plan/channel/timeline fields.');
  return write(narrow(row));
}

/** One lifecycle event, appended to the row's timeline. */
export const event = (status, note = null) => ({ at: new Date().toISOString(), status, ...(note ? { note: String(note).slice(0, 300) } : {}) });
export const withEvent = (row, status, note = null) => [...(Array.isArray(row?.events) ? row.events : []), event(status, note)].slice(-40);

/** Whether 0068 is missing — the agent then reads but never proposes. */
export const isMissingTable = (error) => error && (error.code === '42P01' || error.code === 'PGRST205'
  || /ai_actions/.test(error.message || '') && /does not exist|schema cache/.test(error.message || ''));

export async function countPending(ctx, chatId) {
  const { count, error } = await db().from('ai_actions').select('id', { count: 'exact', head: true })
    .eq('org_id', ctx.orgId).eq('user_id', ctx.user.id).eq('chat_id', chatId)
    .eq('status', 'proposed').gt('expires_at', new Date().toISOString());
  if (error) return 0;
  return count || 0;
}

export async function insertProposal(ctx, { chatId, messageId, tool, args, targets, preview, kind = 'action', reason = null, source = null, parentId = null }) {
  const now = Date.now();
  const { data, error } = await tolerant((row) => db().from('ai_actions').insert(row).select().single(), {
    org_id: ctx.orgId,
    user_id: ctx.user.id,
    chat_id: String(chatId || '').slice(0, 64) || null,
    message_id: String(messageId || '').slice(0, 64) || null,
    tool: tool.name,
    module: tool.module,
    risk: tool.risk,
    args,
    target_ref: targets?.length ? { items: targets } : null,
    preview,
    status: 'proposed',
    prompt_version: AGENT_PROMPT_VERSION,
    proposed_at: new Date(now).toISOString(),
    expires_at: new Date(now + PROPOSAL_TTL_MS).toISOString(),
    kind,
    channel: ctx.channel || 'chat',
    reason: reason ? String(reason).slice(0, 400) : null,
    source: source ? String(source).slice(0, 200) : null,
    approval_required: true,
    events: [event('proposed', parentId ? 'retry' : null)],
    parent_id: parentId,
  });
  if (error) {
    if (isMissingTable(error)) throw Object.assign(new Error('Your cofounder cannot make changes yet: the ai_actions table (migration 0068) is not on this database.'), { code: 'no_table' });
    throw error;
  }
  return data;
}

export async function loadAction(id, userId) {
  const { data, error } = await db().from('ai_actions').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

/** proposed → confirmed (or any from → to) exactly once. Returns the row, or null if it had moved. */
export async function transition(id, from, patch) {
  const { data, error } = await tolerant((p) => db().from('ai_actions').update(p).eq('id', id).eq('status', from).select().maybeSingle(), patch);
  if (error) throw error;
  return data;
}

export async function patchAction(id, patch) {
  const { data, error } = await tolerant((p) => db().from('ai_actions').update(p).eq('id', id).select().maybeSingle(), patch);
  if (error) throw error;
  return data;
}

/**
 * The caller's recent actions in this organization, newest first — what Buddy
 * did, for the activity view and for "what did you do today?".
 */
export async function recentFor(ctx, { limit = 20, since = null } = {}) {
  let q = db().from('ai_actions').select('*').eq('org_id', ctx.orgId).eq('user_id', ctx.user.id)
    .order('proposed_at', { ascending: false }).limit(Math.min(50, Math.max(1, limit)));
  if (since) q = q.gte('proposed_at', since);
  const { data, error } = await q;
  if (error) return [];
  return data || [];
}

export async function loadMany(ids, userId) {
  const clean = (ids || []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 100);
  if (!clean.length) return [];
  const { data, error } = await db().from('ai_actions').select('*').eq('user_id', userId).in('id', clean);
  if (error) return [];
  return data || [];
}

/** The status as the person should see it: a proposal past its expiry is expired, whatever the row says. */
export function effectiveStatus(row, now = Date.now()) {
  if (row.status === 'proposed' && Date.parse(row.expires_at) < now) return 'expired';
  return row.status;
}

export function undoUntil(row) {
  if (row.status !== 'executed' || !row.result?.undoable || !row.executed_at) return null;
  return new Date(Date.parse(row.executed_at) + UNDO_WINDOW_MS).toISOString();
}

/** A row as the client's ActionCard renders it. */
export function toCard(row) {
  return {
    action_id: row.id,
    tool: row.tool,
    module: row.module,
    risk: row.risk,
    status: effectiveStatus(row),
    expires_at: row.expires_at,
    ...(row.preview || {}),
    summary: row.result?.summary || null,
    followUp: row.result?.followUp || null,
    href: row.result?.href || row.preview?.target?.href || null,
    items_done: row.result?.itemsDone ?? null,
    error: row.error || null,
    undo_until: undoUntil(row),
    undone_at: row.undone_at || null,
    tables: row.result?.tables || [],
    kind: row.kind || (row.tool === 'plan' ? 'plan' : 'action'),
    channel: row.channel || null,
    reason: row.reason || row.preview?.reason || null,
    partial: !!row.result?.partial,
    step_results: row.result?.steps || null,
    retry_of: row.parent_id || null,
    events: Array.isArray(row.events) ? row.events : [],
  };
}
