/**
 * Text normalisation for the local understanding engine.
 *
 * Everything here is a pure function of the message: no model, no database.
 * It makes messages comparable ("Whats ovrdue??" and "what is overdue") without
 * changing what they say. Three things are never normalised away:
 *
 *   negation      "don't", "not", "never", "without" survive as words, so
 *                 "show unpaid invoices" and "don't show unpaid invoices" can
 *                 never read alike (understand.js decides what they mean);
 *   uncertainty   "maybe", "I think", "should we" are flagged, and a flagged
 *                 message is never turned into a change;
 *   names         a capitalised word in mid-sentence is somebody's name and is
 *                 not spell-corrected into a word we happen to know.
 */

import { ACTS, THINGS } from './acts.js';

const CONTRACTIONS = [
  [/\bwon['’]?t\b/gi, 'will not'],
  [/\bcan['’]?t\b/gi, 'can not'],
  [/\bcannot\b/gi, 'can not'],
  [/\bain['’]?t\b/gi, 'is not'],
  [/\b(do|does|did|have|has|had|is|are|was|were|should|would|could|must)n['’]?t\b/gi, '$1 not'],
  [/\b(what|who|where|when|how|that|there|here|he|she)['’]s\b/gi, '$1 is'],
  [/\b(what|how|where|who)s\b/gi, '$1 is'],
  [/\bit['’]s\b/gi, 'it is'],
  [/\bi['’]m\b/gi, 'i am'],
  [/\b(i|we|you|they)['’]ve\b/gi, '$1 have'],
  [/\b(i|we|you|they|he|she|it)['’]d\b/gi, '$1 would'],
  [/\b(i|we|you|they|he|she|it)['’]ll\b/gi, '$1 will'],
  [/\b(we|you|they)['’]re\b/gi, '$1 are'],
  [/\blet['’]?s\b/gi, 'let us'],
  [/\bgonna\b/gi, 'going to'],
  [/\bwanna\b/gi, 'want to'],
  [/\bgimme\b/gi, 'give me'],
  [/\b(?:u)\b/gi, 'you'],
  [/\b(?:wat|wht)\b/gi, 'what'],
  [/\bwats\b/gi, 'what is'],
  [/\b(?:hw)\b/gi, 'how'],
  [/\b(?:r)\b(?=\s+(?:there|we|they|you)\b)/gi, 'are'],
];

// Said before the request and carrying none of it. Applied repeatedly.
const LEAD_FILLERS = [
  /^(?:hey|hi|hello|yo|hiya)\b(?:\s+(?:there|buddy|steve|elon|mark|team))?[\s,!.:-]+(?=\S)/i,
  /^(?:buddy|steve|elon|mark)\s*[,:]\s*(?=\S)/i,
  /^(?:no|nope|nah|yes|yeah|yep|ok|okay|alright|right|great|cool|thanks|thank you)\s*[,.!]\s*(?=\S)/i,
  /^(?:so|well|ok|okay|alright|um+|uh+|hmm+|btw|by the way|actually|basically|quick question|one more thing|one thing)\b[\s,:-]*(?=\S)/i,
  /^(?:please|pls|plz|kindly)\b[\s,]*(?=\S)/i,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+|pls\s+|kindly\s+|just\s+|quickly\s+|also\s+)*(?=\S)/i,
  /^(?:i|we)\s+(?:want|need|would like|wish)\s+(?:you\s+)?to\s+(?=\S)/i,
  /^(?:i|we)\s+(?:want|need|would like)\s+(?=(?:a|an|the|my|our|all|some)\b)/i,
  /^i\s+was\s+wondering\s+(?:if\s+you\s+could\s+|whether\s+you\s+could\s+)?(?=\S)/i,
  /^do\s+you\s+(?:know|mind telling me|mind showing me)\s+(?=\S)/i,
  /^(?:go ahead and|just|quickly|now)\s+(?=\S)/i,
  /^(?:do not|never)\s+forget\s+to\s+(?=\S)/i,
  /^remember\s+to\s+(?=\S)/i,
  /^let\s+us\s+(?=\S)/i,
];

const TAIL_FILLER = /(?:[\s,]*\b(?:please|pls|plz|thanks|thank you|thx|ty|asap|if you can|if possible|when you can|buddy|real quick|quickly|right away))+[\s?.!]*$/i;

const UNCERTAIN = /\b(?:maybe|perhaps|possibly|probably|i think|i guess|i suppose|not sure|unsure|might|should (?:i|we)|shall (?:i|we)|do you think|what if|wondering (?:if|whether)|considering|thinking (?:of|about))\b/i;

const QUESTION_OPENER = /^(?:who|whom|whose|what|which|when|where|why|how|is|are|was|were|do|does|did|has|have|had|can|could|will|would|should|any|am)\b/i;

/** Damerau–Levenshtein (optimal string alignment), capped at `cap`. */
export function editDistance(a, b, cap = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) >= cap) return cap;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i][0] = i;
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    let rowMin = cap;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin >= cap) return cap;
  }
  return Math.min(cap, d[a.length][b.length]);
}

/**
 * Light stemming, applied to the lexicon and the message alike, so "invoices",
 * "owes" and "companies" meet their singular forms. Not linguistics — only
 * consistency.
 */
export function stem(w) {
  if (w.length <= 3) return w;
  if (/(?:ss|us|is)$/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

/**
 * The nearest known word to a misspelt one, or null.
 *
 * Deliberately timid, because a correction that lands on the wrong word turns
 * one request into another. The word must be at least four letters, start
 * with the same letter, and have exactly one nearest neighbour. Short words
 * sit close together ("stage" is one letter from "stale"), so four- and
 * five-letter words are only corrected for a swapped pair ("taks", "shwo");
 * six to eight letters allow one edit, longer words two.
 */
export function correctWord(word, vocabulary) {
  if (word.length < 4 || !/^[a-z]+$/.test(word)) return null;
  const max = word.length >= 9 ? 2 : 1;
  let best = null;
  let bestDist = max + 1;
  let tied = false;
  for (const known of vocabulary) {
    if (known[0] !== word[0] || Math.abs(known.length - word.length) > max) continue;
    const dist = editDistance(word, known, max + 1);
    if (dist > max) continue;
    if (word.length <= 5 && !(known.length === word.length && [...known].sort().join('') === [...word].sort().join(''))) continue;
    if (dist < bestDist) { best = known; bestDist = dist; tied = false; } else if (dist === bestDist && known !== best) tied = true;
  }
  return best && !tied ? best : null;
}

const strip = (w) => w.replace(/^[^\p{L}\p{N}₹$€£@#]+|[^\p{L}\p{N}%]+$/gu, '');

/**
 * @typedef {Object} Token
 * @property {string} raw      as typed (case kept, punctuation trimmed)
 * @property {string} w        lower case, possessive removed
 * @property {boolean} poss    it carried 's ("Ravi's")
 * @property {boolean} proper  capitalised somewhere other than the first word
 */

/** Splits text into tokens. */
export function tokenize(text) {
  const out = [];
  const parts = String(text || '').split(/\s+/).filter(Boolean);
  parts.forEach((part, i) => {
    const raw = strip(part);
    if (!raw) return;
    let w = raw.toLowerCase();
    let poss = false;
    const m = w.match(/^(.+?)['’]s$/);
    if (m) { w = m[1]; poss = true; }
    out.push({ raw: poss ? raw.slice(0, -2) : raw, w, poss, proper: i > 0 && /^\p{Lu}/u.test(raw) });
  });
  return out;
}

/**
 * @typedef {Object} Normalized
 * @property {string} raw       the message as sent (trimmed, capped)
 * @property {string} clean     contractions expanded, spacing tidied, case kept
 * @property {string} core      `clean` without leading/trailing filler
 * @property {boolean} question it asks rather than tells
 * @property {boolean} uncertain it hedges ("maybe", "should we")
 * @property {boolean} followUp it opens like a follow-up ("and", "what about")
 * @property {Token[]} tokens   tokens of `core`
 */

/**
 * A slipped article. "fire and employee" is "fire an employee": nothing stands
 * before the "and" for it to join, and what follows is a kind of thing, not a
 * second action ("add and assign a task" is left alone).
 */
const SLIP_VERBS = Object.values(ACTS).flat().filter((v) => !/^(?:new|open|bill|invoice|charge|hire|recruit)$/.test(v));
const SLIP_NOUNS = Object.values(THINGS).flatMap((t) => t.one).filter((n) => !/^(?:hire|recruit)$/.test(n));
const alt = (words) => words.slice().sort((a, b) => b.length - a.length).map((w) => w.replace(/[-\s]+/g, '[-\\s]+')).join('|');
const SLIPPED_ARTICLE = new RegExp(`\\b(${alt(SLIP_VERBS)})\\s+(?:and|ann|anf|adn|nad)\\s+((?:new|existing|old|other)\\s+)?(?=(?:${alt(SLIP_NOUNS)})\\b)`, 'gi');
const SLIPPED_THE = /\b(?:teh|hte|tge|thr)\b/g;

const FOLLOW_UP = /^(?:and|also|what about|how about|and what about|same for|same thing for|now for|then|but|only|just)\b[\s,]*/i;

/** @returns {Normalized} */
export function normalizeMessage(message) {
  const raw = String(message ?? '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
  // A voice turn carries an instruction block after a blank line; the request
  // is the first paragraph.
  let clean = raw.split(/\n\s*\n/)[0]
    .normalize('NFKC')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, to] of CONTRACTIONS) clean = clean.replace(re, to);
  clean = clean.replace(SLIPPED_THE, 'the').replace(SLIPPED_ARTICLE, (_, verb, adj = '') => `${verb} ${/^[aeiou]/i.test(adj) ? 'an' : 'a'} ${adj}`);

  let core = clean;
  for (let pass = 0; pass < 4; pass++) {
    const before = core;
    for (const re of LEAD_FILLERS) core = core.replace(re, '');
    if (core === before) break;
  }
  const followUp = FOLLOW_UP.test(core);
  const trimmed = core.replace(TAIL_FILLER, '').trim();
  if (trimmed) core = trimmed;
  const question = /\?\s*$/.test(clean) || QUESTION_OPENER.test(core);
  core = core.replace(/[\s?.!]+$/, '').trim();

  return {
    raw,
    clean,
    core,
    question,
    uncertain: UNCERTAIN.test(clean),
    followUp,
    tokens: tokenize(core),
  };
}

export const FOLLOW_UP_PREFIX = FOLLOW_UP;
