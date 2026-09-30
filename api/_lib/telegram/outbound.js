import { supabaseAdmin } from '../supabaseAdmin.js';
import * as store from './store.js';
import * as bot from './bot.js';

/**
 * A private Telegram message from Buddy to one company person, on behalf of
 * whoever asked (send_telegram_message, carried out by executor.js).
 *
 * Nothing here takes a Telegram id from the caller. It starts from the
 * company (the verified ctx.orgId) and a person id, and works out the rest
 * from the adapter's own tables, again on every call:
 *
 *   person in this company → still active → the company has Telegram on →
 *   a live, unrevoked link for that person in this company → a private chat
 *   they opened with the bot (dm_chat_id is their own user id, so it can
 *   never be a group) → sendMessage.
 *
 * A bot cannot start a private chat, so a person who linked but never pressed
 * Start (or has blocked the bot since) cannot be messaged; that is reported,
 * never papered over. Their Telegram id, username and chat id never leave
 * this file: callers get the link id and Telegram's message id.
 *
 * The message body is never logged.
 */

const db = () => supabaseAdmin();

export class DeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const firstName = (p) => String(p?.full_name || 'them').trim().split(/\s+/)[0] || 'them';

/**
 * Where a message to this person would go, or why it cannot.
 * Returns { ok: true, person, link, chatId } | { ok: false, code, message, person? }.
 */
export async function recipientChannel(orgId, employeeId) {
  if (!orgId || !employeeId) return { ok: false, code: 'not_found', message: 'I could not find that person in your company.' };
  const person = await store.personInOrg(orgId, employeeId);
  // Another company's person looks exactly like nobody.
  if (!person || person.org_id !== orgId) return { ok: false, code: 'not_found', message: 'I could not find that person in your company.' };
  const name = firstName(person);
  if (person.exited_at || person.access_revoked_at) {
    return { ok: false, code: 'inactive', person, message: `${person.full_name} is no longer active in the team, so I can't message them.` };
  }
  if (!bot.isConfigured()) {
    return { ok: false, code: 'not_configured', person, message: 'The Telegram bot is not set up for StartupBuddy yet, so I can\'t send Telegram messages.' };
  }
  const settings = await store.orgSettings(orgId);
  if (!settings.enabled) {
    return { ok: false, code: 'disabled', person, message: 'Telegram is switched off for this company in StartupBuddy. An admin can turn it on in Settings → Telegram.' };
  }

  const link = await liveLink(orgId, person);
  if (!link) {
    const revoked = await hadLink(orgId, person);
    return revoked
      ? { ok: false, code: 'revoked', person, message: `${name}'s Telegram connection was disconnected. An admin can send ${name} a new Connect Telegram link from Team.` }
      : { ok: false, code: 'no_link', person, message: `${name} hasn't connected Telegram yet. An admin can send ${name} a Connect Telegram link from Team.` };
  }
  // A private chat's id is the person's own Telegram user id; a group's is
  // negative. Anything else is not a chat with this person alone.
  const chatId = Number(link.dm_chat_id);
  if (!link.dm_chat_id || !Number.isSafeInteger(chatId) || chatId <= 0 || String(link.dm_chat_id) !== String(link.telegram_user_id)) {
    return { ok: false, code: 'no_private_chat', person, message: `${name} hasn't started a private chat with Buddy yet. Ask ${name} to open their Connect Telegram link and press Start.` };
  }
  return { ok: true, person, link, chatId };
}

/** The person's live link in this company: their own (0071), or the one of their StartupBuddy login. */
async function liveLink(orgId, person) {
  const own = await store.personLinkFor(orgId, person.id);
  if (own) return own;
  if (!person.user_id) return null;
  const { data, error } = await db().from('telegram_links').select('*')
    .eq('org_id', orgId).eq('user_id', person.user_id).is('revoked_at', null).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function hadLink(orgId, person) {
  const byPerson = await db().from('telegram_links').select('id').eq('org_id', orgId).eq('employee_id', person.id).limit(1);
  if (byPerson.data?.length) return true;
  if (!person.user_id) return false;
  const byUser = await db().from('telegram_links').select('id').eq('org_id', orgId).eq('user_id', person.user_id).limit(1);
  return !!byUser.data?.length;
}

/* ── what the recipient may see ─────────────────────────────────────────────
   A message must not carry what the recipient could not read in StartupBuddy
   themselves. Their rights are the ones the rest of the app gives them: a
   login's effective permissions (public.user_permissions, service role), or,
   for a person with no login, what 0071 gives a person principal — the admin
   role's view rights, minus the withheld resources. Pay is owner/admin only
   for everyone. */

const PERSON_WITHHELD = new Set(['organizations', 'memberships', 'invitations', 'audit_log', 'ai_actions']);

export async function recipientAccess(orgId, person) {
  if (person.user_id) {
    const { data: m } = await db().from('memberships').select('role').eq('org_id', orgId).eq('user_id', person.user_id).maybeSingle();
    if (m) {
      const { data } = await db().rpc('user_permissions', { p_org: orgId, p_user: person.user_id });
      return { kind: 'user', role: m.role, view: new Set((data || []).filter((r) => r.can_view).map((r) => r.resource)) };
    }
  }
  const { data } = await db().from('role_permissions').select('resource, can_view').eq('org_id', orgId).eq('role', 'admin');
  return {
    kind: 'person', role: null,
    view: new Set((data || []).filter((r) => r.can_view && !PERSON_WITHHELD.has(r.resource)).map((r) => r.resource)),
  };
}

/*
 * What a message is about, as far as it can be told from its words. Blunt on
 * purpose: the person approving the card reads the exact text too; this is
 * the floor under that, not the whole of it.
 */
const TOPICS = [
  {
    key: 'secrets', label: 'passwords, keys or bank details', never: true,
    test: /\b(?:password|passcode|passwd|otp|one[- ]time (?:password|code)|api[ -]?key|secret key|access token|private key|cvv|ifsc|account (?:number|no\.?)|a\/c (?:no\.?|number))\b/i,
  },
  {
    key: 'pay', label: 'salaries and pay', adminOnly: true,
    test: /\b(?:salary|salaries|payroll|pay ?slips?|ctc|compensation|appraisal|increment|stipend|bonus)\b/i,
  },
  {
    key: 'money', label: 'money and invoices', resources: ['financial_documents', 'payments', 'expenses', 'income_entries'],
    test: /(?:₹|\brs\.?\s?\d|\binr\s?\d|\$\s?\d|\busd\s?\d|\d[\d,.]*\s?(?:lakhs?|crores?|cr|k)\b|\binv[-/ ]?\d|\binvoices?\b|\brevenue\b|\bprofit\b|\bburn\b|\brunway\b|\bbank balance\b|\bcash balance\b|\bgst\b)/i,
  },
];

export function topicsOf(text) {
  const s = String(text || '');
  return TOPICS.filter((t) => t.test.test(s));
}

/**
 * Why a message is not routine enough for Buddy to send without a person
 * approving it (0072), or null. Routine = short, and about nothing on the
 * list above: no money, pay or secrets. Anything else waits for approval.
 */
export const ROUTINE_MAX = 600;
export function routineIssue(text) {
  const s = String(text || '').trim();
  if (!s) return 'empty';
  if (s.length > ROUTINE_MAX) return 'long_message';
  if (topicsOf(s).length) return 'sensitive_topic';
  return null;
}

/** The first reason this person may not be sent this text, or null. */
export function withheldFor(text, access, name = 'They') {
  for (const t of topicsOf(text)) {
    if (t.never) return `I don't send ${t.label} over Telegram. Remove that part and I'll send the rest.`;
    if (t.adminOnly && !(access.kind === 'user' && ['owner', 'admin'].includes(access.role))) {
      return `${name} can't see ${t.label} in StartupBuddy, so I won't send that to them. Remove that part, or share it with someone who has access.`;
    }
    if (t.resources && !t.resources.some((r) => access.view.has(r))) {
      return `${name} can't see ${t.label} in StartupBuddy, so I won't send that to them. Remove that part, or share it with someone who has access.`;
    }
  }
  return null;
}

/* ── sending ──────────────────────────────────────────────────────────────── */

export const MAX_MESSAGE = 3500;

/**
 * What the recipient reads: who it is from, then the approved text exactly.
 * Buddy's own messages (a reminder, a follow-up — sent autonomously, 0072)
 * say they come from Buddy, never from a person who did not write them.
 */
export function formatMessage(text, { senderName, orgName, fromBuddy = false }) {
  if (fromBuddy) return `🤖 <b>Buddy</b>${orgName ? ` · ${bot.esc(orgName)}` : ''}\n\n${bot.esc(text)}`;
  const from = senderName && senderName !== 'you' ? senderName : 'A teammate';
  return `💬 <b>${bot.esc(from)}</b>${orgName ? ` · ${bot.esc(orgName)}` : ''} sent you a message via Buddy:\n\n${bot.esc(text)}`;
}

/**
 * Sends one private message. Everything is re-checked here, at the moment of
 * sending — nothing from when the card was drawn is trusted. Resolves with
 * what the audit keeps; throws DeliveryError with a message for the person.
 */
export async function deliverPrivate({ orgId, employeeId, text, senderName = null, orgName = null, fromBuddy = false }, { send = bot.sendMessage } = {}) {
  const body = String(text || '').trim();
  if (!body) throw new DeliveryError('empty', 'The message is empty.');
  if (body.length > MAX_MESSAGE) throw new DeliveryError('too_long', `The message is too long for Telegram (${MAX_MESSAGE} characters at most).`);

  const r = await recipientChannel(orgId, employeeId);
  if (!r.ok) throw new DeliveryError(r.code, r.message);
  const name = firstName(r.person);

  let sent;
  try {
    sent = await send(r.chatId, formatMessage(body, { senderName, orgName, fromBuddy }));
  } catch (err) {
    const why = String(err?.description || '');
    console.warn('[telegram] private message failed', { orgId, linkId: r.link.id, status: err?.status ?? null });
    if (/blocked by the user|user is deactivated/i.test(why)) {
      throw new DeliveryError('blocked', `Telegram couldn't deliver this message to ${name}: ${name} has blocked or stopped the Buddy bot. Ask ${name} to open the bot and press Start again.`);
    }
    if (/chat not found|bot can't initiate/i.test(why)) {
      throw new DeliveryError('no_private_chat', `Telegram couldn't deliver this message to ${name}: ${name} hasn't started a private chat with Buddy. Ask ${name} to open their Connect Telegram link and press Start.`);
    }
    throw new DeliveryError('telegram', `Telegram couldn't deliver this message to ${name}. Try again in a moment.`);
  }
  // Only Telegram's own acknowledgement counts as delivered.
  if (!sent || !Number.isFinite(Number(sent.message_id))) {
    throw new DeliveryError('telegram', `Telegram couldn't deliver this message to ${name}. Try again in a moment.`);
  }
  return {
    recipient_person_id: r.person.id,
    recipient_name: r.person.full_name,
    telegram_link_id: r.link.id,
    telegram_message_id: sent.message_id,
    chat: 'private',
    characters: body.length,
    from: fromBuddy ? 'buddy' : 'person',
    delivered_at: new Date().toISOString(),
  };
}
