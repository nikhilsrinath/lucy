import { createHash, randomBytes } from 'node:crypto';
import { supabaseAdmin } from '../supabaseAdmin.js';

/**
 * The Telegram adapter's own tables (0070), service role only — every one of
 * them has RLS on and no client policy. None of this is business data: it is
 * who is linked to whom, which group belongs to which company, which updates
 * were already handled, and each chat's short-term context.
 *
 * Link and group tokens are 24 random bytes, shown once as base64url and kept
 * only as their SHA-256; consuming one is a single conditional UPDATE, so a
 * token works exactly once even if two people race to use it.
 */

const db = () => supabaseAdmin();
const nowIso = () => new Date().toISOString();

export const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;
export const INVITE_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
export const GROUP_TOKEN_TTL_MS = 30 * 60 * 1000;

export const isMissingTable = (error) => error && (error.code === '42P01' || error.code === 'PGRST205'
  || /does not exist|schema cache/i.test(error.message || ''));

function must({ data, error }) {
  if (error) throw error;
  return data;
}

/* ── updates: idempotency and inbound rate ────────────────────────────────── */

/** True if this update_id is new (and now claimed); false if it was seen before. */
export async function claimUpdate(updateId, { telegramUserId = null, chatId = null, kind = null } = {}) {
  const { error } = await db().from('telegram_updates').insert({
    update_id: updateId, telegram_user_id: telegramUserId, chat_id: chatId, kind,
  });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw error;
}

export async function finishUpdate(updateId, status, error = null) {
  await db().from('telegram_updates')
    .update({ status, error: error ? String(error).slice(0, 500) : null, finished_at: nowIso() })
    .eq('update_id', updateId);
}

export async function recentUpdateCount(telegramUserId, windowMs) {
  const { count } = await db().from('telegram_updates').select('update_id', { count: 'exact', head: true })
    .eq('telegram_user_id', telegramUserId).gt('received_at', new Date(Date.now() - windowMs).toISOString());
  return count || 0;
}

/* ── company settings ─────────────────────────────────────────────────────── */

const DEFAULT_SETTINGS = { enabled: false, pulse_enabled: false, pulse_hour: 18 };

export async function orgSettings(orgId) {
  const { data, error } = await db().from('org_telegram').select('*').eq('org_id', orgId).maybeSingle();
  if (error) throw error;
  return { ...DEFAULT_SETTINGS, ...(data || {}), org_id: orgId };
}

export async function saveOrgSettings(orgId, patch, userId) {
  const row = { org_id: orgId, updated_by: userId };
  for (const k of ['enabled', 'pulse_enabled']) if (typeof patch[k] === 'boolean') row[k] = patch[k];
  if (Number.isInteger(patch.pulse_hour) && patch.pulse_hour >= 0 && patch.pulse_hour <= 23) row.pulse_hour = patch.pulse_hour;
  return must(await db().from('org_telegram').upsert(row, { onConflict: 'org_id' }).select().single());
}

export async function orgsWithPulse() {
  return must(await db().from('org_telegram').select('org_id, pulse_hour').eq('enabled', true).eq('pulse_enabled', true)) || [];
}

export async function orgBasics(orgId) {
  const { data } = await db().from('organizations').select('*').eq('id', orgId).maybeSingle();
  return { name: data?.company_name || data?.name || 'your company', tz: data?.timezone || data?.time_zone || null };
}

/* ── links ────────────────────────────────────────────────────────────────── */

export async function linksForTelegram(telegramUserId) {
  return must(await db().from('telegram_links').select('*')
    .eq('telegram_user_id', telegramUserId).is('revoked_at', null).order('last_seen_at', { ascending: false, nullsFirst: false })) || [];
}

export async function linkFor(telegramUserId, orgId) {
  return must(await db().from('telegram_links').select('*')
    .eq('telegram_user_id', telegramUserId).eq('org_id', orgId).is('revoked_at', null).maybeSingle());
}

export async function linksForOrg(orgId) {
  return must(await db().from('telegram_links').select('*').eq('org_id', orgId).is('revoked_at', null)) || [];
}

/**
 * Links this Telegram account to this person in this company. Any earlier
 * live link for either side in the company is revoked first, so the unique
 * indexes hold and a re-link replaces rather than duplicates.
 */
export async function createLink({ orgId, userId, from, dmChatId, via, invitedBy = null }) {
  const at = nowIso();
  await db().from('telegram_links').update({ revoked_at: at, revoked_reason: 'relinked' })
    .eq('org_id', orgId).is('revoked_at', null).or(`user_id.eq.${userId},telegram_user_id.eq.${from.id}`);
  return must(await db().from('telegram_links').insert({
    org_id: orgId,
    user_id: userId,
    telegram_user_id: from.id,
    telegram_username: from.username || null,
    telegram_name: [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 120) || null,
    dm_chat_id: dmChatId,
    linked_via: via,
    invited_by: invitedBy,
    last_seen_at: at,
  }).select().single());
}

export async function revokeLink(id, reason) {
  await db().from('telegram_links').update({ revoked_at: nowIso(), revoked_reason: String(reason).slice(0, 60) })
    .eq('id', id).is('revoked_at', null);
}

export async function touchLink(link, { from = null, dmChatId = null } = {}) {
  const patch = { last_seen_at: nowIso() };
  if (dmChatId) patch.dm_chat_id = dmChatId;
  if (from?.username !== undefined && from.username !== link.telegram_username) patch.telegram_username = from.username || null;
  await db().from('telegram_links').update(patch).eq('id', link.id);
}

export async function setPulseOptOut(linkId, optOut) {
  await db().from('telegram_links').update({ pulse_opt_out: !!optOut }).eq('id', linkId);
}

/* ── groups ───────────────────────────────────────────────────────────────── */

export async function chatFor(chatId) {
  return must(await db().from('telegram_chats').select('*').eq('chat_id', chatId).is('disconnected_at', null).maybeSingle());
}

export async function chatsForOrg(orgId) {
  return must(await db().from('telegram_chats').select('*').eq('org_id', orgId).is('disconnected_at', null)
    .order('connected_at', { ascending: false })) || [];
}

export async function connectChat({ orgId, chat, userId }) {
  return must(await db().from('telegram_chats').insert({
    org_id: orgId, chat_id: chat.id, chat_type: chat.type, title: (chat.title || '').slice(0, 200) || null, connected_by: userId,
  }).select().single());
}

export async function disconnectChat({ chatId = null, id = null, orgId = null }) {
  let q = db().from('telegram_chats').update({ disconnected_at: nowIso() }).is('disconnected_at', null);
  if (id) q = q.eq('id', id);
  if (chatId) q = q.eq('chat_id', chatId);
  if (orgId) q = q.eq('org_id', orgId);
  return must(await q.select()) || [];
}

/** A group became a supergroup: Telegram gives it a new id. */
export async function migrateChat(fromId, toId) {
  await db().from('telegram_chats').update({ chat_id: toId, chat_type: 'supergroup' }).eq('chat_id', fromId).is('disconnected_at', null);
  await db().from('telegram_conversations').delete().eq('chat_id', fromId);
}

/* ── one-time tokens ──────────────────────────────────────────────────────── */

const hash = (token) => createHash('sha256').update(token).digest('hex');
export const isTokenShape = (s) => /^[A-Za-z0-9_-]{32}$/.test(String(s || ''));

export async function createToken({ orgId, purpose, userId = null, createdBy, ttlMs }) {
  const token = randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + ttlMs).toISOString();
  must(await db().from('telegram_link_tokens').insert({
    token_hash: hash(token), org_id: orgId, purpose, user_id: userId, created_by: createdBy, expires_at: expires,
  }));
  return { token, expires_at: expires };
}

/** The token's row if it was unused and unexpired — and now it is used. Otherwise null. */
export async function consumeToken(token, telegramUserId) {
  if (!isTokenShape(token)) return null;
  const { data, error } = await db().from('telegram_link_tokens')
    .update({ used_at: nowIso(), used_by_telegram: telegramUserId })
    .eq('token_hash', hash(token)).is('used_at', null).gt('expires_at', nowIso())
    .select().maybeSingle();
  if (error) throw error;
  return data;
}

/** Puts a consumed token back when the step it was for could not complete. */
export async function releaseToken(token) {
  await db().from('telegram_link_tokens').update({ used_at: null, used_by_telegram: null }).eq('token_hash', hash(token));
}

/* ── conversations ────────────────────────────────────────────────────────── */

export async function loadConversation(chatId, telegramUserId) {
  const { data } = await db().from('telegram_conversations').select('*')
    .eq('chat_id', chatId).eq('telegram_user_id', telegramUserId).maybeSingle();
  return data || null;
}

export async function saveConversation(chatId, telegramUserId, orgId, state) {
  must(await db().from('telegram_conversations').upsert({
    chat_id: chatId, telegram_user_id: telegramUserId, org_id: orgId, state, updated_at: nowIso(),
  }, { onConflict: 'chat_id,telegram_user_id' }));
}

export async function clearConversationsFor(telegramUserId, orgId) {
  await db().from('telegram_conversations').delete().eq('telegram_user_id', telegramUserId).eq('org_id', orgId);
}
