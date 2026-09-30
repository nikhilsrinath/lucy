import { timingSafeEqual } from 'node:crypto';

/**
 * The Telegram Bot API, and nothing else: no company, no person, no Buddy.
 *
 * The bot token and the webhook secret live only in the server environment
 * (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET). Nothing here returns either,
 * and errors are logged without the request URL, which contains the token.
 *
 * Rate limits: Telegram answers 429 with parameters.retry_after. A short wait
 * (≤ 5 s) is retried once; anything longer gives up rather than hold a
 * serverless function open — the caller treats it as a failed send.
 */

const API = 'https://api.telegram.org';
const MAX_TEXT = 4096;

export const botToken = () => process.env.TELEGRAM_BOT_TOKEN || '';
export const isConfigured = () => /^\d+:[\w-]{30,}$/.test(botToken());

export class TelegramError extends Error {
  constructor(method, status, description) {
    super(`Telegram ${method} failed (${status}): ${description || 'unknown error'}`);
    this.status = status;
    this.description = description || '';
  }
}

export async function call(method, params = {}, { fetchImpl = fetch, retry = true } = {}) {
  if (!isConfigured()) throw new TelegramError(method, 0, 'TELEGRAM_BOT_TOKEN is not set');
  let res;
  try {
    res = await fetchImpl(`${API}/bot${botToken()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch (err) {
    throw new TelegramError(method, 0, err?.message || 'network error');
  }
  const json = await res.json().catch(() => ({}));
  if (json.ok) return json.result;
  const wait = Number(json.parameters?.retry_after);
  if (res.status === 429 && retry && wait > 0 && wait <= 5) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    return call(method, params, { fetchImpl, retry: false });
  }
  throw new TelegramError(method, res.status, json.description);
}

/** Webhook authenticity: Telegram echoes the secret set with setWebhook in this header. */
export function verifyWebhookSecret(req) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  const got = req.headers?.['x-telegram-bot-api-secret-token'] || '';
  if (!expected || expected.length < 16 || typeof got !== 'string' || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

let me = null;
/** The bot's own identity ({ id, username }), cached per warm instance. */
export async function getMe() {
  if (me) return me;
  const fromEnv = process.env.TELEGRAM_BOT_USERNAME;
  const r = await call('getMe');
  me = { id: r.id, username: fromEnv || r.username };
  return me;
}

/* ── messages ─────────────────────────────────────────────────────────────── */

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

export function sendMessage(chatId, html, { buttons = null, replyTo = null } = {}) {
  return call('sendMessage', {
    chat_id: chatId,
    text: clip(html),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  });
}

export async function editMessage(chatId, messageId, html, { buttons = null } = {}) {
  try {
    return await call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: clip(html),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buttons || [] },
    });
  } catch (err) {
    // Editing to identical content is not a failure worth surfacing.
    if (/message is not modified/i.test(err?.description || '')) return null;
    throw err;
  }
}

export const clearButtons = (chatId, messageId) =>
  call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => null);

export const answerCallback = (id, text = '', { alert = false } = {}) =>
  call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text: text.slice(0, 190), show_alert: alert } : {}) }).catch(() => null);

export const typing = (chatId) => call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => null);

/* ── formatting ───────────────────────────────────────────────────────────── */

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Buddy's replies are light Markdown (**bold**, *italic*, `code`, "- " lists).
 * Telegram gets them as HTML — escaped first, then only those marks mapped,
 * so nothing in a record's text can inject markup.
 */
export function mdToHtml(md) {
  return esc(md)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ');
}
