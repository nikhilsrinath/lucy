/**
 * What the top of the Buddy screen shows: { mood, word, tag }.
 * Loading is always "thinking"; an answered exchange shows the server's mood;
 * nothing asked yet, or something shown without a turn, is a quiet "thinking".
 */
export function stageFor({ persona, mood, streaming, empty }) {
    const thinking = (tag) => ({ mood: 'thinking', word: persona.headlines.thinking, tag });
    if (streaming) return thinking('Thinking');
    if (empty) return thinking('Ask me anything');
    if (!mood?.mood) return thinking('For you');
    return { mood: mood.mood, word: mood.headline_word || persona.headlines[mood.mood], tag: mood.tag };
}
