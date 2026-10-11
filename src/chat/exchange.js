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
