import { MOODS } from './parse.js';

/**
 * The mood of a reply: warning, win, thinking or celebrate.
 *
 * The server decides. A detected situation fixes the mood
 * (cofounders/_core/situations.md); the model may suggest one with a
 * [[mood:…]] marker, which is used only when no rule applies.
 */

export const DEFAULT_MOOD = 'thinking';
export const DEFAULT_TAGS = { warning: 'Needs attention', win: 'Good news', thinking: 'Thinking it through', celebrate: 'Big win' };

const MARKER = /\[\[mood:([a-z]+)\]\]/gi;

/** Strips the model's mood marker from its words. Returns { text, suggested }. */
export function takeMood(text) {
  let suggested = null;
  const clean = String(text || '').replace(MARKER, (_, m) => {
    const mood = m.toLowerCase();
    if (!suggested && MOODS.includes(mood)) suggested = mood;
    return '';
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: clean, suggested };
}

/** The server's rule first, the model's suggestion second, the default last. */
export function decideMood({ situation = null, suggested = null } = {}, situations = []) {
  const s = situation ? situations.find((x) => x.id === situation) : null;
  if (s) return { mood: s.mood, tag: s.tag || DEFAULT_TAGS[s.mood], by: 'rule' };
  if (MOODS.includes(suggested)) return { mood: suggested, tag: DEFAULT_TAGS[suggested], by: 'model' };
  return { mood: DEFAULT_MOOD, tag: DEFAULT_TAGS[DEFAULT_MOOD], by: 'default' };
}

/** What the screen shows above the answer: { mood, headline_word, tag, situation }. */
export function moodFor(cofounder, { situation = null, suggested = null } = {}, situations = []) {
  const { mood, tag } = decideMood({ situation, suggested }, situations);
  return { mood, headline_word: cofounder?.headlines?.[mood] || '', tag, situation: situation || null };
}
