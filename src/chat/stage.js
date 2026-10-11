/**
 * What the top of the Buddy screen shows: { mood, word, tag }.
 * "thinking" is only for a reply that is loading (or a question the cofounder
 * is asking). An answered exchange shows the server's mood. With nothing asked
 * yet the cofounder reacts to today's brief: a warning when something is
 * overdue or cash is negative, pleased otherwise.
 */
const needsAttention = (brief) => {
    const f = brief?.facts;
    if (!f) return false;
    return f.overdueCount > 0 || f.tasksOverdue > 0 || (f.netCash !== null && f.netCash < 0);
};

// What an ordinary answer was stored as before the default mood became "win".
const oldDefault = (mood) => mood.mood === 'thinking' && mood.tag === 'Thinking it through';

export function stageFor({ persona, mood, streaming, empty, brief = null }) {
    const as = (m, tag) => ({ mood: m, word: persona.headlines[m], tag });
    if (streaming) return as('thinking', 'Thinking');
    if (empty) return needsAttention(brief) ? as('warning', 'Needs attention') : as('win', 'Ask me anything');
    if (!mood?.mood) return as('win', 'For you');
    if (oldDefault(mood)) return as('win', 'Here you go');
    return { mood: mood.mood, word: mood.headline_word || persona.headlines[mood.mood], tag: mood.tag };
}
