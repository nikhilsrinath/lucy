import {
  blankDraft, parseCashSentence, parseAmount, parseCurrency, parseDate, parseMethod, parseGstRate,
  guessCategory, nextQuestion, validateDraft, baseAmount, taxFromRate, draftTreatment, cashEntryRow,
  CURRENCIES, methodOptions,
} from '../../../../src/shared/cashIntent.js';
import {
  setCategories, allCategories, categoriesFor, categoryOf, categoryLabel, TREATMENTS, PAYMENT_METHODS, methodLabel,
} from '../../../../src/shared/financeTaxonomy.js';
import { isIsoDate } from '../../../../src/shared/dates.js';
import { resolveEntity, loadKind, byId } from '../resolvers.js';
import { choiceFrom, needsInput, notFound, money, formatDate } from '../helpers.js';

/**
 * create_cash_entry — money in or out that no invoice represents.
 *
 * Replaces the browser-only cash flow (AssistantContext + CashEntryCard): the
 * questions it asked, the parsers it read the sentence with and the checks it
 * made before saving are the same functions, now called here. The model
 * decides that money moved and which way; everything about the figure — the
 * amount, "1.2 lakh", the date "yesterday", the 18% inside it, the rail, the
 * category — is read by src/shared/cashIntent.js, not by the model.
 *
 * High risk: it records money. The card shows the whole row the executor
 * will write, and the button names the amount.
 */

const GST_RATES = [0, 5, 12, 18, 28];
const TABLE = { in: 'income_entries', out: 'expenses' };
const DATE_COL = { in: 'received_on', out: 'incurred_on' };

/** finance_categories is reference data every org shares — loaded once per instance. */
async function ensureCategories(ctx) {
  if (allCategories().length) return;
  const { data, error } = await ctx.db.from('finance_categories')
    .select('key, label, direction, group_label, treatment, hint, sort_order, active')
    .order('sort_order');
  if (!error && data?.length) setCategories(data);
}

async function openProjects(ctx) {
  if (!ctx.can('projects', 'view')) return [];
  const [projects, clients] = await Promise.all([loadKind('project', ctx), loadKind('client', ctx)]);
  const names = Object.fromEntries(clients.map((c) => [c.id, c.name]));
  return projects.filter((p) => !p.archived_at && !['completed', 'cancelled'].includes(p.status))
    .map((p) => ({ id: p.id, code: p.code, name: p.name, client: names[p.client_id] || '' }));
}

/** The rail used on this side of the ledger most recently — the default when none was said. */
async function lastMethod(direction, ctx) {
  const { data } = await ctx.db.from(TABLE[direction]).select('payment_method')
    .order('created_at', { ascending: false }).limit(1);
  return data?.[0]?.payment_method || null;
}

const SLOT_PARAM = {
  direction: 'direction', amount: 'amount', description: 'description', category: 'category',
  date: 'date', payment_method: 'payment_method', project: 'project',
};

function readDirection(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['in', 'income', 'money in', 'received'].includes(s)) return 'in';
  if (['out', 'expense', 'money out', 'spent', 'paid'].includes(s)) return 'out';
  return null;
}

/**
 * Builds the draft from the arguments, falling back to what the user's own
 * sentence says for anything the model left out. Returns { draft } or a
 * needs/error stop.
 */
async function buildDraft(args, ctx) {
  await ensureCategories(ctx);
  const direction = readDirection(args.direction);
  const source = String(args.source_text || '').trim();
  const projects = await openProjects(ctx);

  let draft = blankDraft(direction, ctx.today);
  if (source && direction) draft = { ...draft, ...parseCashSentence(source, direction, ctx.today, projects) };
  // A project is optional. It is asked about only when the person mentioned
  // one; "Acme paid us" names a client, and asking which of Acme's projects
  // is a question they did not raise.
  if (!/\b(?:project|prj-\d)/i.test(source)) draft.project_candidates = [];

  // The model's structured arguments, each read by the same parser.
  if (args.amount !== undefined && args.amount !== '') {
    const a = Number.isFinite(Number(args.amount)) ? { amount: Number(args.amount), currency: null } : parseAmount(String(args.amount));
    if (!a) return needsInput('amount', `I could not read “${args.amount}” as an amount. How much was it?`);
    draft.original_amount = String(a.amount);
    if (a.currency) draft.currency = a.currency;
  }
  if (args.currency) {
    const c = String(args.currency).toUpperCase();
    draft.currency = CURRENCIES.includes(c) ? c : parseCurrency(args.currency) || draft.currency;
  }
  if (args.fx_rate !== undefined && args.fx_rate !== '') draft.fx_rate = Number(args.fx_rate) || draft.fx_rate;
  if (args.description) draft.description = String(args.description).trim().slice(0, 120);
  if (args.date) {
    const d = isIsoDate(args.date) ? { date: args.date } : parseDate(String(args.date), ctx.today);
    if (!d) return needsInput('date', `I could not read “${args.date}” as a date. When was it?`,
      [{ label: 'Today', value: 'today' }, { label: 'Yesterday', value: 'yesterday' }]);
    draft.date = d.date;
  }
  if (args.payment_method) {
    const key = PAYMENT_METHODS.find((m) => m.key === args.payment_method || m.label.toLowerCase() === String(args.payment_method).toLowerCase())?.key
      || parseMethod(String(args.payment_method))?.method;
    if (key) draft.payment_method = key;
  }
  if (args.gst_rate !== undefined && args.gst_rate !== '') {
    const r = Number.isFinite(Number(args.gst_rate)) ? Number(args.gst_rate) : parseGstRate(String(args.gst_rate))?.rate;
    if (Number.isFinite(r)) draft.tax_rate = r;
  }
  if (args.reference) draft.reference = String(args.reference).slice(0, 120);

  if (direction && args.category) {
    // The model chose from the org's real category list (modelParams), by
    // what the money was for. A key it did not take from that list is read
    // as words; the sentence parser is only the fallback when it chose none.
    const exact = categoryOf(args.category);
    draft.category = exact && exact.direction === direction ? exact.key
      : guessCategory(String(args.category), direction) || draft.category;
  }
  if (direction && !draft.category) {
    draft.category = guessCategory(`${draft.description} ${source}`, direction) || '';
  }

  // Who it was with: a client for money in, a vendor for money out.
  if (direction && args.counterparty) {
    const kind = direction === 'in' ? 'client' : 'vendor';
    const r = await resolveEntity(kind, args.counterparty, ctx);
    if (r.status === 'one') draft[direction === 'in' ? 'client_id' : 'vendor_id'] = r.row.id;
    else if (r.status === 'many') return choiceFrom('counterparty', kind, r);
    // Nobody by that name is not a reason to stop: the entry stands without
    // the link, and the description still carries the name.
  }

  if (args.project !== undefined && args.project !== '') {
    if (/^(?:none|no|overhead|no project)$/i.test(String(args.project))) {
      draft.project_id = '';
      draft.project_candidates = [];
    } else {
      const r = await resolveEntity('project', args.project, ctx, { filter: (p) => projects.some((o) => o.id === p.id) });
      if (r.status === 'one') { draft.project_id = r.row.id; draft.project_candidates = []; }
      else if (r.status === 'many') return choiceFrom('project', 'project', r);
      else return notFound(`I could not find an open project matching “${args.project}”.`);
    }
  }

  if (draft.direction && !draft.payment_method) draft.payment_method = (await lastMethod(draft.direction, ctx)) || '';
  if (Number(draft.tax_rate) > 0) draft.tax_amount = String(taxFromRate(baseAmount(draft), draft.tax_rate));
  return { draft };
}

const params = {
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ['in', 'out'], description: '"out" for money spent or paid by us, "in" for money received.' },
    amount: { type: 'string', description: 'The amount exactly as the user said it: "4,500", "1.2 lakh", "$300", "50k".' },
    description: { type: 'string', description: 'What it was for, in a few words of your own: "Office chairs", "October rent", "Payment from Kite for app design".' },
    category: { type: 'string', description: 'Category key if known, else a word or two ("furniture", "rent").' },
    date: { type: 'string', description: 'When it happened, as said ("yesterday", "5 Oct") or YYYY-MM-DD. Omit for today.' },
    payment_method: { type: 'string', enum: PAYMENT_METHODS.map((m) => m.key) },
    gst_rate: { type: 'number', description: 'GST % included in the amount, only if the user said one.' },
    currency: { type: 'string', description: 'ISO code if not rupees.' },
    fx_rate: { type: 'number', description: 'Rupees per unit of a foreign currency, only if the user said it.' },
    counterparty: { type: 'string', description: 'Who paid us (money in) or whom we paid (money out), as named.' },
    project: { type: 'string', description: 'Project name or code this money belongs to, or "none".' },
    reference: { type: 'string', description: 'Bill number, UTR or cheque number, if given.' },
    source_text: { type: 'string', description: 'The user\'s own sentence(s) about this money, verbatim.' },
  },
  required: ['direction', 'description', 'source_text'],
};

const create_cash_entry = {
  name: 'create_cash_entry',
  module: 'finance',
  kind: 'write',
  risk: 'high',
  // Visible to anyone who can record money in either direction; resolve()
  // checks the side this entry is on.
  permission: { resource: ['expenses', 'income_entries'], action: 'create' },
  description: 'Record money that moved without an invoice: an expense paid or money received. Implied by statements like '
    + '"spent 4,500 on chairs", "paid the October rent", "got 20k from a counter sale", "Acme paid us 50k advance by UPI". '
    + 'Not for an issued invoice being paid (that is a payment against the invoice). Pass the user\'s own words as source_text '
    + 'and the amount exactly as said.',
  params,
  undoable: (args, ctx) => ctx.can(TABLE[args.direction], 'delete'),

  // The real category list goes to the model, so it chooses by meaning —
  // "office chairs" is furniture you own, "chair repair" a running cost —
  // rather than a keyword table choosing for it.
  async prepare(ctx) { await ensureCategories(ctx); },
  modelParams() {
    const list = (dir) => categoriesFor(dir).map((c) => `${c.key} = ${c.label}`).join('; ');
    if (!allCategories().length) return params;
    return {
      ...params,
      properties: {
        ...params.properties,
        category: {
          type: 'string',
          description: `The category key that fits what the money was for. Money out: ${list('out')}. Money in: ${list('in')}.`,
        },
      },
    };
  },

  async resolve(args, ctx) {
    const direction = readDirection(args.direction);
    if (!direction) {
      return needsInput('direction', 'Did this money come in, or go out?',
        [{ label: 'Money in', value: 'in' }, { label: 'Money out', value: 'out' }]);
    }
    if (!ctx.can(TABLE[direction], 'create')) {
      return { error: `Your role cannot record ${direction === 'in' ? 'money in' : 'expenses'}.`, fatal: true };
    }
    const built = await buildDraft({ ...args, direction }, ctx);
    if (!built.draft) return built;
    const { draft } = built;

    const qn = nextQuestion(draft);
    if (qn) {
      const param = SLOT_PARAM[qn.slot] || qn.slot;
      return needsInput(param, qn.text, qn.options || [], { hint: qn.hint || null });
    }
    if (draft.currency !== 'INR' && !(Number(args.fx_rate) > 0) && Number(draft.fx_rate) === 1) {
      return needsInput('fx_rate', `What rate did you get — 1 ${draft.currency} in ₹?`, [],
        { hint: 'There is no rate feed; the rate you enter is the one the books use.' });
    }

    return {
      args: {
        direction,
        amount: String(draft.original_amount),
        currency: draft.currency,
        fx_rate: Number(draft.fx_rate) || 1,
        description: draft.description,
        category: draft.category,
        date: draft.date,
        payment_method: draft.payment_method,
        gst_rate: Number(draft.tax_rate) || 0,
        counterparty: draft.client_id || draft.vendor_id || undefined,
        project: draft.project_id || undefined,
        reference: draft.reference || undefined,
      },
    };
  },

  async validate(args, ctx) {
    const built = await buildDraft(args, ctx);
    if (!built.draft) return ['Some details are missing.'];
    const problems = validateDraft(built.draft);
    if (!isIsoDate(built.draft.date)) problems.push('Choose a date.');
    if (built.draft.date > ctx.today) problems.push(`${formatDate(built.draft.date)} has not happened yet — record money once it has moved.`);
    return problems;
  },

  async preview(args, ctx) {
    const { draft } = await buildDraft(args, ctx);
    const base = baseAmount(draft);
    const t = TREATMENTS[draftTreatment(draft)];
    const inward = draft.direction === 'in';
    const party = draft.client_id ? (await byId('client', draft.client_id, ctx))?.name
      : draft.vendor_id ? (await byId('vendor', draft.vendor_id, ctx))?.company_name : null;
    const project = draft.project_id ? await byId('project', draft.project_id, ctx) : null;
    const rows = [
      ['Direction', inward ? 'Money in' : 'Money out'],
      ['Amount', draft.currency === 'INR' ? money(base)
        : `${money(draft.original_amount, draft.currency)} × ${draft.fx_rate} = ${money(base)}`],
      ['For', draft.description],
      ['Category', categoryLabel(draft.category)],
      ['Date', formatDate(draft.date)],
      [inward ? 'Received by' : 'Paid by', methodLabel(draft.payment_method)],
      ['GST inside', Number(draft.tax_rate) > 0 ? `${draft.tax_rate}% — ${money(draft.tax_amount)}` : 'None'],
    ];
    if (party) rows.push([inward ? 'From' : 'To', party]);
    if (project) rows.push(['Project', `${project.code} · ${project.name}`]);
    if (draft.reference) rows.push(['Reference', draft.reference]);
    return {
      title: inward ? 'Record money in' : 'Record expense',
      preview: { kind: 'cash_entry', rows, note: t ? `${t.label}. ${t.note}` : null, amount: money(base), direction: draft.direction },
      confirmLabel: `Record ${money(base)} ${inward ? 'money in' : 'expense'}`,
      fields: [
        { key: 'description', label: 'What it was for', type: 'text', value: draft.description },
        { key: 'amount', label: `Amount (${draft.currency})`, type: 'text', value: String(draft.original_amount) },
        { key: 'category', label: 'Category', type: 'select', value: draft.category,
          options: categoriesFor(draft.direction).map((c) => ({ value: c.key, label: c.label, group: c.group_label })) },
        { key: 'date', label: 'Date', type: 'date', value: draft.date, max: ctx.today },
        { key: 'payment_method', label: inward ? 'Received by' : 'Paid by', type: 'select', value: draft.payment_method, options: methodOptions() },
        { key: 'gst_rate', label: 'GST inside the amount', type: 'select', value: String(Number(draft.tax_rate) || 0),
          options: GST_RATES.map((r) => ({ value: String(r), label: r ? `${r}%` : 'No GST' })) },
        { key: 'reference', label: 'Reference', type: 'text', value: draft.reference || '' },
      ],
    };
  },

  async plan(args, ctx) {
    const { draft } = await buildDraft(args, ctx);
    const { table, row } = cashEntryRow(draft);
    const op = { op: 'insert', table, row: { ...row, org_id: ctx.orgId } };
    if (draft.project_id && ctx.can('project_allocations', 'create')) {
      const sourceType = draft.direction === 'in' ? 'income_entry' : 'expense';
      op.then = (inserted) => [{
        op: 'rpc', fn: 'set_project_allocations',
        params: { p_source_type: sourceType, p_source_id: inserted.id, p_splits: [{ project_id: draft.project_id, amount: null }] },
      }];
    }
    return [op];
  },

  summary(outcome, args) {
    const r = outcome.results.find((x) => !x.followUp);
    if (!r || r.ok === false) return `Not recorded: ${r?.error || 'the entry could not be saved.'}`;
    const row = r.after || {};
    const amount = Number(row.amount) || (Number(row.original_amount) || 0) * (Number(row.fx_rate) || 1);
    const date = row[DATE_COL[args.direction]];
    let line = `Recorded ${args.direction === 'in' ? 'money in' : 'an expense'} of **${money(amount)}** — ${row.description} (${categoryLabel(row.category)})${date ? ` on ${formatDate(date)}` : ''}.`;
    if (outcome.warnings?.length) line += ` Recorded, but not linked to the project: ${outcome.warnings[0]}`;
    return line;
  },

  href: () => '/cashbook',
};


export default [create_cash_entry];
