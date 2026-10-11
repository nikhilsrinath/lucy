import { legacyMood } from '../shared/cofounders/mood.js';

/**
 * What the top of the Buddy screen shows: { mood, word, tag }.
 * "thinking" is only for a reply that is loading (or a question the cofounder
 * is asking). An answered exchange shows the server's mood. With nothing asked
 * yet the cofounder reacts to today's brief: serious when something is
 * overdue or cash is negative, at rest otherwise.
 */
const needsAttention = (brief) => {
    const f = brief?.facts;
    if (!f) return false;
    return f.overdueCount > 0 || f.tasksOverdue > 0 || (f.netCash !== null && f.netCash < 0);
};

export function stageFor({ persona, mood, streaming, empty, brief = null }) {
    const as = (m, tag) => ({ mood: m, word: persona.headlines[m], tag });
    if (streaming) return as('thinking', 'Thinking');
    if (empty) return needsAttention(brief) ? as('serious', 'Needs attention') : as('neutral', 'Ask me anything');
    if (!mood?.mood) return as('neutral', 'For you');
    // An exchange stored before there were eight moods is shown under today's names.
    const now = legacyMood(mood);
    return { mood: now.mood, word: now.headline_word || persona.headlines[now.mood], tag: now.tag };
}
