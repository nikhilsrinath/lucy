import { loadKind, entityOf } from './resolvers.js';
import { money, formatDate, formatDateShort } from './helpers.js';
import { shiftDays as addDays } from '../../../src/shared/dates.js';

/**
 * "Buddy noticed" — situations worth the founder's attention, found in the
 * company's own data. No model call: every insight is a rule over rows the
 * person can already see (their own Supabase client, so RLS and the
 * permission matrix decide what is in scope — a role that cannot read
 * invoices never hears about an overdue one).
 *
 * The bar is "would a good cofounder interrupt you with this?":
 *   · grounded — the reason names the records and figures behind it;
 *   · actionable — each carries one or two next steps (ask Buddy to draft,
 *     follow up or plan; or open the record);
 *   · rationed — thresholds keep noise out, one insight per situation, and
 *     the list is capped (default 5), most pressing first.
 *
 * Shared by the insights endpoint (the cards in Buddy and Home), the
 * get_insights read tool (so "what should I focus on?" uses the same rules),
 * and any future channel (a Telegram digest) — one engine, one set of rules.
 *
 * insight = {
 *   id        stable per situation ('overdue_client:<id>'), for dismissing
 *   kind      overdue_invoices | due_soon | overdue_tasks | slipping_task |
 *             inactive_leads | stale_quotes | project_risk | spend_spike | bills_due
 *   severity  high | medium | low
 *   tone      r | a | b | n
 *   title     one line
 *   reason    why, with the records and figures
 *   entities  records it is about
 *   actions   [{ label, kind: 'ask' | 'open', prompt?, href? }]
 * }
 */

const RANK = { high: 0, medium: 1, low: 2 };
const OPEN_INVOICE = ['sent', 'viewed', 'partially_paid', 'overdue', 'pending', 'payment_submitted', 'advance_paid'];
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lakhish = (v) => money(Math.round(Number(v) || 0)).replace(/\.00$/, '');

const HEALTH_WORDS = {
  burn_ahead_of_time: 'spending ahead of schedule',
  milestone_overdue: 'a milestone is overdue',
  milestone_overdue_long: 'a milestone is over two weeks late',
  invoice_overdue: 'an invoice on it is overdue',
  projected_late: 'on course to finish late',
  burn_over_budget: 'over budget',
  past_target: 'past its target end date',
  losing_money: 'losing money',
};

async function safe(fn) {
  try { return await fn(); } catch (err) { console.warn('[insights]', err?.message || err); return []; }
}

/* ── detectors ────────────────────────────────────────────────────────────── */

async function overdueInvoices(ctx) {
  if (!ctx.can('financial_documents', 'view')) return [];
  const { data, error } = await ctx.db.from('financial_documents')
    .select('id, doc_number, status, bill_to_name, bill_to_email, customer_id, grand_total, amount_paid, due_date, reminder_count:payload->reminder_count, last_reminder_at:payload->>last_reminder_at, updated_at')
    .eq('type', 'invoice').in('status', OPEN_INVOICE).lt('due_date', ctx.today).limit(1000);
  if (error) return [];
  const late = (data || []).map((d) => ({ ...d, balance: (Number(d.grand_total) || 0) - (Number(d.amount_paid) || 0), late: days(d.due_date, ctx.today) }))
    .filter((d) => d.balance > 0.5);
  if (!late.length) return [];

  const byClient = new Map();
  for (const d of late) {
    const key = d.customer_id || d.bill_to_name || d.id;
    if (!byClient.has(key)) byClient.set(key, []);
    byClient.get(key).push(d);
  }
  const groups = [...byClient.values()]
    .map((docs) => ({ docs: docs.sort((a, b) => b.late - a.late), total: docs.reduce((s, d) => s + d.balance, 0) }))
    .sort((a, b) => b.total - a.total);

  const out = [];
  for (const g of groups.slice(0, 2)) {
    const first = g.docs[0];
    const who = first.bill_to_name || 'A client';
    const reminded = first.last_reminder_at ? `last reminded ${formatDateShort(first.last_reminder_at.slice(0, 10), ctx.today)}` : 'no reminder sent yet';
    const oldest = g.docs[0].late;
    out.push({
      id: `overdue_client:${first.customer_id || first.id}`,
      kind: 'overdue_invoices',
      severity: oldest > 30 || g.total >= 100000 ? 'high' : 'medium',
      tone: 'r',
      title: `${who} owes ${lakhish(g.total)}${g.docs.length > 1 ? ` across ${g.docs.length} overdue invoices` : ''}`,
      reason: `${g.docs.slice(0, 3).map((d) => `${d.doc_number || 'An invoice'} is ${plural(d.late, 'day')} late (${lakhish(d.balance)})`).join('; ')}. ${reminded[0].toUpperCase()}${reminded.slice(1)}.`,
      entities: g.docs.slice(0, 3).map((d) => entityOf('invoice', { ...d, type: 'invoice' })),
      actions: [
        { label: 'Draft reminder', kind: 'ask', prompt: `Send a payment reminder to ${who} for ${first.doc_number || 'their overdue invoice'}.` },
        { label: 'View', kind: 'open', href: `/money/invoices?doc=${first.id}` },
      ],
      weight: g.total,
    });
  }
  if (groups.length > 2) {
    const total = late.reduce((s, d) => s + d.balance, 0);
    out.push({
      id: 'overdue_all',
      kind: 'overdue_invoices',
      severity: 'medium',
      tone: 'a',
      title: `${lakhish(total)} overdue across ${plural(late.length, 'invoice')}`,
      reason: `${groups.length} clients are past due. The oldest is ${plural(Math.max(...late.map((d) => d.late)), 'day')} late.`,
      entities: [],
      actions: [{ label: 'Create plan', kind: 'ask', prompt: 'Help me collect all overdue payments.' }],
      weight: total,
    });
  }
  return out;
}

async function taskSignals(ctx) {
  if (!ctx.can('tasks', 'view')) return [];
  const tasks = (await loadKind('task', ctx)).filter((t) => t.status !== 'done');
  const out = [];
  const tomorrow = addDays(ctx.today, 1);

  const soon = tasks.filter((t) => t.deadline && t.deadline >= ctx.today && t.deadline <= tomorrow);
  if (soon.length) {
    out.push({
      id: `due_soon:${ctx.today}`,
      kind: 'due_soon',
      severity: soon.some((t) => t.priority === 'high') ? 'medium' : 'low',
      tone: 'a',
      title: `${plural(soon.length, 'task')} due by tomorrow`,
      reason: soon.slice(0, 3).map((t) => `“${t.title}”${t.assignee_label ? ` (${t.assignee_label})` : ''}, due ${formatDateShort(t.deadline, ctx.today)}`).join('; ') + (soon.length > 3 ? `; and ${soon.length - 3} more.` : '.'),
      entities: soon.slice(0, 3).map((t) => entityOf('task', t)),
      actions: [{ label: 'Review', kind: 'ask', prompt: 'What is due today and tomorrow, and is anything at risk?' }],
      weight: soon.length,
    });
  }

  const overdue = tasks.filter((t) => t.deadline && t.deadline < ctx.today);
  if (overdue.length >= 2 || overdue.some((t) => t.priority === 'high')) {
    const people = new Map();
    for (const t of overdue) {
      const k = t.assignee_label || 'Unassigned';
      people.set(k, (people.get(k) || 0) + 1);
    }
    const top = [...people.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${k} ${n}`).join(', ');
    const oldest = overdue.reduce((m, t) => (t.deadline < m.deadline ? t : m), overdue[0]);
    out.push({
      id: `overdue_tasks:${overdue.length}`,
      kind: 'overdue_tasks',
      severity: overdue.length >= 5 ? 'high' : 'medium',
      tone: 'a',
      title: `${plural(overdue.length, 'task')} overdue`,
      reason: `Most with ${top}. Oldest: “${oldest.title}”, due ${formatDate(oldest.deadline)}.`,
      entities: overdue.slice(0, 3).map((t) => entityOf('task', t)),
      actions: [
        { label: 'Reschedule', kind: 'ask', prompt: 'Show the overdue tasks and suggest new deadlines or owners for them.' },
        { label: 'View', kind: 'open', href: '/work' },
      ],
      weight: overdue.length,
    });
  }
  return out;
}

/** Tasks whose deadline has been pushed at least twice in the last 45 days (audit log). */
async function slippingTasks(ctx) {
  if (!ctx.can('tasks', 'view')) return [];
  const since = new Date(Date.now() - 45 * 86400000).toISOString();
  const { data, error } = await ctx.db.from('audit_log').select('entity_id, diff, created_at')
    .eq('org_id', ctx.orgId).eq('action', 'tasks.update').gte('created_at', since)
    .order('created_at', { ascending: false }).limit(2000);
  if (error || !data?.length) return [];
  const pushes = new Map();
  for (const r of data) {
    const d = r.diff?.deadline;
    if (!d || !d.from || !d.to || String(d.to) <= String(d.from)) continue;
    pushes.set(r.entity_id, (pushes.get(r.entity_id) || 0) + 1);
  }
  const tasks = await loadKind('task', ctx);
  const out = [];
  for (const [id, n] of [...pushes.entries()].sort((a, b) => b[1] - a[1])) {
    if (n < 2) break;
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status === 'done') continue;
    out.push({
      id: `slipping:${id}:${n}`,
      kind: 'slipping_task',
      severity: n >= 3 ? 'medium' : 'low',
      tone: 'a',
      title: `“${t.title}” keeps slipping`,
      reason: `Its deadline has been pushed back ${n} times in the last 45 days${t.deadline ? `; now due ${formatDate(t.deadline)}` : ''}${t.assignee_label ? `, with ${t.assignee_label}` : ''}.`,
      entities: [entityOf('task', t)],
      actions: [{ label: 'Fix it', kind: 'ask', prompt: `“${t.title}” keeps slipping. Look at it and suggest how to unblock it — split it, reassign it, or reset the deadline.` }],
      weight: n,
    });
    if (out.length >= 2) break;
  }
  return out;
}

async function inactiveLeads(ctx) {
  if (!ctx.can('clients', 'view')) return [];
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
  const leads = (await loadKind('client', ctx))
    .filter((c) => ['lead', 'contacted'].includes(c.status) && !c.archived_at && c.updated_at && c.updated_at < cutoff)
    .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
  if (!leads.length) return [];
  const value = leads.reduce((s, c) => s + (Number(c.value) || 0), 0);
  return [{
    id: `inactive_leads:${leads.length}`,
    kind: 'inactive_leads',
    severity: value >= 200000 ? 'medium' : 'low',
    tone: 'b',
    title: `${plural(leads.length, 'lead')} gone quiet for 2+ weeks`,
    reason: `${leads.slice(0, 3).map((c) => `${c.name}${Number(c.value) ? ` (${lakhish(c.value)})` : ''}, untouched since ${formatDateShort(c.updated_at.slice(0, 10), ctx.today)}`).join('; ')}${leads.length > 3 ? `; and ${leads.length - 3} more` : ''}.${value ? ` ${lakhish(value)} of pipeline at stake.` : ''}`,
    entities: leads.slice(0, 3).map((c) => entityOf('client', c)),
    actions: [{ label: 'Follow up', kind: 'ask', prompt: 'Plan follow-ups for the leads we have not touched in two weeks: a task for each, with an owner and a date.' }],
    weight: value,
  }];
}

async function staleQuotes(ctx) {
  if (!ctx.can('financial_documents', 'view')) return [];
  const { data, error } = await ctx.db.from('financial_documents')
    .select('id, doc_number, status, bill_to_name, customer_id, grand_total, issue_date, updated_at')
    .eq('type', 'quotation').in('status', ['sent', 'viewed']).lt('issue_date', addDays(ctx.today, -7)).limit(200);
  if (error || !data?.length) return [];
  const total = data.reduce((s, d) => s + (Number(d.grand_total) || 0), 0);
  const top = [...data].sort((a, b) => (Number(b.grand_total) || 0) - (Number(a.grand_total) || 0));
  return [{
    id: `stale_quotes:${data.length}`,
    kind: 'stale_quotes',
    severity: 'low',
    tone: 'b',
    title: `${plural(data.length, 'quote')} waiting over a week for an answer`,
    reason: `${top.slice(0, 3).map((d) => `${d.doc_number || 'A quote'} to ${d.bill_to_name || 'a client'} (${lakhish(d.grand_total)}), sent ${formatDateShort(d.issue_date, ctx.today)}`).join('; ')}. ${lakhish(total)} in total.`,
    entities: top.slice(0, 3).map((d) => entityOf('invoice', { ...d, type: 'quotation' })),
    actions: [{ label: 'Follow up', kind: 'ask', prompt: 'Create follow-up tasks for the quotes that have been waiting more than a week.' }],
    weight: total,
  }];
}

async function projectRisk(ctx) {
  if (!ctx.can('projects', 'view')) return [];
  const { data, error } = await ctx.db.rpc('project_portfolio', { p_org: ctx.orgId });
  if (error || !data?.length) return [];
  const risky = data.filter((p) => !p.archived && ['off_track', 'at_risk'].includes(p.health))
    .sort((a, b) => (a.health === 'off_track' ? 0 : 1) - (b.health === 'off_track' ? 0 : 1));
  return risky.slice(0, 2).map((p) => {
    const why = (p.health_reasons || []).map((r) => HEALTH_WORDS[r] || r.replace(/_/g, ' '));
    return {
      id: `project_risk:${p.project_id}:${p.health}`,
      kind: 'project_risk',
      severity: p.health === 'off_track' ? 'high' : 'medium',
      tone: p.health === 'off_track' ? 'r' : 'a',
      title: `${p.name} is ${p.health === 'off_track' ? 'off track' : 'at risk'}`,
      reason: `${why.length ? `${why[0][0].toUpperCase()}${why.join(', ').slice(1)}.` : 'Its health check flagged it.'}${p.open_tasks ? ` ${plural(p.open_tasks, 'open task')}.` : ''}`,
      entities: [{ type: 'project', id: p.project_id, label: `${p.code} · ${p.name}`, href: `/projects/${p.project_id}` }],
      actions: [
        { label: 'Create plan', kind: 'ask', prompt: `${p.name} (${p.code}) is ${p.health === 'off_track' ? 'off track' : 'at risk'}: ${why.join(', ') || 'flagged by its health check'}. Look at it and propose a plan to get it back on track.` },
        { label: 'View', kind: 'open', href: `/projects/${p.project_id}` },
      ],
      weight: p.health === 'off_track' ? 2 : 1,
    };
  });
}

/** This month's spending so far against the average of the three months before. */
async function spendSpike(ctx) {
  if (!ctx.can('expenses', 'view')) return [];
  const monthStart = `${ctx.today.slice(0, 7)}-01`;
  const d = new Date(`${monthStart}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 3);
  const from = d.toISOString().slice(0, 10);
  const { data, error } = await ctx.db.from('expenses').select('amount, incurred_on, category')
    .gte('incurred_on', from).lte('incurred_on', ctx.today).limit(5000);
  if (error || !data?.length) return [];
  const thisMonth = data.filter((e) => e.incurred_on >= monthStart);
  const before = data.filter((e) => e.incurred_on < monthStart);
  const now = thisMonth.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const avg = before.reduce((s, e) => s + (Number(e.amount) || 0), 0) / 3;
  if (avg < 1000 || now < avg * 1.4 || now - avg < 10000) return [];
  const cats = new Map();
  for (const e of thisMonth) cats.set(e.category || 'Other', (cats.get(e.category || 'Other') || 0) + (Number(e.amount) || 0));
  const top = [...cats.entries()].sort((a, b) => b[1] - a[1])[0];
  return [{
    id: `spend_spike:${ctx.today.slice(0, 7)}`,
    kind: 'spend_spike',
    severity: now >= avg * 2 ? 'medium' : 'low',
    tone: 'a',
    title: `Spending is up ${Math.round((now / avg - 1) * 100)}% this month`,
    reason: `${lakhish(now)} recorded so far this month against a ${lakhish(avg)} monthly average over the last three months.${top ? ` Biggest category: ${top[0]} (${lakhish(top[1])}).` : ''}`,
    entities: [],
    actions: [{ label: 'Review', kind: 'ask', prompt: 'What is driving our spending this month compared with the last three months?' }],
    weight: now - avg,
  }];
}

async function billsDue(ctx) {
  if (!ctx.can('purchase_invoices', 'view')) return [];
  const { data, error } = await ctx.db.from('purchase_invoices')
    .select('id, vendor_id, bill_number, due_date, total, amount_paid, status')
    .in('status', ['unpaid', 'partially_paid']).not('due_date', 'is', null).lte('due_date', addDays(ctx.today, 7)).limit(500);
  if (error || !data?.length) return [];
  const rows = data.map((b) => ({ ...b, owed: (Number(b.total) || 0) - (Number(b.amount_paid) || 0) })).filter((b) => b.owed > 0.5);
  if (!rows.length) return [];
  const late = rows.filter((b) => b.due_date < ctx.today);
  const total = rows.reduce((s, b) => s + b.owed, 0);
  const vendors = await loadKind('vendor', ctx);
  const name = (id) => vendors.find((v) => v.id === id)?.company_name || 'a vendor';
  return [{
    id: `bills_due:${ctx.today}:${rows.length}`,
    kind: 'bills_due',
    severity: late.length ? 'medium' : 'low',
    tone: late.length ? 'r' : 'b',
    title: late.length ? `${plural(late.length, 'vendor bill')} overdue` : `${plural(rows.length, 'vendor bill')} due this week`,
    reason: `${rows.slice(0, 3).map((b) => `${b.bill_number} to ${name(b.vendor_id)} (${lakhish(b.owed)}), due ${formatDateShort(b.due_date, ctx.today)}`).join('; ')}. ${lakhish(total)} to pay in all.`,
    entities: [],
    actions: [{ label: 'View', kind: 'open', href: '/purchases' }],
    weight: total,
  }];
}

const DETECTORS = [overdueInvoices, taskSignals, slippingTasks, projectRisk, inactiveLeads, staleQuotes, spendSpike, billsDue];

/**
 * The insights for this person, most pressing first. `skip` is a set of ids
 * they dismissed. Never throws; a detector that fails contributes nothing.
 */
export async function computeInsights(ctx, { limit = 5, skip = [] } = {}) {
  const hidden = new Set(skip);
  const all = (await Promise.all(DETECTORS.map((d) => safe(() => d(ctx))))).flat()
    .filter((i) => !hidden.has(i.id));
  all.sort((a, b) => (RANK[a.severity] - RANK[b.severity]) || ((b.weight || 0) - (a.weight || 0)));
  return all.slice(0, Math.max(1, Math.min(10, limit))).map(({ weight: _w, ...i }) => i);
}
