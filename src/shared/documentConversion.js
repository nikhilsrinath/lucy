// documentConversion.js — how a quotation becomes a proforma or an invoice,
// and how a proforma becomes its tax invoice.
//
// Two roads out of an accepted quotation:
//
//   quotation ─→ proforma ─→ tax invoice    advance first, bill on delivery
//   quotation ─────────────→ tax invoice    bill straight away
//
// Which one is a judgement call, so the issuer picks. recommendTarget() only
// suggests, and every reason it gives is a fact read from this organization's
// own documents — a count, a term, a currency — never a guess.
//
// Pure functions. InvoiceList does the writes.
import { withoutResponses, advanceOf, DEFAULT_ADVANCE_PERCENT } from './proformaAdvance.js';
import { issuedInvoices, isOverdue } from './finDocs.js';
import { todayIso } from './dates.js';

/** Days to the due date on a new document: the forms' own defaults. */
export const DUE_DAYS = { proforma: 15, invoice: 30 };

// Payment terms that ask for money before the work. Word-bounded so
// "advanced analytics" in a line description never counts — only the terms,
// notes and payment instructions are read anyway.
const ADVANCE_TERMS = /\b(advance|upfront|up-front|prepaid|prepayment|pre-payment|proforma|pro-forma)\b/i;

const addDays = (isoDay, days) => {
  const [y, m, d] = isoDay.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
};

const clientKey = (d) => d.customer_id
  || (d.clientName || d.issued_to || d.client?.name || '').trim().toLowerCase()
  || null;

/**
 * What `doc` may be converted into right now. Empty when it may not.
 *
 * A quotation must be accepted: the database refuses to build from a version
 * the client never agreed to (0064, SOURCE_NOT_LOCKED). A proforma goes to its
 * tax invoice once the advance is in — or at once when it asked for none.
 */
export function conversionTargets(doc) {
  if (!doc) return [];
  if (doc.type === 'quotation') return doc.status === 'accepted' ? ['proforma', 'invoice'] : [];
  if (doc.type === 'proforma') {
    if (['advance_paid', 'partially_paid', 'paid'].includes(doc.status)) return ['invoice'];
    if (doc.status === 'order_confirmed' && advanceOf(doc).advance === 0) return ['invoice'];
  }
  return [];
}

/**
 * The document already built from `source`, if any. A conversion is two
 * writes (save the new document, then mark the source converted); when the
 * second fails, this is what stops a retry from issuing a duplicate.
 */
export function existingConversion(source, docs) {
  return (docs || []).find((d) => d.converted_from === source.id && d.status !== 'cancelled') || null;
}

/**
 * Proforma or straight invoice, and why.
 *
 * A proforma protects the issuer when money should arrive before the work
 * does; each of these is a reason to want that, and any one of them is enough:
 *   · the quotation's own terms ask for an advance
 *   · the client owes on an overdue invoice right now
 *   · the client has never paid an invoice here (a first order)
 *   · the sale is billed in a foreign currency or to a client abroad
 * With none of them — a client with a paid record and nothing overdue — the
 * invoice can go straight out.
 *
 * @param {object} quotation
 * @param {object[]} docs  every financial document of the organization
 * @returns {{ target: 'proforma'|'invoice', reasons: string[], facts: object }}
 */
export function recommendTarget(quotation, docs, today = todayIso()) {
  const key = clientKey(quotation);
  const history = key
    ? issuedInvoices(docs).filter((d) => d.id !== quotation.id && clientKey(d) === key)
    : [];
  const paid = history.filter((d) => Number(d.amount_paid) > 0);
  const overdue = history.filter((d) => isOverdue(d, today));
  const terms = [quotation.terms, quotation.notes, quotation.payment_instructions].filter(Boolean).join('\n');
  const currency = (quotation.currency || 'INR').toUpperCase();
  const abroad = !!quotation.country_code && quotation.country_code.toUpperCase() !== 'IN';

  const facts = {
    invoices: history.length,
    paidInvoices: paid.length,
    overdueInvoices: overdue.length,
    advanceInTerms: ADVANCE_TERMS.test(terms),
    foreign: currency !== 'INR' || abroad,
  };

  const reasons = [];
  if (facts.advanceInTerms) reasons.push('The quotation’s terms ask for an advance.');
  if (overdue.length) {
    reasons.push(`This client has ${overdue.length} overdue invoice${overdue.length > 1 ? 's' : ''} right now.`);
  }
  if (!key) {
    reasons.push('The quotation names no client to check a payment record against.');
  } else if (paid.length === 0) {
    reasons.push(history.length
      ? `None of this client’s ${history.length} invoice${history.length > 1 ? 's has' : 's have'} been paid yet.`
      : 'First order from this client — no invoice has been issued to them before.');
  }
  if (facts.foreign) {
    reasons.push(currency !== 'INR' ? `Billed in ${currency}.` : `Client is outside India (${quotation.country_code.toUpperCase()}).`);
  }

  if (reasons.length) return { target: 'proforma', reasons, facts };
  return {
    target: 'invoice',
    reasons: [`This client has paid ${paid.length} of ${history.length} invoice${history.length > 1 ? 's' : ''} here and has nothing overdue.`],
    facts,
  };
}

/**
 * The new document, ready for documentStore.save().
 *
 * It keeps what the source SAYS — client, line items (with their catalogue
 * ids), GST, discount, terms, country — and none of what happened TO it:
 * acceptance, signatures, views, payments, version pointers. It is dated
 * today, because an invoice carries the date it is issued, not the date of
 * the quote; and it has no number, so the database draws the next one in the
 * target's own series.
 *
 * @param {object} source
 * @param {'proforma'|'invoice'} target
 * @param {{ advancePercent?: number, today?: string }} [opts]
 */
export function buildConversion(source, target, { advancePercent, today = todayIso() } = {}) {
  if (!conversionTargets(source).includes(target)) {
    throw new Error(`A ${source.type} with status "${source.status}" cannot be converted to a ${target}.`);
  }
  const gst = source.enableGst ?? source.gst_enabled;
  const withGst = gst !== false && Number(source.gstRate ?? source.gst_rate) > 0;

  const doc = {
    ...withoutResponses(source),
    id: undefined,
    revision: undefined,
    // The spread carries the SOURCE's number. Reusing it violates
    // unique(org_id, doc_number); unset, saveFinDoc() draws a fresh one.
    doc_number: undefined,
    invoiceNumber: undefined,
    quotationNumber: undefined,
    proformaNumber: undefined,
    // A stale copy of the source's total, written by the quotation form. The
    // trigger computes grand_total from the line items; this would only lie.
    amount: undefined,
    type: target,
    status: 'draft',
    issue_date: today,
    due_date: addDays(today, DUE_DAYS[target]),
    // A quotation's validity means nothing on a bill.
    valid_until: undefined,
    converted_from: source.id,
    converted_from_type: source.type,
    converted_from_number: source.doc_number || null,
    created_at: new Date().toISOString(),
  };

  if (target === 'proforma') {
    const pct = advancePercent ?? source.advance_percent;
    // Without a percentage the proforma asked for no advance and the portal
    // showed ₹0; an explicit 0 is kept — it means "confirm the order, no advance".
    doc.advance_percent = pct === null || pct === undefined || pct === ''
      ? DEFAULT_ADVANCE_PERCENT
      : Math.min(100, Math.max(0, Number(pct) || 0));
    doc.title = 'Proforma Invoice';
  } else {
    doc.advance_percent = undefined;
    doc.title = withGst ? 'Tax Invoice' : 'Invoice';
  }
  return doc;
}

/**
 * The advance a proforma collected, as the payment it becomes on the tax
 * invoice. Without it the invoice demanded the whole amount again from a
 * client who had already paid part of it — and, since only invoices count as
 * revenue, the advance was never counted as collected at all.
 *
 * Confirmed money only. Null when nothing was received.
 */
export function carriedAdvance(proforma) {
  const confirmed = (proforma.payments || []).filter((p) => p.confirmed_at);
  const amount = confirmed.length
    ? confirmed.reduce((s, p) => s + (Number(p.amount) || 0), 0)
    : Number(proforma.amount_paid) || 0;
  const rounded = Math.round(amount * 100) / 100;
  if (rounded <= 0) return null;
  const last = confirmed.map((p) => p.paid_on).filter(Boolean).sort().pop();
  const ref = proforma.doc_number || 'the proforma';
  return {
    amount: rounded,
    paidOn: last || null,
    method: 'Advance',
    reference: proforma.doc_number || null,
    note: `Advance received against proforma ${ref}`,
  };
}
