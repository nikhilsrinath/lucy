// cashIntent.js — reading a sentence about money.
//
// Lives in src/shared/ because both sides use it: the browser's cash-book card,
// and the agent's create_cash_entry tool on the server (api/_lib/agent), which
// parses the amount, date, GST, rail and category a person said with exactly
// these functions — a lakh is 1,00,000 on both, and "yesterday" is resolved in
// the org's timezone because the caller passes `today` in.
//
// Everything here turns a sentence somebody typed into a cash-book entry, and
// says what still needs asking before one can be written. It is deliberately
// deterministic and free of the model: a row that lands in the ledger is not
// something to be guessed at by a language model whose output cannot be
// replayed, and an entry nobody confirmed is not an entry. The model stays on
// the reading side of the product; this file drives the writing side.
//
// A draft has exactly the shape of CashBook's own form state, so it can be
// written through the same orgStore sections — no second definition of what an
// entry is, and no second place to keep in step with the column guards in
// migrations 0038 and 0041.

import { todayIso, parseDate as parseAnyDate } from './dates.js';
import {
  PAYMENT_METHODS, allCategories, categoryOf, categoriesFor, treatmentOf,
} from './financeTaxonomy.js';

/* ── the draft ────────────────────────────────────────────────────────────── */

export const SECTION_OF = { in: 'income_entries', out: 'expenses' };

export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY'];

const COMMON = (today) => ({
  description: '', original_amount: '', currency: 'INR', fx_rate: 1,
  tax_amount: '', tax_rate: 0, date: today,
  payment_method: '', reference: '',
  country_code: '', place_of_supply: '', is_inter_state: false,
  quantity: '', unit: '', receipt_path: null, notes: '',
  // Projects (Phase 3): the project this money belongs to, and the candidates
  // when the sentence named one ambiguously (which is the only time it is asked).
  project_id: '', project_candidates: [],
});

/**
 * An empty draft, pointed one way down the ledger. Mirrors CashBook's blank().
 *
 * A null direction is a real state, not a missing argument: a message can ask
 * for an entry without saying which way the money went, and the draft has to
 * be able to hold that until it is asked. Defaulting it to 'out' would file
 * money received as money spent whenever somebody was not explicit.
 */
export function blankDraft(direction, today = todayIso()) {
  if (direction === 'in') {
    return { ...COMMON(today), direction: 'in', category: '', client_id: '', catalog_item_id: '' };
  }
  if (direction === 'out') {
    return {
      ...COMMON(today), direction: 'out', category: '',
      vendor_id: '', employee_id: '', product_id: '', department_id: '', client_id: '',
      billable: false, status: 'paid',
    };
  }
  return { ...COMMON(today), direction: null, category: '' };
}

/* ── direction ────────────────────────────────────────────────────────────── */

// Somebody else paying US is money in, whatever the verb. Checked before the
// plain verb lists, where "paid" on its own means we paid.
const PAID_TO_US = /\b(?:got|been|getting|get)\s+paid\b|\b(?:paid|transferred|sent|remitted|wired)\s+(?:us|me)\b|\bpayment\s+(?:from|received)\b|\b(?:received|got)\b[^.]*\bfrom\b/i;

const OUT_WORDS = /\b(spent|spend|spending|paid|pay|paying|bought|buy|buying|purchased|purchase|expense|expenses|expenditure|outgoing|cash\s*out|money\s*out|debited|remitted|disbursed)\b/i;
const IN_WORDS = /\b(received|receive|receiving|got\s+paid|earned|income|revenue|collected|collection|cash\s*in|money\s*in|incoming|credited|sold|sale|came\s+in)\b/i;

// Phrases that mean "write this down" rather than "tell me about it". Without
// them, "log an expense" — which names no verb of spending at all — would not
// register as a request to record anything.
const RECORD_WORDS = /\b(record|log|enter|add|note\s+down|book|create)\b/i;
const CASH_NOUNS = /\b(expense|expenses|income|cash|payment|entry|entries|bill|receipt|spend|revenue|sale|purchase)\b/i;

/* A question is a question, not an instruction, and the difference is not
   decided by the first word alone.

   "okay how much is the expenses" opens with "okay" and asks about spending;
   anchoring the test to the start of the sentence read it as a request to
   record one. People lead with "okay", "hey", "so", "and", "right" constantly,
   so the interrogative is looked for in the opening clause rather than at
   character zero — and "how much" / "how many", which can only ever be asking
   for a figure, anywhere in the sentence at all. */
const INTERROGATIVE = /\b(how\s+much|how\s+many|how\s+(?:do|did|does|is|are|was|were|can|could)|what(?:'s|s)?\b|which\b|when\b|where\b|why\b|who(?:se|m)?\b|is\s+there|are\s+there|do\s+we|did\s+we|does\s+it|can\s+(?:you|we)|could\s+(?:you|we)|should\s+(?:i|we)|tell\s+me|show\s+me|give\s+me|list\b|summari[sz]e|compare|explain|break\s*down|breakdown|status\s+of)/i;
const COUNTING = /\b(how\s+much|how\s+many)\b/i;

// The opening clause: enough to cover a filler word or two before the real
// verb, and short enough that a "what" deep in a subordinate clause — "paid
// what we owed" — is not mistaken for the sentence's own question.
const OPENER_WORDS = 6;

/**
 * Is this message asking something rather than telling it?
 *
 * Used in two places, and it is the same judgement in both: whether to start a
 * cash entry at all, and whether a message sent mid-entry is an answer or a
 * question that deserves a real reply.
 */
export function isQuestion(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (s.endsWith('?')) return true;
  if (COUNTING.test(s)) return true;
  const opener = s.split(/\s+/).slice(0, OPENER_WORDS).join(' ');
  return INTERROGATIVE.test(opener);
}

/**
 * Does this message ask for a cash entry to be recorded?
 *
 * Returns `{ direction, certain }` or null. A null `direction` means the
 * message is clearly about recording money but has not said which way it
 * moved — which is then the first thing asked rather than assumed.
 *
 * Two gates, and a message has to clear both. It must not be a question, and
 * it must carry some evidence that something is to be written down: either an
 * explicit instruction ("log an expense", "add some expenses"), or a claim
 * that money actually moved ("we paid the October rent"). Anything else —
 * every observation, opinion and aside about money — belongs to the model.
 *
 * The bias is deliberately towards doing nothing. Failing to start an entry
 * costs one more sentence; starting one over somebody's question derails the
 * conversation they were having and has to be backed out of by hand.
 */
export function detectCashIntent(text) {
  const s = String(text || '').trim();
  if (!s || isQuestion(s)) return null;

  if (PAID_TO_US.test(s)) return { direction: 'in', certain: true };

  const out = OUT_WORDS.test(s);
  const inward = IN_WORDS.test(s);
  const told = RECORD_WORDS.test(s) && CASH_NOUNS.test(s);

  // Nothing here says anything moved or should be written down.
  if (!told && !out && !inward) return null;

  // "received a refund and paid it back" — both, and neither reading is safe
  // to pick on somebody's behalf. Ask.
  if (out && inward) return { direction: null, certain: false };
  if (out) return { direction: 'out', certain: true };
  if (inward) return { direction: 'in', certain: true };

  if (/\b(expense|spend|purchase|bill)\b/i.test(s)) return { direction: 'out', certain: true };
  if (/\b(income|revenue|sale)\b/i.test(s)) return { direction: 'in', certain: true };
  return { direction: null, certain: false };
}

/**
 * Walking away from a half-finished entry.
 *
 * Matched anywhere in the sentence, not just at the front. "Okay leave it" is
 * how people actually back out of something, and a matcher anchored to the
 * start reads that as an answer, fails to parse it, and asks the question
 * again — which is exactly how a helpful form becomes a thing you cannot
 * escape.
 */
const CANCEL_WORDS = /\b(cancel|never ?mind|nevermind|forget it|forget about it|leave it|leave that|drop it|skip (?:it|this|that)|not now|do it later|maybe later|abort|stop it)\b/i;

export const isCancel = (text) => CANCEL_WORDS.test(String(text || ''));

/** Which way did this answer point? Used when the direction had to be asked. */
export function parseDirection(text) {
  const s = String(text || '').toLowerCase();
  if (PAID_TO_US.test(s)) return 'in';
  if (/\b(in|income|received|revenue|credit|earned|sale|sold)\b/.test(s)) return 'in';
  if (/\b(out|expense|spent|paid|debit|cost|purchase|bought)\b/.test(s)) return 'out';
  return null;
}

/* ── amounts ──────────────────────────────────────────────────────────────── */

const MULTIPLIERS = {
  k: 1e3, thousand: 1e3, thousands: 1e3,
  l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5,
  m: 1e6, mn: 1e6, million: 1e6, millions: 1e6,
  cr: 1e7, crore: 1e7, crores: 1e7,
};

const CURRENCY_BY_TOKEN = {
  '₹': 'INR', rs: 'INR', 'rs.': 'INR', inr: 'INR', rupees: 'INR', rupee: 'INR',
  $: 'USD', usd: 'USD', dollars: 'USD', dollar: 'USD',
  '€': 'EUR', eur: 'EUR', euros: 'EUR', euro: 'EUR',
  '£': 'GBP', gbp: 'GBP', pounds: 'GBP', pound: 'GBP',
  aed: 'AED', dirhams: 'AED', sgd: 'SGD', aud: 'AUD', cad: 'CAD',
  jpy: 'JPY', '¥': 'JPY', yen: 'JPY',
};

const AMOUNT_RE = new RegExp(
  '(₹|\\$|€|£|¥|\\brs\\.?|\\binr\\b|\\busd\\b|\\beur\\b|\\bgbp\\b|\\baed\\b|\\bsgd\\b|\\baud\\b|\\bcad\\b|\\bjpy\\b)?'
  + '\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*'
  // The scale must end its word: "450 kg" is not 4,50,000. A bare "L" counts
  // as lakh only when glued to the figure ("1.5L"), never as "5 litres".
  + '(k(?![a-z])|thousands?(?![a-z])|lakhs?(?![a-z])|lacs?(?![a-z])|crores?(?![a-z])|crs?(?![a-z])|millions?(?![a-z])|mn(?![a-z])|(?<=[0-9])l(?![a-z]))?'
  + '\\s*(₹|\\$|€|£|¥|rs\\.?|inr|usd|eur|gbp|aed|sgd|aud|cad|jpy|rupees?|dollars?|euros?|pounds?|dirhams?|yen)?',
  'gi',
);

/**
 * The figure in a sentence, and the currency it was named in.
 *
 * Several numbers can appear in one line — "paid 25,000 rent on 5 Oct with 18%
 * GST" — so candidates are scored rather than taken in order: a number wearing
 * a currency symbol wins, then one wearing a scale word, then the largest. A
 * percentage is never an amount, and text the date parser has already claimed
 * is removed before this runs.
 */
export function parseAmount(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;

  const candidates = [];
  AMOUNT_RE.lastIndex = 0;
  let m = AMOUNT_RE.exec(raw);
  while (m !== null) {
    const [full, pre, digits, scale, post] = m;
    // A trailing % makes this a rate, not a sum; a trailing "days" or "pcs" a
    // count ("net 30 days", "12 pcs") — unless it wears a currency or scale.
    const after = raw.slice(m.index + full.length).trimStart();
    const isCount = !pre && !post && !scale
      && /^(days?|weeks?|months?|years?|hrs?|hours?|pcs?|nos?|units?|x)\b/i.test(after);
    const n = Number(digits.replace(/,/g, ''));
    if (!after.startsWith('%') && !isCount && Number.isFinite(n) && n > 0) {
      const token = (pre || post || '').trim().toLowerCase();
      const mult = scale ? MULTIPLIERS[scale.toLowerCase().replace(/^crs$/, 'cr')] || 1 : 1;
      candidates.push({
        amount: Math.round(n * mult * 100) / 100,
        currency: CURRENCY_BY_TOKEN[token] || null,
        match: full.trim(),
        score: (CURRENCY_BY_TOKEN[token] ? 4 : 0) + (scale ? 2 : 0),
      });
    }
    m = AMOUNT_RE.exec(raw);
  }

  // "a lakh", "one crore", "half a lakh" — a scale word with no figure.
  const worded = raw.match(/\b(half\s+a|a|one)\s+(thousand|lakh|lac|crore|million)\b/i);
  if (worded) {
    const pre = raw.slice(0, worded.index).match(/(₹|\brs\.?|\binr)\s*$/i);
    candidates.push({
      amount: (/half/i.test(worded[1]) ? 0.5 : 1) * MULTIPLIERS[worded[2].toLowerCase()],
      currency: pre ? 'INR' : null,
      match: (pre ? pre[0] : '') + worded[0],
      score: 2 + (pre ? 4 : 0),
    });
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score || b.amount - a.amount);
  const best = candidates[0];
  return { amount: best.amount, currency: best.currency, match: best.match };
}

// A figure that was formatted for reading — ₹2,615, $1,200, 12,500 — rather
// than any number that happens to appear. A bare "5" in a sentence about five
// invoices is not a sum anybody is about to record.
const STATED_FIGURE = /(₹|\$|€|£|¥)\s*([0-9][0-9,]*(?:\.[0-9]+)?)|\b([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]+)?)\b/g;

const LABEL_STOP = new Set([
  'the', 'a', 'an', 'of', 'for', 'on', 'in', 'to', 'at', 'by', 'from', 'with',
  'and', 'or', 'our', 'we', 'you', 'your', 'is', 'are', 'was', 'were', 'so',
  'around', 'about', 'roughly', 'combined', 'total', 'some', 'that', 'this',
  'them', 'it', 'log', 'keep', 'books', 'accurate', 'recorded', 'unrecorded',
]);

/** Up to three meaningful words, from the end of a phrase or the start of one. */
function words3(phrase, fromStart = false) {
  const kept = String(phrase).toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !LABEL_STOP.has(w));
  return (fromStart ? kept.slice(0, 3) : kept.slice(-3)).join(' ');
}

/**
 * Figures the conversation has already put on the table.
 *
 * When somebody says "we need to add some expenses now", the amount they mean
 * is usually one the assistant named a moment ago — the ₹2,615 of bank charges
 * it just recommended looking into. Offering those back as chips is the
 * difference between a wizard that starts from nothing and one that carries on
 * the conversation it is part of.
 *
 * `texts` is newest-last, as a thread is. Nothing is inferred beyond what was
 * literally written: a figure that was never said does not appear here.
 */
export function amountHints(texts, limit = 3) {
  const seen = new Map();
  for (const text of [...(texts || [])].reverse()) {
    const raw = String(text || '');
    STATED_FIGURE.lastIndex = 0;
    let m = STATED_FIGURE.exec(raw);
    while (m !== null) {
      const digits = (m[2] || m[3] || '').replace(/,/g, '');
      const amount = Number(digits);
      if (Number.isFinite(amount) && amount > 0 && !seen.has(amount)) {
        // What the figure was, taken from the words in front of it: English
        // puts the noun before the sum — "combined bank charges around ₹2,615"
        // — so the words after it belong to the next clause ("so we can log
        // them"), and reading those gives a chip labelled with the wrong half
        // of the sentence.
        const before = words3(raw.slice(Math.max(0, m.index - 60), m.index));
        const label = before || words3(raw.slice(m.index + m[0].length, m.index + m[0].length + 40), true);
        seen.set(amount, {
          value: String(amount),
          label: `${m[1] || '₹'}${amount.toLocaleString('en-IN')}${label ? ` · ${label}` : ''}`,
        });
      }
      m = STATED_FIGURE.exec(raw);
    }
    if (seen.size >= limit) break;
  }
  return [...seen.values()].slice(0, limit);
}

/** A currency named on its own — "in dollars", "USD" — with no figure beside it. */
export function parseCurrency(text) {
  const s = String(text || '').toLowerCase();
  for (const [token, code] of Object.entries(CURRENCY_BY_TOKEN)) {
    const literal = token.replace(/[.$]/g, (c) => `\\${c}`);
    const re = /^[a-z]/.test(token) ? new RegExp(`\\b${literal}\\b`) : new RegExp(literal);
    if (re.test(s)) return code;
  }
  return null;
}

/* ── dates ────────────────────────────────────────────────────────────────── */

/**
 * When did this happen? Returns `{ date, match }` or null.
 *
 * Money that moved has already moved, so a bare month and day with no year is
 * the most recent one: on 22 September, "12 Dec" means last December, and a
 * bare "Friday" is the last Friday. The parser itself lives in ./dates, shared
 * with deadlines, which read the other way.
 */
export function parseDate(text, today = todayIso()) {
  return parseAnyDate(text, today, { prefer: 'past' });
}

/* ── payment method ───────────────────────────────────────────────────────── */

const METHOD_PATTERNS = [
  ['upi', /\b(upi|gpay|google\s*pay|phonepe|bhim|qr\s*code)\b/i],
  ['cheque', /\b(cheque|check\s*no|demand\s*draft)\b/i],
  ['card', /\b(credit\s*card|debit\s*card|card|visa|mastercard|amex|swiped?)\b/i],
  ['wallet', /\b(wallet|paytm|amazon\s*pay|mobikwik)\b/i],
  // "cash in", "cash out" and "cash book" name the ledger, not the rail.
  ['cash', /\b(cash(?!\s*(?:in|out|book|entry|entries|flow|position|balance)\b)|by\s*hand|in\s*hand)\b/i],
  // "bank charges" is a category, not a transfer.
  ['bank_transfer', /\b(bank\s*transfer|bank(?!\s*(?:charges?|fees?|interest)\b)|neft|rtgs|imps|wire|net\s*banking)\b/i],
];

/** The rail this moved on, as `{ method, match }` or null. */
export function parseMethod(text) {
  const s = String(text || '');
  for (const [method, re] of METHOD_PATTERNS) {
    const hit = s.match(re);
    if (hit) return { method, match: hit[0] };
  }
  return null;
}

export const methodOptions = () => PAYMENT_METHODS.map((m) => ({ value: m.key, label: m.label }));

/* ── GST ──────────────────────────────────────────────────────────────────── */

/**
 * A GST rate named in the sentence. Only an explicit rate counts: "plus GST"
 * with no number behind it is not enough to put a figure on a tax line.
 */
export function parseGstRate(text) {
  const s = String(text || '');
  const hit = s.match(/\b(\d{1,2}(?:\.\d+)?)\s*%\s*(?:gst|igst|tax|vat)?/i)
    || s.match(/\b(?:gst|igst|tax|vat)\s*(?:of|at|@)?\s*(\d{1,2}(?:\.\d+)?)\s*%?/i);
  if (!hit) return null;
  const rate = Number(hit[1]);
  return Number.isFinite(rate) && rate >= 0 && rate <= 40 ? { rate, match: hit[0] } : null;
}

/**
 * The tax inside a gross figure, to the paisa.
 *
 * The same arithmetic as CashBook's setRate and app.cash_entry_tax(): the
 * amount entered is what moved, tax included, so the tax is carved out of it
 * rather than added on top. Three places, one formula — a fourth reading of
 * "18%" is how a ledger stops reconciling.
 */
export function taxFromRate(base, rate) {
  const gross = Number(base) || 0;
  const r = Number(rate) || 0;
  if (!gross || !r) return 0;
  return Math.round((gross - gross / (1 + r / 100)) * 100) / 100;
}

/* ── category ─────────────────────────────────────────────────────────────── */

// What people call things, mapped to what the taxonomy calls them. The scorer
// below already covers any category whose label or hint says the word; this
// list is for the ones it cannot reach — a laptop is a "computer", a chair is
// "furniture", and neither word appears in the row it belongs under.
const SYNONYMS = {
  out: [
    [/\b(laptop|macbook|computer|desktop|monitor|keyboard|tablet|ipad|headphone)/i, 'computers'],
    [/\b(chair|desk|table|cupboard|shelf|shelving|cabinet)/i, 'furniture'],
    [/\b(car|bike|scooter|van|truck|vehicle)\b/i, 'vehicle'],
    [/\b(machine|machinery|lathe|generator)\b/i, 'equipment'],
    [/\b(fit[\s-]?out|renovation|interior)\b/i, 'leasehold_improve'],
    [/\b(rent|lease|coworking|co-working)\b/i, 'rent'],
    [/\b(salary|salaries|payroll|pay\s*run)\b/i, 'salaries'],
    [/\b(wage|wages|daily\s*labour)\b/i, 'wages'],
    [/\b(stipend|intern)\b/i, 'intern_stipend'],
    [/\b(freelancer|freelance|contractor)\b/i, 'contractor_fees'],
    [/\b(bonus|incentive)\b/i, 'bonus_incentive'],
    [/\b(pf|epf|esi|provident)\b/i, 'employer_pf_esi'],
    [/\b(gratuity|leave\s*encash)/i, 'gratuity_settlement'],
    [/\b(hiring|recruit|job\s*board)/i, 'recruitment'],
    [/\breimburse/i, 'reimbursement_out'],
    [/\b(electricity|power\s*bill|water\s*bill|diesel|gas\s*bill)/i, 'utilities'],
    [/\b(internet|wifi|wi-fi|broadband|mobile\s*bill|phone\s*bill|recharge)/i, 'internet_phone'],
    [/\b(server|hosting|cloud|aws|gcp|azure|vercel|netlify|domain|supabase)/i, 'hosting_infra'],
    [/\b(software|saas|subscription|figma|slack|notion|zoom|adobe|github)/i, 'software_subs'],
    [/\b(stationery|pantry|tea|coffee|snack|consumable|cartridge)/i, 'office_supplies'],
    [/\b(ads?|advertis|campaign)\b/i, 'advertising'],
    [/\b(design|video|copywrit|photograph|creative)\b/i, 'marketing_content'],
    [/\b(event|exhibition|stall|sponsorship|conference|expo)\b/i, 'events_exhibitions'],
    [/\b(courier|postage|speed\s*post|blue\s*dart|dtdc)/i, 'courier_postage'],
    [/\b(shipping|delivery|logistics)/i, 'shipping_delivery'],
    [/\b(freight|customs|duty|import)\b/i, 'inbound_freight'],
    [/\b(packaging|packing|carton|boxes|label)\b/i, 'packaging'],
    [/\b(raw\s*material|input\s*material|fabric|steel|resin)/i, 'raw_materials'],
    [/\b(stock|inventory|goods\s*for\s*resale)\b/i, 'inventory_purchase'],
    [/\b(job\s*work|fabricat|assembl|manufactur)/i, 'manufacturing'],
    [/\b(petrol|fuel|cab|uber|ola|taxi|flight|train|hotel|commute)/i, 'local_travel'],
    [/\b(client\s*(?:travel|lunch|dinner|hosting)|entertain)/i, 'client_travel'],
    [/\b(insurance|premium|policy)\b/i, 'insurance'],
    [/\b(ca|accountant|lawyer|legal|advocate|audit|consultant)\b/i, 'professional_fees'],
    [/\b(bank\s*charge|bank\s*fee|transfer\s*charge)/i, 'bank_charges'],
    [/\b(gateway|razorpay|stripe|payu|cashfree)/i, 'payment_fees'],
    [/\b(repair|servicing|maintenance|amc)\b/i, 'repairs_maintenance'],
    [/\b(cleaning|housekeeping|security\s*guard|facility)\b/i, 'security_housekeeping'],
    [/\b(licen[sc]e|registration|filing|compliance|statutory)\b/i, 'licences_compliance'],
    [/\b(donation|csr|charity)\b/i, 'donation_csr'],
    [/\b(training|course|certification)\b/i, 'training_cost'],
    [/\b(penalty|fine|late\s*fee)\b/i, 'penalties_fines'],
    [/\b(gst|gstr)\b/i, 'gst_paid'],
    [/\btds\b/i, 'tds_paid'],
    [/\b(income\s*tax|advance\s*tax|self[\s-]?assessment)\b/i, 'income_tax_paid'],
    [/\b(loan\s*interest|interest\s*on\s*(?:the\s*)?loan)\b/i, 'loan_interest'],
    [/\b(loan\s*repay|emi|principal|repaid\s*(?:the\s*)?loan)\b/i, 'loan_repayment'],
    [/\b(drawings?|personal\s*(?:use|withdrawal))\b/i, 'owner_drawings'],
    [/\bdividend\b/i, 'dividend_paid'],
    [/\b(security\s*deposit|deposit)\b/i, 'deposit_paid'],
    [/\b(bad\s*debt|written\s*off|uncollectable)\b/i, 'bad_debt'],
    [/\b(forex\s*loss|exchange\s*loss)\b/i, 'forex_loss'],
    [/\b(subcontract|outsourc)/i, 'subcontracting'],
  ],
  in: [
    [/\b(counter\s*sale|sold|sale\s*of|product\s*sale|marketplace|payout)/i, 'product_sales'],
    [/\b(consulting|consultancy|services?\s*(?:income|fee)|project\s*work|(?:design|development|dev|app|website|build|implementation)\s+work|work\s+(?:done|delivered))/i, 'service_income'],
    [/\b(retainer|subscription|monthly\s*fee)/i, 'subscription_income'],
    [/\b(milestone|stage\s*payment)/i, 'project_milestone'],
    [/\b(advance|token|upfront)\b/i, 'advance_received'],
    [/\b(training|workshop|course\s*fee|bootcamp)\b/i, 'training_income'],
    [/\b(licen[sc]e\s*fee|royalt)/i, 'licensing_income'],
    [/\b(commission|referral|reseller)\b/i, 'commission_income'],
    [/\b(amc|maintenance\s*contract|support\s*contract)\b/i, 'maintenance_income'],
    [/\b(shipping\s*recovered|delivery\s*charge|freight\s*collected)/i, 'freight_recovered'],
    [/\b(interest|fixed\s*deposit|dividend|investment\s*return)/i, 'interest_income'],
    [/\b(rent\s*received|rental|sublet|let\s*out)/i, 'rental_income'],
    [/\b(scrap|asset\s*sale)/i, 'scrap_sale'],
    [/\b(grant|subsidy|government\s*support)/i, 'grant_income'],
    [/\b(forex\s*gain|exchange\s*gain)\b/i, 'forex_gain'],
    [/\b(founder|own\s*money|capital|promoter)/i, 'capital_contribution'],
    [/\b(investor|investment|equity|seed|angel|funding\s*round)/i, 'investment_received'],
    [/\b(loan\s*(?:received|taken|disbursed)|borrowed)/i, 'loan_received'],
    [/\b(security\s*deposit|deposit\s*received)\b/i, 'deposit_received'],
    [/\b(vendor\s*refund|refund)/i, 'vendor_refund'],
    [/\breimburse/i, 'reimbursement_in'],
    [/\b(tax\s*refund|gst\s*refund|tds\s*refund)/i, 'tax_refund'],
  ],
};

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'on', 'in', 'to', 'at', 'by', 'from',
  'with', 'our', 'we', 'i', 'it', 'this', 'that', 'paid', 'spent', 'bought',
  'received', 'got', 'was', 'were', 'is', 'are', 'other', 'amp',
]);

const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/)
  .filter((w) => w.length > 2 && !STOP.has(w));

/**
 * The best category for a sentence, or null when nothing is a confident match.
 *
 * Synonyms first, because they are exact statements of intent. Failing those,
 * the taxonomy's own words are scored — a label word counts for more than a
 * hint word, because "Rent & lease" naming rent is a stronger signal than some
 * unrelated row's hint happening to mention it. A single weak overlap is left
 * unmatched on purpose: an entry filed under a guessed category is worse than
 * one the person was asked about, and the question costs a single tap.
 */
export function guessCategory(text, direction) {
  const s = String(text || '');
  if (!s.trim() || !direction) return null;

  // The taxonomy is the authority on which keys exist. A synonym pointing at a
  // key this deployment does not have is skipped rather than written. Before
  // the taxonomy has loaded there is nothing to check against, and the synonym
  // is trusted — the review card shows what it chose either way.
  const known = new Set(allCategories()
    .filter((c) => c.direction === direction && c.active).map((c) => c.key));
  for (const [re, key] of SYNONYMS[direction] || []) {
    if (re.test(s) && (known.size === 0 || known.has(key))) return key;
  }

  const said = new Set(words(s));
  if (!said.size) return null;

  let best = null;
  for (const c of categoriesFor(direction)) {
    let score = 0;
    for (const w of words(c.label)) if (said.has(w)) score += 3;
    for (const w of words(c.group_label)) if (said.has(w)) score += 1;
    for (const w of words(c.hint)) if (said.has(w)) score += 1;
    if (score > (best?.score || 0)) best = { key: c.key, score };
  }
  return best && best.score >= 3 ? best.key : null;
}

/** A handful of common categories to offer as chips when nothing was guessed. */
export function categoryChoices(direction, limit = 8) {
  const preferred = direction === 'in'
    ? ['product_sales', 'service_income', 'subscription_income', 'advance_received',
      'interest_income', 'capital_contribution', 'loan_received', 'other_income']
    : ['salaries', 'rent', 'software_subs', 'utilities', 'office_supplies',
      'local_travel', 'professional_fees', 'other_expense'];
  const live = categoriesFor(direction);
  const byKey = new Map(live.map((c) => [c.key, c]));
  const picked = preferred.map((k) => byKey.get(k)).filter(Boolean);
  for (const c of live) {
    if (picked.length >= limit) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked.slice(0, limit).map((c) => ({ value: c.key, label: c.label }));
}

/* ── projects ─────────────────────────────────────────────────────────────── */

const PROJECT_CODE = /\bPRJ-\d{4}-\d{3}\b/i;
const PROJECT_CUE = /\b(?:for|on)\s+(?:the\s+)?(?:project\s+)?|\bproject\s+/i;
const NAME_STOP = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'on', 'project', 'website', 'app', 'work', 'job',
  'ltd', 'limited', 'pvt', 'private', 'inc', 'llc', 'llp', 'co', 'corp', 'company', 'group']);
const tokens = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Which project a sentence names, from the open projects the caller passes
 * ([{ id, code, name, client }]). Deterministic:
 *
 *   · a code (PRJ-2026-014) wins outright;
 *   · otherwise, after "for", "on" or "project", the projects whose name's
 *     distinctive words all appear in the sentence — "for the Acme website"
 *     finds "Acme website"; "on project Apollo" finds "Apollo";
 *   · a client name alone counts too, when that client has exactly one open
 *     project.
 *
 * Returns { project, match } for one clear answer, { candidates } when several
 * fit (asked as a question), or null when no project is mentioned at all.
 */
export function parseProject(text, projects = []) {
  const raw = String(text || '');
  if (!projects.length) return null;
  const code = raw.match(PROJECT_CODE);
  if (code) {
    const p = projects.find((x) => String(x.code).toLowerCase() === code[0].toLowerCase());
    return p ? { project: p, match: code[0] } : null;
  }
  const said = new Set(tokens(raw));
  const cued = PROJECT_CUE.test(raw);
  const fits = (ws) => ws.length > 0 && ws.every((w) => said.has(w));
  const scored = [];
  for (const p of projects) {
    const name = tokens(p.name).filter((w) => !NAME_STOP.has(w));
    const client = tokens(p.client).filter((w) => !NAME_STOP.has(w));
    // "Acme website" for client Acme reduces to "acme": that is a mention of
    // the client, not of this project, and scores like one.
    const full = tokens(p.name);
    const onlyClientWords = name.length > 0 && name.every((w) => client.includes(w));
    if (fits(full)) scored.push({ p, score: 20 + full.length });
    else if (fits(name) && !onlyClientWords) scored.push({ p, score: 10 + name.length });
    else if (fits(client)) scored.push({ p, score: 1 + client.length, byClient: true });
  }
  if (!scored.length) return null;
  const best = Math.max(...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best);
  if (top.length === 1 && (cued || !top[0].byClient)) {
    const source = top[0].byClient ? top[0].p.client : top[0].p.name;
    // Take the whole name out of the description when it is written out in
    // full ("for the Acme website"); otherwise just its distinctive words.
    const phrase = (ws) => new RegExp(
      `(?:\\b(?:for|on)\\s+(?:the\\s+)?(?:project\\s+)?)?${ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]+')}`, 'iu');
    const m = raw.match(phrase(tokens(source)))
      || raw.match(phrase(tokens(source).filter((w) => !NAME_STOP.has(w))));
    return { project: top[0].p, match: m ? m[0] : '' };
  }
  return { candidates: top.map((x) => x.p) };
}

/* ── reading a whole sentence ─────────────────────────────────────────────── */

const LEAD = /^\s*(?:please\s+)?(?:can\s+you\s+)?(?:record|log|enter|add|note(?:\s+down)?|book|create)?\s*(?:an?|the)?\s*(?:new\s+)?(?:cash\s*(?:in|out)|money\s*(?:in|out)|expense|income|entry|payment|receipt)?\s*(?:of|for|:)?\s*/i;
const VERBS = /\b(spent|spend|paid|pay|bought|buy|purchased|received|receive|got|earned|collected|sold)\b/gi;
const FILLER = /\b(today|yesterday|rupees?|only|approx(?:imately)?|about|around|via|using|through|by|in|to|from|towards?|for|on|the|a|an|and|it|we|i|was|were|worth|of|our|my|some|please|thanks?)\b/gi;

/** What is left of a sentence once the structured parts have been taken out. */
export function cleanDescription(rest) {
  const cleaned = String(rest || '')
    .replace(LEAD, ' ')
    .replace(VERBS, ' ')
    .replace(FILLER, ' ')
    .replace(/[^\p{L}\p{N}\s&/-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 2) return '';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Everything a single sentence gives up, as a patch onto a draft.
 *
 * Each parser hands back the text it claimed, and that text is removed before
 * the next one looks — which is how "paid 25000 on 5 Oct" does not file a
 * payment of five rupees, and how the description ends up as "rent" rather
 * than as the whole sentence over again.
 */
export function parseCashSentence(text, direction, today = todayIso(), projects = []) {
  let rest = String(text || '');
  const patch = {};

  const proj = parseProject(rest, projects);
  if (proj?.project) {
    patch.project_id = proj.project.id;
    if (proj.match) rest = rest.replace(proj.match, ' ');
  } else if (proj?.candidates) {
    patch.project_candidates = proj.candidates.map((p) => ({ id: p.id, code: p.code, name: p.name }));
  }

  const when = parseDate(rest, today);
  if (when) {
    patch.date = when.date;
    rest = rest.replace(when.match, ' ');
  }

  const gst = parseGstRate(rest);
  if (gst) {
    patch.tax_rate = gst.rate;
    rest = rest.replace(gst.match, ' ');
  }

  const amount = parseAmount(rest);
  if (amount) {
    patch.original_amount = String(amount.amount);
    if (amount.currency) patch.currency = amount.currency;
    rest = rest.replace(amount.match, ' ');
  } else {
    const cur = parseCurrency(rest);
    if (cur) patch.currency = cur;
  }

  const method = parseMethod(rest);
  if (method) {
    patch.payment_method = method.method;
    rest = rest.replace(method.match, ' ');
  }

  const category = guessCategory(text, direction);
  if (category) patch.category = category;

  const description = cleanDescription(rest);
  if (description) patch.description = description;

  return patch;
}

/** A first draft, from the message that started it all. */
export function startDraft(text, direction, today = todayIso(), projects = []) {
  const draft = blankDraft(direction, today);
  const next = { ...draft, ...parseCashSentence(text, direction, today, projects) };
  if (Number(next.tax_rate) > 0) {
    next.tax_amount = String(taxFromRate(baseAmount(next), next.tax_rate));
  }
  return next;
}

/* ── the questions ────────────────────────────────────────────────────────── */

const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';

/**
 * What still needs asking, or null when the draft is ready to be reviewed.
 *
 * Only what is missing gets asked. A message that already said how much, what
 * for and how it was paid goes straight to the confirmation card — the point
 * of the questions is to finish an entry, not to interrogate somebody who has
 * already told you everything.
 */
export function nextQuestion(draft) {
  if (!draft) return null;

  if (!draft.direction) {
    return {
      slot: 'direction',
      text: 'Did this money come in, or go out?',
      options: [{ value: 'in', label: 'Money in' }, { value: 'out', label: 'Money out' }],
    };
  }

  if (!(Number(draft.original_amount) > 0)) {
    return {
      slot: 'amount',
      text: `How much ${draft.direction === 'in' ? 'came in' : 'went out'}?`,
      free: true,
    };
  }

  if (!has(draft.description)) {
    return {
      slot: 'description',
      text: 'What was it for?',
      free: true,
    };
  }

  if (!has(draft.category)) {
    return {
      slot: 'category',
      text: 'Which of these does it belong under?',
      options: categoryChoices(draft.direction),
      free: true,
    };
  }

  if (!has(draft.date)) {
    return {
      slot: 'date',
      text: 'What date did it happen?',
      options: [{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }],
      free: true,
    };
  }

  if (!has(draft.payment_method)) {
    return {
      slot: 'payment_method',
      text: draft.direction === 'in' ? 'How was it received?' : 'How was it paid?',
      options: methodOptions(),
      free: true,
    };
  }

  // Asked only when the sentence named a project (or its client) ambiguously.
  if (!has(draft.project_id) && (draft.project_candidates || []).length > 0) {
    return {
      slot: 'project',
      text: 'Which project? (or none)',
      options: [
        ...draft.project_candidates.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` })),
        { value: 'none', label: 'None' },
      ],
    };
  }

  return null;
}

/** Fields that survive a change of direction, because they mean the same on both sides. */
function stripDirectional(draft) {
  const {
    direction: _d, category: _c, client_id: _cl, vendor_id: _v, employee_id: _e,
    product_id: _p, department_id: _dept, catalog_item_id: _cat, billable: _b, status: _s,
    ...rest
  } = draft || {};
  return rest;
}

/** Anything else an answer happened to mention, where the draft is still empty. */
function absorb(draft, text, today) {
  const next = { ...draft };
  if (!has(next.payment_method)) {
    const m = parseMethod(text);
    if (m) next.payment_method = m.method;
  }
  const when = parseDate(text, today);
  if (when) next.date = when.date;
  if (!Number(next.tax_rate)) {
    const gst = parseGstRate(text);
    if (gst) {
      next.tax_rate = gst.rate;
      next.tax_amount = String(taxFromRate(baseAmount(next), gst.rate));
    }
  }
  return next;
}

/**
 * An answer, folded into the draft. Returns `{ draft }` or `{ error }`.
 *
 * An answer is read for everything it contains, not only for the slot that was
 * asked: somebody answering "how much?" with "4500 by UPI yesterday" has
 * answered three questions, and asking the other two back at them is how a
 * form-filling chat becomes worse than the form it replaced.
 */
export function applyAnswer(draft, slot, text, today = todayIso()) {
  const answer = String(text || '').trim();
  if (!answer) return { error: 'I did not catch that.' };

  switch (slot) {
    case 'direction': {
      const direction = parseDirection(answer);
      if (!direction) return { error: 'Say “in” if the money came in, or “out” if it went out.' };
      const next = { ...blankDraft(direction, draft?.date || today), ...stripDirectional(draft), direction };
      // Category is direction-specific: one guessed for the other side of the
      // ledger does not exist on this one.
      next.category = guessCategory(answer, direction) || '';
      return { draft: absorb(next, answer, today) };
    }

    case 'amount': {
      const parsed = parseAmount(answer);
      if (!parsed) return { error: 'I need a figure — something like 4,500 or $1,200.' };
      const next = { ...draft, original_amount: String(parsed.amount) };
      if (parsed.currency) next.currency = parsed.currency;
      else {
        const cur = parseCurrency(answer);
        if (cur) next.currency = cur;
      }
      return { draft: absorb(next, answer.replace(parsed.match, ' '), today) };
    }

    case 'description': {
      const desc = answer.slice(0, 120);
      const next = { ...draft, description: desc.charAt(0).toUpperCase() + desc.slice(1) };
      if (!has(next.category)) next.category = guessCategory(answer, draft.direction) || '';
      return { draft: absorb(next, answer, today) };
    }

    case 'category': {
      const exact = categoryOf(answer);
      const key = exact && exact.direction === draft.direction
        ? exact.key
        : guessCategory(answer, draft.direction);
      if (!key) return { error: 'I could not place that one. Pick one of the options, or say it another way.' };
      return { draft: { ...draft, category: key } };
    }

    case 'date': {
      const when = parseDate(answer, today);
      if (!when) return { error: 'A date like “yesterday”, “5 Oct” or 2026-10-05.' };
      return { draft: { ...draft, date: when.date } };
    }

    case 'project': {
      if (/^(none|no|nope|overhead|no project|n\/a)$/i.test(answer)) {
        return { draft: { ...draft, project_id: '', project_candidates: [] } };
      }
      const cands = draft.project_candidates || [];
      const pick = cands.find((p) => p.id === answer)
        || parseProject(answer, cands.map((p) => ({ ...p, client: '' })))?.project;
      if (!pick) return { error: 'Pick one of the projects, or say “none”.' };
      return { draft: { ...draft, project_id: pick.id, project_candidates: [] } };
    }

    case 'payment_method': {
      const lower = answer.toLowerCase();
      const known = PAYMENT_METHODS.find((m) => m.key === lower || m.label.toLowerCase() === lower);
      const method = known?.key || parseMethod(answer)?.method;
      if (!method) return { error: 'Cash, bank transfer, UPI, card, cheque or wallet.' };
      return { draft: { ...draft, payment_method: method } };
    }

    default:
      return { error: 'I am not sure what that answers.' };
  }
}

/* ── the entry ────────────────────────────────────────────────────────────── */

/** What the entry is worth in rupees — the figure every total sums. */
export function baseAmount(draft) {
  return Math.round((Number(draft?.original_amount) || 0) * (Number(draft?.fx_rate) || 1) * 100) / 100;
}

/** The treatment this draft will be stamped with, which decides what it does to profit. */
export const draftTreatment = (draft) => (draft?.direction
  ? treatmentOf(draft.category, draft.direction)
  : null);

/** Everything that would stop this being written. An empty list means it is ready. */
export function validateDraft(draft) {
  const problems = [];
  if (!draft?.direction) problems.push('Say whether the money came in or went out.');
  if (!has(draft?.description)) problems.push('Say what this was for.');
  if (!(Number(draft?.original_amount) > 0)) problems.push('Enter an amount greater than zero.');
  if (!(Number(draft?.fx_rate) > 0)) problems.push('Enter an exchange rate greater than zero.');
  if (!has(draft?.category)) problems.push('Choose a category.');
  if (!has(draft?.date)) problems.push('Choose a date.');
  if (Number(draft?.tax_amount || 0) > baseAmount(draft)) {
    problems.push('The GST cannot be more than the amount it is part of.');
  }
  return problems;
}

/**
 * The draft as orgStore wants it: a section, and a row for it.
 *
 * `direction` is dropped for the same reason CashBook drops it — it is how
 * this code decides which table to write, not a column in either of them.
 */
export function toEntry(draft) {
  const { direction, project_id: projectId, project_candidates: _pc, ...data } = draft;
  return {
    section: SECTION_OF[direction],
    // Saved after the row, as a whole-entry allocation (projectService.allocate).
    allocation: projectId
      ? { source_type: direction === 'in' ? 'income_entry' : 'expense', project_id: projectId }
      : null,
    data: {
      ...data,
      original_amount: Number(draft.original_amount) || 0,
      fx_rate: Number(draft.fx_rate) || 1,
      tax_amount: Number(draft.tax_amount) || 0,
      tax_rate: Number(draft.tax_rate) || 0,
    },
  };
}

const nn = (v) => (v === '' || v === undefined ? null : v);

/**
 * The draft as a database row: `{ table, row }`.
 *
 * Column for column what orgStore's `expenses` / `income_entries` toRow()
 * writes for the same draft, so an entry the agent records from the server is
 * indistinguishable from one recorded on the Cash Book screen. `amount`,
 * `treatment` and `net_amount` are never sent: the 0038/0041 guards derive
 * them from original_amount × fx_rate and the category.
 */
export function cashEntryRow(draft) {
  const { section, data } = toEntry(draft);
  const common = {
    description: data.description || '',
    original_amount: data.original_amount,
    currency: String(data.currency || 'INR').toUpperCase(),
    fx_rate: data.fx_rate || 1,
    tax_amount: data.tax_amount, tax_rate: data.tax_rate,
    payment_method: data.payment_method || 'bank_transfer',
    reference: nn(data.reference),
    client_id: nn(data.client_id),
    country_code: nn(data.country_code), place_of_supply: nn(data.place_of_supply),
    is_inter_state: data.is_inter_state === true,
    quantity: data.quantity === '' || data.quantity == null ? null : Number(data.quantity) || 0,
    unit: nn(data.unit),
    receipt_path: nn(data.receipt_path),
    notes: nn(data.notes),
  };
  if (section === 'expenses') {
    return {
      table: 'expenses',
      row: {
        ...common,
        category: data.category || 'other_expense',
        incurred_on: data.date,
        vendor_id: nn(data.vendor_id), employee_id: nn(data.employee_id),
        product_id: nn(data.product_id), department_id: nn(data.department_id),
        billable: data.billable === true,
        status: data.status === 'pending' ? 'pending' : 'paid',
      },
    };
  }
  return {
    table: 'income_entries',
    row: {
      ...common,
      category: data.category || 'other_income',
      received_on: data.date,
      catalog_item_id: nn(data.catalog_item_id),
    },
  };
}

export default {
  cashEntryRow,
  detectCashIntent, isCancel, isQuestion, amountHints,
  parseDirection, startDraft, blankDraft, nextQuestion, applyAnswer,
  parseCashSentence, parseAmount, parseDate, parseMethod, parseGstRate, cleanDescription, parseProject,
  guessCategory, categoryChoices, methodOptions, taxFromRate,
  baseAmount, draftTreatment, validateDraft, toEntry, SECTION_OF, CURRENCIES,
};
