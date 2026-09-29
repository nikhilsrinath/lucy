// voice.js — the text side of a voice call with EdgeAI.
//
// What is spoken is not what is shown: an answer written for the screen has
// Markdown, tables and "₹4,50,000", and read aloud as-is it is noise. These
// turn an answer into sentences a voice can say, pick the best voice the
// browser has, and tidy what the recogniser heard before it becomes a question.
//
// Pure functions except pickVoice, which only reads the list it is given.

/** Added to the question sent to the model during a call — never shown in the chat. */
export const VOICE_INSTRUCTION = '(This is a live phone-style voice call. Reply the way you would out loud, '
  + 'in your own persona and manner: one or two short sentences, under 35 words in total. Lead with the answer itself — '
  + 'no greeting, no restating the question, no "Great question". Plain spoken words only: no lists, '
  + 'tables, headings, symbols or Markdown. Round figures the way people say them, like "about 4.5 lakh". '
  + 'If there is more worth knowing, end with a very short offer such as "Want the breakdown?")';

/** How much of an answer is read out on a call; the rest is in the chat. */
export const MAX_SPOKEN_SENTENCES = 3;

// Said while the answer is on its way, so the pause never reads as a dead
// line. Grouped by what was asked; never the same one twice in a row.
const FILLERS = {
  question: ['Hmm, good question.', 'Let me check that.', 'Hmm, let me see.', 'Good question — one sec.', 'Let me look that up.'],
  numbers: ['Let me pull up the numbers.', 'One sec, checking the figures.', 'Hmm, let me run the numbers.'],
  request: ['Okay, on it.', 'Sure, one moment.', 'Got it — give me a second.', 'Alright, let me do that.'],
  generic: ['Hmm…', 'Okay, one sec.', 'Right, let me see.', 'Let me think about that.'],
  still: ['Still pulling that together…', 'Almost there…', 'Bear with me, just a moment more.', 'Nearly done…'],
};
let lastFiller = '';

/** What kind of filler suits what was asked. */
export function fillerKind(question = '') {
  const q = question.toLowerCase().trim();
  if (/\b(how much|how many|revenue|profit|runway|cash|expense|spent|balance|outstanding|overdue|gst|margin|total|sales)\b/.test(q)) return 'numbers';
  if (/^(please |can you |could you |send|create|add|record|schedule|remind|make|draft|mark|set)\b/.test(q)) return 'request';
  if (/\?$|^(what|why|how|who|which|when|where|is|are|do|does|did|should|can|will)\b/.test(q)) return 'question';
  return 'generic';
}

/**
 * A filler line for this moment, in the cofounder's own words when `own`
 * (a persona's `fillers`) has some for this kind. `random` is injectable for tests.
 */
export function pickFiller(kind, own = null, random = Math.random) {
  const lines = own?.[kind]?.length ? own[kind] : (FILLERS[kind] || FILLERS.generic);
  const pool = lines.filter((f) => f !== lastFiller);
  lastFiller = pool[Math.floor(random() * pool.length)] || pool[0];
  return lastFiller;
}

/** Markdown to the words a person would read out. */
export function speakable(md = '') {
  return String(md)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ')         // table rules
    .replace(/\|/g, ', ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')   // headings, quotes, bullets
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2')
    .replace(/₹\s?/g, '₹')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n+\s*/g, '\n')
    .trim();
}

// A sentence ends at . ! ? followed by a space or the end, or at a line break.
// Decimals ("4.5") never qualify — no space follows the dot — and these
// abbreviations are not ends either: "Rs. 500", "e.g. this", "Dr. Rao".
const NO_SPLIT = /\b(?:rs|dr|mr|mrs|ms|no|vs|etc|e\.g|i\.e|approx|inc|ltd|pvt)\.$/i;

/**
 * Splits text into sentences with their offsets, so a speaker can say one at a
 * time and the screen can light the right words.
 *
 * @param {string} text
 * @param {boolean} final  false while the answer is still streaming: the last,
 *                         unterminated piece is held back until it completes
 * @returns {{ text: string, start: number, end: number }[]}
 */
export function sentencesOf(text, final = true) {
  const out = [];
  const push = (from, to) => {
    const raw = text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    if (raw.trim()) out.push({ text: raw.trim(), start: from + lead, end: from + lead + raw.trim().length });
  };
  let start = 0;
  const re = /[.!?]+["')\]]*(?=\s|$)|\n+/g;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const isBreak = m[0][0] === '\n';
    // Mid-stream, a stop at the very end may be "4." of "4.5" still arriving.
    if (!final && end >= text.length) break;
    if (!isBreak && NO_SPLIT.test(text.slice(start, end).trim())) continue;
    push(start, isBreak ? m.index : end);
    start = end;
  }
  if (final) push(start, text.length);
  return out;
}

// Who a voice sounds like, from its name. Browsers do not report gender, so
// this is the names that ship in Edge, Chrome, Windows and macOS. "female"
// is tested first: it contains "male".
const FEMALE = /female|\b(neerja|heera|veena|kalpana|aria|jenny|ana|michelle|emma|ava|sonia|libby|maisie|hazel|susan|zira|natasha|clara|emily|molly|luna|leah|samantha|karen|moira|tessa|fiona|victoria)\b|google us english/i;
const MALE = /\bmale\b|\b(prabhat|ravi|hemant|rishi|guy|christopher|eric|roger|steffan|andrew|brian|ryan|thomas|george|david|mark|william|liam|connor|mitchell|wayne|luke|alex|daniel|fred|james)\b/i;

/** 'f', 'm', or null when the name does not say. */
export function voiceGender(v) {
  const name = v?.name || '';
  if (FEMALE.test(name)) return 'f';
  if (MALE.test(name)) return 'm';
  return null;
}

/**
 * The best English voice available for `style` — a persona's
 * `{ gender, prefer }` (see src/design/personas.js). Without a style, simply
 * the most natural one. Edge's "Online (Natural)" voices and Chrome's Google
 * voices are far better than the old system ones, and an Indian English voice
 * says ₹, lakh and Indian names properly.
 *
 * With a style, the right gender outweighs everything, and the persona's own
 * shortlist (in order) decides between good voices — so two cofounders of the
 * same gender land on different voices wherever the browser has more than one.
 */
export function pickVoice(voices = [], style = null) {
  const en = voices.filter((v) => /^en[-_]/i.test(v.lang || '') || /^en$/i.test(v.lang || ''));
  if (!en.length) return voices[0] || null;
  const prefer = (style?.prefer || []).map((n) => n.toLowerCase());
  const score = (v) => {
    const name = v.name || '';
    const lang = (v.lang || '').replace('_', '-').toLowerCase();
    let s = 0;
    if (/natural|neural/i.test(name)) s += 40;
    if (/online/i.test(name)) s += 10;
    if (/google/i.test(name)) s += 25;
    if (lang === 'en-in') s += 30;
    else if (lang === 'en-gb') s += 8;
    else if (lang === 'en-us') s += 6;
    if (v.localService === false) s += 3;
    if (style?.gender) {
      const g = voiceGender(v);
      if (g === style.gender) s += 60;
      else if (g) s -= 80;
    } else if (/female|neerja|aria|jenny|sonia|libby/i.test(name)) s += 2;
    const i = prefer.findIndex((n) => name.toLowerCase().includes(n));
    if (i >= 0) s += Math.max(30, 80 - 8 * i);
    return s;
  };
  return [...en].sort((a, b) => score(b) - score(a))[0];
}

// What the recogniser commonly mishears in this app's vocabulary.
const FIXES = [
  [/\bpro[\s-]?forma\b/gi, 'proforma'],
  [/\bg\.?\s?s\.?\s?t\b\.?/gi, 'GST'],
  [/\bedge\s?(?:o\.?\s?s|os)\b/gi, 'EdgeOS'],
  [/\bedge\s?a\.?\s?i\b/gi, 'EdgeAI'],
  [/\bin\s?voice(s?)\b/gi, 'invoice$1'],
  [/\bp\s?(?:&|and)\s?l\b/gi, 'P&L'],
  [/\bgst\s?in\b/gi, 'GSTIN'],
  [/\brs\.?\s?(\d)/gi, '₹$1'],
];

/** What the recogniser heard, tidied into a question. */
export function tidyTranscript(text = '') {
  let t = String(text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  for (const [re, to] of FIXES) t = t.replace(re, to);
  return t.charAt(0).toUpperCase() + t.slice(1);
}
