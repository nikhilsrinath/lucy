import { randomBytes } from 'node:crypto';

/**
 * One person's short-term context in one Telegram chat — the server-side
 * twin of what the web client keeps per chat in the browser
 * (AssistantContext.jsx): the recent words, the records in play, the open
 * question, the cards shown and what became of them. Built into the same
 * request body the web client sends, so Buddy reads a Telegram turn exactly
 * like a web one.
 *
 * Context never grants anything: record ids in it are only pointers that
 * Buddy's tools re-load through the person's own token (an id for a record
 * they cannot see resolves to nothing), and cards are re-loaded by id and
 * owner on every tap. A conversation is keyed by chat AND Telegram user, so
 * two people in one group never share context, and it is tied to the company
 * it was built in — switching company starts it afresh.
 */

export const STALE_MS = 12 * 60 * 60 * 1000;
const MAX_HISTORY = 16;
const MAX_ENTITIES = 10;
const MAX_CARDS = 12;

export function freshState(orgId) {
  return { org_id: orgId, at: Date.now(), history: [], entities: [], pending: null, offers: null, cards: [], pulse: null };
}

/** The stored state, or a fresh one if it is for another company or has gone stale. */
export function currentState(row, orgId) {
  const s = row?.state;
  if (!s || s.org_id !== orgId) return freshState(orgId);
  if (Date.now() - (s.at || 0) > STALE_MS) {
    // Old words and questions no longer help; cards are kept so a late tap still resolves.
    return { ...freshState(orgId), cards: (s.cards || []).slice(-MAX_CARDS), pulse: s.pulse || null };
  }
  return { ...freshState(orgId), ...s };
}

export const chatKey = (chatId) => `tg:${chatId}`;
export const nonce = () => randomBytes(4).toString('hex');

/** The /api/agent-shaped body for this turn. */
export function requestBody(state, { chatId, messageId, audience, source = null }) {
  const now = Date.now();
  const live = (c) => c.status === 'proposed' && (!c.expires_at || Date.parse(c.expires_at) > now);
  return {
    channel: 'telegram',
    audience,
    chat_id: chatKey(chatId),
    message_id: String(messageId),
    history: state.history,
    pending: state.pending || undefined,
    context: {
      recentEntities: state.entities,
      openCards: state.cards.filter(live).slice(-5)
        .map((c) => ({ action_id: c.action_id, title: c.title, risk: c.kind === 'plan' ? 'high' : c.risk })),
      recentActions: state.cards.filter((c) => !live(c) && c.status !== 'confirmed').slice(-6)
        .map((c) => ({ action_id: c.action_id, tool: c.tool, title: c.title, status: c.status === 'proposed' ? 'expired' : c.status, summary: c.summary || c.error || '' })),
      source: source || undefined,
    },
  };
}

/* ── after a turn ─────────────────────────────────────────────────────────── */

export function pushHistory(state, role, content) {
  const text = String(content || '').trim();
  if (!text) return;
  state.history = [...state.history, { role, content: text.slice(0, 2000) }].slice(-MAX_HISTORY);
}

export function remember(state, entities, turn) {
  if (!entities?.length) return;
  const fresh = entities.map((e) => ({ type: e.type, id: e.id, label: e.label, turn }));
  const rest = state.entities.filter((e) => !fresh.some((f) => f.id === e.id));
  state.entities = [...fresh, ...rest].slice(0, MAX_ENTITIES);
}

/** Records a card (new or changed) and the Telegram message showing it. */
export function trackCard(state, card, messageId = null) {
  const prev = state.cards.find((c) => c.action_id === card.action_id);
  const entry = {
    action_id: card.action_id,
    title: card.title,
    tool: card.tool,
    kind: card.kind,
    risk: card.risk,
    status: card.status,
    expires_at: card.expires_at || null,
    summary: card.summary || null,
    error: card.error || null,
    message_id: messageId || prev?.message_id || null,
  };
  state.cards = [...state.cards.filter((c) => c.action_id !== card.action_id), entry].slice(-MAX_CARDS);
  return entry;
}

/** A card as one line of history — what the model reads back (cardText.js on the web). */
export function cardLine(card) {
  if (!card) return '';
  if (card.kind === 'plan') {
    const n = (card.steps || []).length;
    if (card.status === 'executed') return card.summary || `Plan done: ${card.title}.`;
    if (card.status === 'proposed') return `Proposed plan: ${card.title} (${n} steps). Not done until approved.`;
    return `Plan ${card.status}: ${card.title}.`;
  }
  if (card.status === 'executed') return card.summary || 'Done.';
  if (card.status === 'undone') return `Undone: ${card.title}.`;
  if (card.status === 'cancelled') return `Cancelled: ${card.title}. Nothing was changed.`;
  if (card.status === 'expired') return `Expired: ${card.title}. Nothing was changed.`;
  if (card.status === 'failed') return `Failed: ${card.title}. ${card.error || ''}`.trim();
  const diff = (card.diff || []).map((d) => `${d.label} ${d.from} → ${d.to}`).join('; ');
  return `Proposed: ${card.title}${card.target ? ` — ${card.target.label}` : ''}${diff ? ` (${diff})` : ''}. Not done until confirmed.`;
}
