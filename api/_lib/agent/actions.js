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

export async function insertProposal(ctx, { chatId, messageId, tool, args, targets, preview }) {
  const now = Date.now();
  const { data, error } = await db().from('ai_actions').insert({
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
  }).select().single();
  if (error) {
    if (isMissingTable(error)) throw Object.assign(new Error('EdgeAI cannot make changes yet: the ai_actions table (migration 0068) is not on this database.'), { code: 'no_table' });
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
  const { data, error } = await db().from('ai_actions').update(patch).eq('id', id).eq('status', from).select().maybeSingle();
  if (error) throw error;
  return data;
}

export async function patchAction(id, patch) {
  const { data, error } = await db().from('ai_actions').update(patch).eq('id', id).select().maybeSingle();
  if (error) throw error;
  return data;
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
  };
}
