import {
  KINDS, loadKind, resolveEntity, rankCandidates, entityOf, byId,
} from '../resolvers.js';
import { readDate, formatDate, money } from '../helpers.js';
import { getMetrics, headlineSection, buildContext, CONTEXT_RULES } from '../../brainRetrieval.js';

/**
 * Read tools. They run the moment the model calls them — no card, no
 * confirmation — and what they return goes back to the model as data.
 *
 * Every figure a read tool returns is computed over the whole filtered set,
 * and says so: `total_matching` is a count of all matching rows, and the list
 * beside it is labelled as the first N. A reply built from these can say
 * "3 of 14 overdue invoices" but never mistake a page of results for the
 * whole table (see memory: EdgeBrain must not bluff).
 *
 * Reads go through the user's own client, so a row their role cannot see is
 * not in any count.
 */

const STATUS_LABEL = { pending: 'pending', in_progress: 'in progress', done: 'done', overdue: 'overdue' };
const clamp = (n, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : d));

async function nameOf(kind, id, ctx) {
  if (!id) return null;
  const row = await byId(kind, id, ctx);
  return row ? KINDS[kind].label(row) : null;
}

/** An optional entity filter: { id } when it resolved, { reply } when it did not. */
async function filterEntity(kind, ref, ctx) {
  if (ref === undefined || ref === null || ref === '') return { id: undefined };
  const r = await resolveEntity(kind, ref, ctx);
  if (r.status === 'one') return { id: r.row.id, entity: r.entity };
  if (r.status === 'many') {
    return { reply: { ambiguous: true, kind, said: ref, candidates: r.candidates.map((c) => c.entity.label) } };
  }
  return { reply: { not_found: true, kind, said: ref, searched: r.searched } };
}

/* ── search ───────────────────────────────────────────────────────────────── */

const search = {
  name: 'search',
  module: 'core',
  kind: 'read',
  permission: null,
  description: 'Find records by name across tasks, clients, people, projects, invoices and vendors. Use it to identify what the user is referring to.',
  params: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      kinds: { type: 'array', items: { type: 'string', enum: Object.keys(KINDS) } },
    },
    required: ['query'],
  },
  status: 'Searching…',
  async run(args, ctx) {
    const kinds = (args.kinds?.length ? args.kinds : Object.keys(KINDS))
      .filter((k) => KINDS[k] && ctx.can(KINDS[k].resource, 'view'));
    const hits = [];
    for (const kind of kinds) {
      const def = KINDS[kind];
      const rows = await loadKind(kind, ctx);
      const ranked = rankCandidates(args.query, rows.map((r) => ({ id: r.id, aliases: def.aliases(r), updatedAt: r.updated_at })), { limit: 5 });
      for (const c of ranked.candidates || []) {
        const row = rows.find((r) => r.id === c.id);
        hits.push({ score: c.score, entity: entityOf(kind, row) });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, 8);
    return {
      data: { query: args.query, results: top.map((h) => ({ type: h.entity.type, id: h.entity.id, name: h.entity.label })), searched: kinds },
      entities: top.map((h) => h.entity),
    };
  },
};

/* ── one record ───────────────────────────────────────────────────────────── */

const get_record = {
  name: 'get_record',
  module: 'core',
  kind: 'read',
  permission: null,
  description: 'Everything about one record — a task, client, person, project, invoice or vendor — by name, code or "it".',
  params: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: Object.keys(KINDS) },
      ref: { type: 'string', description: 'Name, code, id, or "it" for the one being discussed.' },
    },
    required: ['type', 'ref'],
  },
  status: 'Looking it up…',
  async run(args, ctx) {
    const kind = args.type;
    if (!KINDS[kind]) return { data: { error: `Unknown record type ${kind}` } };
    if (!ctx.can(KINDS[kind].resource, 'view')) return { data: { error: `Your role cannot view ${KINDS[kind].noun}s.` } };
    const f = await filterEntity(kind, args.ref, ctx);
    if (f.reply) return { data: f.reply };
    const row = await byId(kind, f.id, ctx);
    const record = { ...row };
    if (kind === 'task') {
      record.assignee = row.assignee_label || await nameOf('employee', row.assignee_id, ctx);
      record.project = await nameOf('project', row.project_id, ctx);
      record.overdue = row.status !== 'done' && !!row.deadline && row.deadline < ctx.today;
    }
    if (kind === 'project') record.client = await nameOf('client', row.client_id, ctx);
    if (kind === 'invoice') record.balance = (Number(row.grand_total) || 0) - (Number(row.amount_paid) || 0);
    return { data: { type: kind, record }, entities: [f.entity] };
  },
};

/* ── tasks ────────────────────────────────────────────────────────────────── */

const list_tasks = {
  name: 'list_tasks',
  module: 'tasks',
  kind: 'read',
  permission: { resource: 'tasks', action: 'view' },
  description: 'List tasks with filters: status (open = not done), overdue, assignee, project, client (via its projects), text, due window, mine. Returns the total count of all matches plus the first `limit`.',
  params: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['open', 'pending', 'in_progress', 'done', 'overdue', 'all'] },
      assignee: { type: 'string', description: 'Team member name, or "me".' },
      project: { type: 'string' },
      client: { type: 'string', description: 'Tasks on this client\'s projects, or whose title names the client.' },
      text: { type: 'string', description: 'Words in the title or description.' },
      due_before: { type: 'string' },
      due_after: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  status: 'Checking tasks…',
  async run(args, ctx) {
    let rows = await loadKind('task', ctx);
    const today = ctx.today;
    const overdue = (r) => r.status !== 'done' && !!r.deadline && r.deadline < today;
    const status = args.status || 'open';
    if (status === 'open') rows = rows.filter((r) => r.status !== 'done');
    else if (status === 'overdue') rows = rows.filter(overdue);
    else if (status !== 'all') rows = rows.filter((r) => r.status === status);

    if (args.assignee) {
      if (/^(?:me|mine|myself|i)$/i.test(args.assignee)) {
        rows = rows.filter((r) => ctx.employeeId && r.assignee_id === ctx.employeeId);
      } else {
        const f = await filterEntity('employee', args.assignee, ctx);
        if (f.reply) return { data: f.reply };
        rows = rows.filter((r) => r.assignee_id === f.id);
      }
    }
    if (args.project) {
      const f = await filterEntity('project', args.project, ctx);
      if (f.reply) return { data: f.reply };
      rows = rows.filter((r) => r.project_id === f.id);
    }
    if (args.client) {
      const f = await filterEntity('client', args.client, ctx);
      if (f.reply) return { data: f.reply };
      const projects = (await loadKind('project', ctx)).filter((p) => p.client_id === f.id).map((p) => p.id);
      const name = (await byId('client', f.id, ctx))?.name?.toLowerCase() || '';
      rows = rows.filter((r) => projects.includes(r.project_id) || (name && `${r.title} ${r.description || ''}`.toLowerCase().includes(name.split(' ')[0])));
    }
    if (args.text) {
      const t = String(args.text).toLowerCase();
      rows = rows.filter((r) => `${r.title} ${r.description || ''}`.toLowerCase().includes(t));
    }
    const before = args.due_before ? readDate(args.due_before, today).value : null;
    const after = args.due_after ? readDate(args.due_after, today).value : null;
    if (before) rows = rows.filter((r) => r.deadline && r.deadline <= before);
    if (after) rows = rows.filter((r) => r.deadline && r.deadline >= after);

    rows = [...rows].sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
    const limit = clamp(args.limit, 1, 50, 20);
    const shown = rows.slice(0, limit);
    const out = [];
    for (const r of shown) {
      out.push({
        id: r.id, title: r.title, status: STATUS_LABEL[r.status] || r.status,
        deadline: r.deadline ? formatDate(r.deadline) : null, overdue: overdue(r),
        assignee: r.assignee_label || await nameOf('employee', r.assignee_id, ctx),
        project: await nameOf('project', r.project_id, ctx),
      });
    }
    return {
      data: {
        today: formatDate(today),
        total_matching: rows.length,
        overdue_among_them: rows.filter(overdue).length,
        showing: shown.length,
        tasks: out,
      },
      entities: shown.slice(0, 10).map((r) => entityOf('task', r)),
      view: {
        type: 'list',
        title: status === 'overdue' ? 'Overdue tasks' : status === 'done' ? 'Done tasks' : 'Tasks',
        total: rows.length,
        href: '/work',
        warning: status !== 'overdue' && rows.filter(overdue).length ? `${rows.filter(overdue).length} overdue` : null,
        items: out.map((t) => ({
          title: t.title,
          sub: [t.assignee, t.project].filter(Boolean).join(' · '),
          value: t.deadline,
          badge: t.overdue ? 'Overdue' : t.status,
          tone: t.overdue ? 'r' : t.status === 'done' ? 'g' : 'n',
          href: `/tasks?task=${t.id}`,
        })),
      },
    };
  },
};

/* ── invoices ─────────────────────────────────────────────────────────────── */

const OPEN_STATUSES = ['sent', 'viewed', 'partially_paid', 'overdue', 'pending', 'payment_submitted', 'advance_paid'];

const list_invoices = {
  name: 'list_invoices',
  module: 'finance',
  kind: 'read',
  permission: { resource: 'financial_documents', action: 'view' },
  description: 'List invoices, quotations or proformas with filters (status, client, overdue, unpaid, issued between). Returns counts and totals over ALL matches plus the first `limit`.',
  params: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['invoice', 'quotation', 'proforma'] },
      status: { type: 'string', description: 'A document status (draft, sent, paid, partially_paid, overdue, accepted…).' },
      client: { type: 'string' },
      overdue: { type: 'boolean', description: 'Unpaid invoices past their due date.' },
      unpaid: { type: 'boolean', description: 'Issued invoices with a balance left.' },
      from: { type: 'string', description: 'Issued on or after (as said or YYYY-MM-DD).' },
      to: { type: 'string', description: 'Issued on or before.' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  status: 'Checking invoices…',
  async run(args, ctx) {
    const type = args.type || 'invoice';
    let q = ctx.db.from('financial_documents')
      .select('id, doc_number, type, status, bill_to_name, customer_id, grand_total, amount_paid, currency, issue_date, due_date, updated_at')
      .eq('type', type).order('issue_date', { ascending: false }).limit(2000);
    if (args.status) q = q.eq('status', args.status);
    if (args.client) {
      const f = await filterEntity('client', args.client, ctx);
      if (f.reply) return { data: f.reply };
      q = q.eq('customer_id', f.id);
    }
    const from = args.from ? readDate(args.from, ctx.today, { prefer: 'past' }).value : null;
    const to = args.to ? readDate(args.to, ctx.today, { prefer: 'past' }).value : null;
    if (from) q = q.gte('issue_date', from);
    if (to) q = q.lte('issue_date', to);
    const { data, error } = await q;
    if (error) return { data: { error: 'Could not read documents.' } };
    const balance = (d) => (Number(d.grand_total) || 0) - (Number(d.amount_paid) || 0);
    let rows = data || [];
    const isOverdue = (d) => OPEN_STATUSES.includes(d.status) && d.due_date && d.due_date < ctx.today && balance(d) > 0.005;
    if (args.overdue) rows = rows.filter(isOverdue);
    if (args.unpaid) rows = rows.filter((d) => OPEN_STATUSES.includes(d.status) && balance(d) > 0.005);
    const limit = clamp(args.limit, 1, 50, 20);
    const shown = rows.slice(0, limit);
    return {
      data: {
        type, total_matching: rows.length,
        total_value: money(rows.reduce((s, d) => s + (Number(d.grand_total) || 0), 0)),
        total_balance_due: money(rows.reduce((s, d) => s + Math.max(0, balance(d)), 0)),
        overdue_among_them: rows.filter(isOverdue).length,
        showing: shown.length,
        documents: shown.map((d) => ({
          id: d.id, number: d.doc_number || '(draft)', client: d.bill_to_name, status: d.status,
          total: money(d.grand_total, d.currency || 'INR'), balance: money(balance(d), d.currency || 'INR'),
          issued: d.issue_date ? formatDate(d.issue_date) : null, due: d.due_date ? formatDate(d.due_date) : null,
          overdue: isOverdue(d),
        })),
      },
      entities: shown.slice(0, 10).map((d) => entityOf('invoice', d)),
      view: {
        type: 'list',
        title: args.overdue ? `Overdue ${type}s` : args.unpaid ? `Unpaid ${type}s` : `${type[0].toUpperCase()}${type.slice(1)}s`,
        total: rows.length,
        href: type === 'invoice' ? '/money/invoices' : type === 'quotation' ? '/quotations' : '/proforma',
        warning: rows.some((d) => balance(d) > 0.005 && OPEN_STATUSES.includes(d.status))
          ? `${money(rows.reduce((sum, d) => sum + (OPEN_STATUSES.includes(d.status) ? Math.max(0, balance(d)) : 0), 0))} still to collect` : null,
        items: shown.map((d) => ({
          title: d.bill_to_name || 'No client',
          sub: [d.doc_number || 'Draft', d.due_date && (isOverdue(d) ? `${Math.round((Date.parse(ctx.today) - Date.parse(d.due_date)) / 86400000)} days late` : `due ${formatDate(d.due_date)}`)].filter(Boolean).join(' · '),
          value: money(OPEN_STATUSES.includes(d.status) ? balance(d) : d.grand_total, d.currency || 'INR'),
          badge: isOverdue(d) ? 'Overdue' : String(d.status || '').replace(/_/g, ' '),
          tone: isOverdue(d) ? 'r' : d.status === 'paid' ? 'g' : 'n',
          href: type === 'invoice' ? `/money/invoices?doc=${d.id}` : null,
        })),
      },
    };
  },
};

/* ── people ops ───────────────────────────────────────────────────────────── */

const list_leave = {
  name: 'list_leave',
  module: 'people',
  kind: 'read',
  permission: { resource: 'leave_requests', action: 'view' },
  description: 'Leave requests: who is off when, pending approvals. Filters: employee, status, overlapping a date range.',
  params: {
    type: 'object',
    properties: {
      employee: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'cancelled'] },
      from: { type: 'string' }, to: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  status: 'Checking leave…',
  async run(args, ctx) {
    let q = ctx.db.from('leave_requests')
      .select('id, employee_id, leave_type_id, start_date, end_date, days, half_day, status, reason, updated_at')
      .order('start_date', { ascending: false }).limit(1000);
    if (args.status) q = q.eq('status', args.status);
    if (args.employee) {
      const f = await filterEntity('employee', args.employee, ctx);
      if (f.reply) return { data: f.reply };
      q = q.eq('employee_id', f.id);
    }
    const from = args.from ? readDate(args.from, ctx.today).value : null;
    const to = args.to ? readDate(args.to, ctx.today).value : null;
    if (from) q = q.gte('end_date', from);
    if (to) q = q.lte('start_date', to);
    const [{ data, error }, types] = await Promise.all([
      q, ctx.db.from('leave_types').select('id, name'),
    ]);
    if (error) return { data: { error: 'Could not read leave requests.' } };
    const typeName = Object.fromEntries((types.data || []).map((t) => [t.id, t.name]));
    const rows = data || [];
    const limit = clamp(args.limit, 1, 50, 20);
    const out = [];
    for (const r of rows.slice(0, limit)) {
      out.push({
        id: r.id, employee: await nameOf('employee', r.employee_id, ctx), type: typeName[r.leave_type_id] || null,
        from: formatDate(r.start_date), to: formatDate(r.end_date), days: Number(r.days), status: r.status, reason: r.reason,
      });
    }
    return { data: { total_matching: rows.length, pending_among_them: rows.filter((r) => r.status === 'pending').length, showing: out.length, requests: out } };
  },
};

const get_attendance = {
  name: 'get_attendance',
  module: 'people',
  kind: 'read',
  permission: { resource: ['attendance_days', 'attendance'], action: 'view' },
  description: 'Attendance for a day or range, optionally for one person: who was present, remote, on leave or absent.',
  params: {
    type: 'object',
    properties: { employee: { type: 'string' }, date: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
  },
  status: 'Checking attendance…',
  async run(args, ctx) {
    const day = args.date ? readDate(args.date, ctx.today, { prefer: 'past' }).value : null;
    const from = day || (args.from ? readDate(args.from, ctx.today, { prefer: 'past' }).value : ctx.today);
    const to = day || (args.to ? readDate(args.to, ctx.today, { prefer: 'past' }).value : from);
    let q = ctx.db.from('attendance_days').select('employee_id, work_date, status, note')
      .gte('work_date', from).lte('work_date', to).limit(3000);
    if (args.employee) {
      const f = await filterEntity('employee', args.employee, ctx);
      if (f.reply) return { data: f.reply };
      q = q.eq('employee_id', f.id);
    }
    const { data, error } = await q;
    if (error) return { data: { error: 'Could not read attendance.' } };
    const counts = {};
    for (const r of data || []) counts[r.status] = (counts[r.status] || 0) + 1;
    const rows = [];
    for (const r of (data || []).slice(0, 60)) {
      rows.push({ employee: await nameOf('employee', r.employee_id, ctx), date: formatDate(r.work_date), status: r.status, note: r.note });
    }
    return { data: { from: formatDate(from), to: formatDate(to), marked_days: (data || []).length, by_status: counts, showing: rows.length, days: rows } };
  },
};

/* ── the company's figures ────────────────────────────────────────────────── */

/**
 * Cash, receivables and payables computed from the rows, for an org whose
 * EdgeBrain has not been built. The rules follow financeAnalytics.cashPosition
 * (confirmed document payments, cash-book income not already counted as a
 * document payment, paid expenses, vendor bill payments), and a figure is
 * given only when the person can read every table behind it — a partial sum
 * would be a wrong number, not a smaller one.
 */
async function liveFigures(ctx) {
  const need = ['financial_documents', 'income_entries', 'expenses', 'purchase_invoices'];
  if (!need.every((r) => ctx.can(r, 'view'))) return null;
  const [docs, pays, income, expenses, bills] = await Promise.all([
    ctx.db.from('financial_documents').select('id, type, status, grand_total, amount_paid, due_date').limit(5000),
    ctx.db.from('payments').select('document_id, amount, confirmed_at, paid_on').limit(10000),
    ctx.db.from('income_entries').select('amount, document_id, received_on').limit(10000),
    ctx.db.from('expenses').select('amount, status, incurred_on').limit(10000),
    ctx.db.from('purchase_invoices').select('total, amount_paid, status, due_date').limit(5000),
  ]);
  if ([docs, pays, income, expenses, bills].some((r) => r.error)) return null;
  const n = (v) => Number(v) || 0;
  const paidDocs = new Set();
  let received = 0;
  for (const p of pays.data || []) {
    if (!p.confirmed_at) continue;
    paidDocs.add(p.document_id);
    received += n(p.amount);
  }
  for (const e of income.data || []) if (!(e.document_id && paidDocs.has(e.document_id))) received += n(e.amount);
  let paidOut = 0;
  for (const e of expenses.data || []) if ((e.status || 'paid') !== 'pending') paidOut += n(e.amount);
  for (const b of bills.data || []) if (b.status !== 'void') paidOut += n(b.amount_paid);
  const open = (docs.data || []).filter((d) => d.type === 'invoice' && OPEN_STATUSES.includes(d.status));
  const bal = (d) => Math.max(0, n(d.grand_total) - n(d.amount_paid));
  const owed = open.reduce((s, d) => s + bal(d), 0);
  const overdue = open.filter((d) => d.due_date && d.due_date < ctx.today).reduce((s, d) => s + bal(d), 0);
  const payable = (bills.data || []).filter((b) => ['unpaid', 'partially_paid'].includes(b.status)).reduce((s, b) => s + Math.max(0, n(b.total) - n(b.amount_paid)), 0);
  const net = received - paidOut;
  return {
    data: {
      net_cash: money(net), money_received_all_time: money(received), money_paid_out_all_time: money(paidOut),
      owed_to_us: money(owed), overdue_receivables: money(overdue), open_invoices: open.length, we_owe_vendors: money(payable),
    },
    view: {
      type: 'metrics', title: 'Money · live', href: '/business',
      items: [
        { label: 'Net cash', value: money(net), sub: 'Received less paid out', tone: net >= 0 ? 'g' : 'r' },
        { label: 'Owed to you', value: money(owed), sub: `${open.length} open invoice${open.length === 1 ? '' : 's'}`, tone: 'n' },
        { label: 'Overdue', value: money(overdue), tone: overdue > 0 ? 'r' : 'g' },
        { label: 'You owe', value: money(payable), sub: 'Vendor bills', tone: payable > 0 ? 'a' : 'g' },
      ],
    },
  };
}

const finance_summary = {
  name: 'finance_summary',
  module: 'finance',
  kind: 'read',
  permission: { resource: 'edgebrain', action: 'view' },
  description: 'The headline money figures — net cash, received, paid out, revenue, receivables, overdue, payables, expenses — exactly as the dashboard tiles compute them.',
  params: { type: 'object', properties: {} },
  status: 'Reading the figures…',
  async run(_args, ctx) {
    const metrics = await getMetrics(ctx.orgId, ctx.allowed).catch(() => []);
    const block = headlineSection(metrics);
    if (!block) {
      // No EdgeBrain yet: the same figures straight from the records.
      const live = await liveFigures(ctx).catch(() => null);
      if (!live) return { data: { unavailable: 'No headline figures have been computed yet (EdgeBrain has not been built or synced), or your role cannot see them.' } };
      return { data: { source: 'computed live from the records just now', figures: live.data }, view: live.view };
    }
    const asOf = metrics.find((m) => m.as_of)?.as_of;
    const byKey = new Map(metrics.filter((m) => !m.bucket).map((m) => [m.key, m]));
    const tile = (key, label, tone) => (byKey.has(key) ? { label, value: money(byKey.get(key).value), tone: tone(Number(byKey.get(key).value) || 0) } : null);
    const items = [
      tile('cash.net', 'Net cash', (v) => (v >= 0 ? 'g' : 'r')),
      tile('revenue.outstanding', 'Owed to you', () => 'n'),
      tile('revenue.overdue', 'Overdue', (v) => (v > 0 ? 'r' : 'g')),
      tile('revenue.total', 'Revenue', () => 'n'),
      tile('cash.paid_out', 'Paid out', () => 'n'),
    ].filter(Boolean);
    return {
      data: { as_of: asOf ? formatDate(asOf) : null, figures: block, rules: CONTEXT_RULES },
      view: items.length ? { type: 'metrics', title: `Money${asOf ? ` · as of ${formatDate(asOf)}` : ''}`, items, href: '/business' } : null,
    };
  },
};

const ask_brain = {
  name: 'ask_brain',
  module: 'core',
  kind: 'read',
  permission: { resource: 'edgebrain', action: 'view' },
  description: 'Retrieve EdgeBrain\'s facts about the company for a question that is not one of the list tools: aggregates, relationships, documents in the library. Answer from what it returns, with its counts.',
  params: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  status: 'Asking EdgeBrain…',
  async run(args, ctx) {
    try {
      const pkg = await buildContext(ctx.orgId, ctx.allowed, String(args.question || ''), { maxEntities: 14 });
      return { data: { context: pkg.context, counts: pkg.counts } };
    } catch {
      return { data: { unavailable: 'EdgeBrain could not be read just now.' } };
    }
  },
};

export default [search, get_record, list_tasks, list_invoices, list_leave, get_attendance, finance_summary, ask_brain];
