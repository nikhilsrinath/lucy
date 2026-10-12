/* The one exchange the chat screen shows: the person's question and what the
   cofounder answered with. Pure, so the "only one exchange" rule is tested
   without a browser. */

/**
 * The current exchange out of a list of messages: the LAST question and
 * everything after it. The store only ever holds one (AssistantContext), but
 * the screen does not rely on that — whatever it is handed, it shows one.
 * With no question at all (a call summary, a slash command's result) the
 * items stand alone.
 */
export function currentExchange(messages = []) {
    let at = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { at = i; break; }
    }
    return {
        question: at >= 0 ? messages[at] : null,
        items: (at >= 0 ? messages.slice(at + 1) : messages).filter((m) => m.role !== 'user'),
    };
}

const optionsOf = (m) => m.choice?.options || m.input?.options || [];

/**
 * What in the exchange is waiting for the person to choose, if anything: a
 * card still open (or being carried out), or a question with quick picks.
 * This is what the decision dialog shows. A card whose time has run out is
 * not a decision any more. The last one wins: a re-previewed card replaces
 * the one it was made from.
 */
export function pendingDecision(items = [], { streaming = false, now = Date.now() } = {}) {
    for (let i = items.length - 1; i >= 0; i--) {
        const m = items[i];
        if (m.kind === 'action' && m.card) {
            const { status, expires_at } = m.card;
            const lapsed = !!expires_at && Math.round((Date.parse(expires_at) - now) / 60000) <= 0;
            if (status === 'executing' || status === 'confirmed' || (status === 'proposed' && !lapsed)) return m;
        }
        if (!streaming && (m.kind === 'choice' || m.kind === 'input') && optionsOf(m).length) return m;
    }
    return null;
}

/** What a decision is called: on the panel's button and as the dialog's name. */
export const decisionTitle = (m) => (m.kind === 'action'
    ? (m.card.kind === 'plan' ? m.card.goal || m.card.title : m.card.title)
    : m.choice?.question || m.content);

/**
 * The exchange as the response shape the product defines:
 *   { mood, headline_word, tag, answer, card?, picks? }
 * `mood` is the server's mood event for the turn (null while it is loading).
 */
export function exchangeResponse(messages = [], mood = null) {
    const { items } = currentExchange(messages);
    const answer = items.filter((m) => !m.kind && !m.error && m.content).map((m) => m.content).join('\n\n');
    const card = items.find((m) => m.kind === 'action' && m.card)?.card;
    const ask = items.find((m) => m.kind === 'input' || m.kind === 'choice');
    const picks = (ask?.input?.options || ask?.choice?.options || []).map((o) => o.label);
    return {
        mood: mood?.mood || null,
        headline_word: mood?.headline_word || '',
        tag: mood?.tag || '',
        answer: answer || ask?.content || '',
        ...(card ? { card } : {}),
        ...(picks.length ? { picks } : {}),
    };
}
