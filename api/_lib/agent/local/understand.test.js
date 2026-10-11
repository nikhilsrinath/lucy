import { describe, it, expect } from 'vitest';
import { normalizeMessage, editDistance, correctWord, stem } from './text.js';
import { readConcepts, spell } from './lexicon.js';
import { extractPeriod } from './periods.js';
import { understand, classifyRead, cleanRoute, T_LOCAL, __test } from './understand.js';
import { INTENTS, intentProblems, describeIntent, cleanArgs, getIntent } from './intents.js';
import { resolveName } from './engine.js';
import { evalCtx } from './evaluate.js';
import { IDS, TODAY } from '../../../../scripts/eval-agent.world.js';

/** understand() over the fixture company, with names resolved against its records. */
function reader(session = {}) {
  const { ctx } = evalCtx({ session });
  const env = {
    today: TODAY, pending: null, openCards: [], lastRoute: null,
    resolve: (text, kinds, opts) => resolveName(ctx, text, kinds, { across: opts?.across ?? kinds.length > 3 }),
    hasOpenInvoices: async () => false,
    ...session.env,
  };
  return (message) => understand(message, env);
}
const read = reader();

describe('normalisation', () => {
  it('expands contractions and keeps negation as a word', () => {
    expect(normalizeMessage("don't show unpaid invoices").clean).toBe('do not show unpaid invoices');
    expect(normalizeMessage("Which clients haven't paid?").clean).toBe('Which clients have not paid?');
    expect(normalizeMessage('whats overdue').clean).toBe('what is overdue');
  });

  it('strips filler from both ends without touching the request', () => {
    expect(normalizeMessage('Hey Buddy, can you please show unpaid invoices? thanks').core).toBe('show unpaid invoices');
    expect(normalizeMessage('I want to create a task to call Acme').core).toBe('create a task to call Acme');
    // "mark" is a cofounder's name and a verb: it is only filler when addressed.
    expect(normalizeMessage('mark the pricing task done').core).toBe('mark the pricing task done');
    expect(normalizeMessage('Mark, what is overdue').core).toBe('what is overdue');
  });

  it('flags questions, hedges and follow-up openers', () => {
    expect(normalizeMessage('is the pricing task done').question).toBe(true);
    expect(normalizeMessage('mark the pricing task done').question).toBe(false);
    expect(normalizeMessage('maybe we should invoice Acme').uncertain).toBe(true);
    expect(normalizeMessage('what about last month?').followUp).toBe(true);
  });

  it('reads only the request of a voice turn, not the instruction block after it', () => {
    expect(normalizeMessage('who owes us money\n\nReply in two short sentences, spoken aloud.').core).toBe('who owes us money');
  });

  it('keeps a possessive as a name', () => {
    const t = normalizeMessage("Ravi's tasks").tokens;
    expect(t[0]).toMatchObject({ w: 'ravi', poss: true });
  });
});

describe('spelling', () => {
  it('measures edits, counting a swapped pair as one', () => {
    expect(editDistance('invioce', 'invoice')).toBe(1);
    expect(editDistance('ovrdue', 'overdue')).toBe(1);
    expect(editDistance('cash', 'cost')).toBe(2);
  });

  it('corrects towards a known word only when it is safe', () => {
    const vocab = new Set(['invoice', 'overdue', 'task', 'stale', 'contract']);
    expect(correctWord('invioce', vocab)).toBe('invoice');
    expect(correctWord('ovrdue', vocab)).toBe('overdue');
    expect(correctWord('taks', vocab)).toBe('task');
    // Five letters, one edit away: too close to call.
    expect(correctWord('stage', vocab)).toBe(null);
    // Different first letter.
    expect(correctWord('unvoice', vocab)).toBe(null);
  });

  it('never rewrites a real word or a name into a business word', () => {
    expect(spell('contact').corrected).toBe(false);   // not "contract"
    expect(spell('stage').corrected).toBe(false);     // not "stale"
    expect(spell('invoicely', { proper: true }).corrected).toBe(false);
    expect(spell('unpiad')).toEqual({ word: 'unpaid', corrected: true });
  });

  it('stems consistently', () => {
    expect([stem('invoices'), stem('owes'), stem('companies'), stem('status'), stem('is')]).toEqual(['invoice', 'owe', 'company', 'status', 'is']);
  });
});

describe('concepts', () => {
  const concepts = (s) => [...readConcepts(normalizeMessage(s).tokens).concepts].sort();

  it('reads many phrasings as the same concept', () => {
    for (const s of ['who owes us money', 'which clients have not paid', 'pending collections', 'accounts receivable', 'clients who are yet to pay']) {
      expect(concepts(s), s).toContain('RECEIVABLE');
    }
  });

  it('claims a negation only when a phrase means it', () => {
    expect(readConcepts(normalizeMessage('invoices that are not paid').tokens)).toMatchObject({ negated: false });
    expect(concepts('invoices that are not paid')).toContain('UNPAID');
    expect(readConcepts(normalizeMessage('invoices that are not overdue').tokens).negated).toBe(true);
    expect(readConcepts(normalizeMessage('tasks not assigned to Ravi').tokens).negated).toBe(true);
  });

  it('leaves unknown words as residue rather than dropping them', () => {
    const r = readConcepts(normalizeMessage('unpaid invoices sorted by amount').tokens);
    expect(r.residue.map((x) => x.w)).toEqual(['sorted']);
  });
});

describe('periods (today is Sat 26 Sep 2026)', () => {
  const p = (s, opts) => { const x = extractPeriod(s, TODAY, opts); return x ? [x.from, x.to, x.label] : null; };

  it('resolves relative periods on Monday-to-Sunday weeks and calendar quarters', () => {
    expect(p('this week')).toEqual(['2026-09-21', '2026-09-27', 'this week']);
    expect(p('last week')).toEqual(['2026-09-14', '2026-09-20', 'last week']);
    expect(p('this month')).toEqual(['2026-09-01', '2026-09-30', 'this month']);
    expect(p('last month')).toEqual(['2026-08-01', '2026-08-31', 'last month']);
    expect(p('last quarter')).toEqual(['2026-04-01', '2026-06-30', 'last quarter']);
    expect(p('this financial year')).toEqual(['2026-04-01', '2027-03-31', 'this financial year']);
    expect(p('the last 30 days')).toEqual(['2026-08-27', '2026-09-26', 'the last 30 days']);
    expect(p('yesterday')).toEqual(['2026-09-25', '2026-09-25', 'yesterday']);
  });

  it('reads a named month as the most recent one, and a year when given', () => {
    expect(p('in August')).toEqual(['2026-08-01', '2026-08-31', 'August 2026']);
    expect(p('for December')).toEqual(['2025-12-01', '2025-12-31', 'December 2025']);
    expect(p('February 2024')).toEqual(['2024-02-01', '2024-02-29', 'February 2024']);
  });

  it('does not take a name or a verb for a month or a weekday', () => {
    expect(p("Jan's tasks")).toBe(null);
    expect(p('we may hire')).toBe(null);
    expect(p('sun pharma invoices')).toBe(null);
  });

  it('says "all time" only when it was said', () => {
    expect(p('revenue so far')).toEqual([null, null, 'all time']);
    expect(p('revenue')).toBe(null);
  });

  it('prefers the future for work and the past for money', () => {
    expect(p('friday', { prefer: 'future' })[0]).toBe('2026-10-02');
    expect(p('friday', { prefer: 'past' })[0]).toBe('2026-09-25');
  });
});

describe('the intent registry', () => {
  it('is consistent with the tools it names', () => {
    expect(intentProblems()).toEqual([]);
  });

  it('takes read-only, permission, risk and confirmation from the tool, never from itself', () => {
    expect(describeIntent('GET_OUTSTANDING_INVOICES')).toMatchObject({ readOnly: true, requiresConfirmation: false, requiredPermissions: [{ resource: 'financial_documents', action: 'view' }] });
    expect(describeIntent('CREATE_TASK')).toMatchObject({ readOnly: false, requiresConfirmation: true, risk: 'low' });
    expect(describeIntent('MARK_INVOICE_PAID')).toMatchObject({ readOnly: false, requiresConfirmation: true, risk: 'high' });
    expect(describeIntent('DELETE_TASK').requiredPermissions).toEqual([{ resource: 'tasks', action: 'delete' }]);
  });

  it('every change intent maps to a write tool, so it can only ever become a card', () => {
    for (const intent of INTENTS.filter((i) => /^(?:CREATE|UPDATE|DELETE|COMPLETE|REOPEN|MOVE|ADD|MARK|RECORD|ISSUE|CANCEL_DOCUMENT|CONVERT|DRAFT)/.test(i.id) && i.escalate !== 'always')) {
      expect(describeIntent(intent.id), intent.id).toMatchObject({ readOnly: false, requiresConfirmation: true });
    }
  });

  it('cleans arguments to the declared ones, whatever a client sends back', () => {
    const args = cleanArgs(getIntent('GET_OUTSTANDING_INVOICES'), { client: IDS.acme, unpaid: false, status: 'paid', limit: 5000, __proto__: { x: 1 }, _options: [] });
    expect(args).toEqual({ client: IDS.acme, unpaid: true });
  });
});

describe('understanding: structured decisions', () => {
  it('returns the documented decision shape', async () => {
    const d = await read('unpaid invoices for Zephyr last month');
    expect(d).toMatchObject({
      intent: 'GET_OUTSTANDING_INVOICES',
      parameters: { client: IDS.zephyr, from: '2026-08-01', to: '2026-08-31' },
      missingParameters: [],
      ambiguities: [],
      executionRoute: 'local',
      requiresConfirmation: false,
      requiredPermissions: [{ resource: 'financial_documents', action: 'view' }],
    });
    expect(d.entities).toEqual([expect.objectContaining({ kind: 'client', id: IDS.zephyr, label: 'Zephyr Retail', param: 'client' })]);
    expect(d.confidence).toBeGreaterThanOrEqual(T_LOCAL);
    expect(typeof d.reason).toBe('string');
  });

  it('maps equivalent wordings to one operation', async () => {
    const all = await Promise.all([
      'Who owes us money?', "Which clients haven't paid?", 'Show outstanding customer payments.',
      'Can you check our pending collections?', 'List the invoices that are still unpaid.',
    ].map(read));
    for (const d of all) expect(d).toMatchObject({ intent: 'GET_OUTSTANDING_INVOICES', executionRoute: 'local', parameters: {} });
  });

  it('never reads a request and its negation alike', async () => {
    const yes = await read('show unpaid invoices');
    const no = await read("don't show unpaid invoices");
    expect(yes.intent).toBe('GET_OUTSTANDING_INVOICES');
    expect(no.intent).toBe('DECLINED_COMMAND');
    expect(no.intent).not.toBe(yes.intent);
    expect((await read('show invoices that are not overdue')).executionRoute).toBe('llm');
  });

  it('lowers confidence for every word and concept it cannot account for', async () => {
    const clean = await read('show unpaid invoices');
    const one = await read('show unpaid invoices sorted by amount');
    expect(one.executionRoute).toBe('clarify');
    expect(one.confidence).toBeLessThan(T_LOCAL);
    expect(clean.confidence - one.confidence).toBeCloseTo(0.3, 5);
    // Two unexplained things: not even a question — the model reads it.
    expect((await read('show me the top 3 clients by revenue')).executionRoute).toBe('llm');
  });

  it('asks which record when a name is ambiguous, and never picks', async () => {
    const d = await read('tell me about Acme');
    expect(d.executionRoute).toBe('clarify');
    expect(d.ambiguities[0].options.map((o) => o.label)).toEqual(expect.arrayContaining(['Acme Corp (client)', 'PRJ-2026-001 · Acme website (project)']));
    // Two people called Priya: an employee and a client's contact.
    expect((await read("what is Priya's email")).executionRoute).toBe('clarify');
    // One Kite with an email: no question needed.
    expect(await read("what is Kite's email")).toMatchObject({ executionRoute: 'local', parameters: { type: 'client', ref: IDS.kite, facet: 'email' } });
  });

  it('hedged or questioned changes are not proposed', async () => {
    expect((await read('invoice Acme 50k for the website')).intent).toBe('CREATE_INVOICE');
    expect((await read('maybe we should invoice Acme 50k')).executionRoute).toBe('llm');
    expect((await read('should I mark the pricing task done?')).executionRoute).toBe('llm');
    expect((await read('how do I create an invoice?')).executionRoute).toBe('llm');
  });

  it('sends several actions, and the same action on many records, to the model', async () => {
    expect(await read('create a task to call Acme and mark the pricing task done')).toMatchObject({ executionRoute: 'llm', intent: 'BULK_CHANGE' });
    expect(await read('mark all the Acme tasks done')).toMatchObject({ executionRoute: 'llm', intent: 'BULK_CHANGE' });
  });

  it('reports what is still missing for a change it recognised', async () => {
    const d = await read('add a task');
    expect(d).toMatchObject({ intent: 'CREATE_TASK', executionRoute: 'local', missingParameters: ['title'], requiresConfirmation: true });
  });

  it('does not take an adjective for an event', async () => {
    expect(await read('completed tasks')).toMatchObject({ intent: 'LIST_TASKS', parameters: { status: 'done' } });
    expect(await read('lost deals')).toMatchObject({ intent: 'LIST_CLIENTS', parameters: { stage: 'lost' } });
    expect((await read('we lost the Kite deal')).intent).toBe('MOVE_CLIENT_STAGE');
  });

  it('reads the form of a question before the words in a record name', async () => {
    // "deck" is a document word; this is still a question about a task.
    expect(await read('who is working on the pitch deck?')).toMatchObject({ intent: 'GET_RECORD_DETAILS', parameters: { type: 'task', ref: IDS.deck, facet: 'who' } });
  });

  it('extracts dates, people and titles for a change, as said', async () => {
    expect((await read('add a task for Priya to send the proposal by the 5th')).parameters).toEqual({ assignee: 'Priya', deadline: 'the 5th', title: 'Send the proposal' });
    expect((await read('remind me to call Kite on Monday')).parameters).toEqual({ title: 'Call Kite', deadline: 'Monday' });
    expect((await read('invoice Zephyr 1 lakh for the fit-out, no GST')).parameters).toMatchObject({ client: 'Zephyr', no_gst: true, items: [{ description: 'The fit-out', rate: '1 lakh' }] });
    expect((await read('quote Globex 50k for the security audit with a 10% discount')).parameters).toMatchObject({ client: 'Globex', discount_percent: 10 });
  });

  it('keeps a spoken yes about an open card for the model (it may confirm on a call)', async () => {
    const card = { action_id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Create task', risk: 'low' };
    const typed = reader({ env: { openCards: [card] } });
    const spoken = reader({ env: { openCards: [card], voice: true } });
    expect((await typed('yes')).intent).toBe('CONFIRM_HINT');
    expect((await spoken('yes')).executionRoute).toBe('llm');
    expect(await typed('scrap that')).toMatchObject({ intent: 'CANCEL_PROPOSAL', parameters: { action_id: card.action_id } });
  });
});

describe('follow-ups', () => {
  it('reads a fragment against the last answer, and as nothing without one', async () => {
    const first = await read('how much did we spend this month?');
    const after = reader({ env: { lastRoute: first.memo } });
    expect(await after('what about last month?')).toMatchObject({ intent: 'GET_EXPENSE_SUMMARY', parameters: { from: '2026-08-01', to: '2026-08-31' }, followUp: true });
    expect((await read('what about last month?')).executionRoute).toBe('llm');
  });

  it('a new status replaces the old one; a new name replaces the old name', async () => {
    const unpaid = await read('unpaid invoices for Zephyr');
    const after = reader({ env: { lastRoute: unpaid.memo } });
    expect(await after('only the overdue ones')).toMatchObject({ intent: 'GET_OVERDUE_PAYMENTS', parameters: { client: IDS.zephyr } });
    expect((await after('and for Acme?')).parameters.client).toBe(IDS.acme);
  });

  it('accepts only a well-formed memo from a client', () => {
    expect(cleanRoute({ intent: 'NOT_AN_INTENT', concepts: ['EXPENSE'] })).toBe(null);
    const cleaned = cleanRoute({
      intent: 'GET_EXPENSE_SUMMARY', concepts: ['EXPENSE', 'DROP TABLE', 7], period: { from: '2026-08-01', to: 'tomorrow' },
      ents: { client: { id: 'not-a-uuid', kind: 'client' }, vendor: { id: IDS.dell, kind: 'vendor', label: 'Dell India' } },
    });
    expect(cleaned).toEqual({ intent: 'GET_EXPENSE_SUMMARY', concepts: ['EXPENSE'], period: null, ents: { vendor: { id: IDS.dell, kind: 'vendor', label: 'Dell India' } } });
  });
});

describe('concept rules', () => {
  const rule = (list, period = null) => classifyRead(new Set(list), period, { today: TODAY });

  it('separates money owed to us from money we owe', () => {
    expect(rule(['RECEIVABLE']).intent).toBe('GET_OUTSTANDING_INVOICES');
    expect(rule(['PAYABLE']).intent).toBe('GET_VENDOR_BILLS');
    expect(rule(['OVERDUE', 'INVOICE']).intent).toBe('GET_OVERDUE_PAYMENTS');
    expect(rule(['OVERDUE', 'TASK']).intent).toBe('GET_OVERDUE_TASKS');
    expect(rule(['OVERDUE']).intent).toBe('GET_OVERDUE_ITEMS');
  });

  it('will not pretend to answer what the tools cannot', () => {
    expect(rule(['PROFIT'])).toMatchObject({ llm: true, intent: 'PROFIT_ANALYSIS' });
    expect(rule(['TASK', 'DONE'], { from: '2026-09-21', to: '2026-09-27', label: 'this week' })).toMatchObject({ llm: true });
    expect(rule(['OPEN']).clarify).toHaveLength(2);
    expect(rule([])).toBe(null);
  });
});

describe('helpers', () => {
  it('finds a date at the end of a phrase and leaves the rest as the title', () => {
    expect(__test.tailDate('send the deck for Acme by Friday', TODAY)).toEqual({ text: 'send the deck for Acme', date: 'friday' });
    expect(__test.tailDate('call Kite on Monday', TODAY)).toEqual({ text: 'call Kite', date: 'Monday' });
    expect(__test.tailDate('renew the domain', TODAY)).toEqual({ text: 'renew the domain', date: null });
  });

  it('names a task or a document the way the resolvers expect', () => {
    expect(__test.taskRef('the pricing one')).toBe('pricing');
    expect(__test.taskRef('that task')).toBe('that task');
    expect(__test.docRef('the overdue invoice', 'Zephyr')).toBe('Zephyr');
    expect(__test.docRef('invoice INV-2026-0012')).toBe('INV-2026-0012');
  });
});
