import { MOODS } from './parse.js';
import { usableSituations, cardSituation, fromSource, detectCue } from './detect.js';
import { readMood } from './reading.js';

/**
 * The mood of a reply: one of eight faces.
 *
 *   calm   neutral · thinking · explaining
 *   warm   happy · serious
 *   peak   surprised · disappointed · laughing
 *
 * The server decides, from what the turn produced and what was asked. The
 * first of these that applies wins (`by` names it):
 *
 *   failure    the turn failed                       → disappointed
 *   question   a detail or a choice was asked for    → thinking
 *   outcome    a card was carried out, or is waiting → its situation's mood
 *   source     an insight started the turn           → its situation's mood
 *   reading    the answer's figures (reading.js)     → their verdict
 *   keywords   the words match a situation           → its mood
 *   cue        a laugh, "explain…" in the message    → the cue's mood
 *   model      the model's [[mood:…]] marker         → a calm or warm mood only
 *   shape      a view was shown, or steps listed     → explaining
 *   default                                          → neutral
 *
 * Figures outrank words: "any overdue invoices?" with none overdue is happy.
 * A peak mood needs a rule, never the model alone, and one that rests on
 * words alone is not shown twice running (it steps down a tier).
 */

export const DEFAULT_MOOD = 'neutral';
export const DEFAULT_TAG = 'Here you go';
export const DEFAULT_TAGS = {
  neutral: DEFAULT_TAG, thinking: 'Needs info', explaining: "Here's how", happy: 'Good news',
  serious: 'Needs attention', surprised: 'Unexpected', disappointed: "Didn't work", laughing: 'Big win',
};
/** What the model's marker may ask for. "thinking" and the peak moods are the server's alone. */
export const SUGGESTABLE = ['neutral', 'happy', 'explaining', 'serious'];
export const STEP_DOWN = { laughing: 'happy', surprised: 'explaining', disappointed: 'serious' };
const CUE_TAGS = { laughing: 'Good one' };
const WORDS_ALONE = ['keywords', 'cue'];

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

/** Two or more lines that open like a step: "1.", "-", "•". */
const hasSteps = (reply) => (String(reply || '').match(/^\s*(?:\d+[.)]|[-•*])\s+\S/gm) || []).length >= 2;

/**
 * `turn` is what is known when a reply ends:
 *   { outcome: { failed, asked, cards: [{ tool, args, status, risk }], viewed, reply },
 *     detected, source, message, suggested, readings, prevMood, audience }
 * `core` is the parsed situations file: { situations, cues, metrics }.
 * Returns { mood, tag, by, situation }.
 */
export function decideMood(turn = {}, core = {}) {
  const { outcome = {}, detected = null, source = null, message = '', suggested = null, readings = [], prevMood = null, audience = 'private' } = turn;
  const usable = usableSituations(core.situations || [], audience);
  const find = (id) => usable.find((s) => s.id === id) || null;
  const of = (s, by) => ({ mood: s.mood, tag: s.tag || DEFAULT_TAGS[s.mood], by, situation: s.id });
  const plain = (mood, by, tag = DEFAULT_TAGS[mood]) => ({ mood, tag, by, situation: null });
  const found = find(detected);

  const pick = () => {
    if (outcome.failed) return plain('disappointed', 'failure');
    if (outcome.asked) {
      const s = find(outcome.asked === 'choice' ? 'quick_pick' : 'missing_info');
      return s ? of(s, 'question') : plain('thinking', 'question');
    }
    const cards = outcome.cards || [];
    for (const card of cards) {
      const s = cardSituation(card, usable);
      if (s) return of(s, 'outcome');
    }
    const waiting = cards.find((c) => c.status !== 'executed');
    if (waiting) {
      if (found) return of(found, 'outcome');
      return waiting.risk && waiting.risk !== 'low' ? plain('serious', 'outcome', 'Check this') : plain('neutral', 'outcome', 'Ready for you');
    }
    if (found && fromSource(found, source)) return of(found, 'source');
    const read = readMood(message, readings, core.metrics || [], audience);
    if (read) return { mood: read.mood, tag: read.tag, by: 'reading', situation: found?.id || null };
    if (found) return of(found, 'keywords');
    const cue = detectCue(message, core.cues || []);
    if (cue) return plain(cue.mood, 'cue', CUE_TAGS[cue.mood]);
    if (SUGGESTABLE.includes(suggested)) return plain(suggested, 'model');
    if (outcome.viewed) return plain('explaining', 'shape', 'Take a look');
    if (hasSteps(outcome.reply)) return plain('explaining', 'shape');
    return plain(DEFAULT_MOOD, 'default');
  };

  const out = pick();
  // The same peak twice running, on words alone, steps down a tier. The tag stays.
  if (prevMood && out.mood === prevMood && STEP_DOWN[out.mood] && WORDS_ALONE.includes(out.by)) out.mood = STEP_DOWN[out.mood];
  return out;
}

/** What the screen shows above the answer: { mood, headline_word, tag, situation }. */
export function moodFor(cofounder, turn = {}, core = {}) {
  const { mood, tag, situation } = decideMood(turn, core);
  return { mood, headline_word: cofounder?.headlines?.[mood] || '', tag, situation };
}

/* ── moods stored before there were eight ──────────────────────────────── */

const RENAMED = { warning: 'serious', win: 'happy', celebrate: 'laughing' };
// What an ordinary answer was stored as, when the resting mood was "win" and, before that, "thinking".
const wasDefault = (m) => (m.mood === 'win' && m.tag === 'Here you go') || (m.mood === 'thinking' && m.tag === 'Thinking it through');

/** A stored mood event under today's names. The headline word is dropped when the mood changes. */
export function legacyMood(stored) {
  if (!stored?.mood) return stored || null;
  if (wasDefault(stored)) return { ...stored, mood: DEFAULT_MOOD, tag: DEFAULT_TAG, headline_word: '' };
  if (RENAMED[stored.mood]) return { ...stored, mood: RENAMED[stored.mood], headline_word: '' };
  return MOODS.includes(stored.mood) ? stored : { ...stored, mood: DEFAULT_MOOD, headline_word: '' };
}
