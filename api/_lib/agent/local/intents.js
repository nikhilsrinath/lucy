import { getTool } from '../registry.js';

/**
 * The intent registry: what the local engine can recognise, and which
 * existing business function carries each one out.
 *
 * An intent is a meaning, not a sentence. Many phrasings reach one intent
 * (lexicon.js, understand.js); one intent maps to one tool of the agent's own
 * catalogue (../registry.js) — the same code the model calls — so there is no
 * second implementation of any business rule, permission or confirmation.
 *
 *   id            unique name
 *   description   what the person wants, in plain words
 *   tool          the business function (a registry tool), or null for talk
 *   fixed         arguments the intent always passes to its tool
 *   params        the arguments it may extract: { type, required?, entity? }
 *   render        the response template (render.js)
 *   escalate      when the model takes over:
 *                   'never'        always answered here
 *                   'unresolved'   if the tool cannot place what was said
 *                   'always'       recognised, but needs the model (listed so
 *                                  the router can say why it escalated)
 *
 * Read-only or mutating, the permission it needs, its risk and whether it
 * must be confirmed are NOT declared here: they are read off the tool
 * (describeIntent), so the registry cannot drift from what the tool enforces.
 */

const S = (required = false, extra = {}) => ({ type: 'string', required, ...extra });
const E = (entity, required = false) => ({ type: 'string', entity, required });
const PERIOD = { from: { type: 'date' }, to: { type: 'date' } };

const def = (id, description, tool, rest = {}) => ({ id, description, tool, fixed: {}, params: {}, render: null, escalate: 'never', ...rest });

export const INTENTS = [
  /* ── money ───────────────────────────────────────────────────────────── */
  def('GET_CASH_BALANCE', 'How much cash the company has.', 'finance_summary', { render: 'finance', fixed: { focus: 'cash' }, local: ['focus'] }),
  def('GET_FINANCE_SUMMARY', 'The headline money figures: cash, receivables, overdue, payables.', 'finance_summary', { render: 'finance', params: { focus: S() }, local: ['focus'] }),
  def('GET_MONTHLY_REVENUE', 'What was invoiced and what came in over a period.', 'money_for_period', { render: 'period_money', fixed: { focus: 'revenue' }, params: PERIOD, local: ['focus'] }),
  def('GET_EXPENSE_SUMMARY', 'What was spent over a period, by category.', 'money_for_period', { render: 'period_money', fixed: { focus: 'expenses' }, params: PERIOD, local: ['focus'] }),
  def('GET_CASH_FLOW', 'Money in against money out over a period.', 'money_for_period', { render: 'period_money', fixed: { focus: 'flow' }, params: PERIOD, local: ['focus'] }),
  def('GET_OUTSTANDING_INVOICES', 'Who owes the company money: issued invoices with a balance left.', 'list_invoices', { render: 'invoices', fixed: { unpaid: true }, params: { client: E('client'), type: S(), ...PERIOD } }),
  def('GET_OVERDUE_PAYMENTS', 'Unpaid invoices past their due date.', 'list_invoices', { render: 'invoices', fixed: { overdue: true }, params: { client: E('client'), type: S(), ...PERIOD } }),
  def('LIST_INVOICES', 'Invoices, quotations or proformas, by status, client or date.', 'list_invoices', { render: 'invoices', params: { type: S(), status: S(), client: E('client'), ...PERIOD } }),
  def('GET_VENDOR_BILLS', 'What the company owes vendors: purchase bills, open or overdue.', 'list_bills', { render: 'bills', params: { status: S(), vendor: E('vendor') } }),
  def('CALCULATE_GST', 'GST on an amount, added or backed out.', null, { render: 'gst', params: { amount: { type: 'number', required: true }, rate: { type: 'number', required: true }, inclusive: { type: 'boolean' } } }),

  /* ── work ────────────────────────────────────────────────────────────── */
  def('LIST_TASKS', 'Tasks by status, owner, project, client or due window.', 'list_tasks', { render: 'tasks', params: { status: S(), assignee: E('employee'), project: E('project'), client: E('client'), text: S(), due_after: { type: 'date' }, due_before: { type: 'date' } } }),
  def('GET_OVERDUE_TASKS', 'Tasks past their deadline.', 'list_tasks', { render: 'tasks', fixed: { status: 'overdue' }, params: { assignee: E('employee'), project: E('project'), client: E('client'), text: S() } }),
  def('GET_OVERDUE_ITEMS', 'Everything overdue: tasks and invoices together.', null, { render: 'composite', steps: ['GET_OVERDUE_TASKS', 'GET_OVERDUE_PAYMENTS'] }),
  def('LIST_PROJECTS', 'Projects with status and health.', 'list_projects', { render: 'projects', params: { status: S(), health: S(), client: E('client') } }),
  def('LIST_TEAM', 'The team and each person\'s load.', 'list_team', { render: 'team', params: { person: E('employee') } }),
  def('LIST_LEAVE', 'Who is on leave, and leave requests waiting.', 'list_leave', { render: 'leave', params: { employee: E('employee'), status: S(), ...PERIOD } }),
  def('GET_ATTENDANCE', 'Who was present, remote, on leave or absent.', 'get_attendance', { render: 'attendance', params: { employee: E('employee'), date: { type: 'date' }, ...PERIOD } }),
  def('GET_TEAM_PULSE', 'The Daily Pulse: who checked in and what they said.', 'team_pulse', { render: 'pulse', params: { date: { type: 'date' } } }),

  /* ── clients, documents, the company ─────────────────────────────────── */
  def('LIST_CLIENTS', 'Clients and the sales pipeline, by stage or quiet for a while.', 'list_clients', { render: 'clients', params: { stage: S(), inactive_days: { type: 'integer' } } }),
  def('SEARCH_COMPANY_DOCUMENTS', 'Documents in the company library by words or category.', 'list_documents', { render: 'documents', params: { text: S(), category: S() } }),
  def('GET_INSIGHTS', 'What needs attention right now.', 'get_insights', { render: 'insights' }),
  def('GET_BUSINESS_OVERVIEW', 'How the company is doing: what needs attention plus the money figures.', null, { render: 'composite', steps: ['GET_INSIGHTS', 'GET_FINANCE_SUMMARY'] }),
  def('COMPOUND_READ', 'Two or three reads asked for in one message.', null, { render: 'composite' }),
  def('GET_RECENT_ACTIVITY', 'What happened in the company over a period.', 'recent_activity', { render: 'activity', params: PERIOD }),
  def('GET_BUDDY_ACTIVITY', 'What Buddy proposed and did recently.', 'buddy_activity', { render: 'buddy_activity', params: { days: { type: 'integer' } } }),
  def('GET_RECORD_DETAILS', 'Everything about one task, client, person, project, invoice or vendor.', 'get_record', { render: 'record', params: { type: S(true), ref: S(true), facet: S() }, local: ['facet'], escalate: 'unresolved' }),
  def('SEARCH_RECORDS', 'Find records by name across the company.', 'search', { render: 'search', params: { query: S(true) } }),
  def('OPEN_PAGE', 'Open a screen of the app.', 'open_page', { render: 'navigate', params: { page: S(true), note: S() }, local: ['note'] }),
  def('OPEN_RECORD', 'Open one record\'s screen.', 'open_record', { render: 'navigate', params: { type: S(true), ref: S(true) } }),

  /* ── changes (always a card the person confirms) ─────────────────────── */
  def('CREATE_TASK', 'Create a task.', 'create_task', { params: { title: S(true), deadline: S(), assignee: S(), priority: S(), project: S() }, escalate: 'unresolved' }),
  def('COMPLETE_TASK', 'Mark a task done.', 'complete_task', { params: { task: S() }, escalate: 'unresolved' }),
  def('REOPEN_TASK', 'Reopen a finished task.', 'reopen_task', { params: { task: S() }, escalate: 'unresolved' }),
  def('UPDATE_TASK', 'Change a task\'s deadline, owner, priority or status.', 'update_task', { params: { task: S(), deadline: S(), assignee: S(), priority: S(), status: S() }, escalate: 'unresolved' }),
  def('DELETE_TASK', 'Delete a task.', 'delete_task', { params: { task: S() }, escalate: 'unresolved' }),
  def('CREATE_CLIENT', 'Add a client or lead.', 'create_client', { params: { name: S(true), stage: S(), email: S(), phone: S(), person_name: S(), value: S() }, escalate: 'unresolved' }),
  def('MOVE_CLIENT_STAGE', 'Move a client to a CRM stage.', 'move_client_stage', { params: { client: S(true), stage: S(true) }, escalate: 'unresolved' }),
  def('ADD_CLIENT_NOTE', 'Add a note to a client.', 'add_client_note', { params: { client: S(true), note: S(true) }, escalate: 'unresolved' }),
  def('DELETE_CLIENT', 'Delete a client.', 'delete_client', { params: { client: S(true) }, escalate: 'unresolved' }),
  def('CREATE_EXPENSE', 'Record money paid out with no bill behind it.', 'create_cash_entry', { fixed: { direction: 'out' }, params: { description: S(true), source_text: S(true), amount: S(), date: S(), counterparty: S() }, escalate: 'unresolved' }),
  def('CREATE_INCOME', 'Record money received with no invoice behind it.', 'create_cash_entry', { fixed: { direction: 'in' }, params: { description: S(true), source_text: S(true), amount: S(), date: S(), counterparty: S() }, escalate: 'unresolved' }),
  def('CREATE_INVOICE', 'Draft a tax invoice.', 'create_invoice_draft', { params: { client: S(true), items: { type: 'array' }, no_gst: { type: 'boolean' }, discount_percent: { type: 'number' } }, escalate: 'unresolved' }),
  def('CREATE_QUOTATION', 'Draft a quotation.', 'create_quotation_draft', { params: { client: S(true), items: { type: 'array' }, no_gst: { type: 'boolean' }, discount_percent: { type: 'number' } }, escalate: 'unresolved' }),
  def('CREATE_PROFORMA', 'Draft a proforma invoice.', 'create_proforma_draft', { params: { client: S(true), items: { type: 'array' }, advance_percent: { type: 'number' }, no_gst: { type: 'boolean' }, discount_percent: { type: 'number' } }, escalate: 'unresolved' }),
  def('MARK_INVOICE_PAID', 'Record an invoice\'s whole balance as received.', 'mark_invoice_paid', { params: { document: S(true), method: S() }, escalate: 'unresolved' }),
  def('RECORD_PAYMENT', 'Record a payment against an invoice.', 'record_payment', { params: { document: S(true), amount: S(), method: S() }, escalate: 'unresolved' }),
  def('ISSUE_DOCUMENT', 'Issue a draft invoice, quotation or proforma.', 'issue_document', { params: { document: S(true) }, escalate: 'unresolved' }),
  def('CANCEL_DOCUMENT', 'Cancel an issued invoice, quotation or proforma.', 'cancel_financial_document', { params: { document: S(true) }, escalate: 'unresolved' }),
  def('CONVERT_QUOTATION', 'Turn a quotation into a proforma or an invoice.', 'convert_quotation', { params: { source: S(true), target: S() }, escalate: 'unresolved' }),
  def('DRAFT_PAYMENT_REMINDER', 'Prepare a payment reminder email from the standard template.', 'send_payment_reminder', { params: { invoice: S(true) }, escalate: 'unresolved' }),
  def('CREATE_PROJECT', 'Create a project.', 'create_project', { params: { name: S(true), client: S(), target_end_date: S() }, escalate: 'unresolved' }),
  def('CREATE_VENDOR', 'Add a supplier.', 'create_vendor', { params: { company_name: S(true), gstin: S(), payment_terms_days: { type: 'number' } }, escalate: 'unresolved' }),

  /* ── talk and controls (no business function) ────────────────────────── */
  def('GREETING', 'A hello.', null, { render: 'social' }),
  def('THANKS', 'A thank-you.', null, { render: 'social' }),
  def('ACKNOWLEDGE', 'An acknowledgement ("ok", "got it").', null, { render: 'social' }),
  def('FAREWELL', 'A goodbye.', null, { render: 'social' }),
  def('HELP', 'What Buddy can do.', null, { render: 'social' }),
  def('IDENTITY', 'Who Buddy is.', null, { render: 'social' }),
  def('CONFIRM_HINT', 'A typed "yes" while a card waits: cards are confirmed by tapping.', null, { render: 'social' }),
  def('UNDO_HINT', 'A typed "undo": undo is the card\'s own button.', null, { render: 'social' }),
  def('CANCEL_PROPOSAL', 'Withdraw the open card.', null, { render: 'social', params: { action_id: S() } }),
  def('DECLINED_COMMAND', 'An instruction NOT to do something.', null, { render: 'social' }),
  def('BARE_ANSWER', 'A "yes" or "no" with nothing open to answer.', null, { render: 'social' }),

  /* ── recognised, but the model's job ─────────────────────────────────── */
  def('CREATE_PROJECT_PLAN', 'A goal that needs a multi-step plan.', 'propose_plan', { escalate: 'always' }),
  def('ADVICE', 'Advice, reasoning, a recommendation or an explanation.', null, { escalate: 'always' }),
  def('COMPOSE_MESSAGE', 'Original writing: an email, a message to a teammate, a post.', null, { escalate: 'always' }),
  def('FOLLOW_THROUGH', 'Chasing someone until something is done; timed reminders.', 'start_followup', { escalate: 'always' }),
  def('BULK_CHANGE', 'The same change to many records at once.', null, { escalate: 'always' }),
  def('PROFIT_ANALYSIS', 'Profit, margin or runway: needs the P&L treatments explained.', 'ask_brain', { escalate: 'always' }),
  def('DAILY_CHECKIN', 'A free-form reply to the Daily Pulse.', null, { escalate: 'always' }),
  def('OPEN_ENDED', 'Anything the engine does not recognise.', null, { escalate: 'always' }),
];

const BY_ID = new Map(INTENTS.map((i) => [i.id, i]));

export const getIntent = (id) => BY_ID.get(id) || null;

/**
 * What an intent requires, read off its tool: whether it only reads, the
 * permission it needs, its risk, and whether a person must confirm it.
 */
export function describeIntent(id) {
  const intent = getIntent(id);
  if (!intent) return null;
  const tool = intent.tool ? getTool(intent.tool) : null;
  const steps = (intent.steps || []).map((s) => describeIntent(s)).filter(Boolean);
  return {
    id: intent.id,
    description: intent.description,
    tool: intent.tool,
    readOnly: tool ? tool.kind !== 'write' && tool.kind !== 'plan' : true,
    risk: tool?.kind === 'write' ? tool.risk : null,
    requiresConfirmation: tool?.kind === 'write' || tool?.kind === 'plan',
    requiredPermissions: tool?.permission ? [tool.permission] : steps.flatMap((s) => s.requiredPermissions),
    privateOnly: !!tool?.privateOnly,
    escalate: intent.escalate,
  };
}

/** Problems in the registry, for the tests: an intent naming a tool that does not exist, a required argument the tool does not take. */
export function intentProblems() {
  const problems = [];
  const seen = new Set();
  for (const intent of INTENTS) {
    if (seen.has(intent.id)) problems.push(`duplicate intent ${intent.id}`);
    seen.add(intent.id);
    if (!intent.description) problems.push(`${intent.id}: no description`);
    if (!['never', 'unresolved', 'always'].includes(intent.escalate)) problems.push(`${intent.id}: bad escalation policy`);
    for (const step of intent.steps || []) if (!BY_ID.has(step)) problems.push(`${intent.id}: unknown step ${step}`);
    if (!intent.tool) continue;
    const tool = getTool(intent.tool);
    if (!tool) { problems.push(`${intent.id}: unknown tool ${intent.tool}`); continue; }
    if (intent.escalate === 'always') continue;
    const known = new Set(Object.keys(tool.params?.properties || {}));
    const local = new Set(intent.local || []);
    for (const key of [...Object.keys(intent.fixed), ...Object.keys(intent.params)]) {
      if (!known.has(key) && !local.has(key)) problems.push(`${intent.id}: ${intent.tool} takes no "${key}"`);
    }
    if (intent.render === null && tool.kind !== 'write') problems.push(`${intent.id}: a read needs a renderer`);
  }
  return problems;
}

/**
 * The arguments an intent may send to its tool, cleaned: only declared keys,
 * of the declared type. Run on everything that reaches a tool from here —
 * including arguments a client sent back with a tapped chip.
 */
export function cleanArgs(intent, raw = {}) {
  const out = {};
  for (const [key, spec] of Object.entries(intent.params)) {
    const v = raw[key];
    if (v === undefined || v === null || v === '') continue;
    if (spec.type === 'string' || spec.type === 'date') {
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      out[key] = String(v).slice(0, 400);
    } else if (spec.type === 'integer' || spec.type === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[key] = spec.type === 'integer' ? Math.round(n) : n;
    } else if (spec.type === 'boolean') {
      out[key] = v === true || v === 'true';
    } else if (spec.type === 'array') {
      if (Array.isArray(v)) out[key] = v.slice(0, 20);
    }
  }
  return { ...out, ...intent.fixed };
}
