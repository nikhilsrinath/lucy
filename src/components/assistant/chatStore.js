/* ══════════════════════════════════════════════════════════════════════════
   Where chats are kept, per company and per person (plan §5.7).

   Before: one global localStorage['edgeos.ai.chats'] — every org and every
   person on the browser saw the same list. Now each (org, user) has its own
   key, with the same data format.

   The old list is read once per (org, user) and never again for that pair:
     · a chat with cards moves only if the server confirms every one of its
       cards belongs to this org AND this user (mode:'status' returns only
       the caller's own cards in that org) — so attribution is exact;
     · a chat with no cards cannot be attributed. Those move once, to the
       first org the person opens after the upgrade (the app has always
       opened a person's first org), and are then marked claimed.
   The old key is left in place, untouched, so nothing is lost.
   ══════════════════════════════════════════════════════════════════════════ */

export const OLD_KEY = 'edgeos.ai.chats';
export const scopedKey = (orgId, userId) => `startupbuddy.chats.${orgId}.${userId}`;
export const migratedKey = (orgId, userId) => `startupbuddy.chats.migrated.${orgId}.${userId}`;
export const cardlessClaimedKey = (userId) => `startupbuddy.chats.cardless.${userId}`;

/** A stored list, cleaned the way the provider always cleaned it; null if absent or unreadable. */
export function readChats(key, storage = globalThis.localStorage) {
    try {
        const raw = JSON.parse(storage.getItem(key) || 'null');
        if (!Array.isArray(raw) || !raw.length) return null;
        return raw.map((c) => ({
            entities: [],
            ...c,
            messages: (c.messages || [])
                // The old in-browser cash card (before the agent) cannot be
                // acted on any more; its stored line says what it was.
                .map((m) => (m.kind === 'card' || m.kind === 'ask' ? { ...m, kind: undefined } : m))
                // A reply that was mid-stream when the tab closed will never
                // finish. Left empty it would render as a typing indicator.
                .map((m) => (
                    m.role === 'assistant' && !m.content && !m.kind
                        ? { ...m, content: 'This reply was interrupted.', error: true }
                        : m
                )),
        }));
    } catch {
        return null;
    }
}

const cardsOf = (chat) => (chat.messages || []).filter((m) => m.kind === 'action' && m.actionId).map((m) => m.actionId);

/** Every card id in these chats. */
export const cardIds = (chats) => [...new Set((chats || []).flatMap(cardsOf))];

/**
 * The old chats that move into this (org, user).
 * @param {object[]} old
 * @param {Set<string>} verified  card ids the server confirmed as this user's in this org
 * @param {boolean} takeCardless  whether the cardless chats are still unclaimed
 */
export function selectMigratable(old, verified, takeCardless) {
    return (old || []).filter((c) => {
        if (!c.messages?.length) return false;
        const ids = cardsOf(c);
        return ids.length ? ids.every((id) => verified.has(id)) : takeCardless;
    });
}

/** `incoming` added after `current`'s chats, skipping ids already there.
 *  Blank chats are dropped, except `keepId` (the one on screen). */
export function mergeChats(current, incoming, keepId = null) {
    const have = new Set(current.map((c) => c.id));
    const add = incoming.filter((c) => !have.has(c.id));
    if (!add.length) return current;
    const base = current.filter((c) => c.messages.length || c.titled || c.id === keepId);
    return [...base, ...add].sort((a, b) => (b.at || 0) - (a.at || 0));
}
