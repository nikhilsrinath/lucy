import { stem, correctWord } from './text.js';

/**
 * The vocabulary the local engine understands: business words and phrases
 * mapped to a small set of CONCEPTS. Many ways of saying a thing meet in one
 * concept ("who owes us", "receivables", "haven't paid", "pending
 * collections" → RECEIVABLE), and the intent rules (understand.js) are written
 * over concepts, never over sentences.
 *
 * A phrase is matched on stemmed words, longest first, so "not paid" is read
 * as UNPAID before "paid" could be read as PAID — which is also how negation
 * that changes a filter is kept apart from negation the engine cannot express
 * (a "not" no phrase claims sends the message to the model).
 *
 * Adding a way of saying something is a line here plus a line in the eval set
 * (local/evalset.js). Adding a capability is an intent (intents.js).
 */

const C = {
  INVOICE: ['invoice', 'inv', 'tax invoice', 'invoicing'],
  QUOTE: ['quotation', 'quote', 'estimate'],
  PROFORMA: ['proforma', 'pro forma', 'proforma invoice'],
  RECEIVABLE: [
    'owe us', 'owe me', 'owed to us', 'owing us', 'owe to us', 'who owe', 'owe us money', 'owe money to us',
    'ows us', 'ows me', 'who ows', 'ows us money', 'owes me money', 'owes us money',
    'receivable', 'accounts receivable', 'account receivable', 'money owed to us', 'collection', 'pending collection',
    'to collect', 'to be collected', 'yet to pay', 'have not paid', 'has not paid', 'not paid us', 'did not pay',
    'not paying', 'are we owed', 'we are owed', 'owed', 'still to pay us', 'yet to pay us', 'not paid yet',
    'have not paid us', 'has not paid us', 'have not paid yet', 'has not paid yet', 'have not yet paid', 'has not yet paid',
    'have yet to pay', 'has yet to pay', 'not cleared', 'have not cleared', 'has not cleared', 'have not settled', 'has not settled',
  ],
  UNPAID: [
    'unpaid', 'outstanding', 'not paid', 'not yet paid', 'unsettled', 'uncollected', 'not been paid', 'payment pending',
    'pending payment', 'awaiting payment', 'non paid', 'not settled', 'still unpaid', 'not been settled', 'not been cleared',
  ],
  PAYABLE: [
    'we owe', 'do we owe', 'i owe', 'do i owe', 'owe vendor', 'owe supplier', 'owe our vendor', 'owe our supplier', 'owe to vendor',
    'payable', 'accounts payable', 'account payable', 'have to pay', 'need to pay', 'bills to pay', 'we have to pay', 'do we have to pay',
  ],
  PAYMENT: ['payment'],
  OVERDUE: [
    'overdue', 'past due', 'late', 'delayed', 'over due', 'missed deadline', 'past deadline', 'past the deadline',
    'behind schedule', 'running late', 'past its due date', 'past their due date', 'missed its deadline',
    'past their deadline', 'past its deadline', 'past the due date', 'past due date',
  ],
  // People who pay late: read as OVERDUE + RECEIVABLE (understand.js).
  LATEPAY: ['late payer', 'defaulter', 'slow payer', 'late paying', 'late in paying', 'bad payer'],
  PAID: ['paid', 'settled', 'cleared', 'collected'],
  DRAFT: ['draft'],
  CANCELLED: ['cancelled', 'canceled', 'void'],
  SENT: ['sent'],
  ACCEPTED: ['accepted'],
  CASH: [
    'cash', 'cash balance', 'bank balance', 'balance', 'cash position', 'net cash', 'cash in hand', 'cash on hand',
    'money in the bank', 'in the bank', 'fund', 'money do we have', 'money we have', 'money have we got', 'liquidity',
    'how much do we have', 'money do i have', 'money we got',
  ],
  CASHFLOW: ['cash flow', 'cashflow', 'money in and out', 'in and out'],
  MONEY: [
    'money', 'finance', 'financial', 'financial summary', 'financial position', 'financial health', 'money situation',
    'the number', 'our number', 'key number', 'key figure', 'headline figure', 'headline number',
  ],
  REVENUE: [
    'revenue', 'sale', 'income', 'earning', 'turnover', 'earned', 'did we make', 'have we made', 'we made', 'did we earn',
    'billed', 'invoiced', 'money in', 'came in', 'inflow', 'received', 'did we bill', 'did we invoice', 'did we collect', 'collected from',
  ],
  EXPENSE: [
    'expense', 'spending', 'spend', 'spent', 'cost', 'outgoing', 'money out', 'expenditure', 'outflow', 'burn',
    'did we spend', 'went out', 'paid out',
  ],
  PROFIT: ['profit', 'margin', 'p&l', 'p and l', 'profit and loss', 'net income', 'profitability', 'runway', 'loss', 'break even', 'breakeven'],
  TASK: [
    'task', 'todo', 'to-do', 'to do', 'action item', 'work item', 'assignment', 'to do list',
    'todo list', 'task list', 'worklist', 'work list',
  ],
  // Tasks that are the speaker's own: read as TASK + MINE (understand.js).
  MYTASK: ['on my plate', 'my plate', 'on my list', 'my to do list', 'my todo list', 'my worklist'],
  DUE: ['due', 'deadline', 'due date', 'coming up', 'upcoming', 'falling due', 'fall due'],
  OPEN: [
    'open', 'pending', 'in progress', 'not done', 'not finished', 'not completed', 'not complete', 'incomplete', 'remaining',
    'left', 'unfinished', 'ongoing', 'not yet done', 'yet to be done', 'still open', 'not closed', 'to be done', 'left to do',
  ],
  DONE: ['done', 'completed', 'finished', 'closed', 'wrapped up'],
  MINE: ['my', 'mine', 'assigned to me', 'i have', 'do i have', 'i', 'myself', 'am i', 'i am'],
  FORME: ['for me'],
  CLIENT: ['client', 'customer', 'buyer'],
  LEAD: ['lead', 'prospect'],
  PIPELINE: ['pipeline', 'sales pipeline', 'funnel', 'crm', 'sales funnel'],
  DEAL: ['deal'],
  QUIET: [
    'quiet', 'inactive', 'cold', 'stale', 'gone cold', 'gone quiet', 'not contacted', 'untouched', 'no activity', 'dormant',
    'not heard from', 'need follow up', 'need a follow up', 'need following up', 'went cold', 'went quiet', 'not touched',
    'have not contacted', 'have not heard from', 'ghosted', 'ghosting',
  ],
  LOST: ['lost'],
  WON: ['won'],
  PROJECT: ['project'],
  ATRISK: ['at risk', 'off track', 'unhealthy', 'in trouble', 'slipping', 'behind', 'troubled', 'risky', 'in danger', 'struggling'],
  TEAM: ['team', 'employee', 'staff', 'people', 'member', 'team member', 'workforce', 'headcount', 'colleague', 'teammate', 'everyone', 'everybody',
    'work here', 'working here', 'who work here', 'who all work here', 'people work here', 'work with me', 'working with me', 'work for us', 'working for us',
    'who is in my team', 'who is in our team', 'who is in the team', 'who is on my team', 'who is on our team', 'who is on the team', 'who are in my team',
    'who are on my team', 'in my team', 'in our team', 'on my team', 'on our team', 'part of the team', 'part of my team',
    'in my company', 'in our company', 'in the company', 'there in my company', 'who all are there', 'who all are there in my company', 'working in my company'],
  WORKLOAD: [
    'workload', 'load', 'overloaded', 'busy', 'busiest', 'free', 'available', 'capacity', 'bandwidth', 'swamped',
    'who can take', 'has time', 'most work', 'least work', 'who is free', 'overworked', 'stretched', 'who has the most',
    'who has the least', 'who has bandwidth', 'who has capacity',
  ],
  LEAVE: [
    'leave', 'on leave', 'time off', 'vacation', 'holiday', 'day off', 'pto', 'off today', 'taking off', 'out of office',
    'ooo', 'who is off', 'who is out', 'leave request', 'leave application', 'is off', 'are off', 'off sick', 'sick leave', 'on holiday',
  ],
  ATTENDANCE: [
    'attendance', 'present', 'absent', 'showed up', 'came in', 'came to office', 'in office', 'in the office', 'wfh', 'remote',
    'working from home', 'who is in', 'clocked in', 'turned up', 'at work', 'who came', 'did not come', 'not come in',
  ],
  VENDOR: ['vendor', 'supplier', 'buy from', 'we buy from', 'who do we buy from', 'purchase from', 'we purchase from'],
  BILL: ['bill', 'purchase bill', 'vendor bill', 'purchase invoice', 'supplier invoice', 'supplier bill', 'vendor invoice'],
  DOCUMENT: ['document', 'doc', 'file', 'contract', 'nda', 'agreement', 'policy', 'deck', 'library', 'upload', 'pdf', 'paperwork'],
  // Letters the company makes for people (records): an NDA is listed here when it is not being searched for.
  LETTER: ['offer letter', 'offer', 'letter', 'mou', 'certificate', 'appointment letter', 'non disclosure agreement'],
  CATALOG: [
    'product', 'catalog', 'catalogue', 'catalog item', 'catalogue item', 'price list', 'pricelist', 'rate card', 'sku',
    'we sell', 'do we sell', 'what we sell', 'what do we sell', 'we offer', 'do we offer', 'what we offer', 'thing we sell', 'our service',
    'price of', 'the price of', 'cost of', 'the cost of', 'rate of', 'rate for', 'price for', 'do we charge for', 'we charge for', 'how much do we charge',
  ],
  DEPARTMENT: ['department', 'dept'],
  COMPANYINFO: [
    'company profile', 'company detail', 'company info', 'company information', 'business profile', 'business detail', 'our detail',
    'company address', 'our address', 'our company address', 'office address', 'registered address', 'company phone', 'our phone',
    'company phone number', 'our phone number', 'our company phone', 'our company phone number', 'company contact number', 'our contact number',
    'our company website', 'our company tagline', 'our registered address', 'our office address', 'company email', 'our email', 'our company email', 'company website',
    'our website', 'company name', 'our company name', 'name of our company', 'name of the company', 'our tagline', 'company tagline',
    'signatory', 'authorised signatory', 'authorized signatory', 'who sign', 'who sign our', 'sign our document', 'sign for us',
  ],
  ANNOUNCEMENT: ['announcement', 'notice board', 'noticeboard', 'notice', 'on the notice board'],
  TIMESHEET: [
    'timesheet', 'time sheet', 'hours did i log', 'hours have i logged', 'hours i logged', 'hours logged', 'logged hour', 'time logged',
    'time i logged', 'time did i log', 'time have i logged', 'my hour', 'hours did i work', 'hours i worked', 'hours have i worked',
    'time on project', 'hours this week', 'my logged time',
  ],
  LEAVEBAL: [
    'leave balance', 'leave left', 'leave remaining', 'remaining leave', 'leave quota', 'leave type', 'type of leave', 'kind of leave',
    'leave policy', 'leave do i have', 'leaves do i have', 'leave i have', 'leave have i got', 'days of leave', 'leave do i get',
    'leave do we get', 'leave entitlement', 'leave available', 'available leave', 'balance leave',
  ],
  ATTENTION: [
    'what should i focus on', 'should i focus on', 'focus on today', 'need attention', 'need my attention', 'need our attention',
    'anything i should know', 'anything i need to know', 'what should i do today', 'what should i do first', 'what should i work on',
    'priority', 'top priority', 'what is important', 'what is urgent', 'anything urgent', 'what matter', 'red flag', 'on fire',
    'heads up', 'insight', 'buddy noticed', 'what did you notice', 'what need doing', 'where should i focus',
    'what is the most important', 'need to worry about', 'worry about', 'anything wrong', 'any problem', 'any issue', 'any risk',
    'what am i missing', 'what should we focus on', 'what need me', 'what do i need to look at', 'anything i should be worried about',
    'should i be worried', 'what should i look at', 'what should i prioritise', 'what should i prioritize', 'what should i tackle',
    'need looking at', 'what is burning', 'biggest risk', 'what need to be done today', 'what need fixing',
  ],
  OVERVIEW: [
    'how are we doing', 'how is the business', 'how is business', 'how is the company', 'how is everything', 'how are thing',
    'business overview', 'company overview', 'overview', 'summary', 'daily brief', 'brief', 'briefing', 'morning brief',
    'status update', 'state of the business', 'state of the company', 'big picture', 'health check', 'where do we stand',
    'snapshot', 'how is the business doing', 'how is the company doing', 'how are we doing overall', 'quick update',
    'status report', 'how do thing look', 'how is it looking', 'rundown', 'run down', 'lay of the land', 'bird eye view', 'recap',
  ],
  ACTIVITY: [
    'what happened', 'what is new', 'what changed', 'recent activity', 'activity', 'what did i miss', 'catch me up',
    'bring me up to speed', 'what went on', 'what has been happening', 'what has happened', 'changelog', 'audit trail',
    'audit log', 'what has changed', 'what is been happening', 'recent change', 'latest change', 'what got done',
    'what was done', 'what did the team do', 'what did everyone do', 'recent update', 'latest update', 'fill me in',
  ],
  BUDDYDID: [
    'what did you do', 'what have you done', 'what did buddy do', 'your activity', 'did that go through', 'did it go through',
    'did it work', 'did that work', 'what failed', 'what are you working on', 'what have you been doing', 'your action',
    'what did you change', 'anything fail', 'did that get sent', 'did it get sent', 'did you send it', 'did you do it',
    'did that happen', 'what have you been up to', 'your recent action', 'what did you get done', 'what is waiting for me',
    'what is waiting on me', 'waiting for my approval', 'need my approval', 'pending approval',
  ],
  PULSE: [
    'check in', 'checked in', 'checkin', 'daily pulse', 'pulse', 'standup', 'stand up', 'blocker', 'blocked',
    'how did the team day go', 'team day', 'not checked in', 'team update', 'how was the team day', 'end of day update', 'eod update',
  ],
  SEARCHV: ['find', 'search', 'look up', 'lookup', 'locate', 'look for', 'search for', 'find me'],
  DETAILS: ['detail', 'info', 'information', 'profile'],
};

// Words that carry no intent of their own: they are read past, never left over.
const NEUTRAL = [
  'the', 'a', 'an', 'of', 'on', 'in', 'for', 'to', 'with', 'and', 'or', 'at', 'by', 'from', 'that', 'this', 'these', 'those',
  'our', 'we', 'us', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'have', 'has', 'had', 'there', 'their',
  'them', 'they', 'it', 'its', 'still', 'yet', 'currently', 'now', 'right now', 'at the moment', 'as of now', 'all', 'total',
  'overall', 'up', 'out', 'got', 'any', 'some', 'here', 'show', 'list', 'display', 'give', 'get', 'see', 'view', 'pull',
  'fetch', 'check', 'tell', 'what', 'which', 'how many', 'how much', 'who', 'whom', 'when', 'where', 'show me', 'tell me',
  'give me', 'get me', 'let me know', 'let me see', 'can i see', 'can i get', 'i want', 'i need', 'i want to see',
  'i need to see', 'i would like to see', 'i want to know', 'i need to know', 'do we have', 'are there', 'is there',
  'have we got', 'exactly', 'again', 'quick', 'current', 'latest', 'full', 'entire', 'whole', 'list of', 'number of',
  'count of', 'count', 'value', 'worth', 'sum', 'status', 'about', 'so', 'please', 'me', 'you', 'can', 'could', 'would',
  'will', 'thing', 'stuff', 'item', 'one', 'look', 'looking', 'stand', 'standing', 'like', 'how', 'many', 'much', 'much is',
  'each', 'every', 'whose', 'just', 'only', 'also', 'too', 'then', 'if', 'pull up', 'bring up', 'run', 'report', 'breakdown',
  'data', 'record', 'entry', 'as', 'far', 'today is', 'day', 'date', 'time', 'right', 'really', 'actually', 'amount', 'name',
  'tell us', 'show us', 'give us', 'know', 'want', 'need', 'see all', 'all the', 'all of', 'all our', 'all my', 'into',
  'having', 'being', 'going', 'go', 'am', 'what is', 'who is', 'who are', 'what are', 'which are', 'how is', 'how are',
  'who has', 'who have', 'which have', 'that have', 'that are', 'which is', 'that is', 'across', 'per', 'via',
  'until', 'till', 'through', 'throughout', 'within', 'during', 'over', 'as of', 'between',
  'issued', 'raised', 'by category', 'category wise', 'category', 'wise', 'breakup', 'split', 'vs', 'versus', 'against',
  'far', 'do', 'please show', 'kind of', 'sort of', 'type of', 'figure', 'look like', 'looking like', 'side',
];

/** Concepts that add nothing when unused: a request word, not a filter. */
export const IGNORABLE = new Set(['FORME', 'DETAILS', 'SEARCHV']);

/** Words that negate. One left unclaimed by a phrase means "not something we can express". */
export const NEGATORS = new Set(['not', 'no', 'never', 'without', 'except', 'excluding', 'neither', 'nor', 'non', 'none', 'exclude', 'besides', 'other than', 'but not']);

const stemPhrase = (p) => p.split(' ').map(stem).join(' ');

const PHRASES = new Map();   // stemmed phrase → concept | null (neutral)
let MAX_WORDS = 1;
for (const phrase of NEUTRAL) PHRASES.set(stemPhrase(phrase), null);
for (const [concept, list] of Object.entries(C)) {
  for (const phrase of list) {
    PHRASES.set(stemPhrase(phrase), concept);
    MAX_WORDS = Math.max(MAX_WORDS, phrase.split(' ').length);
  }
}

// Every single word the lexicon knows, for spelling correction. Verbs the
// write patterns key on are added so "delte the task" is not left to chance.
const COMMAND_WORDS = [
  'create', 'delete', 'remove', 'update', 'change', 'assign', 'reschedule', 'postpone', 'remind', 'reminder', 'complete',
  'finish', 'reopen', 'record', 'spent', 'received', 'convert', 'issue', 'cancel', 'archive', 'priority', 'urgent',
  'tomorrow', 'yesterday', 'today', 'month', 'week', 'quarter', 'year', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'against', 'mark', 'move', 'push', 'settings', 'dashboard', 'cashbook',
  'announcement', 'certificate', 'timesheet', 'product', 'recurring', 'purchase', 'schedule', 'message',
];
// Ordinary words that sit one edit from a word above and must be left alone.
const LEAVE_ALONE = [
  'contact', 'contacts', 'contrast', 'revenge', 'expanse', 'prevent', 'police', 'locale', 'unload', 'martin', 'marlin',
  'supplies', 'vocation', 'expensive', 'collective', 'collecting', 'president', 'stage', 'stages', 'summer', 'presents',
  'fine', 'lean', 'ball', 'call', 'term', 'terms', 'last', 'most', 'least', 'then', 'than', 'that', 'this', 'them', 'their',
  'there', 'these', 'those', 'what', 'when', 'where', 'which', 'while', 'with', 'will', 'were', 'your', 'from', 'more',
  'make', 'made', 'need', 'next', 'past', 'send', 'take', 'time', 'want', 'work', 'year', 'page', 'plan', 'part', 'paying',
  'please', 'clean', 'clear', 'class', 'close', 'count', 'could', 'would', 'should', 'board', 'point', 'email', 'phone',
  'being', 'above', 'below', 'under', 'after', 'before', 'since', 'until', 'thing', 'think', 'thank', 'tasty', 'party',
  'dealt', 'leads', 'least', 'leaves', 'later', 'latest', 'money', 'month', 'might', 'maybe', 'house', 'horse', 'store',
  'short', 'shirt', 'state', 'start', 'staff', 'still', 'stock', 'sales', 'salary', 'salaries', 'client', 'clients',
  'check', 'cheque', 'charge', 'chance', 'change', 'chase', 'cheap', 'costs', 'coast', 'court', 'cover', 'report',
  'remote', 'remove', 'recent', 'record', 'reason', 'really', 'ready', 'reply', 'other', 'order', 'offer', 'office',
  'paper', 'party', 'prior', 'price', 'prices', 'pricing', 'print', 'proof', 'tasked', 'taken', 'taxes', 'teams',
  'final', 'first', 'fresh', 'front', 'given', 'going', 'great', 'group', 'guess', 'happy', 'heavy', 'hello',
  'issue', 'issues', 'known', 'large', 'learn', 'level', 'light', 'local', 'lower', 'major', 'minor', 'named', 'never',
  'notes', 'noted', 'owner', 'owners', 'paint', 'plans', 'plant', 'quite', 'quick', 'raise', 'reach', 'right', 'round',
  'share', 'sheet', 'small', 'sound', 'spend', 'split', 'stand', 'steps', 'style', 'table', 'today', 'total', 'track',
  'trade', 'train', 'trial', 'under', 'value', 'video', 'visit', 'whole', 'world', 'worth', 'write', 'wrong', 'vendors',
];

const VOCAB = new Set();
for (const phrase of [...PHRASES.keys(), ...COMMAND_WORDS]) for (const w of phrase.split(' ')) if (/^[a-z]+$/.test(w)) VOCAB.add(w);
const SKIP = new Set([...VOCAB, ...LEAVE_ALONE, ...LEAVE_ALONE.map(stem)]);

/** The corrected spelling of a stemmed word, or the word itself. */
export function spell(word, { proper = false } = {}) {
  if (proper || SKIP.has(word) || SKIP.has(stem(word))) return { word, corrected: false };
  const fixed = correctWord(word, VOCAB) || correctWord(stem(word), VOCAB);
  return fixed ? { word: fixed, corrected: true } : { word, corrected: false };
}

/**
 * Reads tokens into concepts.
 *
 * @param {import('./text.js').Token[]} tokens
 * @returns {{ concepts: Set<string>, residue: {raw:string,w:string,at:number}[], corrections: number, negated: boolean, marks: (string|null|undefined)[] }}
 *   `marks[i]` is the concept that claimed token i, null for a neutral word,
 *   undefined for a word nothing claimed (the residue).
 */
export function readConcepts(tokens) {
  let corrections = 0;
  const words = tokens.map((t) => {
    const s = stem(t.w);
    if (PHRASES.has(s) || NEGATORS.has(t.w)) return s;
    // "un-paid", "taskss": the same word, written a little differently.
    // Only for longer words: "off" is not "of" with a letter repeated.
    const variants = [t.w.replace(/-/g, ''), ...(t.w.length >= 6 ? [t.w.replace(/(.)\1+$/, '$1'), t.w.replace(/(.)\1{2,}/g, '$1')] : [])];
    for (const variant of variants) {
      if (variant !== t.w && variant.length >= 4 && PHRASES.has(stem(variant))) return stem(variant);
    }
    const fix = spell(t.w, { proper: t.proper });
    if (fix.corrected) corrections += 1;
    return stem(fix.word);
  });
  const marks = new Array(tokens.length).fill(undefined);
  const concepts = new Set();
  for (let i = 0; i < words.length;) {
    let took = 0;
    for (let n = Math.min(MAX_WORDS, words.length - i); n >= 1; n--) {
      const phrase = words.slice(i, i + n).join(' ');
      if (!PHRASES.has(phrase)) continue;
      const concept = PHRASES.get(phrase);
      for (let k = i; k < i + n; k++) marks[k] = concept;
      if (concept) concepts.add(concept);
      took = n;
      break;
    }
    i += took || 1;
  }
  const residue = [];
  let negated = false;
  tokens.forEach((t, i) => {
    if (marks[i] !== undefined) return;
    if (NEGATORS.has(t.w)) { negated = true; return; }
    residue.push({ raw: t.raw, w: t.w, at: i, poss: t.poss });
  });
  return { concepts, residue, corrections, negated, marks };
}

export const CONCEPTS = Object.keys(C);
export const isConcept = (id) => Object.prototype.hasOwnProperty.call(C, id);
