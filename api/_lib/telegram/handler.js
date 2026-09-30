import * as bot from './bot.js';
import * as store from './store.js';
import * as buddy from '../agent/buddy.js';
import { openChannelSession, verifyPerson, ChannelAccessError } from '../agent/channelSession.js';
import { supabaseAdmin } from '../supabaseAdmin.js';
import { requireOrgRole } from '../auth.js';
import { bumpAiUsage, logAiUsage } from '../aiUsage.js';
import { AGENT_MODEL, newUsage, describeUsage } from '../agent/model.js';
import * as pulse from '../agent/pulse.js';
import {
  currentState, freshState, requestBody, pushHistory, remember, trackCard, cardLine, nonce, chatKey,
} from './conversation.js';
import { renderCard, renderView, renderOptions, renderNotice, renderNavigate } from './render.js';

/**
 * One Telegram update, start to finish. The Telegram half of the adapter:
 *
 *   identify   update → Telegram user + chat → (group mapping | DM choice)
 *              → the company → that person's live link → verifyPerson
 *              (account, membership, revoked login) — on every update
 *   translate  a message becomes the same request body the web client sends
 *              (conversation.js), a button becomes the same confirm / cancel
 *              / undo / retry / resume call the web card makes
 *   render     Buddy's events become messages and buttons (render.js)
 *
 * Everything that decides anything — intent, tools, permissions, proposals,
 * approval, execution, audit, undo — is Buddy's (api/_lib/agent/buddy.js),
 * running as the person with their own database identity.
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
const ONBOARD = 'To talk to me here, link your StartupBuddy account: open <b>StartupBuddy → Settings → Telegram</b> and tap <b>Link my Telegram</b>, or ask your admin for an invite link.';
const ENDED = 'Your StartupBuddy access to this company has ended, so I can\'t act for you here anymore. If that\'s a mistake, ask your admin.';
const noBuddy = (role) => `Your role in StartupBuddy${role ? ` (${role})` : ''} doesn't include Buddy, so I can't help you here yet. Ask your admin to change your role.`;

/**
 * A refused channel identity: when access has really ended the link is
 * revoked and its conversations cleared; a role without Buddy keeps the link.
 * Returns the sentence to show.
 */
async function refused(err, link, orgId) {
  console.warn(`[telegram] link ${link.id} refused: ${err.reason}`);
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

async function employeeOf(orgId, userId) {
  const { data } = await supabaseAdmin().from('employees').select('id, full_name').eq('org_id', orgId).eq('user_id', userId).maybeSingle();
  return data || null;
}

/**
 * Opens Buddy as the linked person, or explains why not. A person whose
 * StartupBuddy access ended has the link revoked here, at first contact.
 */
async function session(link, orgId, body, { chatId, cb = null }) {
  try {
    return await openChannelSession({ userId: link.user_id, orgId, channel: 'telegram', body });
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
  const link = await store.linkFor(msg.from.id, chatRow.org_id);
  if (!link) {
    await reply(msg, 'I don\'t know you yet. Message me privately to link your StartupBuddy account first.',
      { buttons: me.username ? [[{ text: 'Message Buddy', url: `https://t.me/${me.username}` }]] : null });
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

async function buddyTurn({ msg, text, audience, link, orgId, conv }) {
  const { chat, from } = msg;
  const settings = await store.orgSettings(orgId);
  if (!settings.enabled) { await reply(msg, 'Telegram is switched off for this company in StartupBuddy.'); return 'done'; }

  const state = currentState(conv, orgId);
  let checkin = null;
  // A check-in stays open for follow-up messages for a while after the first
  // answer ("oh, and…"); after that, messages are ordinary questions again.
  if (state.pulse?.answered_at && Date.now() - state.pulse.answered_at > PULSE_FOLLOW_UP_MS) state.pulse = null;
  if (audience === 'private' && state.pulse?.id) {
    checkin = await pulse.openCheckin({ id: state.pulse.id, orgId, userId: link.user_id }).catch(() => null);
    if (!checkin) state.pulse = null;
  }
  const messageId = `tg${msg.message_id}`;
  const body = requestBody(state, { chatId: chat.id, messageId, audience, source: checkin ? `pulse:${checkin.id}` : null });
  const ctx = await session(link, orgId, body, { chatId: chat.id });
  if (!ctx) return 'done';
  await store.touchLink(link, { from, dmChatId: audience === 'private' ? chat.id : null });

  // Metered exactly like a web message, before the model is called.
  const used = await bumpAiUsage(orgId, 'telegram');
  if (used > ctx.aiLimit) {
    await logAiUsage({ orgId, user: ctx.user, surface: 'copilot', outcome: 'blocked' });
    await reply(msg, bot.esc(`Your plan's AI message limit (${ctx.aiLimit}) has been reached.`));
    return 'done';
  }

  await bot.typing(chat.id);
  const events = [];
  const emit = (event, data) => { events.push({ event, data }); if (event === 'status') bot.typing(chat.id); };
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
        const m = await send(renderCard(data.card));
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
async function showCard(chatId, state, card, messageId = null) {
  const r = renderCard(card);
  const mid = messageId || state.cards.find((c) => c.action_id === card.action_id)?.message_id;
  if (mid) {
    try { await bot.editMessage(chatId, mid, r.html, { buttons: r.buttons }); trackCard(state, card, mid); return; } catch { /* sent afresh below */ }
  }
  const m = await bot.sendMessage(chatId, r.html, { buttons: r.buttons });
  trackCard(state, card, m?.message_id);
}

/* ── buttons ──────────────────────────────────────────────────────────────── */

async function onCallback(cb) {
  const chat = cb.message?.chat;
  if (!chat) { await bot.answerCallback(cb.id); return 'ignored'; }
  if (await overLimit(cb.from, null)) { await bot.answerCallback(cb.id, 'Slow down a little — try again in a minute.'); return 'ignored'; }
  const data = String(cb.data || '');
  let m;
  if ((m = /^a:([cxur]):([0-9a-f-]{36})$/i.exec(data))) return onCardButton(cb, m[1], m[2]);
  if ((m = /^k:([0-9a-f]{8}):(\d{1,2})$/.exec(data))) return onOption(cb, m[1], Number(m[2]));
  if ((m = /^s:([0-9a-f-]{36})$/i.exec(data)) && chat.type === 'private') return onSwitch(cb, m[1]);
  await bot.answerCallback(cb.id, 'That button is no longer active.');
  return 'ignored';
}

async function onCardButton(cb, op, actionId) {
  const chat = cb.message.chat;
  const group = chat.type !== 'private';
  // Only to learn which company to check; buddy.* reload it by id AND owner.
  const { data: row } = await supabaseAdmin().from('ai_actions').select('id, org_id, user_id, risk, kind, tool').eq('id', actionId).maybeSingle();
  if (!row) { await bot.answerCallback(cb.id, 'That change is no longer available.'); return 'done'; }
  const link = await store.linkFor(cb.from.id, row.org_id);
  if (!link || link.user_id !== row.user_id) {
    await bot.answerCallback(cb.id, 'Only the person who asked for this can use these buttons.', { alert: true });
    return 'done';
  }
  if (group) {
    const chatRow = await store.chatFor(chat.id);
    if (!chatRow || chatRow.org_id !== row.org_id) { await bot.answerCallback(cb.id, 'That change is not available here.'); return 'done'; }
  }
  // Never from Telegram, whatever the button said: high risk is approved in the app.
  if (op === 'c' && row.risk !== 'low') {
    await bot.answerCallback(cb.id, 'This needs your approval in StartupBuddy — use "Review in StartupBuddy".', { alert: true });
    return 'done';
  }
  const settings = await store.orgSettings(row.org_id);
  if (!settings.enabled) { await bot.answerCallback(cb.id, 'Telegram is switched off for this company.', { alert: true }); return 'done'; }

  const conv = await store.loadConversation(chat.id, cb.from.id);
  const state = currentState(conv?.org_id === row.org_id ? conv : null, row.org_id);
  const body = requestBody(state, { chatId: chat.id, messageId: `cb${cb.message.message_id}`, audience: group ? 'shared' : 'private' });
  const ctx = await session(link, row.org_id, body, { chatId: chat.id, cb });
  if (!ctx) return 'done';
  await bot.answerCallback(cb.id, op === 'c' ? 'Working on it…' : '');

  const mid = cb.message.message_id;
  const say = (html) => bot.sendMessage(chat.id, html, { replyTo: group ? mid : null });
  let res;
  if (op === 'c') {
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
  const ctx = await session(link, orgId, body, { chatId: chat.id, cb });
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
  try { await verifyPerson({ userId: link.user_id, orgId }); } catch (err) {
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
  if (!row) { await reply(msg, 'That link has expired or was already used. Create a new one in <b>StartupBuddy → Settings → Telegram</b>.'); return 'done'; }
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
    `Mention me (@${bot.esc(me.username)}) or reply to my messages to ask about tasks and projects. I only answer teammates who have linked their StartupBuddy account, with their own permissions, and I keep money, invoices and personal details out of the group.`,
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
  let person;
  try { person = await verifyPerson({ userId: id.link.user_id, orgId: id.link.org_id }); } catch (err) {
    if (!(err instanceof ChannelAccessError)) throw err;
    await reply(msg, bot.esc(await refused(err, id.link, id.link.org_id)));
    return 'done';
  }
  const [org, emp] = await Promise.all([store.orgBasics(id.link.org_id), employeeOf(id.link.org_id, id.link.user_id)]);
  const others = id.links.length - 1;
  await reply(msg, `You're <b>${bot.esc(personName(person.user, emp))}</b> (${bot.esc(person.membership.role)}) at <b>${bot.esc(org.name)}</b>.${others ? `\nLinked to ${others} other compan${others === 1 ? 'y' : 'ies'} — /company to switch.` : ''}`);
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
