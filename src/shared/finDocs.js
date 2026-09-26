// finDocs.js — invoices, quotations and proformas as data, for both sides.
//
// The browser's orgStore and the agent's server-side executors write
// financial documents through these same functions, so a draft EdgeAI creates
// is column-for-column what the form would have saved. Nothing here reads
// state: whatever a caller knows (the signature path, today) is passed in.

/* ── small coercions (the same ones orgStore's section mappers use) ───────── */

export const nn = (v) => (v === undefined || v === '' ? null : v);
export const bool = (v, dflt = false) => (v === undefined || v === null ? dflt : v === true || v === 'Yes' || v === 'true');
export const num = (v, dflt = null) => (v === undefined || v === '' || v === null ? dflt : Number(v));
export const day = (v) => (v ? String(v).slice(0, 10) : null);

// Rounded as Postgres rounds numeric: to the cent, halves away from zero, on the
// decimal value — not on its binary approximation, where 2.5 × 333.33 is
// 833.3249999… and would round the wrong way.
const round2 = (n) => {
  const v = Number(n) || 0;
  const cents = Number((Math.abs(v) * 100).toPrecision(15));
  return Math.sign(v) * Math.round(cents) / 100;
};

/** The human number of a document, whichever field an older save used. */
export const docNumber = (d) => (d && (d.doc_number || d.invoiceNumber || d.id)) || '';

/* ── receivables ──────────────────────────────────────────────────────────── */

// Statuses that mean an invoice is not (or no longer) a real receivable.
const DEAD = new Set(['draft', 'cancelled', 'declined', 'expired']);
const dayKey = (d) => (d ? String(d).slice(0, 10) : '');

/** Issued sales invoices only: quotations and proformas are not revenue. */
export function issuedInvoices(docs) {
  return (docs || []).filter((d) => d.type === 'invoice' && !DEAD.has(d.status));
}

export const balanceOf = (d) => Math.max(0, (Number(d.grand_total) || 0) - (Number(d.amount_paid) || 0));

/** Overdue: issued, money still owed, and the due date is behind us. */
export function isOverdue(d, today) {
  return d.type === 'invoice' && !DEAD.has(d.status) && d.status !== 'paid'
    && !!d.due_date && dayKey(d.due_date) < today && balanceOf(d) > 0.009;
}

/* ── the money ────────────────────────────────────────────────────────────── */

/**
 * A document's totals, by exactly the rules app.recompute_document_totals()
 * (0002) applies once the rows are written:
 *
 *   line_total = round(qty × rate, 2)          per line
 *   subtotal   = Σ line_total
 *   discount   = percent: round(subtotal × min(value, 100) / 100, 2)
 *                flat:    min(value, subtotal)
 *   taxable    = round(subtotal − discount + making_charges, 2)
 *   gst        = gst_enabled ? round(taxable × gst_rate / 100, 2) : 0
 *   grand      = round(taxable + gst, 2)
 *
 * The CGST/SGST/IGST split is presentation: inter-state is all IGST,
 * otherwise it is halved. A card that promises a total must promise the one
 * the database will store; a test pins the two together.
 */
export function documentTotals({
  items = [], discountType = null, discountValue = 0, makingCharges = 0,
  gstEnabled = true, gstRate = 18, isInterState = false,
} = {}) {
  const lines = (items || []).map((it) => round2((Number(it.quantity) || 0) * (Number(it.rate) || 0)));
  const subtotal = round2(lines.reduce((s, v) => s + v, 0));
  const value = Number(discountValue) || 0;
  const discount = discountType === 'percent' ? round2(subtotal * Math.min(value, 100) / 100)
    : discountType === 'flat' ? Math.min(value, subtotal) : 0;
  const taxable = round2(subtotal - discount + (Number(makingCharges) || 0));
  const gst = gstEnabled ? round2(taxable * (Number(gstRate) || 0) / 100) : 0;
  const half = round2(gst / 2);
  return {
    lines, subtotal, discount, taxable, gst,
    igst: isInterState ? gst : 0,
    cgst: isInterState ? 0 : half,
    sgst: isInterState ? 0 : round2(gst - half),
    grandTotal: round2(taxable + gst),
  };
}

/* ── the company on the document ──────────────────────────────────────────── */

/**
 * The seller block the forms stamp on every document (`company_profile`),
 * built from the organizations row. Secrets and bank details are stripped by
 * scrubSnapshot() before it is stored, as they are for the forms.
 */
export function companyProfileOf(org = {}) {
  return {
    // Storage paths, not URLs: the renderer signs them when it draws.
    logo_path: org.logo_path || null,
    signature_path: org.signature_path || null,
    stamp_path: org.stamp_path || null,
    stamp_type: org.stamp_type || null,
    stamp_city: org.stamp_city || null,
    company_tagline: org.company_tagline || '',
    company_website: org.company_website || '',
    company_name: org.company_name || org.name || '',
    address: org.company_address || org.address || '',
    email: org.company_email || org.email || '',
    phone: org.company_phone || org.phone || '',
    gstin: org.gstin || '',
    logo_url: org.logo_url || '',
    signature_url: org.signature_url || '',
    upi_id: org.upi_id || '',
    bank_name: org.bank_name || '',
    bank_account_number: org.bank_account_number || '',
    bank_ifsc: org.bank_ifsc || '',
    bank_account_type: org.bank_account_type || '',
  };
}

// Never persisted into a document snapshot: mail credentials, and the bank and
// tax identifiers the renderer reads live from the company profile instead.
export const SECRET_KEYS = ['gmail_user', 'gmail_app_password', 'emailjs_service_id',
  'emailjs_template_id', 'emailjs_public_key',
  'bank_account_number', 'bank_ifsc', 'bank_name', 'bank_account_type',
  'upi_id', 'gstin', 'cin'];

/**
 * A company profile fit to store on a document.
 *
 * A snapshot outlives any URL in it. logo_url and stamp_url are permanent CDN
 * links from the public bucket and can be stored as-is, but signature_url is a
 * signed URL that expires in an hour — persisting it would leave every
 * document without a signature by tomorrow. Store the stable object path and
 * let the renderer sign it on demand.
 */
export function scrubSnapshot(profile, signaturePath = null) {
  if (!profile || typeof profile !== 'object') return {};
  const clean = { ...profile };
  for (const k of SECRET_KEYS) delete clean[k];
  const path = signaturePath || profile.signature_path;
  if (path) {
    clean.signature_path = path;
    delete clean.signature_url;
  } else if (typeof clean.signature_url === 'string' && clean.signature_url.includes('token=')) {
    // A signed URL with no path to fall back on is worse than nothing.
    delete clean.signature_url;
  }
  return clean;
}

/* ── rows ─────────────────────────────────────────────────────────────────── */

/**
 * A document as a financial_documents row. Money columns are not sent: the
 * totals trigger computes them from the line items and these inputs.
 */
export function finDocToRow(i, { signaturePath = null, today = null } = {}) {
  const known = {
    type: i.type,
    status: i.status || 'draft',
    revision: i.revision || 'v1',
    customer_id: nn(i.customer_id),
    bill_to_name: i.clientName || i.bill_to_name || 'Unnamed',
    bill_to_email: nn(i.clientEmail || i.bill_to_email),
    bill_to_address: nn(i.clientAddress || i.bill_to_address),
    bill_to_gstin: nn(i.buyerGSTIN || i.bill_to_gstin),
    bill_to_state: nn(i.buyerState || i.bill_to_state),
    issue_date: day(i.issue_date) || today || day(new Date().toISOString()),
    due_date: day(i.due_date),
    valid_until: day(i.valid_until),
    // Omitted entirely — not nulled — when the caller has no opinion, so the
    // BEFORE INSERT trigger can resolve it from the customer or the org.
    //
    // `undefined` rather than nn(): a caller's stripNulls() drops undefined but
    // keeps an explicit null, and nothing re-resolves country on UPDATE.
    // Sending null here would erase a resolved country on any save whose cache
    // entry was cold. Passing '' still clears it, which is what someone
    // deliberately blanking the field means.
    country_code: i.country_code === undefined ? undefined : nn(i.country_code),
    country_source: i.country_source === undefined ? undefined : nn(i.country_source),
    currency: (i.currency || 'INR').slice(0, 3).toUpperCase(),
    // The forms speak camelCase and nest the discount; the columns are
    // snake_case and flat. These are not cosmetic aliases: the totals trigger
    // computes subtotal/gst/grand_total from discount_type, discount_value,
    // making_charges, gst_enabled and gst_rate on THIS row, so a name that
    // fails to land here silently saves the wrong money.
    discount_type: nn(i.discount_type ?? i.discountType ?? i.discount?.type),
    discount_value: num(i.discount_value ?? i.discountValue ?? i.discount?.value, 0),
    gst_enabled: bool(i.gst_enabled ?? i.enableGst, true),
    gst_rate: num(i.gst_rate ?? i.gstRate, 18),
    // NOT NULL with a default in the schema; an explicit null died with 23502.
    is_inter_state: bool(i.is_inter_state ?? i.isInterState, false),
    // Deliberately NOT aliased to the forms' `makingCharges`. The trigger ADDS
    // making_charges to the taxable amount, but InvoiceForm's makingCost is an
    // internal per-item cost used for the profit estimate (BillingRevenue.jsx
    // subtracts it from revenue). Mapping the two would inflate every total.
    making_charges: num(i.making_charges, 0),
    amount_in_words: nn(i.amount_in_words),
    advance_percent: num(i.advance_percent),
    payment_instructions: nn(i.payment_instructions),
    terms: nn(i.terms),
    notes: nn(i.notes),
    company_snapshot: scrubSnapshot(i.company_profile, signaturePath),
    doc_number: nn(i.doc_number || i.invoiceNumber || i.proformaNumber || i.quotationNumber),
  };

  // Everything the forms carry that has no column keeps working via `payload`.
  const MAPPED = new Set(['id', 'type', 'status', 'revision', 'customer_id',
    // Aliases consumed above. Without these they would also be copied into
    // `payload`, leaving two disagreeing copies of the same number.
    'discountType', 'discountValue', 'discount', 'enableGst', 'gstRate',
    'isInterState',
    'clientName', 'bill_to_name', 'clientEmail', 'bill_to_email', 'clientAddress',
    'bill_to_address', 'buyerGSTIN', 'bill_to_gstin', 'buyerState', 'bill_to_state',
    'issue_date', 'due_date', 'valid_until', 'currency', 'country_code',
    'country_source', 'discount_type',
    'discount_value', 'gst_enabled', 'gst_rate', 'is_inter_state', 'making_charges',
    'amount_in_words', 'advance_percent', 'payment_instructions', 'terms', 'notes',
    'company_profile', 'company_snapshot', 'doc_number', 'invoiceNumber', 'items',
    'subtotal', 'discount_amount', 'taxable_amount', 'gst_amount', 'grand_total',
    // `payments` is a joined child table, not a form field. Without it here the
    // whole ledger would be copied into payload on every save and then shadow
    // the real join when read back.
    'amount_paid', 'payments', 'created_at', 'updated_at', 'org_id', 'payload',
    'current_version_id', 'locked_version_id']);
  const payload = {};
  for (const [k, v] of Object.entries(i)) if (!MAPPED.has(k)) payload[k] = v;
  known.payload = payload;

  return known;
}

/**
 * Line items as document_line_items columns. The forms spell the HSN and
 * catalogue fields several ways depending on which one saved the document;
 * accept all of them, because a line that arrives without its catalogue id is
 * a sale that never reaches Product Performance. line_total is trigger-computed
 * and never sent.
 */
export function lineItemRows(items) {
  return (items || [])
    .filter((it) => it && (it.description || it.rate || it.quantity))
    .map((it) => ({
      description: it.description || '',
      hsn_sac: nn(it.hsn || it.hsn_sac || it.hsnSac || it.hsnCode),
      quantity: num(it.quantity, 1),
      unit: it.unit || 'Nos',
      rate: num(it.rate, 0),
      gst_rate: num(it.gst_rate),
      catalog_item_id: nn(it.catalog_item_id || it.catalogItemId || it.productId),
    }));
}

/* ── back to the app's shape ──────────────────────────────────────────────── */

export function financialDocFromRow(r) {
  const items = (r.document_line_items || [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((li) => ({
      id: li.id, description: li.description, hsn: li.hsn_sac,
      quantity: li.quantity, unit: li.unit, rate: li.rate,
      gst_rate: li.gst_rate, amount: li.line_total,
      // Which catalogue row this line was billed against, if any. Reloading a
      // saved document into a form has to bring this back, or re-saving would
      // silently detach the line and the product would lose the sale.
      catalog_item_id: li.catalog_item_id || null,
    }));

  return {
    id: r.id,
    invoiceNumber: r.doc_number, doc_number: r.doc_number,
    type: r.type, status: r.status, revision: r.revision,
    customer_id: r.customer_id,
    clientName: r.bill_to_name, clientEmail: r.bill_to_email,
    clientAddress: r.bill_to_address, buyerGSTIN: r.bill_to_gstin,
    buyerState: r.bill_to_state,
    issue_date: r.issue_date, due_date: r.due_date, valid_until: r.valid_until,
    // Where this sale happened, frozen onto the document. `country_source`
    // says how it got here — a customer record today, a storefront checkout
    // later — and the Sales by Countries widget groups on country_code without
    // caring which.
    country_code: r.country_code || null,
    country_source: r.country_source || null,
    currency: r.currency,
    subtotal: r.subtotal, discount_type: r.discount_type,
    discount_value: r.discount_value, discount_amount: r.discount_amount,
    taxable_amount: r.taxable_amount,
    gst_enabled: r.gst_enabled, gst_rate: r.gst_rate, gst_amount: r.gst_amount,
    is_inter_state: r.is_inter_state, making_charges: r.making_charges,
    grand_total: r.grand_total, amount_in_words: r.amount_in_words,
    amount_paid: r.amount_paid, advance_percent: r.advance_percent,
    payment_instructions: r.payment_instructions, terms: r.terms, notes: r.notes,
    company_profile: r.company_snapshot,
    items,
    // The ledger behind amount_paid. Absent when the row was selected without
    // the join (api/_lib/docShape.js does exactly that for the portal), so this
    // is always an array and never undefined.
    payments: (r.payments || [])
      .slice()
      .sort((a, b) => new Date(a.paid_on) - new Date(b.paid_on)),
    // Set once the document has been sent (0064). From then on its content
    // changes only by publishing a new version; see publishFinDocVersion().
    current_version_id: r.current_version_id || null,
    locked_version_id: r.locked_version_id || null,
    created_at: r.created_at, updated_at: r.updated_at,
    // The forms and the PDF builder read the camelCase names they wrote.
    // finDocToRow() maps those onto columns and keeps them out of `payload`,
    // so without these a reloaded document looked GST-free and undiscounted,
    // and re-saving it from the edit form actually dropped the GST.
    enableGst: r.gst_enabled, gstRate: Number(r.gst_rate) || 0,
    discount: {
      type: r.discount_type,
      value: Number(r.discount_value) || 0,
      amount: Number(r.discount_amount) || 0,
    },
    ...(r.payload || {}),
  };
}
