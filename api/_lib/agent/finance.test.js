import { describe, it, expect } from 'vitest';
import { fakeDb, fakeCtx } from './testing/fakeDb.js';
import { getTool } from './registry.js';
import { applyPlan, undoPlan } from './executor.js';
import { documentTotals } from '../../../src/shared/finDocs.js';

const TODAY = '2026-09-26';
const ALL = { view: true, create: true, edit: true, delete: true };
const PERMS = {
  clients: ALL, financial_documents: ALL, document_line_items: ALL, payments: ALL, vendors: ALL,
  purchase_invoices: ALL, usage_counters: ALL, catalog_items: ALL, projects: ALL, project_allocations: ALL,
};
const ACME = 'a0000000-0000-4000-8000-000000000001';
const KITE = 'a0000000-0000-4000-8000-000000000002';
const INV1 = 'd0000000-0000-4000-8000-000000000001';
const QT1 = 'd0000000-0000-4000-8000-000000000002';
const DRAFT = 'd0000000-0000-4000-8000-000000000003';
const DELL = 'e0000000-0000-4000-8000-000000000001';

const doc = (id, fields) => ({
  id, org_id: 'org-1', revision: 'v1', currency: 'INR', gst_enabled: true, gst_rate: 18, is_inter_state: false,
  discount_type: null, discount_value: 0, making_charges: 0, amount_paid: 0, payload: {}, company_snapshot: {},
  current_version_id: null, locked_version_id: null, created_at: '2026-09-01T00:00:00+00:00',
  updated_at: '2026-09-01T00:00:00+00:00', ...fields,
});

function world({ plan = 'max', usage = {} } = {}) {
  const db = fakeDb({
    organizations: [{ id: 'org-1', company_name: 'Edge Labs', company_address: 'Bengaluru', company_email: 'hi@edge.test', country_code: 'IN', signature_path: 'org-1/sig.png' }],
    clients: [
      { id: ACME, org_id: 'org-1', name: 'Acme Corp', email: 'ap@acme.com', gstin: '29ABCDE1234F1Z5', state: 'Karnataka', status: 'active', updated_at: '2026-09-01' },
      { id: KITE, org_id: 'org-1', name: 'Kite Labs', email: 'hello@kite.io', status: 'contacted', country_code: 'US', updated_at: '2026-09-01' },
    ],
    financial_documents: [
      // Acme's issued invoice: 50,000 + 18% = 59,000, 5,000 paid; issued with 45-day terms.
      doc(INV1, {
        type: 'invoice', status: 'partially_paid', doc_number: 'INV-2026-0007', customer_id: ACME, bill_to_name: 'Acme Corp',
        issue_date: '2026-09-01', due_date: '2026-10-16', subtotal: 50000, taxable_amount: 50000, gst_amount: 9000,
        grand_total: 59000, amount_paid: 5000, terms: 'Net 45', payment_instructions: 'HDFC 0001',
      }),
      // Kite accepted this quotation.
      doc(QT1, {
        type: 'quotation', status: 'accepted', doc_number: 'QT-2026-0003', customer_id: KITE, bill_to_name: 'Kite Labs',
        issue_date: '2026-09-10', valid_until: '2026-10-10', subtotal: 100000, taxable_amount: 100000, gst_amount: 18000,
        grand_total: 118000, current_version_id: 'v-1', locked_version_id: 'v-1', payload: { title: 'Quotation', accepted_by: 'Priya' },
      }),
      doc(DRAFT, { type: 'quotation', status: 'draft', doc_number: 'QT-2026-0004', customer_id: ACME, bill_to_name: 'Acme Corp', issue_date: '2026-09-20', grand_total: 0 }),
    ],
    document_line_items: [
      { id: 'li-1', document_id: INV1, org_id: 'org-1', position: 0, description: 'Website', quantity: 1, rate: 50000, line_total: 50000, unit: 'Nos' },
      { id: 'li-2', document_id: QT1, org_id: 'org-1', position: 0, description: 'App build', quantity: 1, rate: 100000, line_total: 100000, unit: 'Nos', catalog_item_id: null },
    ],
    payments: [{ id: 'p-1', org_id: 'org-1', document_id: INV1, amount: 5000, paid_on: '2026-09-05', confirmed_at: '2026-09-05T00:00:00Z', method: 'UPI' }],
    catalog_items: [{ id: 'cat-1', org_id: 'org-1', name: 'Support retainer', unit_price: 20000, unit: 'Month', hsn_sac: '998313', archived_at: null }],
    usage_counters: [{ org_id: 'org-1', invoices: usage.invoices ?? 1, quotations: usage.quotations ?? 2 }],
    vendors: [{ id: DELL, org_id: 'org-1', company_name: 'Dell India', payment_terms_days: 45, archived_at: null, updated_at: '2026-01-01' }],
    purchase_invoices: [],
  }, { rpc: { next_document_number: ({ p_type }) => ({ invoice: 'INV-2026-0008', quotation: 'QT-2026-0005', proforma: 'PF-2026-0001' })[p_type] } });
  const ctx = fakeCtx({ db, perms: structuredClone(PERMS), today: TODAY });
  ctx.plan = plan;
  return { db, ctx };
}

async function propose(name, args, ctx) {
  const tool = getTool(name);
  const r = await tool.resolve(args, ctx);
  if (!r.args) return { stopped: r };
  const problems = await tool.validate(r.args, ctx);
  if (problems.length) return { problems, r };
  return { r, preview: await tool.preview(r.args, ctx), tool };
}

async function confirm(p, ctx) {
  const plan = await p.tool.plan(p.r.args, ctx);
  const outcome = await applyPlan(ctx.db, plan);
  return { plan, outcome, summary: p.tool.summary(outcome, p.r.args, ctx) };
}

describe('document totals match the database trigger', () => {
  it('uses the same rounding and order as app.recompute_document_totals', () => {
    // Pinned by the same fixture in supabase/tests/14_document_totals_test.sql.
    const t = documentTotals({
      items: [{ quantity: 3, rate: 1234.56 }, { quantity: 1, rate: 999.99 }, { quantity: 2.5, rate: 333.33 }],
      discountType: 'percent', discountValue: 10, makingCharges: 150, gstEnabled: true, gstRate: 18,
    });
    expect(t).toMatchObject({ subtotal: 5537.00, discount: 553.70, taxable: 5133.30, gst: 923.99, grandTotal: 6057.29 });
    expect(t.cgst + t.sgst).toBeCloseTo(t.gst, 2);
  });
  it('caps a flat discount at the subtotal and skips GST when disabled', () => {
    const t = documentTotals({ items: [{ quantity: 1, rate: 100 }], discountType: 'flat', discountValue: 500, gstEnabled: false });
    expect(t).toMatchObject({ subtotal: 100, discount: 100, taxable: 0, gst: 0, grandTotal: 0 });
  });
});

describe('drafts', () => {
  it('"invoice Acme 50k for the website" — a draft with the org\'s usual terms and the totals the DB will store', async () => {
    const { db, ctx } = world();
    const p = await propose('create_invoice_draft', { client: 'Acme', items: 'website redesign 50k' }, ctx);
    expect(p.r.args).toMatchObject({
      client: ACME, gst_rate: 18, issue_date: TODAY, due_date: '2026-11-10', terms: 'Net 45',
      items: [{ description: 'website redesign', rate: 50000, quantity: 1 }],
    });
    expect(p.preview.preview.document.totals).toMatchObject({ subtotal: 50000, cgst: 4500, sgst: 4500, igst: 0, grandTotal: 59000 });
    expect(p.preview.confirmLabel).toBe('Save invoice draft · ₹59,000.00');
    expect(db.writes).toEqual([]);

    const { outcome, summary } = await confirm(p, ctx);
    const saved = db.tables.financial_documents.find((d) => d.doc_number === 'INV-2026-0008');
    expect(saved).toMatchObject({ type: 'invoice', status: 'draft', customer_id: ACME, bill_to_name: 'Acme Corp', gst_rate: 18, org_id: 'org-1' });
    expect(saved.company_snapshot).toMatchObject({ company_name: 'Edge Labs', signature_path: 'org-1/sig.png' });
    expect(saved.company_snapshot).not.toHaveProperty('gstin');
    expect(db.tables.document_line_items.filter((l) => l.document_id === saved.id)).toHaveLength(1);
    expect(summary).toMatch(/INV-2026-0008/);
    // Undo keeps the number in the series: the draft is cancelled, not deleted.
    expect(getTool('create_invoice_draft').undoPlan(outcome.results)[0]).toMatchObject({ op: 'update', patch: { status: 'cancelled' } });
  });

  it('bills a catalogue product at its price', async () => {
    const { ctx } = world();
    const p = await propose('create_invoice_draft', { client: 'Acme', items: [{ product: 'support retainer', quantity: 3 }] }, ctx);
    expect(p.r.args.items[0]).toMatchObject({ description: 'Support retainer', rate: 20000, quantity: 3, unit: 'Month', hsn: '998313', catalog_item_id: 'cat-1' });
  });

  it('a client abroad is billed IGST; an unknown client is not invented', async () => {
    const { ctx } = world();
    const p = await propose('create_quotation_draft', { client: 'Kite', items: 'app build 1 lakh' }, ctx);
    expect(p.r.args).toMatchObject({ is_inter_state: true, valid_until: '2026-10-26' });
    expect(p.preview.preview.document.totals).toMatchObject({ igst: 18000, cgst: 0 });
    const none = await propose('create_invoice_draft', { client: 'Umbrella', items: 'x 5k' }, ctx);
    expect(none.stopped.needs).toMatchObject({ kind: 'none', offer: { tool: 'create_client' } });
  });

  it('asks for the amount instead of drafting a zero-rupee line', async () => {
    const { ctx } = world();
    const p = await propose('create_invoice_draft', { client: 'Acme', items: [{ description: 'Consulting' }] }, ctx);
    expect(p.stopped.needs).toMatchObject({ kind: 'input', param: 'items' });
  });

  it('enforces the plan limit the form enforces', async () => {
    const { ctx } = world({ plan: 'free', usage: { invoices: 5 } });
    const p = await propose('create_invoice_draft', { client: 'Acme', items: 'x 5k' }, ctx);
    expect(p.problems[0]).toMatch(/all 5 invoices on the Free plan/);
  });

  it('re-resolving its own output lands on the same draft (what confirm does)', async () => {
    const { ctx } = world();
    const tool = getTool('create_invoice_draft');
    const first = await tool.resolve({ client: 'Acme', items: 'x 10k', no_gst: true, discount_percent: 10 }, ctx);
    const again = await tool.resolve(first.args, ctx);
    expect(again.args).toEqual(first.args);
  });
});

describe('convert', () => {
  it('accepted quotation → proforma draft (first order), source marked converted with its payload intact', async () => {
    const { db, ctx } = world();
    const p = await propose('convert_quotation', { source: 'the Kite quote' }, ctx);
    expect(p.r.args).toMatchObject({ source: QT1, target: 'proforma', advance_percent: 50 });
    expect(p.preview.preview.note).toMatch(/First order/);
    await confirm(p, ctx);
    const src = db.tables.financial_documents.find((d) => d.id === QT1);
    const made = db.tables.financial_documents.find((d) => d.doc_number === 'PF-2026-0001');
    expect(made).toMatchObject({ type: 'proforma', status: 'draft', customer_id: KITE, advance_percent: 50 });
    expect(db.tables.document_line_items.filter((l) => l.document_id === made.id).map((l) => l.description)).toEqual(['App build']);
    expect(src.status).toBe('converted');
    expect(src.payload).toEqual({ title: 'Quotation', accepted_by: 'Priya', converted_to: made.id });
  });

  it('refuses a quotation the client has not accepted, and says why', async () => {
    const { ctx } = world();
    const p = await propose('convert_quotation', { source: 'QT-2026-0004' }, ctx);
    expect(p.stopped.error).toMatch(/only an accepted quotation/);
  });
});

describe('issue', () => {
  it('only a draft, high risk, with the full document and a plain "not emailed"', async () => {
    const { ctx } = world();
    const tool = getTool('issue_document');
    expect(tool.risk).toBe('high');
    const bad = await propose('issue_document', { document: 'INV-2026-0007' }, ctx);
    expect(bad.stopped.needs.kind).toBe('none');
    const { db } = world();
    db.tables.document_line_items.push({ id: 'li-3', document_id: DRAFT, position: 0, description: 'Audit', quantity: 1, rate: 10000, line_total: 10000 });
    db.tables.financial_documents.find((d) => d.id === DRAFT).grand_total = 11800;
    const c2 = fakeCtx({ db, perms: structuredClone(PERMS), today: TODAY });
    const p = await propose('issue_document', { document: 'QT-2026-0004' }, c2);
    expect(p.preview.irreversible).toMatch(/not emailed/);
    expect(p.preview.preview.full).toBe(true);
    const { plan } = await confirm(p, c2);
    expect(plan[0]).toMatchObject({ op: 'update', patch: { status: 'sent' } });
  });
});

describe('payments', () => {
  it('"Acme paid the invoice" finds Acme\'s one open invoice and records the whole balance', async () => {
    const { db, ctx } = world();
    const p = await propose('mark_invoice_paid', { document: 'Acme', method: 'upi' }, ctx);
    expect(p.r.args).toMatchObject({ document: INV1, amount: 54000, date: TODAY, method: 'upi' });
    expect(p.preview.confirmLabel).toBe('Record ₹54,000.00 payment');
    expect(p.preview.preview.rows).toContainEqual(['Still owed after', 'Nothing — it will show as paid']);
    await confirm(p, ctx);
    expect(db.tables.payments.at(-1)).toMatchObject({ document_id: INV1, amount: 54000, method: 'UPI', confirmed_by: 'u-1' });
    expect(db.tables.payments.at(-1).confirmed_at).toBeTruthy();
  });

  it('refuses more than is owed, and a future date', async () => {
    const { ctx } = world();
    expect((await propose('record_payment', { document: 'INV-2026-0007', amount: '60k' }, ctx)).problems[0]).toMatch(/more than the ₹54,000.00 still owed/);
    expect((await propose('record_payment', { document: 'INV-2026-0007', amount: '5k', date: '2026-12-01' }, ctx)).problems[0]).toMatch(/future/);
  });

  it('asks how much, offering the balance', async () => {
    const { ctx } = world();
    const p = await propose('record_payment', { document: 'INV-2026-0007' }, ctx);
    expect(p.stopped.needs.options[0]).toEqual({ label: 'All ₹54,000.00', value: 'full' });
  });
});

describe('cancel and delete follow the app\'s rules', () => {
  it('a tax invoice is never deleted — it offers to cancel; one with money received cannot be cancelled', async () => {
    const { ctx } = world();
    const del = await propose('delete_financial_document', { document: 'INV-2026-0007' }, ctx);
    expect(del.stopped.needs.message).toMatch(/cancelled, not deleted/);
    const cancel = await propose('cancel_financial_document', { document: 'INV-2026-0007' }, ctx);
    expect(cancel.stopped.needs.message).toMatch(/has been received against this invoice/);
  });

  it('a never-sent quotation draft is deleted outright', async () => {
    const { db, ctx } = world();
    const p = await propose('delete_financial_document', { document: 'QT-2026-0004' }, ctx);
    await confirm(p, ctx);
    expect(db.tables.financial_documents.some((d) => d.id === DRAFT)).toBe(false);
  });
});

describe('vendors and bills', () => {
  it('"Dell\'s bill 85k incl GST, no DL-9981" → subtotal backed out, due on Dell\'s 45-day terms', async () => {
    const { db, ctx } = world();
    const p = await propose('create_purchase_bill', { vendor: 'Dell', amount: '85k', bill_number: 'DL-9981' }, ctx);
    expect(p.r.args).toMatchObject({ vendor: DELL, subtotal: 72033.9, tax_rate: 18, bill_date: TODAY, due_date: '2026-11-10' });
    expect(p.preview.confirmLabel).toBe('Record ₹85,000.00 bill');
    await confirm(p, ctx);
    expect(db.tables.purchase_invoices[0]).toMatchObject({ vendor_id: DELL, bill_number: 'DL-9981', subtotal: 72033.9, status: 'unpaid' });
    expect(await getTool('create_purchase_bill').resolve(p.r.args, ctx)).toMatchObject({ args: p.r.args });
  });

  it('an unknown vendor is offered, not invented', async () => {
    const { ctx } = world();
    const p = await propose('create_purchase_bill', { vendor: 'Sharma Stationers', amount: '4200', bill_number: '11' }, ctx);
    expect(p.stopped.needs.offer).toMatchObject({ tool: 'create_vendor', args: { company_name: 'Sharma Stationers' } });
  });

  it('a duplicate vendor is refused', async () => {
    const { ctx } = world();
    expect((await propose('create_vendor', { company_name: 'dell india' }, ctx)).problems[0]).toMatch(/already a vendor/);
  });
});

void undoPlan;

describe('catalogue products named in passing', () => {
  it('"Support retainer (3 months)" is the product, three of them, at its price', async () => {
    const { ctx } = world();
    const p = await propose('create_invoice_draft', { client: 'Acme', items: [{ description: 'Support retainer (3 months)' }] }, ctx);
    expect(p.r.args.items[0]).toMatchObject({ rate: 20000, quantity: 3, catalog_item_id: 'cat-1' });
  });
});
