import { normalizeMessage } from './text.js';
import { readConcepts, IGNORABLE, isConcept } from './lexicon.js';
import { extractPeriod, withoutPeriod } from './periods.js';
import { describeIntent, getIntent } from './intents.js';
import { parseDate, shiftDays, isIsoDate } from '../../../../src/shared/dates.js';
import { parseAmount, detectCashIntent, parseCashSentence } from '../../../../src/shared/cashIntent.js';
import { PAGES } from '../tools/navigate.js';

/**
 * Understanding a message without a model.
 *
 *   normalise → talk/controls → navigation → one-record questions → changes
 *   (strict sentence patterns) → "this needs the model" signals → reads
 *   (concept rules) → follow-ups against the last answer → compound reads
 *
 * The result is a routing decision, never an action:
 *
 *   { intent, parameters, entities, confidence, missingParameters,
 *     ambiguities, executionRoute, reason, requiresConfirmation,
 *     requiredPermissions }
 *
 *   executionRoute  'local'    a business function answers it (engine.js)
 *                   'clarify'  supported, but one thing has to be asked
 *                   'llm'      genuinely the model's
 *
 * Matching words is not understanding. A decision is 'local' only when every
 * meaningful word of the message is accounted for — by a concept the chosen
 * rule uses, a period, or a record the person may see. A word nothing
 * explains lowers the confidence; so does a concept the rule has no use for,
 * and a negation no phrase claims sends the message to the model outright.
 * Nothing is ever mapped to "the nearest" intent.
 *
 * Authorisation is not decided here. The decision names the permission its
 * tool needs (read off the tool itself); the engine and the tool enforce it.
 */

/* Calibrated on local/evalset.js (see local/eval.test.js): at 0.80 the eval
   set has no wrongly executed message, and one unexplained word (-0.30) or
   one unused concept (-0.30) always falls below it. */
export const T_LOCAL = 0.8;
export const T_CLARIFY = 0.5;
export const MAX_TOKENS = 28;

const BASE = { exact: 0.97, pattern: 0.93, concept: 0.92, followUp: 0.88 };
const PENALTY = { residue: 0.3, unused: 0.3, correction: 0.04, period: 0.3 };

/* ── the decision ─────────────────────────────────────────────────────────── */

function decide(intentId, route, extra = {}) {
  const d = describeIntent(intentId);
  return {
    intent: intentId,
    parameters: {},
    entities: [],
    confidence: 0,
    missingParameters: [],
    ambiguities: [],
    executionRoute: route,
    reason: '',
    requiresConfirmation: !!d?.requiresConfirmation,
    requiredPermissions: d?.requiredPermissions || [],
    readOnly: d ? d.readOnly : true,
    ...extra,
  };
}

const toModel = (intentId, reason, extra = {}) => decide(intentId, 'llm', { reason, ...extra });

/* ── talk and controls ────────────────────────────────────────────────────── */

const NAMES = '(?:\\s+(?:there|buddy|steve|elon|mark|team|everyone))?';
const END = '[\\s!.?]*$';
const SOCIAL = [
  ['GREETING', new RegExp(`^(?:hi+|hello+|hey+|yo|hiya|namaste|good (?:morning|afternoon|evening|day)|sup|what is up|howdy|gm)${NAMES}${END}`, 'i')],
  ['THANKS', new RegExp(`^(?:ok(?:ay)?[, ]+)?(?:thanks+|thank you|thx|ty|thanks a lot|thank you so much|thanks so much|great,? thanks|cheers|appreciate it|much appreciated|many thanks)${NAMES}${END}`, 'i')],
  ['FAREWELL', new RegExp(`^(?:bye+|goodbye|see you|see ya|good night|gn|talk later|catch you later|later)${NAMES}${END}`, 'i')],
  ['HELP', /^(?:help|help me|what can you do(?: for me)?|what do you do|how can you help(?: me)?|what are you capable of|what can i ask(?: you)?|commands|menu|how does this work|how do i use (?:this|you)|what can buddy do|what are your (?:features|capabilities)|what all can you do)[\s!.?]*$/i],
  ['IDENTITY', /^(?:who are you|what are you|what is your name|are you (?:a |an )?(?:ai|bot|robot|human|real(?: person)?))[\s!.?]*$/i],
  ['UNDO_HINT', /^(?:undo|revert|roll ?back|take (?:that|it) back)(?:\s+(?:that|it|this|the last (?:one|change|thing)))?[\s!.?]*$/i],
];
const ACK = /^(?:ok(?:ay)?|k|kk|cool|great|nice|got it|alright|sure|perfect|awesome|sounds good|good|fine|noted|understood|makes sense|will do|right|hmm+|👍|👌)[\s!.?]*$/i;
const YES = /^(?:yes|yeah|yep|yup|ya|y|sure|ok(?:ay)?|go ahead|do it|confirm(?: it| that)?|please do|yes please|go for it|approve(?: it)?|proceed|correct|right|sounds good|looks good|lgtm|ship it)[\s!.?]*$/i;
const NO = /^(?:no|nope|nah|n|no thanks|not now|never ?mind|nevermind|cancel(?: it| that| this)?|scrap (?:it|that|this)|forget (?:it|that)|leave it|drop it|stop|discard(?: it| that)?|do not|skip(?: it| that)?|abort)[\s!.?]*$/i;

const NEGATED_COMMAND = /^(?:do not|never|stop|no need to|you need not|please do not)\s+(?:show|list|display|send|create|add|delete|remove|tell|give|open|mark|make|remind|email|invoice|record|log|update|change|move|assign|cancel|issue)\b/i;

function talk(u, env) {
  const text = u.clean;
  const open = env.openCards || [];
  if (env.pending) return null; // an answer to an open question is the engine's to read
  // On a call a spoken yes may confirm a low-risk card (confirm_proposal): the model's, with the server's guards.
  if (env.voice && open.length && (YES.test(text) || NO.test(text))) return toModel('OPEN_ENDED', 'A spoken yes or no about an open card.');
  if (open.length && YES.test(text)) return decide('CONFIRM_HINT', 'local', { confidence: BASE.exact, reason: 'A typed yes while a card is open: cards are confirmed by tapping.' });
  if (NO.test(text)) {
    if (open.length === 1) return decide('CANCEL_PROPOSAL', 'local', { confidence: BASE.exact, parameters: { action_id: open[0].action_id }, reason: 'Withdraws the one open card.' });
    if (open.length > 1) return decide('CANCEL_PROPOSAL', 'clarify', { confidence: BASE.exact, ambiguities: [{ param: 'action_id', options: open.map((c) => ({ label: c.title, value: c.action_id })) }], reason: 'Several cards are open; which one is asked.' });
    return decide('BARE_ANSWER', 'local', { confidence: BASE.exact, parameters: { said: 'no' }, reason: 'A no with nothing open to refuse.' });
  }
  for (const [id, re] of SOCIAL) if (re.test(text)) return decide(id, 'local', { confidence: BASE.exact, reason: 'Small talk needs no model.' });
  if (ACK.test(text)) return decide('ACKNOWLEDGE', 'local', { confidence: BASE.exact, reason: 'An acknowledgement.' });
  if (YES.test(text)) return decide('BARE_ANSWER', 'local', { confidence: BASE.exact, parameters: { said: 'yes' }, reason: 'A yes with nothing open to agree to.' });
  if (NEGATED_COMMAND.test(u.clean) || NEGATED_COMMAND.test(u.core)) {
    return decide('DECLINED_COMMAND', 'local', { confidence: BASE.pattern, reason: 'An instruction not to do something: nothing is run.' });
  }
  return null;
}

/* ── navigation ───────────────────────────────────────────────────────────── */

const PAGE_WORDS = {
  hub: ['hub', 'home'],
  dashboard: ['dashboard', 'overview page', 'main dashboard'],
  finance_dashboard: ['finance dashboard', 'financial dashboard', 'money dashboard'],
  sales_dashboard: ['sales dashboard'],
  team_dashboard: ['team dashboard'],
  usage: ['usage', 'ai usage', 'usage dashboard'],
  tasks: ['tasks', 'task', 'task board', 'task list', 'todos'],
  projects: ['projects', 'project list'],
  new_project: ['new project', 'create project'],
  timesheets: ['timesheets', 'timesheet'],
  crm: ['crm', 'crm board', 'pipeline', 'sales pipeline', 'leads'],
  clients: ['clients', 'customers', 'client list', 'customer list'],
  products: ['products', 'catalog', 'catalogue', 'product list'],
  invoices: ['invoices', 'invoice list', 'invoice'],
  new_invoice: ['new invoice', 'invoice form'],
  quotations: ['quotations', 'quotes', 'quotation list'],
  new_quotation: ['new quotation', 'new quote'],
  proforma: ['proforma', 'proformas', 'proforma invoices'],
  recurring: ['recurring', 'recurring invoices'],
  cashbook: ['cashbook', 'cash book'],
  vendors: ['vendors', 'suppliers', 'vendor list'],
  purchases: ['purchases', 'purchase bills', 'vendor bills', 'bills'],
  profit_loss: ['profit and loss', 'profit & loss', 'p&l', 'pnl', 'profit loss', 'p and l'],
  tax_summary: ['tax summary', 'gst summary', 'taxes', 'gst report', 'tax report'],
  employees: ['employees', 'employee list', 'staff list', 'team page', 'people'],
  new_employee: ['new employee', 'add employee'],
  attendance: ['attendance'],
  leave: ['leave', 'leave requests', 'leaves'],
  announcements: ['announcements'],
  offers: ['offers', 'offer letters'],
  ndas: ['ndas', 'nda'],
  mous: ['mous', 'mou'],
  certificates: ['certificates'],
  library: ['library', 'document library', 'documents', 'files'],
  edgebrain: ['edgebrain', 'edge brain', 'brain', 'company memory', 'knowledge graph'],
  settings: ['settings', 'company profile', 'profile', 'preferences', 'company settings'],
};
const PAGE_OF = new Map();
for (const [key, list] of Object.entries(PAGE_WORDS)) for (const w of list) PAGE_OF.set(w, key);
// "open tasks" is as much "tasks that are open" as "open the Tasks screen".
const STATUS_READS = { tasks: 'LIST_TASKS', invoices: 'GET_OUTSTANDING_INVOICES', projects: 'LIST_PROJECTS', quotations: 'LIST_INVOICES', leave: 'LIST_LEAVE' };

const NAV = /^(?<verb>open|go to|goto|take me to|navigate to|bring up|jump to|switch to|head to|show me|show|launch|visit)\s+(?:the\s+|my\s+|our\s+)?(?<what>.+?)(?<suffix>\s+(?:page|screen|section|tab|board|view|module|window))?$/i;

function navigation(u) {
  const m = u.core.match(NAV);
  if (!m) return null;
  const { verb, what, suffix } = m.groups;
  const page = PAGE_OF.get(what.toLowerCase().trim());
  if (!page || !PAGES[page]) return null;
  const showy = /^show/i.test(verb);
  if (showy && !suffix) return null; // "show invoices" asks for the invoices, not the screen
  if (!suffix && /^open$/i.test(verb) && STATUS_READS[page]) {
    const read = STATUS_READS[page];
    const fixed = read === 'LIST_INVOICES' ? { type: 'quotation', status: 'sent' } : read === 'LIST_LEAVE' ? { status: 'pending' } : {};
    return decide('OPEN_PAGE', 'clarify', {
      confidence: 0.6,
      parameters: { page },
      ambiguities: [{
        param: 'intent',
        question: `Do you want the ${PAGES[page].label} screen, or the ones that are still open?`,
        options: [
          { label: `Open ${PAGES[page].label}`, value: 'OPEN_PAGE', args: { page } },
          { label: `List open ${what.toLowerCase()}`, value: read, args: fixed },
        ],
      }],
      reason: '"open" reads both as a command and as a status.',
    });
  }
  return decide('OPEN_PAGE', 'local', { confidence: BASE.pattern, parameters: { page }, reason: 'Asked to go to a screen.' });
}

/* ── helpers for sentence patterns ────────────────────────────────────────── */

const AMT = '(?:(?:₹|rs\\.?|inr|\\$|usd|€|£)\\s?)?\\d[\\d,]*(?:\\.\\d+)?\\s?(?:k|l|lac|lacs|lakh|lakhs|cr|crore|crores|m|mn|million|thousand)?\\b';
const METHOD = 'upi|cash|cheque|check|card|bank transfer|neft|imps|rtgs|wallet|gpay|phonepe|paytm';
const DOC_CODE = /\b[a-z]{2,6}[-/]\d[\w/-]*\b/i;
const isDocish = (s) => DOC_CODE.test(s) || /\b(?:invoice|proforma|quotation|quote)\b/i.test(s);
const BULK = /\b(?:all|every|each|both|everything|everyone)\b/i;
const MULTI = /(?:\band\b|\bthen\b|\balso\b|[,;])\s+(?:then\s+|also\s+|please\s+)?(?:mark|create|add|delete|remove|send|assign|move|invoice|bill|record|remind|email|message|tell|update|set|make|schedule|cancel|issue|convert|draft|quote|log|text|ping)\b/i;
const CLOCK = /\b(?:at\s+)?\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\bat\s+\d{1,2}(?::\d{2})?\b|\b(?:morning|afternoon|evening|noon|midnight|tonight)\b|\bin\s+\d+\s+(?:minutes?|mins?|hours?|hrs?)\b/i;
const ME = /^(?:me|myself|i|mine)$/i;

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const unquote = (s) => String(s || '').trim().replace(/^["'“”‘’]+|["'“”‘’.]+$/g, '').trim();

/** A task as it was referred to: "the pricing one" → "pricing", "that task" stays a pointer. */
function taskRef(s) {
  const t = unquote(s);
  if (/^(?:it|that|this|that one|this one|the task|that task|this task|the same(?: one)?)$/i.test(t)) return t;
  const stripped = t.replace(/^(?:the|my|our|that|this)\s+/i, '').replace(/\s+(?:tasks?|todo|to-do|one|item)$/i, '').trim();
  return stripped || t;
}

/** A document as it was referred to: a code, or the client whose document it is. */
function docRef(s, fallback = null) {
  const t = unquote(s);
  const code = t.match(DOC_CODE);
  if (code) return code[0];
  const name = t.replace(/^(?:the|their|its|our|that|this)\s+/i, '').replace(/\b(?:tax\s+)?(?:invoice|proforma(?: invoice)?|quotation|quote|estimate|bill|dues|balance|payment)s?\b/gi, ' ')
    .replace(/\b(?:overdue|unpaid|outstanding|pending|latest|last|open|due|late|same)\b/gi, ' ')
    .replace(/\b(?:for|from|of|to)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return name || fallback;
}

/**
 * A date said at the end of a phrase: "send the deck by Friday" →
 * { text: 'send the deck', date: 'Friday' }. The words are passed to the tool
 * as said (tools resolve them in the org's timezone); this only decides where
 * the phrase ends.
 */
function tailDate(text, today) {
  const s = String(text || '').trim();
  const withPrep = s.match(/^(?<head>.+?)\s+(?:by|on|due|due on|due by|before|until|till|for|at|this|coming)\s+(?<when>[^,]+)$/i);
  const whole = (words) => {
    const hit = parseDate(words, today, { prefer: 'future' });
    if (!hit) return null;
    const left = words.toLowerCase().replace(hit.match, ' ').replace(/\b(?:the|on|by|of|this|coming|at|due)\b/g, ' ').trim();
    return left ? null : words.trim();
  };
  if (withPrep) {
    // "this Friday" keeps its qualifier.
    const lead = s.slice(withPrep.groups.head.length).trim().match(/^(this|coming)\b/i);
    const said = whole(lead ? `${lead[1]} ${withPrep.groups.when}` : withPrep.groups.when);
    if (said) return { text: withPrep.groups.head.trim(), date: said };
  }
  const hit = parseDate(s, today, { prefer: 'future' });
  if (hit && s.toLowerCase().endsWith(hit.match)) {
    const head = s.slice(0, s.length - hit.match.length).replace(/\s+(?:by|on|due|before|until|till|for)\s*$/i, '').trim();
    if (head) return { text: head, date: hit.match };
  }
  return { text: s, date: null };
}

const fullDate = (words, today) => {
  const hit = parseDate(words, today, { prefer: 'future' });
  if (!hit) return null;
  const left = String(words).toLowerCase().replace(hit.match, ' ').replace(/\b(?:the|on|by|of|this|coming|at)\b/g, ' ').trim();
  return left ? null : String(words).trim();
};

const STAGE = { lead: 'lead', contacted: 'contacted', deal: 'deal', won: 'deal', lost: 'lost', archived: 'archived', archive: 'archived' };
const PRIORITY = { high: 'high', top: 'high', urgent: 'high', critical: 'high', medium: 'medium', normal: 'medium', low: 'low' };
const methodOf = (s) => {
  if (!s) return undefined;
  const t = s.toLowerCase();
  if (/upi|gpay|phonepe|paytm/.test(t)) return 'upi';
  if (/neft|imps|rtgs|bank/.test(t)) return 'bank_transfer';
  if (/cheque|check/.test(t)) return 'cheque';
  return ['cash', 'card', 'wallet'].find((k) => t.includes(k));
};

const write = (intent, parameters, extra = {}) => ({ intent, parameters, ...extra });
const escalate = (intent, reason) => ({ llm: true, intent, reason });

/* ── changes: strict sentence patterns ────────────────────────────────────── */

async function buildCreateTask(restRaw, u, env) {
  let rest = unquote(restRaw);
  const params = {};
  const forTo = rest.match(/^for\s+(?<who>.+?)\s+to\s+(?<title>.+)$/i);
  if (forTo && forTo.groups.who.split(/\s+/).length <= 3) {
    params.assignee = ME.test(forTo.groups.who) ? 'me' : forTo.groups.who.trim();
    rest = forTo.groups.title;
  } else {
    rest = rest.replace(/^(?:to|:|-|–|called|named|titled|about|that says|saying)\s+/i, '');
    const forWho = rest.match(/^for\s+(?<who>[^\s,]+(?:\s+[^\s,]+)?)$/i);
    if (forWho && !ME.test(forWho.groups.who)) {
      const hit = await env.resolve(forWho.groups.who, ['employee']);
      if (hit.status === 'one') { params.assignee = hit.id; rest = ''; }
    }
    rest = rest.replace(/^for\s+/i, '');
  }
  const assign = rest.match(/^(?<head>.+?)[,;]?\s+(?:and\s+)?(?:assign(?:ed)?(?:\s+it)?\s+to|assigned to|owner(?:\s+is)?)\s+(?<who>[^,]+)$/i);
  if (assign) { params.assignee = ME.test(assign.groups.who.trim()) ? 'me' : assign.groups.who.trim(); rest = assign.groups.head; }
  const prio = rest.match(/^(?<head>.+?)[,;]?\s+(?:with\s+|at\s+|as\s+)?(?:(?<p>high|low|medium|top)\s+priority|(?<p2>urgent))$/i);
  if (prio) { params.priority = PRIORITY[(prio.groups.p || prio.groups.p2).toLowerCase()]; rest = prio.groups.head; }
  const dated = tailDate(rest, env.today);
  if (dated.date) params.deadline = dated.date;
  const title = cap(unquote(dated.text).replace(/^to\s+/i, ''));
  if (title) params.title = title.slice(0, 200);
  return write('CREATE_TASK', params);
}

/** A bare plural noun: "completed tasks" and "lost deals" describe a list, they do not report an event. */
const BARE_NOUN = /^(?:the\s+|all\s+|our\s+|my\s+)?(?:tasks?|todos?|items?|ones?|work|deals?|leads?|clients?|customers?|accounts?|projects?|invoices?|quotes?|quotations?|bills?|payments?)$/i;
const notWe = (s) => !/^(?:we|i|you|they|us|me)$/i.test(String(s).trim());
const short = (s, n = 6) => String(s).trim().split(/\s+/).length <= n;

function partsOfContact(restRaw) {
  let rest = String(restRaw || '');
  const out = {};
  const take = (re, key, map = (m) => m[1] ?? m[0]) => {
    const m = rest.match(re);
    if (!m) return;
    out[key] = map(m).trim();
    rest = rest.replace(m[0], ' ');
  };
  take(/[\w.+-]+@[\w-]+\.[\w.-]+/, 'email', (m) => m[0]);
  take(/(?:\+?\d[\d\s-]{8,13}\d)/, 'phone', (m) => m[0]);
  take(/\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2}\b/i, 'gstin', (m) => m[0].toUpperCase());
  take(new RegExp(`\\b(?:deal\\s+)?(?:worth|value(?:d at)?|of value)\\s+(${AMT})`, 'i'), 'value');
  take(/\b(\d{1,3})\s+days?\s+(?:credit|payment terms|terms)\b/i, 'payment_terms_days');
  take(/\bcontact(?:\s+person)?(?:\s+is)?\s+(\p{Lu}[\p{L}.]*(?:\s+\p{Lu}[\p{L}.]*)?)/u, 'person_name');
  const left = rest.replace(/\b(?:and|with|email|phone|mobile|number|gstin|gst|is|at|the|their|his|her)\b/gi, ' ').replace(/[,;:.\s-]+/g, ' ').trim();
  return { out, left };
}

function clientOrVendor(kindWord, name, restRaw) {
  const kind = kindWord.toLowerCase();
  const { out, left } = partsOfContact(restRaw);
  if (left) return escalate(/vendor|supplier/.test(kind) ? 'OPEN_ENDED' : 'OPEN_ENDED', 'More detail than the pattern reads.');
  const clean = unquote(name);
  if (!clean || !short(clean, 6)) return null;
  if (/vendor|supplier/.test(kind)) {
    const p = { company_name: clean };
    if (out.gstin) p.gstin = out.gstin;
    if (out.payment_terms_days) p.payment_terms_days = Number(out.payment_terms_days);
    return write('CREATE_VENDOR', p);
  }
  const p = { name: clean };
  if (/lead|prospect/.test(kind)) p.stage = 'lead';
  for (const k of ['email', 'phone', 'person_name', 'value']) if (out[k]) p[k] = out[k];
  return write('CREATE_CLIENT', p);
}

function draftDoc(type, client, amount, desc, advance) {
  const text = `${amount || ''} ${desc || ''}`;
  if (/\b(?:each|per|apiece|x\s?\d|@)\b/i.test(text) || /\b\d+\s+(?:months?|hours?|hrs?|days?|units?|seats?|licen[cs]es?)\b/i.test(desc || '')) {
    return escalate(type, 'Several units at a rate: the model lays out the lines.');
  }
  const c = unquote(client).replace(/^(?:the|our)\s+/i, '');
  if (!c || !short(c, 6) || !notWe(c)) return null;
  const params = { client: c };
  // What the sentence says about tax and discount goes to the tool as arguments,
  // never into the line's description. Anything else of that kind is the model's.
  let line = desc || '';
  const noGst = line.match(/[,;]?\s*(?:and\s+)?(?:with\s+)?(?:no|without|zero|excluding|excl\.?)\s+(?:gst|tax)\s*$/i);
  if (noGst) { params.no_gst = true; line = line.slice(0, noGst.index); }
  const disc = line.match(/[,;]?\s*(?:and\s+|with\s+|less\s+|after\s+)?(?:an?\s+)?(\d{1,2}(?:\.\d+)?)\s?%\s+(?:discount|off)\s*$/i);
  if (disc) { params.discount_percent = Number(disc[1]); line = line.slice(0, disc.index); }
  if (/\b(?:gst|igst|tax|discount|advance|abroad|export|terms|net\s+\d+|due)\b|%/i.test(line)) return escalate(type, 'Terms the pattern does not read: the model sets them.');
  desc = line;
  if (amount) params.items = [{ description: cap(unquote(desc || '')) || undefined, rate: amount.trim() }];
  if (advance) params.advance_percent = Number(advance);
  return write(type, params);
}

const DOC_TYPE = (w) => (/quot|estimate/i.test(w) ? 'CREATE_QUOTATION' : /proforma/i.test(w) ? 'CREATE_PROFORMA' : 'CREATE_INVOICE');

const WRITE_PATTERNS = [
  /* tasks */
  [/^(?:add|create|make|new|log|set up|put in|put)\s+(?:me\s+)?(?:a\s+|an\s+|another\s+|one more\s+)?(?:new\s+)?(?:task|todo|to-do|to do|action item)\b\s*(?<rest>.*)$/i,
    (m, u, env) => buildCreateTask(m.groups.rest, u, env)],
  [/^(?:todo|to-do|task)\s*[:–-]\s*(?<rest>.+)$/i, (m, u, env) => buildCreateTask(m.groups.rest, u, env)],
  [/^remind me\s+(?:to|about)\s+(?<rest>.+)$/i, (m, u, env) => (CLOCK.test(m.groups.rest)
    ? escalate('FOLLOW_THROUGH', 'A reminder at a clock time is a scheduled message, not a task.')
    : buildCreateTask(m.groups.rest, u, env))],

  /* money received against a document — before the task patterns that end in "paid"/"done" */
  [new RegExp(`^(?:mark\\s+)?(?<doc>.+?)\\s+(?:is|as|has been|was|got|is now)\\s+(?:fully\\s+)?(?:paid|settled|cleared)(?:\\s+in full)?(?:\\s+(?:by|via|through)\\s+(?<method>${METHOD}))?$`, 'i'),
    (m) => (isDocish(m.groups.doc) && docRef(m.groups.doc)
      ? write('MARK_INVOICE_PAID', { document: docRef(m.groups.doc), method: methodOf(m.groups.method) }) : null)],
  [new RegExp(`^(?<c>.+?)\\s+(?:has\\s+|have\\s+)?(?:paid|settled|cleared)\\s+(?:the|their|its|that)\\s+(?:invoice|dues|balance|proforma)(?:\\s+in full)?(?:\\s+(?:by|via|through)\\s+(?<method>${METHOD}))?$`, 'i'),
    (m) => (notWe(m.groups.c) && short(m.groups.c, 5) ? write('MARK_INVOICE_PAID', { document: unquote(m.groups.c), method: methodOf(m.groups.method) }) : null)],
  [new RegExp(`^(?<c>.+?)\\s+(?:has\\s+|have\\s+)?paid\\s+(?:us\\s+)?(?<amt>${AMT})\\s+(?:against|towards|toward|for|on)\\s+(?<doc>.+?)(?:\\s+(?:by|via|through)\\s+(?<method>${METHOD}))?$`, 'i'),
    (m) => (notWe(m.groups.c) && isDocish(m.groups.doc)
      ? write('RECORD_PAYMENT', { document: docRef(m.groups.doc, unquote(m.groups.c)), amount: m.groups.amt.trim(), method: methodOf(m.groups.method) }) : null)],
  [new RegExp(`^(?:record|log|add)\\s+(?:a\\s+)?payment\\s+of\\s+(?<amt>${AMT})\\s+(?:against|towards|toward|for|on)\\s+(?<doc>.+?)(?:\\s+(?:by|via|through)\\s+(?<method>${METHOD}))?$`, 'i'),
    (m) => (docRef(m.groups.doc) ? write('RECORD_PAYMENT', { document: docRef(m.groups.doc), amount: m.groups.amt.trim(), method: methodOf(m.groups.method) }) : null)],

  /* documents */
  [/^(?:issue|finali[sz]e)\s+(?<doc>.+)$/i, (m) => (isDocish(m.groups.doc) && docRef(m.groups.doc) ? write('ISSUE_DOCUMENT', { document: docRef(m.groups.doc) }) : null)],
  [/^(?:cancel|void)\s+(?<doc>.+)$/i, (m) => (isDocish(m.groups.doc) && docRef(m.groups.doc) ? write('CANCEL_DOCUMENT', { document: docRef(m.groups.doc) }) : null)],
  [/^convert\s+(?<doc>.+?)\s+(?:to|into)\s+(?:an?\s+)?(?:tax\s+)?(?<target>invoice|proforma)(?:\s+invoice)?$/i,
    (m) => (docRef(m.groups.doc) ? write('CONVERT_QUOTATION', { source: docRef(m.groups.doc), target: m.groups.target.toLowerCase() }) : null)],
  [new RegExp(`^(?:invoice|bill)\\s+(?<c>.+?)\\s+(?:for\\s+)?(?<amt>${AMT})(?:\\s+(?:for|towards|against)\\s+(?<desc>.+))?$`, 'i'),
    (m) => draftDoc('CREATE_INVOICE', m.groups.c, m.groups.amt, m.groups.desc)],
  [new RegExp(`^quote\\s+(?<c>.+?)\\s+(?:for\\s+)?(?<amt>${AMT})(?:\\s+(?:for|towards)\\s+(?<desc>.+))?$`, 'i'),
    (m) => draftDoc('CREATE_QUOTATION', m.groups.c, m.groups.amt, m.groups.desc)],
  [new RegExp(`^(?:create|make|draft|raise|generate|prepare|new|start)\\s+(?:a\\s+|an\\s+|the\\s+)?(?:new\\s+)?(?:tax\\s+)?(?<type>invoice|quotation|quote|estimate|proforma(?:\\s+invoice)?)\\s+(?:for|to)\\s+(?<c>[^,]+?)(?:(?:\\s*,\\s*|\\s+(?:for|of|worth)\\s+)(?<amt>${AMT})(?:\\s+(?:for|towards)\\s+(?<desc>[^,]+))?)?(?:\\s*,\\s*(?<adv>\\d{1,3})\\s?%\\s+advance)?$`, 'i'),
    (m) => draftDoc(DOC_TYPE(m.groups.type), m.groups.c, m.groups.amt, m.groups.desc, m.groups.adv)],
  [new RegExp(`^proforma\\s+(?:invoice\\s+)?(?:for|to)\\s+(?<c>[^,]+?)\\s*,?\\s+(?<amt>${AMT})(?:\\s*,?\\s*(?<adv>\\d{1,3})\\s?%\\s+advance)?$`, 'i'),
    (m) => draftDoc('CREATE_PROFORMA', m.groups.c, m.groups.amt, null, m.groups.adv)],

  /* payment reminders (the tool writes the email from its template) */
  [/^(?:send|draft|prepare|write|create|shoot)\s+(?:a\s+|an\s+|the\s+)?(?<pay>payment\s+)?reminder\s+(?:email\s+|mail\s+)?(?:to|for)\s+(?<c>.+?)(?:\s+(?:about|for|regarding|on)\s+(?<doc>.+))?$/i,
    (m, u) => {
      const money = m.groups.pay || /\b(?:invoice|payment|dues|balance|overdue|outstanding|proforma)\b/i.test(u.core) || DOC_CODE.test(u.core);
      if (!money) return escalate('COMPOSE_MESSAGE', 'A reminder to a person about work is a message, not a payment reminder.');
      return write('DRAFT_PAYMENT_REMINDER', { invoice: docRef(m.groups.doc || '', unquote(m.groups.c)) || unquote(m.groups.c) });
    }],
  [/^(?:remind|chase|nudge|follow up with)\s+(?<c>.+?)\s+(?:about|for|on|regarding|to pay|to clear|to settle)\s+(?<doc>.+)$/i,
    (m) => (/\b(?:invoice|payment|dues|balance|overdue|outstanding|proforma)\b/i.test(m.groups.doc) || DOC_CODE.test(m.groups.doc)
      ? write('DRAFT_PAYMENT_REMINDER', { invoice: docRef(m.groups.doc, unquote(m.groups.c)) }) : null)],

  /* tasks: reopen, priority, deadline, owner, progress, done */
  [/^(?:reopen|re-open|uncomplete|unmark)\s+(?<ref>.+)$/i, (m) => write('REOPEN_TASK', { task: taskRef(m.groups.ref) })],
  [/^(?<ref>.+?)\s+(?:is|was)\s+not\s+(?:actually\s+|really\s+)?(?:done|finished|completed|complete)(?:\s+yet)?(?:\s*,?\s*(?:so\s+)?(?:please\s+)?(?:reopen|re-open)\s+(?:it|that))?$/i,
    (m) => (short(m.groups.ref, 10) ? write('REOPEN_TASK', { task: taskRef(m.groups.ref) }) : null)],
  [/^(?:make|mark|set|flag)\s+(?<ref>.+?)\s+(?:as\s+|to\s+)?(?:(?<p>high|low|medium|top|normal)\s+priority|(?<p2>urgent|critical))$/i,
    (m) => write('UPDATE_TASK', { task: taskRef(m.groups.ref), priority: PRIORITY[(m.groups.p || m.groups.p2).toLowerCase()] })],
  [/^(?:set|change|make|update)\s+(?:the\s+)?priority\s+(?:of|for|on)\s+(?<ref>.+?)\s+(?:to|as)\s+(?<p>high|low|medium|urgent|top|normal)$/i,
    (m) => write('UPDATE_TASK', { task: taskRef(m.groups.ref), priority: PRIORITY[m.groups.p.toLowerCase()] })],
  [/^(?<ref>.+?)\s+(?:is|is now|has become)\s+(?:(?<p>high|low|medium|top)\s+priority|(?<p2>urgent|critical))$/i,
    (m) => (short(m.groups.ref, 10) ? write('UPDATE_TASK', { task: taskRef(m.groups.ref), priority: PRIORITY[(m.groups.p || m.groups.p2).toLowerCase()] }) : null)],
  [/^(?:move|push|shift|change|set|update|extend)\s+(?:the\s+)?(?:deadline|due date)\s+(?:of|for|on)\s+(?<ref>.+?)\s+(?:to|till|until|for)\s+(?<date>.+)$/i,
    (m, u, env) => (fullDate(m.groups.date, env.today) && !isDocish(m.groups.ref)
      ? write('UPDATE_TASK', { task: taskRef(m.groups.ref), deadline: fullDate(m.groups.date, env.today) }) : null)],
  [/^(?:move|mark|set|change)\s+(?<c>.+?)\s+(?:to|as)\s+(?:a\s+)?(?<stage>lead|contacted|deal|won|lost|archived)$/i,
    (m) => (short(m.groups.c, 5) ? write('MOVE_CLIENT_STAGE', { client: unquote(m.groups.c).replace(/^the\s+/i, ''), stage: STAGE[m.groups.stage.toLowerCase()] }) : null)],
  [/^(?:move|push|shift|reschedule|postpone|prepone|delay|defer|extend)\s+(?<ref>.+?)\s+(?:to|till|until|for)\s+(?<date>.+)$/i,
    (m, u, env) => (fullDate(m.groups.date, env.today) && !isDocish(m.groups.ref)
      ? write('UPDATE_TASK', { task: taskRef(m.groups.ref), deadline: fullDate(m.groups.date, env.today) }) : null)],
  [/^(?<ref>.+?)\s+(?:is|has been|got|was|is now|is being)\s+(?:rescheduled|moved|pushed|postponed|shifted|delayed|deferred)\s+(?:to|till|until)\s+(?<date>.+)$/i,
    (m, u, env) => (fullDate(m.groups.date, env.today) && !isDocish(m.groups.ref)
      ? write('UPDATE_TASK', { task: taskRef(m.groups.ref), deadline: fullDate(m.groups.date, env.today) }) : null)],
  [/^set\s+(?<ref>.+?)\s+for\s+(?<date>.+)$/i,
    (m, u, env) => (fullDate(m.groups.date, env.today) && !isDocish(m.groups.ref)
      ? write('UPDATE_TASK', { task: taskRef(m.groups.ref), deadline: fullDate(m.groups.date, env.today) }) : null)],
  [/^(?:assign|reassign|give|hand over|hand|delegate)\s+(?<ref>.+?)\s+to\s+(?<who>.+)$/i,
    (m) => (short(m.groups.who, 3) && !isDocish(m.groups.ref) && !/\d/.test(m.groups.ref)
      ? write('UPDATE_TASK', { task: taskRef(m.groups.ref), assignee: ME.test(m.groups.who.trim()) ? 'me' : unquote(m.groups.who) }) : null)],
  [/^(?<who>[\p{L}.]+(?:\s+[\p{L}.]+)?)\s+(?:is taking over|is taking|will take over|will take|takes|is handling|will handle|will own|is picking up|will pick up|will do)\s+(?<ref>.+)$/iu,
    (m) => (!/^(?:it|that|this|who|what|he|she|they|we)$/i.test(m.groups.who)
      ? write('UPDATE_TASK', { task: taskRef(m.groups.ref), assignee: ME.test(m.groups.who.trim()) ? 'me' : m.groups.who.trim() }) : null)],
  [/^(?:i\s+have\s+|we\s+have\s+|i\s+|we\s+|have\s+)?(?:started|begun|began)\s+(?:work\s+|working\s+)?on\s+(?<ref>.+)$/i,
    (m) => write('UPDATE_TASK', { task: taskRef(m.groups.ref), status: 'in_progress' })],
  [/^(?:mark|set|tick off|check off|tick|check)\s+(?<ref>.+?)\s+(?:as\s+|to\s+|off\s+as\s+)?(?:done|complete|completed|finished)$/i,
    (m) => (!isDocish(m.groups.ref) ? write('COMPLETE_TASK', { task: taskRef(m.groups.ref) }) : null)],
  [/^(?:i\s+have\s+|we\s+have\s+|i\s+am\s+|we\s+are\s+|i\s+|we\s+|have\s+)?(?:finished|completed|done with|wrapped up)\s+(?<ref>.+)$/i,
    (m) => (!isDocish(m.groups.ref) && short(m.groups.ref, 10) && !BARE_NOUN.test(m.groups.ref.trim()) ? write('COMPLETE_TASK', { task: taskRef(m.groups.ref) }) : null)],
  [/^(?:complete|finish)\s+(?<ref>.+)$/i, (m) => (!isDocish(m.groups.ref) ? write('COMPLETE_TASK', { task: taskRef(m.groups.ref) }) : null)],
  [/^(?<ref>.+?)\s+(?:is|are|has been|have been|got)\s+(?:now\s+)?(?:done|finished|completed|complete)$/i,
    (m) => (!isDocish(m.groups.ref) && short(m.groups.ref, 10) ? write('COMPLETE_TASK', { task: taskRef(m.groups.ref) }) : null)],

  /* deletes: the noun says what kind of record */
  [/^(?:delete|remove|trash|get rid of)\s+(?<ref>.+)$/i, (m) => {
    const ref = m.groups.ref;
    if (/\b(?:tasks?|todo|to-do)\b/i.test(ref)) return write('DELETE_TASK', { task: taskRef(ref) });
    if (/\b(?:client|customer|lead)\b/i.test(ref)) {
      const name = ref.replace(/^(?:the|our)\s+/i, '').replace(/\b(?:client|customer|lead)\b/gi, ' ').replace(/\s+/g, ' ').trim();
      return name ? write('DELETE_CLIENT', { client: name }) : null;
    }
    return null;
  }],

  /* clients */
  [/^(?:add|create|register|onboard|save)\s+(?<name>.+?)\s+as\s+(?:a\s+|an\s+|our\s+)?(?:new\s+)?(?<kind>lead|client|customer|prospect|vendor|supplier)\b(?<rest>.*)$/i,
    (m) => clientOrVendor(m.groups.kind, m.groups.name, m.groups.rest)],
  [/^(?:add|create|new|register)\s+(?:a\s+|an\s+)?(?:new\s+)?(?<kind>lead|client|customer|prospect|vendor|supplier)\s*(?:called|named|:|-|–)?\s+(?<name>[^,]+?)(?<rest>,.*)?$/i,
    (m) => clientOrVendor(m.groups.kind, m.groups.name, m.groups.rest)],
  [/^(?:we\s+)?(?:have\s+)?lost\s+(?:the\s+)?(?<c>.+?)(?:\s+(?:deal|account|lead|contract))?$/i,
    (m) => (short(m.groups.c, 4) && !BARE_NOUN.test(m.groups.c.trim()) ? write('MOVE_CLIENT_STAGE', { client: unquote(m.groups.c), stage: 'lost' }) : null)],
  [/^(?<c>.+?)\s+(?:signed|has signed|have signed|is signed|signed up|signed the contract|said yes|is onboard|is on board|is a client now|came through)$/i,
    (m) => (short(m.groups.c, 4) && notWe(m.groups.c) ? write('MOVE_CLIENT_STAGE', { client: unquote(m.groups.c).replace(/^the\s+/i, ''), stage: 'deal' }) : null)],
  [/^(?:we\s+)?(?:have\s+)?(?:won|signed|landed|bagged)\s+(?:the\s+)?(?<c>.+?)(?:\s+(?:deal|account|contract))?$/i,
    (m) => (short(m.groups.c, 4) && !BARE_NOUN.test(m.groups.c.trim()) ? write('MOVE_CLIENT_STAGE', { client: unquote(m.groups.c), stage: 'deal' }) : null)],
  [/^archive\s+(?<c>.+)$/i, (m) => (short(m.groups.c, 5) && !/\btasks?\b|\bprojects?\b/i.test(m.groups.c)
    ? write('MOVE_CLIENT_STAGE', { client: unquote(m.groups.c).replace(/^the\s+/i, '').replace(/\s+(?:client|lead|account)$/i, ''), stage: 'archived' }) : null)],
  [/^(?:add\s+(?:a\s+)?note\s+(?:to|on|for)|note\s+(?:on|for))\s+(?<c>.+?)\s*[:–,-]\s*(?<note>.+)$/i,
    (m) => (/\btasks?\b/i.test(m.groups.c) ? escalate('OPEN_ENDED', 'A note on a task.')
      : write('ADD_CLIENT_NOTE', { client: unquote(m.groups.c).replace(/^the\s+/i, ''), note: cap(unquote(m.groups.note)) }))],
  [/^(?:note|make a note|add a note|jot down|note down)\s+that\s+(?<clause>.+)$/i, async (m, u, env) => {
    const wordsOf = m.groups.clause.split(/\s+/);
    for (let n = Math.min(3, wordsOf.length - 1); n >= 1; n--) {
      const hit = await env.resolve(wordsOf.slice(0, n).join(' ').replace(/['’]s$/i, ''), ['client']);
      if (hit.status === 'one') return write('ADD_CLIENT_NOTE', { client: hit.id, note: cap(unquote(m.groups.clause)) }, { entities: [hit] });
    }
    return escalate('OPEN_ENDED', 'A note with no client it clearly belongs to.');
  }],

  /* projects */
  [/^(?:start|create|set up|open|add|new|kick off|make)\s+(?:a\s+)?(?:new\s+)?project\s+(?:for|called|named|titled|:|-|–)?\s*(?<name>.+)$/i, (m, u, env) => {
    const end = m.groups.name.match(/^(?<head>.+?)[,;]?\s+(?:ending|ends|due|by|deadline|till|until|to finish by|finishing)\s+(?:on\s+)?(?<date>.+)$/i);
    const params = {};
    let name = m.groups.name;
    if (end && fullDate(end.groups.date, env.today)) { name = end.groups.head; params.target_end_date = fullDate(end.groups.date, env.today); }
    name = cap(unquote(name).replace(/^the\s+/i, ''));
    if (!name || !short(name, 8)) return null;
    return write('CREATE_PROJECT', { name, ...params });
  }],
];

/** A few words for what the money was: "spent 4,500 on chairs yesterday" → "Chairs". */
function cashDescription(core, patch, amount) {
  let rest = core;
  if (amount?.match) rest = rest.replace(amount.match, ' ');
  const day = parseDate(rest, '2000-01-01');
  if (day?.match) rest = rest.replace(new RegExp(day.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
  rest = rest.replace(new RegExp(`\\b(?:by|via|through|in|using)\\s+(?:${METHOD})\\b`, 'i'), ' ').replace(/\s+/g, ' ').trim();
  const from = rest.match(/^(?<who>.+?)\s+(?:has\s+|have\s+)?(?:paid|sent|transferred|wired|remitted)\s+(?:us|me)\s*(?<what>.*)$/i);
  if (from) return cap(`${from.groups.what.replace(/^(?:an?|the|for|as)\s+/i, '').trim() || 'payment'} from ${from.groups.who.trim()}`).slice(0, 120);
  const out = rest.match(/^(?:we\s+|i\s+)?(?:have\s+)?(?:spent|paid|bought|purchased|got|received|earned|collected|sold)\s+(?:on\s+|for\s+|from\s+)?(?<what>.+)$/i);
  if (out) return cap(out.groups.what.replace(/^(?:an?|the|our|some)\s+/i, '').trim()).slice(0, 120);
  return patch.description || cap(core).slice(0, 120);
}

/** Money that moved with no document behind it: the cash book's own parser decides. */
async function cashEntry(u, env) {
  const cash = detectCashIntent(u.core);
  if (!cash || !cash.certain || !cash.direction) return null;
  if (isDocish(u.core) || /\bbills?\b|\bsalar(?:y|ies)\b|\bpayroll\b|\bagainst\b/i.test(u.core)) {
    return escalate('OPEN_ENDED', 'Money tied to a document or to payroll: the model checks what it settles.');
  }
  const amount = parseAmount(u.core);
  // A sentence that merely mentions paying or receiving is not an entry: it
  // needs a figure, or an explicit instruction to record one.
  if (!amount && !/^(?:record|log|add|enter|book|create|note)\b/i.test(u.core)) return null;
  const patch = parseCashSentence(u.core, cash.direction, env.today);
  let payer = null;
  if (cash.direction === 'in') {
    // Money from a client who has an invoice open may be paying that invoice.
    const who = u.core.match(/^(?<c>.+?)\s+(?:has\s+|have\s+)?(?:paid|sent|transferred|wired|remitted)\b/i)
      || u.core.match(/\bfrom\s+(?<c>[\p{L}][\p{L}\s.&-]*?)(?:\s+(?:for|by|via|on|towards|as)\b|$)/iu);
    if (who) {
      payer = unquote(who.groups.c).replace(/^(?:the|our)\s+/i, '');
      const hit = await env.resolve(payer, ['client']);
      if (hit.status !== 'none' && (await env.hasOpenInvoices?.(hit))) {
        return escalate('RECORD_PAYMENT', 'This client has an invoice open: the money may settle it.');
      }
    }
  }
  const params = {
    source_text: u.core.slice(0, 400),
    description: cashDescription(u.core, patch, amount),
  };
  // Who it was with, as named. The tool links a client or vendor it can find
  // and carries on without the link when it cannot.
  const paidTo = cash.direction === 'out' ? u.core.match(new RegExp(`^(?:we\\s+|i\\s+)?(?:have\\s+)?paid\\s+(?<v>\\p{Lu}[\\p{L}.&-]*(?:\\s+\\p{Lu}[\\p{L}.&-]*)?)\\s+(?:${AMT})`, 'u')) : null;
  if (paidTo) { params.counterparty = paidTo.groups.v; params.description = cashDescription(u.core.replace(paidTo.groups.v, ' '), patch, amount); }
  if (cash.direction === 'in' && payer) params.counterparty = payer;
  if (amount) params.amount = amount.match.trim();
  return write(cash.direction === 'in' ? 'CREATE_INCOME' : 'CREATE_EXPENSE', params);
}

async function changes(u, env) {
  if (u.question) return null;
  let found = null;
  for (const [re, build] of WRITE_PATTERNS) {
    const m = u.core.match(re);
    if (!m) continue;
    found = await build(m, u, env);
    if (found) break;
  }
  if (!found) found = await cashEntry(u, env);
  if (!found) return null;
  if (found.llm) return toModel(found.intent, found.reason);
  if (u.uncertain) return toModel('ADVICE', 'A hedged statement is a question for the model, not a change to propose.');
  if (MULTI.test(u.core)) return toModel('BULK_CHANGE', 'More than one action in one message.');
  if (BULK.test(u.core) && !/^CREATE_/.test(found.intent)) return toModel('BULK_CHANGE', 'The same change to several records: the model lists them first.');
  const intent = getIntent(found.intent);
  const parameters = Object.fromEntries(Object.entries(found.parameters).filter(([, v]) => v !== undefined && v !== ''));
  const missing = Object.entries(intent.params).filter(([k, spec]) => spec.required && parameters[k] === undefined).map(([k]) => k);
  return decide(found.intent, 'local', {
    confidence: BASE.pattern,
    parameters,
    entities: found.entities || [],
    missingParameters: missing,
    reason: missing.length ? `Recognised; ${missing.join(', ')} still to be asked.` : 'A change said in a form the engine reads exactly. It becomes a card, never a write.',
  });
}

/* ── "this needs the model" ───────────────────────────────────────────────── */

const MODEL_SIGNALS = [
  // A fact that has changed ("Acme's contact is now Meera") is an update to propose, never a lookup.
  ['OPEN_ENDED', /\b(?:is|are|was)\s+now\b|\b(?:has|have)\s+(?:changed|moved|shifted)\b|\bchanged\s+(?:to|from)\b|\bnew\s+(?:email|e-mail|phone|number|address|contact|gstin|name)\b.*\b(?:is|are)\b|\bno longer\b/i],
  ['CREATE_PROJECT_PLAN', /\b(?:make|create|build|draw up|put together|give me|need|want)\s+(?:a|an|the|me a)\s+(?:\w+\s+)?(?:plan|roadmap|strategy|checklist|timeline)\b|\b(?:plan|prepare|get ready)\s+for\b|\bwe (?:are |will be )?launch(?:ing)?\b|\bwe need to (?:hire|launch|ship|raise)\b|\bhelp me (?:collect|prepare|launch|hire|organi[sz]e|plan|get)\b/i],
  ['COMPOSE_MESSAGE', /\b(?:draft|write|compose|rewrite|rephrase|reword|reply to|respond to|proofread|translate)\b|^(?:text|message|msg|ping|dm|whatsapp|telegram|inform|notify)\s+\S+|^tell\s+(?!me\b|us\b)\S+|^(?:email|mail)\s+(?!of\b|for\b|address\b)\S+|^let\s+(?!me\b|us\b)\S+|\b(?:let everyone know|tell the (?:group|team)|post in|announce)\b/i],
  ['FOLLOW_THROUGH', /^(?:make sure|ensure|keep after|keep chasing|stop chasing|see to it)\b|\buntil (?:it is|they|he|she)\b|^remind\s+\S+\s+(?:to|at|on|tomorrow|today)\b|\bcheck (?:on|whether|if)\b.*\band (?:tell|let) me\b/i],
  ['ADVICE', /\b(?:why|should (?:i|we)|shall (?:i|we)|how (?:do|can|should|would|could|to) (?:i|we|you)?|what (?:do|would) you (?:think|suggest|recommend|advise)|advice|advise|recommend(?:ation)?|suggest(?:ion)?|strateg(?:y|ies|ize|ise)|brainstorm|ideas?|explain|compare|comparison|analy[sz]e|analysis|forecast|predict|projection|what if|scenario|pros and cons|opinion|is it (?:a good|worth|ok|okay|wise)|can we afford|worth it|best way|tips?|improve|optimi[sz]e|negotiat\w*|summari[sz]e|trend|insightful|better|worse|healthy|enough|on track to|likely|risk of|think about)\b/i],
];

function modelSignal(u) {
  for (const [intent, re] of MODEL_SIGNALS) {
    if (re.test(u.core)) return toModel(intent, `Needs the model: ${getIntent(intent).description}`);
  }
  return null;
}

/* ── reads: rules over concepts ───────────────────────────────────────────── */

const STATUS_GROUP = ['OVERDUE', 'UNPAID', 'PAID', 'DONE', 'OPEN', 'DRAFT', 'SENT', 'CANCELLED', 'ACCEPTED', 'QUIET', 'LOST', 'WON', 'ATRISK', 'DUE'];
const OWNER_GROUP = ['MINE', 'FORME'];
const DOMAIN = [
  'INVOICE', 'QUOTE', 'PROFORMA', 'RECEIVABLE', 'PAYABLE', 'PAYMENT', 'CASH', 'CASHFLOW', 'MONEY', 'REVENUE', 'EXPENSE', 'PROFIT',
  'TASK', 'CLIENT', 'LEAD', 'PIPELINE', 'DEAL', 'PROJECT', 'TEAM', 'WORKLOAD', 'LEAVE', 'ATTENDANCE', 'VENDOR', 'BILL', 'DOCUMENT',
  'ATTENTION', 'OVERVIEW', 'ACTIVITY', 'BUDDYDID', 'PULSE',
];

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * The read a set of concepts asks for.
 *
 * Returns { intent, args, used, kinds, periodUsed, textParam } — `used` are
 * the concepts the rule accounts for, `kinds` the record kinds a leftover
 * name may be, `textParam` the argument that takes leftover words as search
 * text — or { llm, intent, reason }, { clarify: [...] }, or null.
 */
export function classifyRead(C, period, { today, text = '', docWord = null, quietDays = null } = {}) {
  const has = (...k) => k.every((x) => C.has(x));
  const any = (...k) => k.some((x) => C.has(x));
  const dates = period && (period.from || period.to) ? { from: period.from || undefined, to: period.to || undefined } : {};
  const hasPeriod = !!period;
  // "All time" is said, not assumed: the money tool defaults to this month.
  const moneyDates = period && !period.from && !period.to ? { from: '2000-01-01' } : dates;
  const rule = (intent, args, used, extra = {}) => ({ intent, args, used, kinds: [], periodUsed: false, ...extra });
  const also = [];

  if (has('BUDDYDID')) {
    const days = period?.from ? Math.min(60, Math.max(1, daysBetween(period.from, today) + 1)) : undefined;
    return rule('GET_BUDDY_ACTIVITY', { days }, ['BUDDYDID', 'ACTIVITY', 'OPEN'], { periodUsed: true });
  }
  if (has('ATTENTION')) return rule('GET_INSIGHTS', {}, ['ATTENTION', 'OVERVIEW', 'MINE', 'TASK'], { periodUsed: period?.label === 'today' });
  if (has('PULSE') && !has('TASK')) return rule('GET_TEAM_PULSE', { date: period?.from || undefined }, ['PULSE', 'TEAM', 'ACTIVITY'], { periodUsed: !period || period.from === period.to });
  if (has('ACTIVITY')) return rule('GET_RECENT_ACTIVITY', dates, ['ACTIVITY', 'TEAM', 'OVERVIEW'], { periodUsed: true });
  if (has('PROFIT')) return { llm: true, intent: 'PROFIT_ANALYSIS', reason: 'Profit and runway depend on how entries are treated; the model explains from the P&L facts.' };

  if (has('OVERVIEW')) {
    const domain = DOMAIN.filter((d) => !['OVERVIEW', 'MONEY', 'CASH'].includes(d)).some((d) => C.has(d));
    if (!domain) {
      if (any('MONEY', 'CASH')) return rule('GET_FINANCE_SUMMARY', {}, ['OVERVIEW', 'MONEY', 'CASH'], { periodUsed: period?.label === 'today' });
      return rule('GET_BUSINESS_OVERVIEW', {}, ['OVERVIEW'], { periodUsed: period?.label === 'today' });
    }
    also.push('OVERVIEW');
  }

  const finDoc = any('INVOICE', 'QUOTE', 'PROFORMA');
  const docType = has('QUOTE') && !has('INVOICE') ? 'quotation' : has('PROFORMA') && !has('INVOICE') ? 'proforma' : undefined;

  if (has('PAYABLE') || has('BILL') || (has('VENDOR') && any('UNPAID', 'OVERDUE', 'DUE', 'OPEN'))) {
    const status = has('OVERDUE') ? 'overdue' : has('PAID') ? 'paid' : any('UNPAID', 'DUE', 'OPEN', 'PAYABLE') ? 'open' : undefined;
    return rule('GET_VENDOR_BILLS', { status }, [...also, 'PAYABLE', 'BILL', 'VENDOR', 'UNPAID', 'OVERDUE', 'DUE', 'OPEN', 'PAID', 'PAYMENT', 'MONEY'], { kinds: ['vendor'] });
  }
  if (has('VENDOR') && C.size - also.length === 1) {
    return rule('OPEN_PAGE', { page: 'vendors', note: 'There is no vendor list in chat, so I have opened Vendors.' }, [...also, 'VENDOR']);
  }

  if (has('CASHFLOW') || has('REVENUE', 'EXPENSE')) {
    return rule('GET_CASH_FLOW', moneyDates, [...also, 'CASHFLOW', 'MONEY', 'CASH', 'REVENUE', 'EXPENSE', 'PAYMENT'], { periodUsed: true });
  }
  if (has('REVENUE') && !finDoc && !has('TASK')) {
    return rule('GET_MONTHLY_REVENUE', moneyDates, [...also, 'REVENUE', 'MONEY', 'CASH', 'PAYMENT'], { periodUsed: true });
  }
  if (has('EXPENSE') && !finDoc && !has('TASK')) {
    return rule('GET_EXPENSE_SUMMARY', moneyDates, [...also, 'EXPENSE', 'MONEY', 'CASH'], { periodUsed: true });
  }

  // Receivables and late money.
  const moneyish = finDoc || any('PAYMENT', 'RECEIVABLE', 'UNPAID');
  const notWork = !any('TASK', 'PROJECT', 'LEAD', 'PIPELINE', 'DEAL', 'TEAM', 'LEAVE', 'ATTENDANCE');
  const quoteOnly = docType === 'quotation';
  if (has('OVERDUE') && notWork && (moneyish || has('CLIENT')) && !quoteOnly) {
    return rule('GET_OVERDUE_PAYMENTS', { type: docType, ...dates }, [...also, 'OVERDUE', 'INVOICE', 'PROFORMA', 'PAYMENT', 'RECEIVABLE', 'UNPAID', 'CLIENT', 'DUE', 'OPEN', 'MONEY'], { kinds: ['client'], periodUsed: true });
  }
  if (notWork && !quoteOnly && (has('RECEIVABLE') || has('UNPAID') || ((finDoc || has('PAYMENT')) && any('DUE', 'OPEN')))) {
    return rule('GET_OUTSTANDING_INVOICES', { type: docType, ...dates }, [...also, 'RECEIVABLE', 'UNPAID', 'PAYMENT', 'CLIENT', 'DUE', 'OPEN', 'INVOICE', 'PROFORMA', 'MONEY'], { kinds: ['client'], periodUsed: true });
  }
  if (C.has('OVERDUE') && !DOMAIN.some((d) => C.has(d))) {
    if (any('MINE', 'FORME')) return rule('GET_OVERDUE_TASKS', { assignee: 'me' }, ['OVERDUE', 'MINE', 'FORME']);
    return rule('GET_OVERDUE_ITEMS', {}, ['OVERDUE']);
  }
  if (finDoc && notWork) {
    const status = has('DRAFT') ? 'draft' : has('PAID') ? 'paid' : has('CANCELLED') ? 'cancelled' : has('ACCEPTED') ? 'accepted'
      : has('SENT') || (quoteOnly && any('OPEN', 'DUE')) ? 'sent' : undefined;
    return rule('LIST_INVOICES', { type: docType, status, ...dates }, [...also, 'INVOICE', 'QUOTE', 'PROFORMA', 'DRAFT', 'PAID', 'SENT', 'CANCELLED', 'ACCEPTED', 'CLIENT', ...(quoteOnly ? ['OPEN', 'DUE'] : [])], { kinds: ['client'], periodUsed: true });
  }

  // Tasks.
  const mine = any('MINE', 'FORME');
  const taskish = has('TASK') || (has('DUE') && !moneyish) || (mine && any('OVERDUE', 'OPEN', 'DONE')) || (mine && hasPeriod && !DOMAIN.some((d) => C.has(d)));
  if (taskish && !any('LEAVE', 'ATTENDANCE', 'CLIENT', 'LEAD', 'PIPELINE', 'DEAL') ) {
    const used = [...also, 'TASK', 'DUE', 'OPEN', 'DONE', 'OVERDUE', 'MINE', 'FORME', 'TEAM', 'PROJECT'];
    const base = { assignee: mine ? 'me' : undefined };
    const kinds = ['employee', 'client', 'project'];
    if (has('DONE') && !has('OPEN')) {
      if (hasPeriod) return { llm: true, intent: 'OPEN_ENDED', reason: 'Tasks completed in a period need the audit trail read, not a deadline filter.' };
      return rule('LIST_TASKS', { ...base, status: 'done' }, used, { kinds });
    }
    if (has('OVERDUE')) return rule('GET_OVERDUE_TASKS', base, used, { kinds, periodUsed: period?.label === 'today' });
    const window = hasPeriod && (period.from || period.to) ? { due_after: period.from || undefined, due_before: period.to || undefined } : {};
    return rule('LIST_TASKS', { ...base, ...window }, used, { kinds, periodUsed: true });
  }

  if (any('CLIENT', 'LEAD', 'PIPELINE', 'DEAL') || (has('QUIET') && !has('TASK'))) {
    const stage = has('LOST') ? 'lost' : has('WON') ? 'deal' : has('PIPELINE') ? 'pipeline' : has('LEAD') ? 'lead' : has('DEAL') ? 'deal' : undefined;
    const inactive = has('QUIET') ? Math.min(365, Math.max(1, quietDays || 14)) : undefined;
    return rule('LIST_CLIENTS', { stage: has('QUIET') && !stage ? 'pipeline' : stage, inactive_days: inactive }, [...also, 'CLIENT', 'LEAD', 'PIPELINE', 'DEAL', 'QUIET', 'LOST', 'WON', 'OPEN']);
  }
  if (has('PROJECT')) {
    const health = any('ATRISK', 'OVERDUE') ? 'unhealthy' : undefined;
    const status = has('DONE') ? 'completed' : undefined;
    return rule('LIST_PROJECTS', { health, status }, [...also, 'PROJECT', 'ATRISK', 'OVERDUE', 'DONE', 'OPEN', 'CLIENT'], { kinds: ['client'] });
  }
  if (has('LEAVE')) {
    const status = has('OPEN') ? 'pending' : has('ACCEPTED') ? 'approved' : undefined;
    const asked = /\b(?:requests?|applications?|approvals?)\b/i.test(text);
    const window = hasPeriod ? dates : (!status && !asked ? { from: today, to: today } : {});
    return rule('LIST_LEAVE', { status, ...window }, [...also, 'LEAVE', 'TEAM', 'OPEN', 'ACCEPTED'], { kinds: ['employee'], periodUsed: true });
  }
  if (has('ATTENDANCE')) {
    const window = hasPeriod && period.from === period.to ? { date: period.from } : dates;
    return rule('GET_ATTENDANCE', window, [...also, 'ATTENDANCE', 'TEAM'], { kinds: ['employee'], periodUsed: true });
  }
  if (any('WORKLOAD', 'TEAM')) return rule('LIST_TEAM', {}, [...also, 'TEAM', 'WORKLOAD', 'TASK', 'OPEN'], { kinds: ['employee'], periodUsed: ['today', 'this week'].includes(period?.label) });
  if (has('DOCUMENT')) {
    const specific = docWord && !['document', 'doc', 'file', 'library', 'upload', 'pdf', 'paperwork'].includes(docWord) ? docWord : undefined;
    return rule('SEARCH_COMPANY_DOCUMENTS', { text: specific }, [...also, 'DOCUMENT', 'SEARCHV', 'DETAILS', 'CLIENT'], { textParam: 'text' });
  }
  if (has('CASH')) return rule('GET_CASH_BALANCE', {}, [...also, 'CASH', 'MONEY'], { periodUsed: period?.label === 'today' });
  if (has('MONEY')) return rule('GET_FINANCE_SUMMARY', {}, [...also, 'MONEY'], { periodUsed: period?.label === 'today' });
  if (has('SEARCHV')) return rule('SEARCH_RECORDS', {}, ['SEARCHV'], { textParam: 'query', needsText: true });

  if (C.has('OPEN') && !DOMAIN.some((d) => C.has(d))) {
    return {
      clarify: [
        { label: 'Open tasks', value: 'LIST_TASKS', args: {} },
        { label: 'Unpaid invoices', value: 'GET_OUTSTANDING_INVOICES', args: {} },
      ],
      question: 'Pending what — tasks, or payments?',
      used: ['OPEN'],
    };
  }
  return null;
}

/* ── one-record questions ─────────────────────────────────────────────────── */

const ALL_KINDS = ['client', 'task', 'employee', 'project', 'invoice', 'vendor'];
const KIND_WORD = { client: 'client', customer: 'client', lead: 'client', task: 'task', todo: 'task', project: 'project', invoice: 'invoice', quotation: 'invoice', quote: 'invoice', proforma: 'invoice', vendor: 'vendor', supplier: 'vendor', employee: 'employee', person: 'employee', teammate: 'employee' };

// A facet that only some kinds of record have narrows where the name is looked for.
const FACET_KINDS = {
  email: ['client', 'employee', 'vendor'], phone: ['client'], contact: ['client', 'vendor'], gstin: ['client', 'vendor'], stage: ['client'],
  role: ['employee'], balance: ['invoice'], when: ['task', 'invoice', 'project'], priority: ['task'],
};

const RECORD_PATTERNS = [
  [/^who\s+(?:is|are|will be)?\s*(?:working on|handling|doing|responsible for|assigned to|taking care of|looking after|in charge of|on)\s+(?<ref>.+)$/i, 'who', ['task', 'project']],
  [/^who\s+owns\s+(?<ref>.+)$/i, 'who', ['task', 'project']],
  [/^when\s+(?:is|are|was)\s+(?<ref>.+?)\s+(?:due|scheduled|happening|supposed to be done|expected)$/i, 'when', ['task', 'invoice', 'project']],
  [/^(?:is|are|has|have)\s+(?<ref>.+?)\s+(?:been\s+|already\s+)?(?:done|finished|completed|complete|paid|settled|overdue|late|assigned|sent|issued|started)(?:\s+yet)?$/i, 'status', ['task', 'invoice', 'project']],
  [/^(?:what is|what are)\s+(?<ref>.+?)\s+(?<facet>email|e-mail|phone|phone number|mobile|number|contact|gstin|role|status|deadline|due date|balance|stage|priority)$/i, null, ALL_KINDS],
  [/^(?<facet>email|e-mail|phone|phone number|mobile|contact|gstin|role|status|deadline|due date|balance|stage)\s+(?:of|for)\s+(?<ref>.+)$/i, null, ALL_KINDS],
  [/^(?:what is|what are)\s+the\s+(?<facet>email|e-mail|phone|phone number|mobile|contact|gstin|role|status|deadline|due date|balance|stage|priority)\s+(?:of|for|on)\s+(?<ref>.+)$/i, null, ALL_KINDS],
  [/^(?:tell me (?:more\s+)?about|what do we know about|details?\s+(?:of|on|for|about)|info(?:rmation)?\s+(?:on|about|for)|show (?:me\s+)?(?:the\s+)?details?\s+(?:of|for|on|about)|status of|what is the status of)\s+(?<ref>.+)$/i, 'all', ALL_KINDS],
  [/^(?:where are we (?:on|with)|what is happening with|what is up with|any update on|update on)\s+(?<ref>.+)$/i, 'all', ['task', 'project', 'client', 'invoice']],
];
// Forms that also open ordinary list requests ("show me unpaid invoices"):
// tried only when the message did not read confidently as one of those.
const LOOSE_RECORD_PATTERNS = [
  [/^(?:look up|lookup|pull up|bring up|how is|show me|show)\s+(?<ref>.+?)(?:\s+(?:going|doing|coming along|progressing|looking))?$/i, 'all', ALL_KINDS],
];
const FACET = { 'e-mail': 'email', 'phone number': 'phone', mobile: 'phone', number: 'phone', contact: 'contact', 'due date': 'when', deadline: 'when' };
const OPENERS = [
  /^(?:open|go to|take me to|bring up|pull up|jump to)\s+(?<ref>.+)$/i,
];

function refAndKind(refRaw, kinds) {
  let ref = unquote(refRaw).replace(/^(?:the|our|my|that|this)\s+/i, '');
  let only = null;
  const lead = ref.match(/^(client|customer|lead|task|todo|project|invoice|quotation|quote|proforma|vendor|supplier|employee|person|teammate)\s+(.+)$/i);
  const tail = ref.match(/^(.+?)\s+(client|customer|lead|task|todo|project|invoice|quotation|quote|proforma|vendor|supplier|account)$/i);
  if (lead) { only = KIND_WORD[lead[1].toLowerCase()]; ref = lead[2]; } else if (tail) { only = KIND_WORD[tail[2].toLowerCase()] || 'client'; ref = tail[1]; }
  return { ref: ref.replace(/['’]s$/i, '').trim(), kinds: only ? [only] : kinds };
}

async function oneRecord(u, env, { loose = false } = {}) {
  for (const [re, facetFixed, kinds] of (loose ? LOOSE_RECORD_PATTERNS : RECORD_PATTERNS)) {
    const m = u.core.match(re);
    if (!m) continue;
    const { ref, kinds: ks } = refAndKind(m.groups.ref.replace(/['’]s$/i, ''), kinds);
    if (!ref || ref.split(/\s+/).length > 8) continue;
    const facetWord = (m.groups.facet || '').toLowerCase();
    const facet = facetFixed || FACET[facetWord] || facetWord || 'all';
    const within = FACET_KINDS[facet] ? ks.filter((k) => FACET_KINDS[facet].includes(k)) : ks;
    const hit = await env.resolve(ref, within.length ? within : ks, { across: true });
    if (hit.status === 'one') {
      return decide('GET_RECORD_DETAILS', 'local', {
        confidence: BASE.pattern, parameters: { type: hit.kind, ref: hit.id, facet }, entities: [hit],
        reason: `One ${hit.kind} matches “${ref}”.`,
      });
    }
    if (hit.status === 'many') {
      return decide('GET_RECORD_DETAILS', 'clarify', {
        confidence: BASE.pattern, parameters: { facet },
        ambiguities: [{ param: 'ref', question: `Which one did you mean by “${ref}”?`, options: hit.options.map((o) => ({ label: `${o.label} (${o.kind})`, value: o.id, args: { type: o.kind, ref: o.id, facet } })) }],
        reason: `“${ref}” matches several records.`,
      });
    }
  }
  for (const re of (loose ? OPENERS : [])) {
    const m = u.core.match(re);
    if (!m) continue;
    const { ref, kinds } = refAndKind(m.groups.ref, ALL_KINDS);
    if (!ref || ref.split(/\s+/).length > 6) continue;
    const hit = await env.resolve(ref, kinds);
    if (hit.status === 'one') {
      return decide('OPEN_RECORD', 'local', { confidence: BASE.pattern, parameters: { type: hit.kind, ref: hit.id }, entities: [hit], reason: `Asked to open ${hit.label}.` });
    }
  }
  return null;
}

/** "What is Ravi working on?" — that person's open tasks. */
async function personWork(u, env) {
  const m = u.core.match(/^what\s+(?:is|are|am)\s+(?<who>.+?)\s+(?:working on|doing|up to|busy with|handling)(?:\s+(?:today|this week|right now|now|currently|these days))?$/i);
  if (!m) return null;
  const who = m.groups.who.trim();
  let assignee = null;
  const entities = [];
  if (/^i$/i.test(who)) assignee = 'me';
  else {
    const hit = await env.resolve(who, ['employee']);
    if (hit.status === 'many') {
      return decide('LIST_TASKS', 'clarify', {
        confidence: BASE.pattern,
        ambiguities: [{ param: 'assignee', question: `Which person did you mean by “${who}”?`, options: hit.options.map((o) => ({ label: o.label, value: o.id })) }],
        reason: 'Several people match that name.',
      });
    }
    if (hit.status !== 'one') return null;
    assignee = hit.id;
    entities.push({ ...hit, param: 'assignee' });
  }
  return decide('LIST_TASKS', 'local', {
    confidence: BASE.pattern, parameters: { assignee }, entities,
    memo: { intent: 'LIST_TASKS', concepts: ['TASK'], period: null, ents: Object.fromEntries(entities.map((e) => [e.param, { id: e.id, label: e.label, kind: e.kind }])) },
    reason: 'Asked what one person is working on.',
  });
}

/* ── arithmetic the app already defines ───────────────────────────────────── */

function calculation(u) {
  const t = u.core;
  const a = new RegExp(`^(?:what is|calculate|compute|how much is|work out)?\\s*(?:the\\s+)?(?:gst|tax)\\s+(?:on|for|of)\\s+(?<amt>${AMT})(?:\\s+(?:at|@)\\s+(?<rate>\\d+(?:\\.\\d+)?)\\s?%)?$`, 'i').exec(t)
    || new RegExp(`^(?:what is|calculate|compute|how much is|work out)?\\s*(?<rate>\\d+(?:\\.\\d+)?)\\s?%\\s+(?:gst|tax)\\s+(?:on|of|for)\\s+(?<amt>${AMT})$`, 'i').exec(t)
    || new RegExp(`^(?:what is|calculate|compute|how much is|work out)?\\s*(?<amt>${AMT})\\s+(?<mode>plus|with|\\+|and|including|incl\\.?|inclusive of|excluding|excl\\.?|before|without)\\s+(?<rate>\\d+(?:\\.\\d+)?)\\s?%\\s+(?:gst|tax)$`, 'i').exec(t);
  if (!a) return null;
  const amount = parseAmount(a.groups.amt)?.amount;
  if (!amount) return null;
  const inclusive = /^(?:including|incl|inclusive)/i.test(a.groups.mode || '');
  const rate = a.groups.rate ? Number(a.groups.rate) : undefined;
  if (rate === undefined) {
    return decide('CALCULATE_GST', 'clarify', {
      confidence: BASE.pattern, parameters: { amount, inclusive }, missingParameters: ['rate'],
      ambiguities: [{ param: 'rate', question: 'At what GST rate?', options: [5, 12, 18, 28].map((r) => ({ label: `${r}%`, value: r })) }],
      reason: 'The rate was not said, and it is not assumed.',
    });
  }
  return decide('CALCULATE_GST', 'local', { confidence: BASE.pattern, parameters: { amount, rate, inclusive }, reason: 'Arithmetic.' });
}

/* ── reads: from message to decision ──────────────────────────────────────── */

const PARAM_OF = {
  GET_OUTSTANDING_INVOICES: { client: 'client' }, GET_OVERDUE_PAYMENTS: { client: 'client' }, LIST_INVOICES: { client: 'client' },
  GET_VENDOR_BILLS: { vendor: 'vendor' }, LIST_TASKS: { employee: 'assignee', project: 'project', client: 'client' },
  GET_OVERDUE_TASKS: { employee: 'assignee', project: 'project', client: 'client' }, LIST_PROJECTS: { client: 'client' },
  LIST_TEAM: { employee: 'person' }, LIST_LEAVE: { employee: 'employee' }, GET_ATTENDANCE: { employee: 'employee' },
};

const TEXT_CUES = new Set(['about', 'regarding', 'mentioning', 'containing', 'named', 'called', 'titled', 'matching', 'saying']);

/** Leftover words as runs of neighbours: "Ravi Kumar" is one name, not two. */
function spans(residue) {
  const out = [];
  for (const r of residue) {
    const last = out[out.length - 1];
    if (last && r.at === last.end + 1) { last.words.push(r); last.end = r.at; } else out.push({ words: [r], end: r.at });
  }
  return out.map((s) => ({ text: s.words.map((w) => w.raw).join(' '), words: s.words }));
}

const signature = (C, unexplained) => `${[...C].sort().join('+') || '-'}|r${unexplained}`;

const QUIET_WORDS = /\b(?:quiet|inactive|cold|stale|contacted|untouched|dormant|no activity|heard from|touched|ghost(?:ed|ing)?)\b/i;
const QUIET_SPAN = /\b(?:(?:in|for|over|since|within)\s+)?(?:the\s+)?(?:(?:last|past)\s+)?(\d{1,3})\s*\+?\s*(day|week|month)s?\b/i;

async function reads(u, env, { text: said = u.core, base = BASE.concept, inherit = null } = {}) {
  // "not contacted in 30 days" is a length of silence, not a date range.
  let text = said;
  let quietDays = null;
  const quietSpan = QUIET_WORDS.test(text) ? text.match(QUIET_SPAN) : null;
  if (quietSpan) {
    quietDays = Number(quietSpan[1]) * (quietSpan[2].toLowerCase() === 'week' ? 7 : quietSpan[2].toLowerCase() === 'month' ? 30 : 1);
    text = text.replace(quietSpan[0], ' ').replace(/\s+/g, ' ').trim();
  }
  const prefer = /\b(?:tasks?|todo|due|deadline|leave|upcoming|coming up|off|holiday|vacation)\b/i.test(text) ? 'future' : 'past';
  const period = extractPeriod(text, env.today, { prefer }) || inherit?.period || null;
  const ownPeriod = extractPeriod(text, env.today, { prefer });
  const bare = ownPeriod ? withoutPeriod(text, ownPeriod) : text;
  const tokens = normalizeMessage(bare).tokens;
  const read = readConcepts(tokens);
  if (read.negated) return { negated: true, concepts: read.concepts };

  let C = read.concepts;
  if (C.has('MYTASK')) { C.delete('MYTASK'); C.add('TASK'); C.add('MINE'); }
  if (C.has('LATEPAY')) { C.delete('LATEPAY'); C.add('OVERDUE'); C.add('RECEIVABLE'); }
  if (inherit) {
    const merged = new Set(inherit.concepts);
    if (STATUS_GROUP.some((s) => C.has(s))) for (const s of STATUS_GROUP) merged.delete(s);
    for (const c of C) merged.add(c);
    C = merged;
  }
  const docAt = read.marks.findIndex((mk) => mk === 'DOCUMENT');
  const found = classifyRead(C, period, { today: env.today, text: bare, quietDays, docWord: docAt >= 0 ? tokens[docAt].w.replace(/s$/, '') : null });
  if (!found) return { none: true, concepts: C, residue: read.residue, period: ownPeriod };
  if (found.llm) return { decision: toModel(found.intent, found.reason) };
  if (found.clarify) {
    return {
      decision: decide('LIST_TASKS', 'clarify', {
        confidence: 0.6, ambiguities: [{ param: 'intent', question: found.question, options: found.clarify }], reason: 'One word, two readings.',
      }),
    };
  }

  const intent = getIntent(found.intent);
  const args = { ...found.args };
  const entities = [];
  const ambiguities = [];
  let unexplained = 0;
  const residue = read.residue;

  // What the last answer was about carries over unless this message replaces it.
  const carried = inherit?.ents ? { ...inherit.ents } : {};

  if (found.textParam) {
    const words = residue.map((r) => r.raw).join(' ').trim();
    // A name or a few title words — not the rest of a sentence.
    if (residue.length > 3) unexplained += residue.length - 3;
    if (words) args[found.textParam] = words;
    else if (found.needsText) unexplained += 1;
  } else {
    for (const span of spans(residue)) {
      const kinds = found.kinds;
      const cue = tokens[span.words[0].at - 1]?.w;
      if (intent.params.text && args.text === undefined && TEXT_CUES.has(cue)) { args.text = span.text; continue; }
      let hit = kinds.length ? await env.resolve(span.text, kinds) : { status: 'none' };
      if (hit.status === 'none' && span.words.length > 1 && kinds.length) {
        // A name inside a longer run: try each word on its own.
        for (const w of span.words) {
          const one = await env.resolve(w.raw, kinds);
          if (one.status === 'none') { unexplained += 1; continue; }
          hit = one; // the last word that resolves wins; the rest stay unexplained
        }
        if (hit.status === 'none') continue;
      } else if (hit.status === 'none') {
        unexplained += span.words.length;
        continue;
      }
      if (hit.status === 'many') {
        const param = PARAM_OF[found.intent]?.[hit.options[0].kind];
        ambiguities.push({ param, question: `Which ${hit.options[0].kind === 'employee' ? 'person' : hit.options[0].kind} did you mean by “${span.text}”?`, options: hit.options.map((o) => ({ label: o.label, value: o.id })) });
        continue;
      }
      const param = PARAM_OF[found.intent]?.[hit.kind];
      if (!param) { unexplained += span.words.length; continue; }
      args[param] = hit.id;
      delete carried[param];
      entities.push({ ...hit, param });
    }
  }
  for (const [param, e] of Object.entries(carried)) {
    if (args[param] === undefined && intent.params[param]) { args[param] = e.id; entities.push({ ...e, param }); }
  }

  const usedSet = new Set(found.used);
  const unused = [...C].filter((c) => !usedSet.has(c) && !IGNORABLE.has(c) && !(OWNER_GROUP.includes(c)));
  const periodLost = ownPeriod && !found.periodUsed ? 1 : 0;
  const confidence = Math.max(0, base
    - PENALTY.correction * Math.min(2, read.corrections)
    - PENALTY.residue * unexplained
    - PENALTY.unused * unused.length
    - PENALTY.period * periodLost);

  const parameters = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  const memo = {
    intent: found.intent,
    concepts: [...C].filter((c) => usedSet.has(c)),
    period: period ? { from: period.from, to: period.to, label: period.label } : null,
    ents: Object.fromEntries(entities.filter((e) => e.param).map((e) => [e.param, { id: e.id, label: e.label, kind: e.kind }])),
  };
  const d = decide(found.intent, 'local', {
    confidence,
    parameters,
    entities,
    ambiguities,
    memo,
    period: period ? { from: period.from, to: period.to, label: period.label } : null,
    signature: signature(C, unexplained),
    textual: !!found.textParam,
    unexplained,
    unused,
    reason: `Read as ${intent.description}`,
  });
  return { decision: d, concepts: C, residue: read.residue, period: ownPeriod };
}

const hasDomain = (C) => DOMAIN.some((d) => C.has(d));

/** A second message that only adjusts the first: "what about last month?", "and for Acme?", "only overdue ones". */
async function followUp(u, env, first) {
  const last = env.lastRoute;
  if (!last || !getIntent(last.intent)) return null;
  const C = first?.concepts || new Set();
  const fragment = !hasDomain(C);
  if (!fragment) return null;
  const hasSomething = !!first?.period || (first?.residue?.length || 0) > 0 || STATUS_GROUP.some((s) => C.has(s)) || OWNER_GROUP.some((s) => C.has(s));
  if (!hasSomething) return null;
  if (!u.followUp && (first?.residue?.length || 0) > 3) return null;
  const text = u.core.replace(/^(?:and|also|what about|how about|and what about|same for|same thing for|now for|then|but|only|just)\b[\s,]*/i, '')
    .replace(/\b(?:ones?|instead|then|too|as well)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const again = await reads(u, env, { text, base: BASE.followUp, inherit: { concepts: last.concepts || [], period: last.period || null, ents: last.ents || {} } });
  if (!again.decision || again.decision.executionRoute === 'llm') return null;
  again.decision.reason = `A follow-up on the last answer (${last.intent}).`;
  again.decision.followUp = true;
  return again.decision;
}

/** "overdue invoices and overdue tasks": two reads in one breath. */
async function compound(u, env) {
  const parts = u.core.split(/\s+(?:and|&|plus|as well as|and also|along with)\s+|\s*;\s*/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return null;
  const steps = [];
  for (const part of parts) {
    const n = normalizeMessage(part);
    // A bare noun ("…and tasks") would silently lose the first half's filter.
    if (n.tokens.length < 2) return null;
    const r = await reads(n, env, { text: n.core });
    if (!r.decision || r.decision.executionRoute !== 'local' || r.decision.confidence < T_LOCAL || r.decision.ambiguities.length) return null;
    if (!r.decision.readOnly) return null;
    steps.push(r.decision);
  }
  if (new Set(steps.map((s) => `${s.intent}:${JSON.stringify(s.parameters)}`)).size !== steps.length) return null;
  return decide('GET_BUSINESS_OVERVIEW', 'local', {
    intent: 'COMPOUND_READ',
    confidence: Math.min(...steps.map((s) => s.confidence)),
    steps,
    requiredPermissions: steps.flatMap((s) => s.requiredPermissions),
    reason: `Decomposed into ${steps.length} reads: ${steps.map((s) => s.intent).join(' + ')}.`,
    signature: steps.map((s) => s.signature).join(' & '),
  });
}

/** Where a decision with this confidence goes. */
function settle(d, u) {
  if (d.executionRoute === 'llm' || d.executionRoute === 'clarify') return d;
  if (d.ambiguities.length) return { ...d, executionRoute: 'clarify', reason: `${d.reason} One name matched several records.` };
  if (d.confidence >= T_LOCAL) return d;
  if (d.confidence >= T_CLARIFY && u.tokens.length <= 14) {
    return {
      ...d,
      executionRoute: 'clarify',
      confirm: true,
      reason: `${d.reason} Part of the message is not accounted for (${d.unexplained || 0} word(s), ${d.unused?.length || 0} concept(s)), so it is confirmed first.`,
    };
  }
  return toModel('OPEN_ENDED', 'Too much of the message is unexplained to answer from a rule.', { nearest: d.intent, signature: d.signature, confidence: d.confidence });
}

/**
 * @param {string} message
 * @param {object} env
 * @param {string} env.today            the company's today (YYYY-MM-DD)
 * @param {(text:string, kinds:string[]) => Promise<object>} env.resolve
 *        names → records the person may see: { status: 'one', kind, id, label }
 *        | { status: 'many', options } | { status: 'none' }
 * @param {object|null} [env.lastRoute] the last read's memo (follow-ups)
 * @param {object|null} [env.pending]   Buddy's open question, if any
 * @param {object[]}   [env.openCards]  cards waiting for a tap
 * @param {(hit:object) => Promise<boolean>} [env.hasOpenInvoices]
 */
export async function understand(message, env) {
  const u = normalizeMessage(message);
  if (!u.core) return toModel('OPEN_ENDED', 'Nothing to read.');

  const said = talk(u, env);
  if (said) return said;
  if (u.tokens.length > MAX_TOKENS) return toModel('OPEN_ENDED', 'A long message: the model reads it whole.');
  if (/\n/.test(u.raw.split(/\n\s*\n/)[0].trim()) || /[.!?]\s+\S/.test(u.core)) {
    return toModel('OPEN_ENDED', 'Several sentences: the model reads them together.');
  }

  const calc = calculation(u);
  if (calc) return calc;
  const changedFact = !u.question && MODEL_SIGNALS[0][1].test(u.core);

  const nav = navigation(u);
  if (nav) return nav;

  const change = await changes(u, env);
  if (change) return change;

  // Questions about one named record ("who is on the pitch deck?", "what is
  // Kite's email?") are read by their form, before any word in the name
  // ("deck", "invoice") can be taken for a subject.
  const personFirst = await personWork(u, env);
  if (personFirst) return personFirst;
  const recordFirst = await oneRecord(u, env);
  if (recordFirst) return recordFirst;

  // Attention / overview / "what did you do" are phrased with words ("should
  // I", "how are we") that otherwise mean "ask the model".
  if (changedFact) return toModel('OPEN_ENDED', 'A fact that has changed: the model proposes the update.');
  const first = await reads(u, env);

  // A read that accounts for every word of the message stands: the words
  // that mean "ask the model" ("why", "should we", "compare") would have been
  // left over, and a leftover word keeps a read below the threshold. It also
  // outranks "show me <a record>". A follow-up opener ("only…", "and…") is
  // read against the last answer first.
  const sure = first.decision && first.decision.executionRoute === 'local' && first.decision.confidence >= T_LOCAL && !first.decision.ambiguities.length;
  // An intent that takes leftover words as search text accounts for anything,
  // so there the model's signals are still heard ("summarize the Kite contract").
  const absorbed = sure && first.decision.textual && !!modelSignal(u);
  if (sure && !absorbed && !(u.followUp && env.lastRoute)) return settle(first.decision, u);
  const record = sure && !absorbed ? null : await oneRecord(u, env, { loose: true });
  if (record) return record;

  const signal = modelSignal(u);
  if (signal) return signal;

  if (first.negated) return toModel('OPEN_ENDED', 'A negation the engine cannot express as a filter.');

  const follow = (u.followUp || !first.decision || first.decision.confidence < T_LOCAL) ? await followUp(u, env, first) : null;
  if (follow) return settle(follow, u);

  if (first.decision) {
    if (first.decision.executionRoute === 'local' && first.decision.confidence < T_LOCAL) {
      const both = await compound(u, env);
      if (both) return both;
    }
    return settle(first.decision, u);
  }
  return toModel('OPEN_ENDED', 'No supported intent matched.', { signature: signature(first.concepts || new Set(), first.residue?.length || 0) });
}

/** The follow-up memo a client sent back, checked: known intent, known concepts, real dates, uuid ids. */
export function cleanRoute(raw) {
  if (!raw || typeof raw !== 'object' || !getIntent(raw.intent)) return null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const concepts = Array.isArray(raw.concepts) ? raw.concepts.filter((c) => typeof c === 'string' && isConcept(c)).slice(0, 20) : [];
  const p = raw.period && typeof raw.period === 'object' ? raw.period : null;
  const ok = (d) => d === null || d === undefined || isIsoDate(d);
  const period = p && ok(p.from) && ok(p.to) ? { from: p.from || null, to: p.to || null, label: String(p.label || '').slice(0, 40) } : null;
  const ents = {};
  for (const [param, e] of Object.entries(raw.ents && typeof raw.ents === 'object' ? raw.ents : {}).slice(0, 4)) {
    if (e && uuid.test(String(e.id)) && /^[a-z_]{2,20}$/.test(param) && ALL_KINDS.includes(e.kind)) {
      ents[param] = { id: e.id, label: String(e.label || '').slice(0, 120), kind: e.kind };
    }
  }
  return { intent: raw.intent, concepts, period, ents };
}

export const __test = { tailDate, taskRef, docRef, spans, shiftDays };
