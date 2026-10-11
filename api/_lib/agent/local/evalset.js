import { IDS } from '../../../../scripts/eval-agent.world.js';

/**
 * The router's evaluation set: representative messages over the fixture
 * company (scripts/eval-agent.world.js — today is Saturday 26 Sep 2026), each
 * with what a correct router does with it.
 *
 *   route    'local'    answered or proposed by a business function, no model
 *            'clarify'  one question, no model
 *            'llm'      handed to the model
 *            an array   any of these is right (e.g. "must not execute")
 *   intent   the intent a local/clarify decision must carry (or a list)
 *   params   a PARTIAL match on the decision's parameters (ids, ISO dates)
 *   outcome  for a change: 'card' | 'choice' | 'input' — what propose() produced
 *   after    a message sent first, whose answer this one follows up on
 *   group    what the case is evidence for (the categories of the test brief)
 *
 * Expectations describe correct behaviour, not the engine's current
 * behaviour: a case the engine gets wrong stays here and counts against it
 * (evaluate.js reports the misses; eval.test.js pins the floor).
 *
 * To add coverage: add the phrasing here first, watch it fail, then teach the
 * lexicon (lexicon.js) or the patterns (understand.js).
 */

const WEEK = { due_after: '2026-09-21', due_before: '2026-09-27' };
const SEP = { from: '2026-09-01', to: '2026-09-30' };
const AUG = { from: '2026-08-01', to: '2026-08-31' };

const g = (group, rows) => rows.map(([say, expect, extra = {}]) => ({ say, group, expect, ...extra }));
const L = (intent, params, more = {}) => ({ route: 'local', intent, ...(params ? { params } : {}), ...more });
const M = (intent) => ({ route: 'llm', ...(intent ? { intent } : {}) });
const Q = (intent, more = {}) => ({ route: 'clarify', ...(intent ? { intent } : {}), ...more });
const SAFE = { route: ['clarify', 'llm'] };

export const EVAL_CASES = [
  /* 1 · the same question in different words ─────────────────────────── */
  ...g('paraphrase', [
    ['Who owes us money?', L('GET_OUTSTANDING_INVOICES')],
    ["Which clients haven't paid?", L('GET_OUTSTANDING_INVOICES')],
    ['Show outstanding customer payments.', L('GET_OUTSTANDING_INVOICES')],
    ['Can you check our pending collections?', L('GET_OUTSTANDING_INVOICES')],
    ['List the invoices that are still unpaid.', L('GET_OUTSTANDING_INVOICES')],
    ['what are our receivables', L('GET_OUTSTANDING_INVOICES')],
    ['how much are we owed?', L('GET_OUTSTANDING_INVOICES')],
    ['any unpaid invoices?', L('GET_OUTSTANDING_INVOICES')],
    ['pending payments from clients', L('GET_OUTSTANDING_INVOICES')],
    ["who hasn't paid us yet", L('GET_OUTSTANDING_INVOICES')],
    ['outstanding invoices please', L('GET_OUTSTANDING_INVOICES')],
    ["show me what's outstanding", L('GET_OUTSTANDING_INVOICES')],
    ['hey buddy, which invoices are still to be collected?', L('GET_OUTSTANDING_INVOICES')],
    ['accounts receivable', L('GET_OUTSTANDING_INVOICES')],
    ['clients who are yet to pay', L('GET_OUTSTANDING_INVOICES')],
    ['I want to see the invoices that have not been paid', L('GET_OUTSTANDING_INVOICES')],
    ['money owed to us', L('GET_OUTSTANDING_INVOICES')],

    ['overdue invoices', L('GET_OVERDUE_PAYMENTS')],
    ['which invoices are past due', L('GET_OVERDUE_PAYMENTS')],
    ['late payments', L('GET_OVERDUE_PAYMENTS')],
    ['any overdue receivables?', L('GET_OVERDUE_PAYMENTS')],
    ['show me the late payers', L('GET_OVERDUE_PAYMENTS')],
    ['overdue payments from Zephyr', L('GET_OVERDUE_PAYMENTS', { client: IDS.zephyr })],

    ['how much cash do we have?', L('GET_CASH_BALANCE')],
    ["what's our bank balance", L('GET_CASH_BALANCE')],
    ['cash position', L('GET_CASH_BALANCE')],
    ['net cash right now', L('GET_CASH_BALANCE')],
    ['how much money do we have in the bank', L('GET_CASH_BALANCE')],
    ['financial summary', L('GET_FINANCE_SUMMARY')],
    ['show me the numbers', L('GET_FINANCE_SUMMARY')],
    ['how are the finances looking', L('GET_FINANCE_SUMMARY')],

    ['revenue this month', L('GET_MONTHLY_REVENUE', SEP)],
    ["what's our revenue this month?", L('GET_MONTHLY_REVENUE', SEP)],
    ['how much did we make in August', L('GET_MONTHLY_REVENUE', AUG)],
    ['monthly revenue', L('GET_MONTHLY_REVENUE', SEP)],
    ['sales last quarter', L('GET_MONTHLY_REVENUE', { from: '2026-04-01', to: '2026-06-30' })],
    ['how much did we invoice last month', L('GET_MONTHLY_REVENUE', AUG)],
    ['how much did we spend last month?', L('GET_EXPENSE_SUMMARY', AUG)],
    ['expenses this week', L('GET_EXPENSE_SUMMARY', { from: '2026-09-21', to: '2026-09-27' })],
    ['what are our expenses', L('GET_EXPENSE_SUMMARY')],
    ['expense summary for September', L('GET_EXPENSE_SUMMARY', SEP)],
    ['spending by category this month', L('GET_EXPENSE_SUMMARY', SEP)],
    ['where did the money go in August', SAFE],
    ['cash flow this month', L('GET_CASH_FLOW', SEP)],
    ['money in vs money out last month', L('GET_CASH_FLOW', AUG)],

    ['tasks due this week', L('LIST_TASKS', WEEK)],
    ["what's due today", L('LIST_TASKS', { due_after: '2026-09-26', due_before: '2026-09-26' })],
    ['show my tasks', L('LIST_TASKS', { assignee: 'me' })],
    ["what's on my plate", L('LIST_TASKS', { assignee: 'me' })],
    ['my to-do list', L('LIST_TASKS', { assignee: 'me' })],
    ['how many tasks are pending', L('LIST_TASKS')],
    ['list open tasks', L('LIST_TASKS')],
    ['deadlines this week', L('LIST_TASKS', WEEK)],
    ['what do I have to do tomorrow', L('LIST_TASKS', { assignee: 'me', due_after: '2026-09-27', due_before: '2026-09-27' })],
    ['completed tasks', L('LIST_TASKS', { status: 'done' })],
    ['overdue tasks', L('GET_OVERDUE_TASKS')],
    ['which tasks are late', L('GET_OVERDUE_TASKS')],
    ['tasks past their deadline', L('GET_OVERDUE_TASKS')],
    ['my overdue tasks', L('GET_OVERDUE_TASKS', { assignee: 'me' })],
    ["Ravi's tasks", L('LIST_TASKS', { assignee: IDS.ravi })],
    ['open tasks for Ravi', L('LIST_TASKS', { assignee: IDS.ravi })],
    ['what is Neha working on?', L('LIST_TASKS', { assignee: IDS.neha })],
    ['tasks in the Kite app project', L('LIST_TASKS', { project: IDS.kiteApp })],
    ['tasks about pricing', L('LIST_TASKS', { text: 'pricing' })],

    ['who is on the team', L('LIST_TEAM')],
    ['team workload', L('LIST_TEAM')],
    ['who is overloaded', L('LIST_TEAM')],
    ['who is free this week?', L('LIST_TEAM')],
    ['how many employees do we have', L('LIST_TEAM')],
    ['who is on leave today', L('LIST_LEAVE', { from: '2026-09-26', to: '2026-09-26' })],
    ["who's off tomorrow", L('LIST_LEAVE', { from: '2026-09-27', to: '2026-09-27' })],
    ['pending leave requests', L('LIST_LEAVE', { status: 'pending' })],
    ['is Ravi on leave this week', L('LIST_LEAVE', { employee: IDS.ravi, from: '2026-09-21', to: '2026-09-27' })],
    ['who was absent yesterday', L('GET_ATTENDANCE', { date: '2026-09-25' })],
    ['attendance today', L('GET_ATTENDANCE', { date: '2026-09-26' })],
    ['attendance for Neha last week', L('GET_ATTENDANCE', { employee: IDS.neha, from: '2026-09-14', to: '2026-09-20' })],

    ['show the sales pipeline', L('LIST_CLIENTS', { stage: 'pipeline' })],
    ['how many leads do we have', L('LIST_CLIENTS', { stage: 'lead' })],
    ['list clients', L('LIST_CLIENTS')],
    ['lost deals', L('LIST_CLIENTS', { stage: 'lost' })],
    ['leads that have gone quiet', L('LIST_CLIENTS', { inactive_days: 14 })],
    ['leads not contacted in 30 days', L('LIST_CLIENTS', { inactive_days: 30 })],
    ['list projects', L('LIST_PROJECTS')],
    ['which projects are at risk', L('LIST_PROJECTS', { health: 'unhealthy' })],
    ['projects for Acme', L('LIST_PROJECTS', { client: IDS.acme })],
    ['what do we owe vendors', L('GET_VENDOR_BILLS', { status: 'open' })],
    ['unpaid vendor bills', L('GET_VENDOR_BILLS', { status: 'open' })],
    ['overdue bills', L('GET_VENDOR_BILLS', { status: 'overdue' })],
    ['bills from Dell', L('GET_VENDOR_BILLS', { vendor: IDS.dell })],
    ['accounts payable', L('GET_VENDOR_BILLS', { status: 'open' })],
    ['find the NDA', L('SEARCH_COMPANY_DOCUMENTS', { text: 'nda' })],
    ['documents about pricing', L('SEARCH_COMPANY_DOCUMENTS', { text: 'pricing' })],

    ['draft invoices', L('LIST_INVOICES', { status: 'draft' })],
    ['paid invoices this month', L('LIST_INVOICES', { status: 'paid', ...SEP })],
    ['show all quotes', L('LIST_INVOICES', { type: 'quotation' })],
    ['invoices issued last month', L('LIST_INVOICES', AUG)],
    ["Acme's invoices", L('LIST_INVOICES', { client: IDS.acme })],
    ['unpaid invoices for Zephyr', L('GET_OUTSTANDING_INVOICES', { client: IDS.zephyr })],
    ['what does Zephyr owe us', L('GET_OUTSTANDING_INVOICES', { client: IDS.zephyr })],

    ['what should I focus on today?', L('GET_INSIGHTS')],
    ['anything I should know?', L('GET_INSIGHTS')],
    ['what needs my attention', L('GET_INSIGHTS')],
    ['top priorities', L('GET_INSIGHTS')],
    ['any red flags?', L('GET_INSIGHTS')],
    ['how are we doing?', L('GET_BUSINESS_OVERVIEW')],
    ['give me a quick business overview', L('GET_BUSINESS_OVERVIEW')],
    ['daily brief', L('GET_BUSINESS_OVERVIEW')],
    ['what happened this week?', L('GET_RECENT_ACTIVITY', { from: '2026-09-21', to: '2026-09-27' })],
    ['what changed yesterday', L('GET_RECENT_ACTIVITY', { from: '2026-09-25', to: '2026-09-25' })],
    ['catch me up', L('GET_RECENT_ACTIVITY')],
    ['what did you do today?', L('GET_BUDDY_ACTIVITY')],
    ['did that go through?', L('GET_BUDDY_ACTIVITY')],
    ["how did the team's day go?", L('GET_TEAM_PULSE')],
    ['any blockers today?', L('GET_TEAM_PULSE')],
    ["who hasn't checked in?", L('GET_TEAM_PULSE')],
  ]),

  /* 2 · synonyms and spelling mistakes ───────────────────────────────── */
  ...g('spelling', [
    ['whats ovrdue', L('GET_OVERDUE_ITEMS')],
    ['show me the unpiad invioces for Acme', L('GET_OUTSTANDING_INVOICES', { client: IDS.acme })],
    ['outstnding invoices', L('GET_OUTSTANDING_INVOICES')],
    ['overdue taks', L('GET_OVERDUE_TASKS')],
    ['reveneu this month', L('GET_MONTHLY_REVENUE', SEP)],
    ['expences last month', L('GET_EXPENSE_SUMMARY', AUG)],
    ['who ows us money', L('GET_OUTSTANDING_INVOICES')],
    ['PLZ SHOW UNPAID INVOICES', L('GET_OUTSTANDING_INVOICES')],
    ['un-paid   invoices ???', L('GET_OUTSTANDING_INVOICES')],
    ['wat is overdue', L('GET_OVERDUE_ITEMS')],
    ['shwo my taskss', L('LIST_TASKS', { assignee: 'me' })],
    ['pendng leave requets', L('LIST_LEAVE', { status: 'pending' })],
    ["dont show unpaid invoices", L('DECLINED_COMMAND')],
  ]),

  /* 3 · negation and contradiction ───────────────────────────────────── */
  ...g('negation', [
    ["don't show unpaid invoices", L('DECLINED_COMMAND')],
    ['do not list the overdue tasks', L('DECLINED_COMMAND')],
    ['never mind', L('BARE_ANSWER')],
    ['invoices that are not paid', L('GET_OUTSTANDING_INVOICES')],
    ["tasks that aren't done", L('LIST_TASKS')],
    ['show invoices that are not overdue', M()],
    ['tasks not assigned to Ravi', M()],
    ['everything except the Acme invoices', M()],
    ['invoices without a due date', M()],
    ['show paid and unpaid invoices', SAFE],
    ["mark the pricing task done but don't close it", M()],
    ["don't forget to add a task to call Kite on Monday", L('CREATE_TASK', { title: /kite/i }, { outcome: 'card' })],
  ]),

  /* 4 · ambiguous names ──────────────────────────────────────────────── */
  ...g('ambiguous', [
    ['tell me about Acme', Q('GET_RECORD_DETAILS')],
    ["what is Priya's email", Q('GET_RECORD_DETAILS')],
    ['change the deadline of the report to the 10th', L('UPDATE_TASK', null, { outcome: 'choice' })],
    ['mark the report done', L('COMPLETE_TASK', null, { outcome: 'choice' })],
    ['tell me about Zephyr Retail', L('GET_RECORD_DETAILS', { type: 'client', ref: IDS.zephyr })],
    ["what is Kite's email", L('GET_RECORD_DETAILS', { type: 'client', ref: IDS.kite, facet: 'email' })],
    ['who is working on the pitch deck?', L('GET_RECORD_DETAILS', { type: 'task', ref: IDS.deck, facet: 'who' })],
    ['when is the Acme renewal call due?', L('GET_RECORD_DETAILS', { type: 'task', ref: IDS.acmeCall, facet: 'when' })],
    ["what's the balance on INV-2026-0012", L('GET_RECORD_DETAILS', { type: 'invoice', ref: IDS.zephyrInv, facet: 'balance' })],
    ['is the pricing task done?', L('GET_RECORD_DETAILS', { type: 'task', ref: IDS.pricing })],
    ['invoices for Nobody Industries', SAFE],
    ['open', SAFE],
    ['pending', Q()],
    ['open invoices', Q()],
    ['open tasks', Q()],
  ]),

  /* 5 · follow-ups that depend on the turn before ────────────────────── */
  ...g('follow-up', [
    ['what about last month?', L('GET_EXPENSE_SUMMARY', AUG), { after: 'how much did we spend this month?' }],
    ['and in August?', L('GET_MONTHLY_REVENUE', AUG), { after: 'revenue this month' }],
    ['and for Zephyr?', L('GET_OUTSTANDING_INVOICES', { client: IDS.zephyr }), { after: 'unpaid invoices' }],
    ['only the overdue ones', L('GET_OVERDUE_PAYMENTS'), { after: 'unpaid invoices' }],
    ['what about Ravi?', L('LIST_TASKS', { assignee: IDS.ravi }), { after: 'show my tasks' }],
    ['and next week?', L('LIST_TASKS', { due_after: '2026-09-28', due_before: '2026-10-04' }), { after: 'tasks due this week' }],
    ['how about yesterday', L('GET_ATTENDANCE', { date: '2026-09-25' }), { after: 'attendance today' }],
    // With nothing before it, the same words mean nothing the engine can act on.
    ['what about last month?', M()],
    ['and for Zephyr?', M()],
    ['only the overdue ones', L('GET_OVERDUE_ITEMS')],
    ['what about tasks?', L('LIST_TASKS'), { after: 'unpaid invoices' }],
  ]),

  /* 6 · missing amounts, dates and required fields ───────────────────── */
  ...g('missing', [
    ['add a task', L('CREATE_TASK', null, { outcome: 'input' })],
    ['record an expense', L('CREATE_EXPENSE', null, { outcome: 'input' })],
    ['create an invoice for Acme', L('CREATE_INVOICE', { client: /acme/i }, { outcome: 'input' })],
    ['what is gst on 25000', Q('CALCULATE_GST')],
    ['invoice 50k', SAFE],
    ['mark it done', L('COMPLETE_TASK', null, { outcome: 'input' })],
    ['spent some money on chairs', SAFE],
  ]),

  /* 7 · reading versus changing ──────────────────────────────────────── */
  ...g('read-vs-write', [
    ['can you mark the pricing task done', L('COMPLETE_TASK', null, { outcome: 'card' })],
    ['how do I create an invoice?', M()],
    ['should I mark the pricing task done?', M()],
    ['did Acme pay?', SAFE],
    ['which tasks did Ravi finish?', SAFE],
    ['maybe we should invoice Acme 50k', M()],
    ['I think we lost the Kite deal', M()],
    ['what happens if I delete the pricing task?', M()],
  ]),

  /* changes said plainly (each must become a card, never a write) ─────── */
  ...g('change', [
    ['move the pricing task to next Friday', L('UPDATE_TASK', { deadline: /friday/i }, { outcome: 'card' })],
    ['Ravi is taking the pricing one', L('UPDATE_TASK', { assignee: /ravi/i }, { outcome: 'card' })],
    ['the landing page copy is urgent', L('UPDATE_TASK', { priority: 'high' }, { outcome: 'card' })],
    ['finished the pitch deck for Acme', L('COMPLETE_TASK', null, { outcome: 'card' })],
    ['mark the pricing task as done', L('COMPLETE_TASK', null, { outcome: 'card' })],
    ['remind me to call Kite on Monday', L('CREATE_TASK', { title: /kite/i }, { outcome: 'card' })],
    ['add a task for Priya to send the proposal by the 5th', L('CREATE_TASK', { title: /proposal/i, assignee: /priya/i }, { outcome: 'card' })],
    ['create a task to renew the SSL certificate by next Friday', L('CREATE_TASK', { title: /ssl/i }, { outcome: 'card' })],
    ['todo: order new business cards', L('CREATE_TASK', { title: /business cards/i }, { outcome: 'card' })],
    ["the Globex invoice follow-up isn't actually finished, reopen it", L('REOPEN_TASK', null, { outcome: 'card' })],
    ['delete the old onboarding checklist task', L('DELETE_TASK', null, { outcome: 'card' })],
    ['assign the Kite app wireframes to Neha', L('UPDATE_TASK', { assignee: /neha/i }, { outcome: 'card' })],
    ["I've started on the pricing task", L('UPDATE_TASK', { status: 'in_progress' }, { outcome: 'card' })],
    ['set the Acme renewal call for 1st Oct', L('UPDATE_TASK', null, { outcome: 'card' })],
    ['we lost the Kite deal', L('MOVE_CLIENT_STAGE', { stage: 'lost' }, { outcome: 'card' })],
    ['Kite signed', L('MOVE_CLIENT_STAGE', { stage: 'deal' }, { outcome: 'card' })],
    ['archive Globex', L('MOVE_CLIENT_STAGE', { stage: 'archived' }, { outcome: 'card' })],
    ['add Orbit Tech as a lead, contact Priya, priya@orbit.io', L('CREATE_CLIENT', { name: 'Orbit Tech', email: 'priya@orbit.io' }, { outcome: 'card' })],
    ['note that Acme wants the proposal in Hindi', L('ADD_CLIENT_NOTE', { client: IDS.acme }, { outcome: 'card' })],
    ['spent 4,500 on chairs yesterday', L('CREATE_EXPENSE', { amount: '4,500' }, { outcome: 'card' })],
    ['paid 25,000 for October rent', L('CREATE_EXPENSE', null, { outcome: 'card' })],
    ['invoice Acme 50k for the website', L('CREATE_INVOICE', { client: /acme/i }, { outcome: 'card' })],
    ['quote Kite 2 lakh for the app build', L('CREATE_QUOTATION', { client: /kite/i }, { outcome: 'card' })],
    ['INV-2026-0012 is settled', L('MARK_INVOICE_PAID', { document: 'INV-2026-0012' }, { outcome: 'card' })],
    ['Zephyr paid 20k against their invoice', L('RECORD_PAYMENT', { amount: '20k' }, { outcome: 'card' })],
    ['convert QT-2026-0003 to an invoice', L('CONVERT_QUOTATION', { source: 'QT-2026-0003' }, { outcome: 'card' })],
    ['issue INV-2026-0013', L('ISSUE_DOCUMENT', { document: 'INV-2026-0013' }, { outcome: 'card' })],
    ['start a project for the Acme rebrand ending 15th Oct', L('CREATE_PROJECT', { name: /rebrand/i }, { outcome: 'card' })],
  ]),

  /* 11 · requests that decompose into several business functions ──────── */
  ...g('decompose', [
    ['what is overdue?', L('GET_OVERDUE_ITEMS')],
    ['overdue invoices and overdue tasks', L('COMPOUND_READ')],
    ['show unpaid invoices and vendor bills', L('COMPOUND_READ')],
    ['my tasks and the team workload', L('COMPOUND_READ')],
    ['how is the business doing', L('GET_BUSINESS_OVERVIEW')],
  ]),

  /* 12 · requests that genuinely need the model ──────────────────────── */
  ...g('needs-model', [
    ['why are expenses up this month?', M()],
    ['should we hire a developer?', M()],
    ['help me collect all overdue payments', M()],
    ['we launch the product in two weeks', M()],
    ['draft an email to Acme about the delay', M()],
    ['text Ravi that the sponsor replied', M()],
    ['make sure Priya sends the deck by Friday', M()],
    ['what do you think about our pricing?', M()],
    ['compare this month with last month', M()],
    ['how can we improve collections?', M()],
    ['write a LinkedIn post about our launch', M()],
    ['explain GST input credit', M()],
    ['mark all the Acme tasks done', M()],
    ["got Dell's bill for 85k, bill no DL-9981", M()],
    ["Acme's new email is ap@acme.com", M()],
    ["prepare for tomorrow's client meeting", M()],
    ["what's our runway?", M()],
    ['summarize the Kite contract', M()],
    ['profit this quarter', M()],
    ['remind me tomorrow at 10 to call the sponsor', M()],
    ['bill Kite for 3 months of support at 20k each', M()],
    ['push the domain renewal back by 3 days', M()],
    ['Acme accepted the quote, bill them', M()],
    ['tell the group standup moved to 5 PM', M()],
    ['is our cash enough to hire two people?', M()],
    ['The client call went badly. They want a discount and a faster timeline. What should we do?', M()],
  ]),

  /* 13 · must be asked or handed on, never guessed ───────────────────── */
  ...g('no-guess', [
    ['do the thing', M()],
    ['asdf qwer', M()],
    ['show unpaid invoices sorted by amount', SAFE],
    ['show me the top 3 clients by revenue', SAFE],
    ['invoices above 50k', SAFE],
    ['tasks for the marketing push', SAFE],
    ['we lost the keys', M()],
    ['finished lunch', M()],
    ['Acme', SAFE],
    ['revenue from Acme this year', SAFE],
    ['unpaid invoices older than 60 days', SAFE],
  ]),

  /* talk, navigation and arithmetic ──────────────────────────────────── */
  ...g('talk', [
    ['hi', L('GREETING')],
    ['hello buddy', L('GREETING')],
    ['thanks!', L('THANKS')],
    ['ok', L('ACKNOWLEDGE')],
    ['bye', L('FAREWELL')],
    ['what can you do?', L('HELP')],
    ['who are you?', L('IDENTITY')],
    ['undo that', L('UNDO_HINT')],
    ['open settings', L('OPEN_PAGE', { page: 'settings' })],
    ['take me to the cashbook', L('OPEN_PAGE', { page: 'cashbook' })],
    ['go to the invoices page', L('OPEN_PAGE', { page: 'invoices' })],
    ['open the P&L', L('OPEN_PAGE', { page: 'profit_loss' })],
    ['open the Acme website project', L('OPEN_RECORD', { type: 'project', ref: IDS.acmeWeb })],
    ['18% gst on 50k', L('CALCULATE_GST', { amount: 50000, rate: 18 })],
    ['gst on 1 lakh at 12%', L('CALCULATE_GST', { amount: 100000, rate: 12 })],
    ['59000 including 18% gst', L('CALCULATE_GST', { amount: 59000, rate: 18, inclusive: true })],
  ]),
];
