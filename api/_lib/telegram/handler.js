import * as bot from './bot.js';
import * as store from './store.js';
import * as buddy from '../agent/buddy.js';
import { openChannelSession, verifyPerson, verifyLink, ChannelAccessError } from '../agent/channelSession.js';
import { supabaseAdmin } from '../supabaseAdmin.js';
import { requireOrgRole } from '../auth.js';
import { bumpAiUsage, logAiUsage } from '../aiUsage.js';
import { AGENT_MODEL, newUsage, describeUsage } from '../agent/model.js';
import * as pulse from '../agent/pulse.js';
import { getTool, appApprovalOnly } from '../agent/registry.js';
import {
  currentState, freshState, requestBody, pushHistory, remember, trackCard, cardLine, nonce, chatKey,
} from './conversation.js';
import { renderCard, renderView, renderOptions, renderNotice, renderNavigate } from './render.js';

/**
 * One Telegram update, start to finish. The Telegram half of the adapter:
 *
 *   identify   update → Telegram user + chat → (group mapping | DM choice)
 *              → the company → that Telegram account's live link in THAT
 *              company → verified on every update: a StartupBuddy user
 *              (account, membership, revoked login) or a company person with
 *              no login (live link, still in the company) — channelSession.js.
 *              Nothing Telegram says about someone (name, username, group
 *              membership) is ever taken as who they are.
 *   translate  a message becomes the same request body the web client sends
 *              (conversation.js), a button becomes the same confirm / cancel
 *              / undo / retry / resume call the web card makes
 *   render     Buddy's events become messages and buttons (render.js)
 *
 * Everything that decides anything — intent, tools, permissions, proposals,
 * approval, execution, audit, undo — is Buddy's (api/_lib/agent/buddy.js),
 * running as the person with their own database identity — a user's token,
 * or a person principal the database re-checks on every query (0071).
 *
 * Approvals: a low-risk card is confirmed with one tap. A high-risk card
 * (money, issuing documents, deletes) is confirmed only in a private chat,
 * with two taps — Review, which shows exactly what will happen, then Confirm
 * — and the confirm callback refuses it unless that review happened in this
 * chat within the last few minutes. Never in a group. Tools that email
 * someone outside the company are approved in the app only.
 *
 * Groups: Buddy answers only when addressed (a command, an @mention, or a
 * reply to one of its messages) — with BotFather privacy mode on, Telegram
 * does not even deliver the rest. A group turn runs with audience 'shared':
 * no money, invoices, salaries, leave or personal data (context.js).
 *
 * Every update_id is handled once (store.claimUpdate). Errors reply with a
 * generic line; the webhook still answers 200 so Telegram does not redeliver
 * an update whose effects may already exist.
 */

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;
const PULSE_FOLLOW_UP_MS = 30 * 60 * 1000;
const ONBOARD = 'I don\'t recognize your Buddy account yet. Ask your company admin to connect your Telegram account (<b>Team → your name → Connect Telegram</b>). If you use StartupBuddy yourself, open <b>Settings → Telegram</b> and tap <b>Link my Telegram</b>.';
const UNKNOWN_IN_GROUP = 'I don\'t recognize your Buddy account yet. Ask your company admin to connect your Telegram account.';
const ENDED = 'Your access to this company through Buddy has ended, so I can\'t act for you here anymore. If that\'s a mistake, ask your admin.';
const NOT_READY = 'Buddy isn\'t available for your account right now — the company\'s setup needs attention. Your admin can check Settings → Telegram.';
const REVIEW_WINDOW_MS = 5 * 60 * 1000;
const noBuddy = (role) => `Your role in StartupBuddy${role ? ` (${role})` : ''} doesn't include Buddy, so I can't help you here yet. Ask your admin to change your role.`;

/**
 * A refused channel identity: when access has really ended the link is
 * revoked and its conversations cleared; a role without Buddy keeps the link.
 * Returns the sentence to show.
 */
async function refused(err, link, orgId) {
  console.warn(`[telegram] link ${link.id} refused: ${err.reason}`);
  if (err.reason === 'config') return NOT_READY;
  if (!err.ended) return noBuddy(err.role);
  await store.revokeLink(link.id, `access_${err.reason}`);
  await store.clearConversationsFor(link.telegram_user_id, orgId);
  return ENDED;
}

export async function processUpdate(update) {
  const updateId = update?.update_id;
  if (!Number.isSafeInteger(updateId)) return { status: 'ignored' };
  const msg = update.message;
  const cb = update.callback_query;
  const member = update.my_chat_member;
  const from = msg?.from || cb?.from || member?.from || null;
  const chat = msg?.chat || cb?.message?.chat || member?.chat || null;
  const kind = msg ? 'message' : cb ? 'callback' : member ? 'membership' : 'other';

  if (!(await store.claimUpdate(updateId, { telegramUserId: from?.id ?? null, chatId: chat?.id ?? null, kind }))) {
    return { status: 'duplicate' };
  }
  const started = Date.now();
  try {
    let status = 'ignored';
    if (from?.is_bot) status = 'ignored';
    else if (kind === 'membership') status = await onMembership(member);
    else if (kind === 'callback') status = await onCallback(cb);
    else if (kind === 'message') status = await onMessage(msg);
    await store.finishUpdate(updateId, status || 'done');
    console.info(`[telegram] ${kind} ${updateId} ${status || 'done'} ${Date.now() - started}ms`);
    return { status: status || 'done' };
  } catch (err) {
    console.error(`[telegram] ${kind} ${updateId} failed:`, err?.message || err);
    await store.finishUpdate(updateId, 'failed', err?.message || String(err)).catch(() => null);
    if (cb) await bot.answerCallback(cb.id, 'Something went wrong on my side. Try again in a moment.');
    else if (chat?.id && kind === 'message') await bot.sendMessage(chat.id, 'Something went wrong on my side. Try again in a moment.').catch(() => null);
    return { status: 'failed' };
  }
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

const reply = (msg, html, opts = {}) => bot.sendMessage(msg.chat.id, html, {
  ...opts, replyTo: opts.replyTo ?? (msg.chat.type === 'private' ? null : msg.message_id),
});

async function overLimit(from, chatId) {
  const n = await store.recentUpdateCount(from.id, RATE_WINDOW_MS);
  if (n === RATE_MAX + 1 && chatId) await bot.sendMessage(chatId, 'That\'s a lot at once — give me a minute and try again.').catch(() => null);
  return n > RATE_MAX;
}

function parseCommand(text, username) {
  const m = /^\/([a-z_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/i.exec(text || '');
  if (!m) return null;
  return { name: m[1].toLowerCase(), arg: (m[3] || '').trim(), forOther: !!m[2] && m[2].toLowerCase() !== String(username).toLowerCase() };
}

const mentionRe = (username) => new RegExp(`@${username}\\b`, 'ig');
const personName = (user, emp) => emp?.full_name || user?.user_metadata?.full_name || user?.email || 'there';
const actorOf = (from) => `telegram:${from.id}`;
const isPersonLink = (link) => !!link?.employee_id && !link.user_id;

/** Whether an ai_actions row was asked for by this link's identity. */
export const ownsAction = (link, row) => (isPersonLink(link)
  ? !row.user_id && !!row.employee_id && row.employee_id === link.employee_id
  : !!row.user_id && row.user_id === link.user_id);

async function employeeOf(orgId, userId) {
  const { data } = await supabaseAdmin().from('employees').select('id, full_name').eq('org_id', orgId).eq('user_id', userId).maybeSingle();
  return data || null;
}

/**
 * Opens Buddy as the linked person, or explains why not. A person whose
 * StartupBuddy access ended has the link revoked here, at first contact.
 */
async function session(link, orgId, body, { chatId, cb = null, from }) {
  try {
    return await openChannelSession({ link, orgId, channel: 'telegram', body, channelActor: actorOf(from) });
  } catch (err) {
    if (!(err instanceof ChannelAccessError)) throw err;
    const text = await refused(err, link, orgId);
    if (cb) await bot.answerCallback(cb.id, text, { alert: true });
    else if (chatId) await bot.sendMessage(chatId, bot.esc(text));
    return null;
  }
}

/** In a DM: the person's links, and the company this chat is on (their last pick, else the most recent). */
async function dmIdentity(from, chatId) {
  const links = await store.linksForTelegram(from.id);
  if (!links.length) return null;
  const conv = await store.loadConversation(chatId, from.id);
  const link = links.find((l) => l.org_id === conv?.org_id) || links[0];
  return { link, links, conv: conv?.org_id === link.org_id ? conv : null };
}

/* ── messages ─────────────────────────────────────────────────────────────── */

async function onMessage(msg) {
  const { chat, from } = msg;
  if (msg.migrate_to_chat_id) { await store.migrateChat(chat.id, msg.migrate_to_chat_id); return 'done'; }
  if (!from || chat.type === 'channel') return 'ignored';
  const me = await bot.getMe();
  const text = String(msg.text || msg.caption || '').trim();
  const cmd = parseCommand(text, me.username);
  const group = chat.type === 'group' || chat.type === 'supergroup';

  if (group) {
    const mentioned = !!me.username && mentionRe(me.username).test(text);
    const addressed = (cmd && !cmd.forOther) || mentioned || msg.reply_to_message?.from?.id === me.id;
    if (!addressed) return 'ignored';
  } else if (cmd?.forOther) {
    return 'ignored';
  }
  if (await overLimit(from, chat.id)) return 'ignored';
  if (group) {
    const clean = me.username ? text.replace(mentionRe(me.username), '').trim() : text;
    return onGroupMessage(msg, cmd, clean, me);
  }
  return onPrivateMessage(msg, cmd, text, me);
}

async function onPrivateMessage(msg, cmd, text, me) {
  let say = text;
  if (cmd) {
    switch (cmd.name) {
      case 'start': return cmd.arg ? linkAccount(msg, cmd.arg) : welcome(msg);
      case 'help': await reply(msg, helpText(false, me)); return 'done';
      case 'me': case 'whoami': return whoAmI(msg);
      case 'company': return pickCompany(msg);
      case 'unlink': return unlinkSelf(msg);
      case 'pulse': return pulseToggle(msg, cmd.arg);
      case 'new': case 'reset': return resetConversation(msg);
      case 'buddy': say = cmd.arg; break;
      default: await reply(msg, `I don't know that command. ${helpText(false, me)}`); return 'done';
    }
  }
  const id = await dmIdentity(msg.from, msg.chat.id);
  if (!id) { await reply(msg, `Hi! I'm Buddy, the AI teammate in StartupBuddy.\n\n${ONBOARD}`); return 'done'; }
  if (!say) { await reply(msg, 'I can read text messages for now — type what you need.'); return 'done'; }
  return buddyTurn({ msg, text: say, audience: 'private', link: id.link, orgId: id.link.org_id, conv: id.conv });
}

async function onGroupMessage(msg, cmd, text, me) {
  if (cmd?.name === 'start' && cmd.arg) return connectGroup(msg, cmd.arg, me);
  const chatRow = await store.chatFor(msg.chat.id);
  if (!chatRow) {
    await reply(msg, 'This group isn\'t connected to StartupBuddy yet. An owner or admin can connect it from <b>StartupBuddy → Settings → Telegram</b>.');
    return 'done';
  }
  if (cmd && ['help', 'start'].includes(cmd.name)) { await reply(msg, helpText(true, me)); return 'done'; }
  // The group says which company; the sender's own link in THAT company says
  // who they are. Being in the group, a name or a username proves nothing.
  const link = await store.linkFor(msg.from.id, chatRow.org_id);
  if (!link) {
    await reply(msg, UNKNOWN_IN_GROUP);
    return 'done';
  }
  let say = text;
  if (cmd) {
    if (cmd.name !== 'buddy') { await reply(msg, `In a group, mention me or use /buddy — e.g. <code>@${bot.esc(me.username)} what's due this week?</code>`); return 'done'; }
    say = cmd.arg;
  }
  if (!say) { await reply(msg, `Yes? Ask me something — e.g. <code>@${bot.esc(me.username)} who owns the payment integration?</code>`); return 'done'; }
  const conv = await store.loadConversation(msg.chat.id, msg.from.id);
  return buddyTurn({ msg, text: say, audience: 'shared', link, orgId: chatRow.org_id, conv });
}

/* ── a Buddy turn ─────────────────────────────────────────────────────────── */

// Telegram shows "typing…" for about 5 seconds per sendChatAction.
const TYPING_EVERY_MS = 4000;

/** Shows "typing…" now and keeps it on until the returned stop() is called. */
function keepTyping(chatId) {
  bot.typing(chatId);
  const timer = setInterval(() => bot.typing(chatId), TYPING_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function buddyTurn({ msg, text, audience, link, orgId, conv }) {
  // Right away, before the session and metering round trips: the person sees
  // Buddy working instead of silence, for the whole turn.
  const stopTyping = keepTyping(msg.chat.id);
  try {
    return await runBuddyTurn({ msg, text, audience, link, orgId, conv }, stopTyping);
  } finally {
    stopTyping();
  }
}

async function runBuddyTurn({ msg, text, audience, link, orgId, conv }, stopTyping) {
  const { chat, from } = msg;
  const settings = await store.orgSettings(orgId);
  if (!settings.enabled) { await reply(msg, 'Telegram is switched off for this company in StartupBuddy.'); return 'done'; }

  const state = currentState(conv, orgId);
  let checkin = null;
  // A check-in stays open for follow-up messages for a while after the first
  // answer ("oh, and…"); after that, messages are ordinary questions again.
  if (state.pulse?.answered_at && Date.now() - state.pulse.answered_at > PULSE_FOLLOW_UP_MS) state.pulse = null;
  // Daily Pulse is for StartupBuddy users for now (pulse_checkins keys on the user).
  if (audience === 'private' && state.pulse?.id && link.user_id) {
    checkin = await pulse.openCheckin({ id: state.pulse.id, orgId, userId: link.user_id }).catch(() => null);
    if (!checkin) state.pulse = null;
  }
  const messageId = `tg${msg.message_id}`;
  const body = requestBody(state, { chatId: chat.id, messageId, audience, source: checkin ? `pulse:${checkin.id}` : null });
  const ctx = await session(link, orgId, body, { chatId: chat.id, from });
  if (!ctx) return 'done';
  await store.touchLink(link, { from, dmChatId: audience === 'private' ? chat.id : null });

  // Metered exactly like a web message, before the model is called.
  const used = await bumpAiUsage(orgId, 'telegram');
  if (used > ctx.aiLimit) {
    await logAiUsage({ orgId, user: ctx.user, surface: 'copilot', outcome: 'blocked' });
    await reply(msg, bot.esc(`Your plan's AI message limit (${ctx.aiLimit}) has been reached.`));
    return 'done';
  }

  const events = [];
  const emit = (event, data) => { events.push({ event, data }); };
  const usage = newUsage();
  const tokens = () => (usage.calls ? { promptTokens: usage.prompt, completionTokens: usage.output } : {});
  try {
    await buddy.chat(ctx, { message: text, history: body.history, chatId: body.chat_id, messageId }, emit, { usage });
    console.info(`[telegram] tokens: ${describeUsage(usage)}`);
    await logAiUsage({ orgId, user: ctx.user, surface: 'copilot', model: AGENT_MODEL, ...tokens() });
  } catch (err) {
    console.error('[telegram] chat', err?.message || err, err?.detail || '');
    await logAiUsage({ orgId, user: ctx.user, surface: 'copilot', outcome: 'failed', model: AGENT_MODEL, ...tokens() });
    events.push({ event: 'error', data: { message: err?.status ? 'The AI service is unavailable right now. Try again in a moment.' : 'Something went wrong on my side.' } });
  }

  pushHistory(state, 'user', text);
  state.pending = null;
  state.offers = null;
  stopTyping();
  const produced = await deliver(chat.id, state, events, { replyTo: audience === 'shared' ? msg.message_id : null, turn: messageId });
  if (checkin && state.pulse && !state.pulse.answered_at) state.pulse.answered_at = Date.now();
  state.at = Date.now();
  await store.saveConversation(chat.id, from.id, orgId, state);
  if (checkin) await pulse.recordAnswer(checkin, { response: text, actionIds: produced.actionIds }).catch((e) => console.warn('[telegram] pulse answer not recorded:', e?.message));
  return 'done';
}

/**
 * Sends a turn's events in order and folds them into the conversation state.
 * Returns the ids of the proposals it showed.
 */
async function deliver(chatId, state, events, { replyTo = null, turn }) {
  const out = { actionIds: [] };
  let shown = 0;
  const send = async (r) => { shown += 1; return bot.sendMessage(chatId, r.html, { buttons: r.buttons, replyTo }); };

  for (const { event, data } of events) {
    switch (event) {
      case 'text':
        if (data.text) { await send({ html: bot.mdToHtml(data.text) }); pushHistory(state, 'assistant', data.text); }
        break;
      case 'view': {
        const r = renderView(data.view);
        if (r) { await send(r); pushHistory(state, 'assistant', `[Shown: ${data.view.title || 'details'}]`); }
        break;
      }
      case 'card': {
        const m = await send(renderCard(data.card, Date.now(), { group: chatId < 0 }));
        trackCard(state, data.card, m?.message_id);
        pushHistory(state, 'assistant', cardLine(data.card));
        remember(state, data.card.entities, turn);
        out.actionIds.push(data.card.action_id);
        break;
      }
      case 'card_update':
        if (data.card) { await showCard(chatId, state, data.card); shown += 1; remember(state, data.entities || data.card.entities, turn); }
        break;
      case 'choice':
      case 'input': {
        const q = data.choice || data.input;
        const n = nonce();
        const options = q.options || [];
        state.offers = { n, items: options.map((o) => ({ tool: q.resume?.tool, args: q.resume?.args || {}, param: q.param, value: o.value, label: o.label })) };
        state.pending = q.resume ? { ...q.resume, param: q.param, question: q.question } : null;
        await send(renderOptions(q.question, options, n, { hint: q.hint }));
        pushHistory(state, 'assistant', q.question);
        break;
      }
      case 'notice': {
        let n = null;
        if (data.offer?.tool) { n = nonce(); state.offers = { n, items: [{ tool: data.offer.tool, args: data.offer.args || {}, label: data.offer.label }] }; }
        await send(renderNotice(data.text, data.offer?.tool ? data.offer : null, n));
        pushHistory(state, 'assistant', data.text);
        break;
      }
      case 'navigate': {
        const r = renderNavigate(data);
        if (r) await send(r);
        break;
      }
      case 'entities':
        remember(state, data.entities, turn);
        break;
      case 'error':
        await send({ html: bot.esc(data.message || 'Something went wrong on my side.') });
        break;
      default:
        break;
    }
  }
  if (!shown) await send({ html: 'I didn\'t get an answer back. Try again?' });
  return out;
}

/** Re-draws a card where it was shown (or sends it, if that message is unknown). */
async function showCard(chatId, state, card, messageId = null, { reviewing = false } = {}) {
  // Telegram group ids are negative; private chats are the person.
  const r = renderCard(card, Date.now(), { group: chatId < 0, reviewing });
  const mid = messageId || state.cards.find((c) => c.action_id === card.action_id)?.message_id;
  if (mid) {
    try { await bot.editMessage(chatId, mid, r.html, { buttons: r.buttons }); trackCard(state, card, mid); return; } catch { /* sent afresh below */ }
  }
  const m = await bot.sendMessage(chatId, r.html, { buttons: r.buttons });
  trackCard(state, card, m?.message_id);
}

/* ── buttons ──────────────────────────────────────────────────────────────── */

/**
 * Whether a Confirm tap may go ahead from Telegram — null if so, else what to
 * tell the person. Low risk: yes. High risk: never in a group, never for a
 * tool approved only in the app, and only right after this person tapped
 * Review on it in this private chat (state.reviewed, server-side).
 */
export function confirmRefusal({ row, group, state, now = Date.now() }) {
  if (row.risk === 'low') return null;
  if (appApprovalOnly(getTool(row.tool))) return 'This is approved in the StartupBuddy app only — use "Review in StartupBuddy".';
  if (group) return 'Money and other sensitive changes are confirmed in a private chat with me, not in the group.';
  const r = state?.reviewed;
  if (!r || r.action_id !== row.id || !(now - r.at <= REVIEW_WINDOW_MS)) return 'Tap Review first — it shows exactly what will happen.';
  return null;
}

async function onCallback(cb) {
  const chat = cb.message?.chat;
  if (!chat) { await bot.answerCallback(cb.id); return 'ignored'; }
  if (await overLimit(cb.from, null)) { await bot.answerCallback(cb.id, 'Slow down a little — try again in a minute.'); return 'ignored'; }
  const data = String(cb.data || '');
  let m;
  if ((m = /^a:([cxurve]):([0-9a-f-]{36})$/i.exec(data))) return onCardButton(cb, m[1], m[2]);
  if ((m = /^k:([0-9a-f]{8}):(\d{1,2})$/.exec(data))) return onOption(cb, m[1], Number(m[2]));
  if ((m = /^s:([0-9a-f-]{36})$/i.exec(data)) && chat.type === 'private') return onSwitch(cb, m[1]);
  await bot.answerCallback(cb.id, 'That button is no longer active.');
  return 'ignored';
}

async function onCardButton(cb, op, actionId) {
  const chat = cb.message.chat;
  const group = chat.type !== 'private';
  // Only to learn which company to check; buddy.* reload it by id AND owner.
  const { data: row } = await supabaseAdmin().from('ai_actions').select('id, org_id, user_id, employee_id, risk, kind, tool').eq('id', actionId).maybeSingle();
  if (!row) { await bot.answerCallback(cb.id, 'That change is no longer available.'); return 'done'; }
  const link = await store.linkFor(cb.from.id, row.org_id);
  if (!link || !ownsAction(link, row)) {
    await bot.answerCallback(cb.id, 'Only the person who asked for this can use these buttons.', { alert: true });
    return 'done';
  }
  if (group) {
    const chatRow = await store.chatFor(chat.id);
    if (!chatRow || chatRow.org_id !== row.org_id) { await bot.answerCallback(cb.id, 'That change is not available here.'); return 'done'; }
  }
  const settings = await store.orgSettings(row.org_id);
  if (!settings.enabled) { await bot.answerCallback(cb.id, 'Telegram is switched off for this company.', { alert: true }); return 'done'; }

  const conv = await store.loadConversation(chat.id, cb.from.id);
  const state = currentState(conv?.org_id === row.org_id ? conv : null, row.org_id);
  if (op === 'c') {
    const why = confirmRefusal({ row, group, state });
    if (why) { await bot.answerCallback(cb.id, why, { alert: true }); return 'done'; }
  }
  if (op === 'v' && (group || row.risk === 'low' || appApprovalOnly(getTool(row.tool)))) {
    await bot.answerCallback(cb.id, group ? 'Open a private chat with me to review this.' : 'Nothing more to review here.');
    return 'done';
  }
  const body = requestBody(state, { chatId: chat.id, messageId: `cb${cb.message.message_id}`, audience: group ? 'shared' : 'private' });
  const ctx = await session(link, row.org_id, body, { chatId: chat.id, cb, from: cb.from });
  if (!ctx) return 'done';
  await bot.answerCallback(cb.id, op === 'c' ? 'Working on it…' : '');

  const mid = cb.message.message_id;
  const say = (html) => bot.sendMessage(chat.id, html, { replyTo: group ? mid : null });
  let res;
  if (op === 'v') {
    // Step one of a high-risk approval: the full card, and the one button that applies it.
    const [card] = await buddy.status(ctx, [actionId]);
    if (!card || card.status !== 'proposed') {
      if (card) await showCard(chat.id, state, card, mid);
      else await say('That change is no longer available.');
    } else {
      state.reviewed = { action_id: actionId, at: Date.now() };
      await showCard(chat.id, state, card, mid, { reviewing: true });
    }
  } else if (op === 'e') {
    state.pending = null;
    await say('What should I change? Reply with the correction — e.g. “make it ₹4,500” or “date it yesterday” — and I\'ll prepare an updated card. Nothing changes until you confirm.');
    pushHistory(state, 'assistant', `[Asked what to change on the card "${actionId}"]`);
  } else if (op === 'c') {
    state.reviewed = null;
    await bot.clearButtons(chat.id, mid);
    res = await buddy.confirm(ctx, actionId);
    if (res.status === 'invalid') {
      await say(`⚠️ ${bot.esc(res.message || 'That can\'t be done as it stands.')}`);
      const [fresh] = await buddy.status(ctx, [actionId]);
      if (fresh) await showCard(chat.id, state, fresh, mid);
    } else if (res.status === 'repreviewed') {
      const [old] = await buddy.status(ctx, [actionId]);
      if (old) await showCard(chat.id, state, old, mid);
      await say('It changed since I proposed it — here it is again with the current values.');
      await showCard(chat.id, state, res.card);
      pushHistory(state, 'assistant', cardLine(res.card));
    } else if (res.card) {
      await showCard(chat.id, state, res.card, mid);
      pushHistory(state, 'assistant', cardLine(res.card));
      if (res.status === 'executed') remember(state, res.entities || res.card.entities, `cb${mid}`);
    } else if (res.message) {
      await say(bot.esc(res.message));
    }
  } else if (op === 'x') {
    res = await buddy.cancel(ctx, actionId);
    if (res.card) { await showCard(chat.id, state, res.card, mid); pushHistory(state, 'assistant', cardLine(res.card)); }
  } else if (op === 'u') {
    res = await buddy.undo(ctx, actionId);
    if (res.status === 'undone' && res.card) { await showCard(chat.id, state, res.card, mid); pushHistory(state, 'assistant', cardLine(res.card)); }
    else await say(`⚠️ ${bot.esc(res.message || 'Could not undo it.')}`);
  } else {
    res = await buddy.retry(ctx, actionId);
    if (res.status === 'proposed' && res.card) {
      await bot.clearButtons(chat.id, mid);
      await showCard(chat.id, state, res.card);
      pushHistory(state, 'assistant', cardLine(res.card));
    } else await say(`⚠️ ${bot.esc(res.message || 'That can\'t be prepared again right now.')}`);
  }
  state.at = Date.now();
  await store.saveConversation(chat.id, cb.from.id, row.org_id, state);
  return 'done';
}

/** A tapped chip (a choice, a suggested answer, an offer) — straight into its tool, no model, like the web. */
async function onOption(cb, n, i) {
  const chat = cb.message.chat;
  const group = chat.type !== 'private';
  const conv = await store.loadConversation(chat.id, cb.from.id);
  const offers = conv?.state?.offers;
  const item = offers?.n === n ? offers.items?.[i] : null;
  if (!conv?.org_id || !item?.tool) { await bot.answerCallback(cb.id, 'That choice has expired — ask me again.'); return 'done'; }
  const orgId = conv.org_id;
  const link = await store.linkFor(cb.from.id, orgId);
  if (!link) { await bot.answerCallback(cb.id, 'Link your StartupBuddy account first.', { alert: true }); return 'done'; }
  if (group) {
    const chatRow = await store.chatFor(chat.id);
    if (!chatRow || chatRow.org_id !== orgId) { await bot.answerCallback(cb.id, 'Not available here.'); return 'done'; }
  }
  const settings = await store.orgSettings(orgId);
  if (!settings.enabled) { await bot.answerCallback(cb.id, 'Telegram is switched off for this company.', { alert: true }); return 'done'; }

  const state = currentState(conv, orgId);
  const messageId = `cb${cb.message.message_id}`;
  const body = requestBody(state, { chatId: chat.id, messageId, audience: group ? 'shared' : 'private' });
  const ctx = await session(link, orgId, body, { chatId: chat.id, cb, from: cb.from });
  if (!ctx) return 'done';
  await bot.answerCallback(cb.id);
  await bot.clearButtons(chat.id, cb.message.message_id);

  const events = [];
  const resumeArgs = { tool: item.tool, args: item.args || {}, ...(item.param ? { param: item.param, value: item.value } : {}) };
  await buddy.resume(ctx, resumeArgs, (event, data) => events.push({ event, data }), { chatId: chatKey(chat.id), messageId });
  pushHistory(state, 'user', item.label || String(item.value ?? ''));
  state.pending = null;
  state.offers = null;
  await deliver(chat.id, state, events, { replyTo: group ? cb.message.message_id : null, turn: messageId });
  state.at = Date.now();
  await store.saveConversation(chat.id, cb.from.id, orgId, state);
  return 'done';
}

async function onSwitch(cb, orgId) {
  const link = await store.linkFor(cb.from.id, orgId);
  if (!link) { await bot.answerCallback(cb.id, 'You are not linked to that company.'); return 'done'; }
  try { await verifyLink(link, orgId); } catch (err) {
    if (!(err instanceof ChannelAccessError)) throw err;
    await bot.answerCallback(cb.id, await refused(err, link, orgId), { alert: true });
    return 'done';
  }
  await store.saveConversation(cb.message.chat.id, cb.from.id, orgId, freshState(orgId));
  await store.touchLink(link);
  const org = await store.orgBasics(orgId);
  await bot.answerCallback(cb.id);
  await bot.editMessage(cb.message.chat.id, cb.message.message_id, `Now working in <b>${bot.esc(org.name)}</b>.`);
  return 'done';
}

/* ── linking ──────────────────────────────────────────────────────────────── */

async function linkAccount(msg, token) {
  const { from, chat } = msg;
  const row = await store.consumeToken(token, from.id);
  if (!row) { await reply(msg, 'That link has expired or was already used. Ask your company admin for a new one.'); return 'done'; }
  if (row.purpose === 'person') return linkPerson(msg, row, token);
  if (row.purpose !== 'link') {
    await store.releaseToken(token);
    await reply(msg, 'That link connects a group. Open it again and choose the group to add me to.');
    return 'done';
  }
  const settings = await store.orgSettings(row.org_id);
  if (!settings.enabled) { await store.releaseToken(token); await reply(msg, 'Telegram is switched off for this company in StartupBuddy.'); return 'done'; }
  let person;
  try { person = await verifyPerson({ userId: row.user_id, orgId: row.org_id }); } catch (err) {
    if (!(err instanceof ChannelAccessError)) throw err;
    // A role without Buddy: keep the token usable for when the admin changes it.
    if (!err.ended) { await store.releaseToken(token); await reply(msg, bot.esc(noBuddy(err.role))); return 'done'; }
    await reply(msg, 'This link is no longer valid: that account no longer has access to the company.');
    return 'done';
  }
  const self = row.created_by === row.user_id;
  await store.createLink({ orgId: row.org_id, userId: row.user_id, from, dmChatId: chat.id, via: self ? 'self' : 'invite', invitedBy: self ? null : row.created_by });
  await store.saveConversation(chat.id, from.id, row.org_id, freshState(row.org_id));
  const [org, emp] = await Promise.all([store.orgBasics(row.org_id), employeeOf(row.org_id, row.user_id)]);
  console.info(`[telegram] linked tg ${from.id} → user ${row.user_id} org ${row.org_id} (${self ? 'self' : 'invite'})`);
  await reply(msg, [
    `✅ You're linked to <b>${bot.esc(org.name)}</b> as <b>${bot.esc(personName(person.user, emp))}</b> (${bot.esc(person.membership.role)}).`,
    '',
    'Ask me things like:',
    '• What do I need to do today?',
    '• Move my payment task to Friday',
    '• I\'m blocked on the payment integration — need API access',
    '',
    'I always show you a change before I make it. /help for more.',
  ].join('\n'));
  return 'done';
}

/**
 * A person invite (0071): an admin made it for ONE company person, who may
 * have no StartupBuddy login. The token alone decides which person and which
 * company — nothing the person types or their Telegram profile says. Opening
 * it links this Telegram account to that person, once.
 */
async function linkPerson(msg, row, token) {
  const { from, chat } = msg;
  const fail = async (html, { keep = true } = {}) => { if (keep) await store.releaseToken(token); await reply(msg, html); return 'done'; };
  const settings = await store.orgSettings(row.org_id);
  if (!settings.enabled) return fail('Telegram is switched off for this company in StartupBuddy.');

  const person = await store.personInOrg(row.org_id, row.employee_id);
  if (!person || person.exited_at || person.access_revoked_at) {
    return fail('This invite is no longer valid: that person is no longer on the team. Ask your admin.', { keep: false });
  }
  // One Telegram account is one identity per company, and one company person anywhere.
  const mine = await store.linksForTelegram(from.id);
  const login = mine.find((l) => l.org_id === row.org_id && l.user_id);
  if (login) return attachOwnRecord(msg, row, token, person, login, fail);
  if (mine.some((l) => l.employee_id && l.org_id !== row.org_id)) {
    return fail('This Telegram account is already connected to another company as a team member. Ask that company\'s admin to disconnect it first.');
  }

  try {
    await store.createPersonLink({ orgId: row.org_id, employeeId: person.id, from, dmChatId: chat.type === 'private' ? chat.id : null, invitedBy: row.created_by });
  } catch (err) {
    if (err?.code === '23505') return fail('This Telegram account is already connected to another team member. Ask your admin.');
    throw err;
  }
  await store.voidPersonTokens(row.org_id, person.id);
  await store.saveConversation(chat.id, from.id, row.org_id, freshState(row.org_id));
  const org = await store.orgBasics(row.org_id);
  console.info(`[telegram] linked tg ${from.id} → person ${person.id} org ${row.org_id} (person_invite)`);
  await reply(msg, [
    `✅ You're connected to <b>${bot.esc(org.name)}</b> as <b>${bot.esc(person.full_name)}</b>. You can now use Buddy here.`,
    '',
    'Ask me things like:',
    '• Show me my tasks',
    '• Create a task for me to follow up with the sponsor tomorrow',
    '• Invoice Client X ₹25,000 for the event',
    '',
    'I always show you a change before I make it. /help for more.',
  ].join('\n'));
  return 'done';
}

/**
 * A person invite opened by a Telegram account that is already linked to a
 * StartupBuddy login in the same company. One Telegram account is one identity
 * per company, so it cannot become a second, person identity. But when the
 * Team record IS that login's owner — typically an owner/admin who linked
 * their own Telegram in Settings and then pressed Connect Telegram on their
 * own row in Team — the record is simply marked as theirs (employees.user_id).
 * Reminders, follow-ups and messages to that record then reach this chat
 * through the login's link (outbound.liveLink), and "my tasks" mean it.
 *
 * Proof it is the same human: the record already names this login, or the
 * invite was made by this very login (an owner/admin, re-checked now) and
 * opened from its own linked Telegram. Anything else is someone else's record.
 */
async function attachOwnRecord(msg, row, token, person, login, fail) {
  const { from, chat } = msg;
  const org = await store.orgBasics(row.org_id);
  const done = async () => {
    await store.voidPersonTokens(row.org_id, person.id);
    if (chat.type === 'private') await store.touchLink(login, { from, dmChatId: chat.id });
    console.info(`[telegram] person ${person.id} org ${row.org_id} attached to login ${login.user_id} (link ${login.id})`);
    await reply(msg, [
      `✅ <b>${bot.esc(person.full_name)}</b> in Team is you — you're already connected to <b>${bot.esc(org.name)}</b> here.`,
      '',
      `Reminders and follow-ups for tasks assigned to ${bot.esc(person.full_name)} will come to this chat.`,
    ].join('\n'));
    return 'done';
  };
  if (person.user_id === login.user_id) return done();

  const otherRecord = 'This Telegram account is already linked to a StartupBuddy login in this company, so it can\'t also be connected as a different team member. Use /unlink first, or open the invite from the right Telegram account.';
  if (person.user_id || row.created_by !== login.user_id) return fail(otherRecord);
  try {
    const me = await verifyPerson({ userId: login.user_id, orgId: row.org_id });
    if (!['owner', 'admin'].includes(me.membership.role)) return fail(otherRecord);
  } catch (err) {
    if (!(err instanceof ChannelAccessError)) throw err;
    return fail('Your StartupBuddy access to this company has changed, so I can\'t connect this. Ask an admin.', { keep: false });
  }
  try {
    const attached = await store.attachLogin(row.org_id, person.id, login.user_id);
    if (!attached) return fail(otherRecord, { keep: false });
  } catch (err) {
    if (err?.code !== '23505') throw err;
    return fail('Your StartupBuddy login is already attached to another person in Team. Open Connect Telegram on <b>your own</b> Team record instead, or detach the other one in Team first.');
  }
  return done();
}

async function connectGroup(msg, token, me) {
  const { from, chat } = msg;
  const row = await store.consumeToken(token, from.id);
  if (!row || row.purpose !== 'group') {
    if (row) await store.releaseToken(token);
    await reply(msg, 'That connect link has expired or was already used. Create a new one in <b>StartupBuddy → Settings → Telegram</b>.');
    return 'done';
  }
  const fail = async (html) => { await store.releaseToken(token); await reply(msg, html); return 'done'; };
  const link = await store.linkFor(from.id, row.org_id);
  // The admin who made the link must be the one using it, from their own linked Telegram.
  if (!link || link.user_id !== row.created_by) {
    return fail('Only the admin who created this connect link can use it, from a Telegram account linked to StartupBuddy (<b>Settings → Telegram → Link my Telegram</b>).');
  }
  try {
    await verifyPerson({ userId: link.user_id, orgId: row.org_id });
    await requireOrgRole(link.user_id, row.org_id, 'admin');
  } catch {
    return fail('Only an owner or admin of the company can connect a group.');
  }
  const settings = await store.orgSettings(row.org_id);
  if (!settings.enabled) return fail('Telegram is switched off for this company in StartupBuddy.');
  const existing = await store.chatFor(chat.id);
  if (existing && existing.org_id !== row.org_id) return fail('This group is already connected to another company. Disconnect it there first.');
  if (!existing) await store.connectChat({ orgId: row.org_id, chat, userId: link.user_id });
  const org = await store.orgBasics(row.org_id);
  console.info(`[telegram] group ${chat.id} connected to org ${row.org_id} by user ${link.user_id}`);
  await reply(msg, [
    `✅ This group is connected to <b>${bot.esc(org.name)}</b>.`,
    '',
    `Mention me (@${bot.esc(me.username)}) or reply to my messages to ask about tasks and projects. I only answer teammates whose Telegram is connected to StartupBuddy, with their own permissions, and I keep money, invoices and personal details out of the group.`,
  ].join('\n'));
  return 'done';
}

async function onMembership(member) {
  const chat = member.chat;
  const status = member.new_chat_member?.status;
  if (chat.type !== 'group' && chat.type !== 'supergroup') return 'ignored';
  if (status === 'left' || status === 'kicked') {
    const gone = await store.disconnectChat({ chatId: chat.id });
    if (gone.length) console.info(`[telegram] removed from group ${chat.id}; disconnected`);
    return 'done';
  }
  if ((status === 'member' || status === 'administrator') && !(await store.chatFor(chat.id))) {
    await bot.sendMessage(chat.id, 'Hi! To connect this group to your company, an owner or admin should use the <b>Connect a group</b> link from <b>StartupBuddy → Settings → Telegram</b>.').catch(() => null);
  }
  return 'done';
}

/* ── small commands ───────────────────────────────────────────────────────── */

function helpText(group, me) {
  const at = me?.username ? `@${bot.esc(me.username)}` : 'me';
  return group
    ? `I'm Buddy. In this group, mention ${at} or reply to me. I can answer about tasks, projects and who owns what, and prepare changes for you to confirm. For anything private, message me directly.`
    : [
      'I\'m Buddy — your StartupBuddy teammate. Just write normally:',
      '• What do I need to do today?',
      '• What\'s the deadline for the website?',
      '• Mark the homepage task as done',
      '• I finished the client proposal',
      '',
      'Commands: /me who you are linked as · /company switch company · /pulse off|on daily check-in · /new fresh start · /unlink',
    ].join('\n');
}

async function welcome(msg) {
  const id = await dmIdentity(msg.from, msg.chat.id);
  if (!id) { await reply(msg, `Hi! I'm Buddy, the AI teammate in StartupBuddy.\n\n${ONBOARD}`); return 'done'; }
  const org = await store.orgBasics(id.link.org_id);
  await reply(msg, `Hi again! You're working in <b>${bot.esc(org.name)}</b>. What do you need?`);
  return 'done';
}

async function whoAmI(msg) {
  const id = await dmIdentity(msg.from, msg.chat.id);
  if (!id) { await reply(msg, ONBOARD); return 'done'; }
  let who;
  try { who = await verifyLink(id.link, id.link.org_id); } catch (err) {
    if (!(err instanceof ChannelAccessError)) throw err;
    await reply(msg, bot.esc(await refused(err, id.link, id.link.org_id)));
    return 'done';
  }
  const [org, emp] = await Promise.all([
    store.orgBasics(id.link.org_id),
    who.kind === 'person' ? who.person : employeeOf(id.link.org_id, id.link.user_id),
  ]);
  const name = who.kind === 'person' ? who.name : personName(who.user, emp);
  const others = id.links.length - 1;
  await reply(msg, `You're <b>${bot.esc(name)}</b>${who.title ? ` (${bot.esc(who.title)})` : ''} at <b>${bot.esc(org.name)}</b>.${others ? `\nLinked to ${others} other compan${others === 1 ? 'y' : 'ies'} — /company to switch.` : ''}`);
  return 'done';
}

async function pickCompany(msg) {
  const links = await store.linksForTelegram(msg.from.id);
  if (!links.length) { await reply(msg, ONBOARD); return 'done'; }
  const names = await Promise.all(links.map(async (l) => ({ l, name: (await store.orgBasics(l.org_id)).name })));
  if (links.length === 1) { await reply(msg, `You're linked to one company: <b>${bot.esc(names[0].name)}</b>.`); return 'done'; }
  await reply(msg, 'Which company?', { buttons: names.map(({ l, name }) => [{ text: name.slice(0, 60), callback_data: `s:${l.org_id}` }]) });
  return 'done';
}

async function unlinkSelf(msg) {
  const id = await dmIdentity(msg.from, msg.chat.id);
  if (!id) { await reply(msg, 'This Telegram account isn\'t linked to StartupBuddy.'); return 'done'; }
  await store.revokeLink(id.link.id, 'self_unlink');
  await store.clearConversationsFor(msg.from.id, id.link.org_id);
  const org = await store.orgBasics(id.link.org_id);
  await reply(msg, `Unlinked from <b>${bot.esc(org.name)}</b>. You can link again any time from StartupBuddy → Settings → Telegram.`);
  return 'done';
}

async function pulseToggle(msg, arg) {
  const id = await dmIdentity(msg.from, msg.chat.id);
  if (!id) { await reply(msg, ONBOARD); return 'done'; }
  const off = /^(off|stop|no|pause)$/i.test(arg || '');
  const on = /^(on|start|yes|resume)$/i.test(arg || '');
  if (!off && !on) {
    await reply(msg, `Daily check-ins are <b>${id.link.pulse_opt_out ? 'off' : 'on'}</b> for you. Use /pulse off or /pulse on.`);
    return 'done';
  }
  await store.setPulseOptOut(id.link.id, off);
  await reply(msg, off ? 'Okay — no more daily check-ins from me. /pulse on to turn them back on.' : 'Daily check-ins are on. I\'ll ask how your day went.');
  return 'done';
}

async function resetConversation(msg) {
  const id = await dmIdentity(msg.from, msg.chat.id);
  if (!id) { await reply(msg, ONBOARD); return 'done'; }
  await store.saveConversation(msg.chat.id, msg.from.id, id.link.org_id, freshState(id.link.org_id));
  await reply(msg, 'Fresh start. What do you need?');
  return 'done';
}
