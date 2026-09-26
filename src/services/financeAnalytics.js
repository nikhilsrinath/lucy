// financeAnalytics.js — Tax Summary, P&L, cash flow, payment position and
// overdue logic.
//
// Everything here is derived from what has already been recorded — issued
// invoices, purchase invoices, expense entries and income entries. Nothing is
// entered twice and nothing here writes: pure functions over orgStore's cached
// lists, cheap to recompute on each render.
//
// The one idea worth holding on to: an entry's TREATMENT decides whether it
// touches profit, and every entry touches cash. Buying a laptop, repaying a
// loan, taking a drawing and remitting GST all move money without costing
// anything; a loan received and a vendor refund both arrive without being
// earned. P&L reads treatments; cash flow reads everything. The treatments
// themselves are stamped on each row by the database (0038), so this file and
// EdgeBrain's aggregates cannot drift apart.
import { countsAsIncome, countsAsExpense, isCostRecovery, groupOf } from './financeCategories';
import { issuedInvoices, balanceOf, isOverdue as isOverdueShared } from '../shared/finDocs.js';

const n = (v) => Number(v) || 0;

/**
 * What a cash-book entry is worth once the GST inside it is set aside.
 *
 * Computed here rather than read from the stored `net_amount`, deliberately. The
 * column is derived by a trigger, and a row written while that trigger was not
 * attached keeps the column default of zero — which made the entry show its full
 * value under "Money in" and contribute nothing at all to revenue or profit. A
 * figure that can be silently zero is worse than one recomputed on every render,
 * and the subtraction is the same definition the trigger uses.
 */
const net = (e) => n(e.amount) - n(e.tax_amount);
const dayKey = (d) => (d ? String(d).slice(0, 10) : '');
const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
export const todayIso = () => iso(new Date());

// Which invoices are receivables, and when one is overdue, live in
// src/shared/finDocs.js — the agent's list_invoices counts by the same rule.
export { issuedInvoices, balanceOf } from '../shared/finDocs.js';
export const isOverdue = (d, today = todayIso()) => isOverdueShared(d, today);

export const daysOverdue = (d, today = todayIso()) => (d.due_date
  ? Math.max(0, Math.round((new Date(today) - new Date(dayKey(d.due_date))) / 86400000))
  : 0);

// ── Periods ──────────────────────────────────────────────────────────────────

/** Indian financial-year quarters: Q1 = Apr–Jun, Q4 = Jan–Mar. */
export function periodBounds(kind, anchor = new Date()) {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  if (kind === 'month') return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
  if (kind === 'quarter') {
    const start = m - (((m + 9) % 12) % 3);
    return { from: iso(new Date(y, start, 1)), to: iso(new Date(y, start + 3, 0)) };
  }
  if (kind === 'fy') {
    const fy = m >= 3 ? y : y - 1;
    return { from: iso(new Date(fy, 3, 1)), to: iso(new Date(fy + 1, 2, 31)) };
  }
  return { from: null, to: null };
}

export const inRange = (d, from, to) => {
  const k = dayKey(d);
  return !!k && (!from || k >= from) && (!to || k <= to);
};

function quarterLabel(fromIso) {
  const start = new Date(`${fromIso}T00:00:00`);
  const q = Math.floor(((start.getMonth() + 9) % 12) / 3) + 1;
  const fy = start.getMonth() >= 3 ? start.getFullYear() : start.getFullYear() - 1;
  return `Q${q} FY${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
}

/** The last `count` months or FY quarters, newest first, as selectable options. */
export function periodOptions(kind, count = 12) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    const step = kind === 'quarter' ? 3 : 1;
    const b = periodBounds(kind, new Date(now.getFullYear(), now.getMonth() - i * step, 1));
    const label = kind === 'quarter'
      ? quarterLabel(b.from)
      : new Date(`${b.from}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    out.push({ ...b, label, id: b.from });
  }
  return out;
}

// ── Tax Summary ──────────────────────────────────────────────────────────────

/**
 * Output GST on issued invoices and on income entries, against input GST on
 * purchase invoices and expenses, for [from, to]. Positive netPayable is tax
 * owed; negative is a credit carried forward. A preparation aid only — it knows
 * nothing about reverse charge, blocked credits, credit notes or amendments.
 */
export function taxSummary({ docs, purchases, expenses, income, vendors = [] }, from, to) {
  const vendorName = (id) => vendors.find((v) => v.id === id)?.company_name || '';
  const outRows = issuedInvoices(docs).filter((d) => inRange(d.issue_date, from, to));
  // Cash sales collect output GST exactly as an invoice does. Entries against a
  // document are skipped: the invoice already carries that GST.
  const iRows = (income || []).filter((e) => !e.document_id && n(e.tax_amount) > 0
    && inRange(e.date || e.received_on, from, to));
  const output = outRows.reduce((acc, d) => {
    const gst = d.gst_enabled === false ? 0 : n(d.gst_amount);
    acc.taxable += n(d.taxable_amount);
    acc.gst += gst;
    if (d.is_inter_state) acc.igst += gst;
    else { acc.cgst += gst / 2; acc.sgst += gst / 2; }
    return acc;
  }, { taxable: 0, gst: 0, igst: 0, cgst: 0, sgst: 0, count: outRows.length });
  // A cash-book entry carries its own place of supply since 0041. Before that it
  // was assumed intra-state, which charged CGST+SGST on every export.
  iRows.forEach((e) => {
    const gst = n(e.tax_amount);
    output.taxable += net(e);
    output.gst += gst;
    if (e.is_inter_state) output.igst += gst;
    else { output.cgst += gst / 2; output.sgst += gst / 2; }
    output.count += 1;
  });

  const pRows = (purchases || []).filter((p) => p.status !== 'void' && inRange(p.bill_date, from, to));
  const eRows = (expenses || []).filter((e) => n(e.tax_amount) > 0 && inRange(e.date || e.incurred_on, from, to));
  const input = {
    purchases: pRows.reduce((s, p) => s + n(p.tax_amount), 0),
    expenses: eRows.reduce((s, e) => s + n(e.tax_amount), 0),
    taxable: pRows.reduce((s, p) => s + n(p.subtotal), 0)
      + eRows.reduce((s, e) => s + n(e.amount) - n(e.tax_amount), 0),
    count: pRows.length + eRows.length,
  };
  input.gst = input.purchases + input.expenses;

  const rows = [
    ...outRows.map((d) => ({
      kind: 'Output', date: dayKey(d.issue_date), ref: d.doc_number || d.invoiceNumber || '',
      party: d.clientName || '', taxable: n(d.taxable_amount),
      gst: d.gst_enabled === false ? 0 : n(d.gst_amount),
      rate: d.gst_enabled === false ? 0 : n(d.gst_rate), interState: !!d.is_inter_state,
    })),
    ...iRows.map((e) => ({
      kind: 'Output', date: dayKey(e.date || e.received_on), ref: e.reference || 'Cash book',
      party: e.description || '', taxable: net(e), gst: n(e.tax_amount),
      rate: n(e.tax_rate), interState: !!e.is_inter_state,
    })),
    ...pRows.map((p) => ({
      kind: 'Input', date: dayKey(p.bill_date), ref: p.bill_number,
      party: vendorName(p.vendor_id), taxable: n(p.subtotal), gst: n(p.tax_amount),
      rate: n(p.tax_rate), interState: false,
    })),
    ...eRows.map((e) => ({
      kind: 'Input', date: dayKey(e.date || e.incurred_on), ref: 'Expense',
      party: e.description || '', taxable: net(e), gst: n(e.tax_amount),
      rate: n(e.tax_rate), interState: !!e.is_inter_state,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  // Rate-wise, because that is how a return is filed. A single output total
  // cannot be entered into GSTR-1, which asks for the taxable value and the tax
  // at each slab.
  const byRate = [];
  rows.forEach((r) => {
    const key = `${r.kind}:${r.rate}`;
    let bucket = byRate.find((b) => b.key === key);
    if (!bucket) {
      bucket = { key, kind: r.kind, rate: r.rate, taxable: 0, gst: 0, count: 0 };
      byRate.push(bucket);
    }
    bucket.taxable += r.taxable;
    bucket.gst += r.gst;
    bucket.count += 1;
  });
  byRate.sort((a, b) => a.kind.localeCompare(b.kind) || b.rate - a.rate);

  return { output, input, netPayable: output.gst - input.gst, rows, byRate };
}

// ── Profit & Loss ────────────────────────────────────────────────────────────

/**
 * Income is issued invoices at taxable value plus income entries at net value —
 * GST collected is owed to the government, not earned. Expenses are expense
 * entries plus purchase invoices, each net of input GST for the same reason.
 *
 * What is deliberately LEFT OUT is the part that makes the number trustworthy:
 *
 *   · income entries linked to an invoice, which the invoice already counts;
 *   · funding and loans received, which are cash and not earnings;
 *   · asset purchases, loan repayments, owner drawings and tax remittances,
 *     which are cash leaving and not costs.
 *
 * Refunds and reimbursements received come back as a negative expense rather
 * than as income, which is where they belong: money returned on something you
 * paid for reduces what that thing cost you.
 *
 * `invoiced` and `direct` are reported alongside `income` so a caller can say
 * where the top line came from without recomputing either.
 */
export function profitAndLoss({ docs, purchases, expenses, income: incomeRows }, from, to) {
  const invoiced = issuedInvoices(docs)
    .filter((d) => inRange(d.issue_date, from, to))
    .reduce((s, d) => s + n(d.taxable_amount), 0);

  const inPeriod = (incomeRows || []).filter((e) => inRange(e.date || e.received_on, from, to));
  const direct = inPeriod.filter(countsAsIncome).reduce((s, e) => s + net(e), 0);
  const income = invoiced + direct;

  // Kept keyed on the raw category, not on its label or its group: the
  // Overview's category drill-down matches these names back against the spend
  // rows, and a pretty name here would break that link. `byGroup` is the
  // rolled-up view, offered alongside rather than instead.
  const byCategory = {};
  const byGroup = {};
  const add = (cat, amt) => {
    byCategory[cat || 'Other'] = (byCategory[cat || 'Other'] || 0) + amt;
    const g = groupOf(cat);
    byGroup[g] = (byGroup[g] || 0) + amt;
  };
  (expenses || []).filter((e) => inRange(e.date || e.incurred_on, from, to))
    .filter(countsAsExpense)
    .forEach((e) => add(e.category, n(e.amount) - n(e.tax_amount)));
  // A purchase invoice has no treatment of its own: a bill from a vendor is a
  // cost of running, and every category it can carry is an operating one.
  (purchases || []).filter((p) => p.status !== 'void' && inRange(p.bill_date, from, to))
    .forEach((p) => add(p.category, n(p.subtotal)));

  const recovered = inPeriod.filter(isCostRecovery).reduce((s, e) => s + net(e), 0);
  if (recovered > 0) add('Recoveries', -recovered);

  const expenseTotal = Object.values(byCategory).reduce((s, v) => s + v, 0);
  const rank = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  return {
    income,
    invoiced,
    direct,
    recovered,
    expenses: expenseTotal,
    net: income - expenseTotal,
    margin: income > 0 ? ((income - expenseTotal) / income) * 100 : null,
    byCategory: rank(byCategory),
    byGroup: rank(byGroup),
  };
}

// ── Cash flow ────────────────────────────────────────────────────────────────

/**
 * Every rupee in and out over [from, to], whatever its treatment — the question
 * "did the bank balance go up" as opposed to "did we make money". They differ
 * by the funding, the asset purchases, the loan repayments, the drawings and
 * the tax remittances, which is exactly why both are worth showing.
 *
 * Gross, not net of GST: cash flow is about what moved, and the GST moved too.
 * Spend still marked pending has not left yet, so it is reported separately
 * rather than counted.
 */
export { net as netOfTax };

export function cashFlow({ expenses, income: incomeRows }, from, to) {
  const ins = (incomeRows || []).filter((e) => inRange(e.date || e.received_on, from, to));
  const outsAll = (expenses || []).filter((e) => inRange(e.date || e.incurred_on, from, to));
  const outs = outsAll.filter((e) => e.status !== 'pending');

  const tally = (rows, key, amount) => {
    const map = {};
    rows.forEach((r) => { const k = key(r) || 'Other'; map[k] = (map[k] || 0) + amount(r); });
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  };

  const cashIn = ins.reduce((s, e) => s + n(e.amount), 0);
  const cashOut = outs.reduce((s, e) => s + n(e.amount), 0);
  return {
    cashIn,
    cashOut,
    net: cashIn - cashOut,
    inCount: ins.length,
    outCount: outs.length,
    pending: outsAll.filter((e) => e.status === 'pending').reduce((s, e) => s + n(e.amount), 0),
    pendingCount: outsAll.filter((e) => e.status === 'pending').length,
    inByCategory: tally(ins, (e) => e.category, (e) => n(e.amount)),
    outByGroup: tally(outs, (e) => groupOf(e.category), (e) => n(e.amount)),
    byMethod: tally([...ins, ...outs], (e) => e.payment_method, (e) => n(e.amount)),
  };
}

/** Six calendar months ending with the current one, for the bar chart. */
export function sixMonthSeries(data) {
  const now = new Date();
  const out = [];
  for (let i = 5; i >= 0; i -= 1) {
    const b = periodBounds('month', new Date(now.getFullYear(), now.getMonth() - i, 1));
    const pl = profitAndLoss(data, b.from, b.to);
    out.push({
      month: new Date(`${b.from}T00:00:00`).toLocaleDateString('en-IN', { month: 'short' }),
      income: Math.round(pl.income),
      expenses: Math.round(pl.expenses),
      net: Math.round(pl.net),
    });
  }
  return out;
}

// ── Payment position ─────────────────────────────────────────────────────────

/** Invoiced, collected, outstanding and overdue — all-time, over live receivables. */
export function paymentPosition(docs, today = todayIso()) {
  const inv = issuedInvoices(docs);
  const overdue = inv.filter((d) => isOverdue(d, today));
  return {
    invoiced: inv.reduce((s, d) => s + n(d.grand_total), 0),
    invoicedCount: inv.length,
    collected: inv.reduce((s, d) => s + n(d.amount_paid), 0),
    collectedCount: inv.filter((d) => n(d.amount_paid) > 0).length,
    outstanding: inv.reduce((s, d) => s + balanceOf(d), 0),
    outstandingCount: inv.filter((d) => balanceOf(d) > 0.009).length,
    overdue: overdue.reduce((s, d) => s + balanceOf(d), 0),
    overdueCount: overdue.length,
  };
}

// ── CSV export ───────────────────────────────────────────────────────────────

export function downloadCsv(filename, header, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  // BOM so Excel opens the file as UTF-8 and the rupee sign survives.
  const blob = new Blob([`\uFEFF${body}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Net cash, all time — the dashboard's Net cash tile, on the same rules as
 * EdgeBrain's cash.* aggregates (0066), so the tile and the assistant cannot
 * disagree. Every rupee once:
 *
 *   received = confirmed payments on documents (invoice receipts and proforma
 *              advances), except the advance COPIED onto a tax invoice at
 *              conversion, which is the proforma's money
 *            + cash-book receipts not tied to a document, and those tied to a
 *              document that has no confirmed payment — any reason: sales,
 *              funding, refunds. It is cash.
 *   paidOut  = expenses actually paid (not 'pending') + payments on vendor bills
 *
 * Returns dated events too, so the tile's sparkline sums the same rows.
 */
export function cashPosition({ finDocs = [], income = [], expenses = [], purchases = [] } = {}) {
  const inEvents = [];
  const outEvents = [];
  const paidDocs = new Set();

  for (const d of finDocs) {
    for (const p of d.payments || []) {
      if (!p.confirmed_at) continue;
      paidDocs.add(d.id);
      const carried = d.type === 'invoice' && p.method === 'Advance' && !!d.converted_from
        && String(p.note || '').startsWith('Advance received against proforma ');
      if (carried) continue;
      inEvents.push({ at: p.paid_on, amount: n(p.amount), source: d.type === 'proforma' ? 'proforma_advances' : 'invoice_payments' });
    }
  }
  for (const e of income) {
    if (e.document_id && paidDocs.has(e.document_id)) continue;
    const source = e.treatment === 'capital_in' ? 'cash_book_funding'
      : (e.treatment === 'revenue' || e.treatment === 'other_income') ? 'cash_book_revenue' : 'cash_book_other';
    inEvents.push({ at: e.received_on || e.date, amount: n(e.amount), source });
  }
  for (const e of expenses) {
    if ((e.status || 'paid') === 'pending') continue;
    outEvents.push({ at: e.paid_on || e.date || e.incurred_on, amount: n(e.amount), source: 'expenses' });
  }
  for (const b of purchases) {
    if (b.status === 'void' || n(b.amount_paid) <= 0) continue;
    outEvents.push({ at: b.paid_on || b.bill_date, amount: n(b.amount_paid), source: 'vendor_bills' });
  }

  const sum = (evs) => Math.round(evs.reduce((s, x) => s + x.amount, 0) * 100) / 100;
  const bySource = {};
  for (const x of [...inEvents, ...outEvents]) bySource[x.source] = (bySource[x.source] || 0) + x.amount;
  const received = sum(inEvents);
  const paidOut = sum(outEvents);
  return { received, paidOut, net: Math.round((received - paidOut) * 100) / 100, inEvents, outEvents, bySource };
}
