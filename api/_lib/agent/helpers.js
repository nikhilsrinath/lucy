import { formatDate, formatDateShort, parseDate, isIsoDate } from '../../../src/shared/dates.js';

/**
 * Small pieces every tool uses: how figures and dates read on a card, and
 * the three ways a tool can stop short of a proposal.
 *
 *   choice  — the reference matched several records; show them as chips.
 *   input   — something required is missing; ask one short question.
 *   none    — nothing matched; say what was searched (and offer to create it).
 *
 * A tool never guesses its way past any of these.
 */

export const money = (v, currency = 'INR') => {
  const n = Number(v) || 0;
  try {
    return n.toLocaleString('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 });
  } catch {
    return `${currency} ${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  }
};

export { formatDate, formatDateShort };

/** A diff row: field label, what it is now, what it will be. */
export const change = (key, label, from, to) => ({ key, label, from: show(from), to: show(to) });

export function show(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

/* ── stopping short ───────────────────────────────────────────────────────── */

export const needsChoice = (param, question, candidates) => ({
  needs: {
    kind: 'choice', param, question,
    options: candidates.slice(0, 5).map(({ entity, sub }) => ({
      label: entity.label, value: entity.id, sub: sub || null, entity,
    })),
  },
});

export const needsInput = (param, question, options = [], { hint = null } = {}) => ({
  needs: { kind: 'input', param, question, options: options.slice(0, 8), hint },
});

export const notFound = (message, offer = null) => ({ needs: { kind: 'none', message, offer } });

/** A choice between the candidates of a resolution, with a sub-line per kind. */
export function choiceFrom(param, noun, resolution, subOf = () => null) {
  return needsChoice(param, `Which ${noun} did you mean?`,
    resolution.candidates.map((c) => ({ entity: c.entity, sub: subOf(c.row) })));
}

/* ── asking for the essentials, one at a time ─────────────────────────────── */

/** What a person says to pass over a question they need not answer. */
const SKIP = /^(?:skip(?: it| this)?|none|no|nope|nah|not now|later|n\/a|na|nothing|leave it(?: blank| empty)?|do not know|not sure|-)[\s.!]*$/i;
export const isSkip = (v) => typeof v === 'string' && SKIP.test(v.trim());
export const SKIP_OPTION = { label: 'Skip', value: 'skip' };

/**
 * The questions a tool asks before it can draw its card, in order. A tool
 * lists them as `slots` and calls this at the top of resolve():
 *
 *   { key, question(values, ctx), options?(values, ctx), read?(raw, ctx, values),
 *     optional?, when?(values, ctx), free? }
 *
 *   optional  the person may skip it ("skip", "no"); it is then null
 *   when      the question is only put when this holds
 *   free      the answer is running text (an address, a paragraph): the
 *             router takes it whole, however long (local/engine.js)
 *   read      raw answer → { value } | { error }; an unreadable answer is
 *             asked again with the reason
 *
 * Returns the first question still open as needsInput, or { values } once
 * every slot is answered or skipped. Nothing is ever guessed.
 */
export async function askNext(args, slots, ctx) {
  const values = {};
  for (const slot of slots) {
    const raw = args[slot.key];
    const ask = (why = '') => {
      const question = typeof slot.question === 'function' ? slot.question(values, ctx) : slot.question;
      const options = typeof slot.options === 'function' ? slot.options(values, ctx) : slot.options || [];
      return needsInput(slot.key, why ? `${why} ${question}` : question, slot.optional && !options.some((o) => o.value === 'skip') ? [...options, SKIP_OPTION] : options);
    };
    if (slot.when && !slot.when(values, ctx)) { values[slot.key] = null; continue; }
    if (slot.optional && (raw === null || isSkip(raw))) { values[slot.key] = null; continue; }
    if (raw === undefined || raw === null || String(raw).trim() === '') return ask();
    if (!slot.read) { values[slot.key] = String(raw).trim(); continue; }
    const r = await slot.read(raw, ctx, values);
    if (r.error) return ask(r.error);
    values[slot.key] = r.value;
  }
  return { values };
}

/* ── dates said as words ──────────────────────────────────────────────────── */

const CLEAR = /^(?:none|no(?: deadline| date)?|clear(?: it)?|remove(?: it)?|null|n\/a|-)$/i;

/**
 * A date argument, as the model passed it: an ISO date, a phrase to parse
 * ("2nd October", "next Friday"), or a request to clear it. Returns
 * { value: 'YYYY-MM-DD' | null } or { error }.
 */
export function readDate(raw, today, { prefer = 'future' } = {}) {
  if (raw === null) return { value: null };
  const s = String(raw ?? '').trim();
  if (!s) return { value: undefined };
  if (CLEAR.test(s)) return { value: null };
  if (isIsoDate(s)) return { value: s };
  const hit = parseDate(s, today, { prefer });
  if (hit) return { value: hit.date };
  return { error: `I could not read “${s}” as a date.` };
}

/** Strips a model's argument object down to the keys a tool declares. */
export function onlyKnown(args, params) {
  const allowed = new Set(Object.keys(params?.properties || {}));
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (allowed.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

export const truncate = (s, n = 80) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** "Connect with client on pricing" in quotes, trimmed for a one-line summary. */
export const q = (s) => `“${truncate(s, 60)}”`;
