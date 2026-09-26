// financeTaxonomy.js — the reasons money moves, without the loading.
//
// The pure half of services/financeCategories.js, split out so the agent's
// serverless executors can use the same treatments, payment rails and category
// lookups as the browser. Whoever loads public.finance_categories (0038) —
// financeCategories.js in the browser, api/_lib/agent on the server — hands the
// rows to setCategories(); everything else reads them from here.
//
// The table, not this file, is the definition of the categories. The treatment
// constants below mirror app.finance_treatment() and are what the cards say.

export const TREATMENTS = {
  // in
  revenue:       { label: 'Revenue',            income: true,  note: 'Earned from customers. Counts in the P&L.' },
  other_income:  { label: 'Other income',       income: true,  note: 'Earned, but not from your main trade. Counts in the P&L.' },
  capital_in:    { label: 'Funding',            income: false, note: 'Cash in, but not earned — it never reaches the P&L.' },
  cost_recovery: { label: 'Recovery',           income: false, note: 'Money back on something you paid for. Reduces that cost.' },
  // out
  operating:     { label: 'Operating cost',     expense: true,  note: 'An ordinary cost of running. Reduces profit.' },
  non_operating: { label: 'Non-operating cost', expense: true,  note: 'A real cost, below the operating line. Reduces profit.' },
  capex:         { label: 'Asset purchase',     expense: false, note: 'You still own it, so it is not a cost. Cash only.' },
  financing:     { label: 'Financing',          expense: false, note: 'Settles or places a claim rather than costing you. Cash only.' },
  owner:         { label: 'Owner draw',         expense: false, note: 'A share of profit taken out, not a cost of earning it.' },
  tax:           { label: 'Tax remitted',       expense: false, note: 'Settles the liability the Tax Summary computes. Cash only.' },
};

/** Treatments that belong in P&L income. */
export const INCOME_TREATMENTS = new Set(['revenue', 'other_income']);
/** Treatments that belong in the P&L expense line. */
export const EXPENSE_TREATMENTS = new Set(['operating', 'non_operating']);

export const PAYMENT_METHODS = [
  { key: 'bank_transfer', label: 'Bank transfer' },
  { key: 'upi',           label: 'UPI' },
  { key: 'cash',          label: 'Cash' },
  { key: 'card',          label: 'Card' },
  { key: 'cheque',        label: 'Cheque' },
  { key: 'wallet',        label: 'Wallet' },
  { key: 'other',         label: 'Other' },
];
export const methodLabel = (key) => PAYMENT_METHODS.find((m) => m.key === key)?.label || 'Other';

/* ── the loaded categories ────────────────────────────────────────────────── */

let _rows = null;

/** Hands over the finance_categories rows once somebody has fetched them. */
export function setCategories(rows) {
  _rows = Array.isArray(rows) ? rows : null;
}

/** Synchronous read of whatever has been loaded. Empty before the first load. */
export const allCategories = () => _rows || [];

/** Pickable categories for one direction, in display order. */
export function categoriesFor(direction) {
  return allCategories().filter((c) => c.direction === direction && c.active);
}

export const categoryOf = (key) => allCategories().find((c) => c.key === key) || null;

/** Readable name for a stored key, falling back to the key for unknown values. */
export const categoryLabel = (key) => categoryOf(key)?.label || key || '—';

/**
 * The treatment of a category. Mirrors app.finance_treatment(): an unknown key
 * gets the neutral treatment for its direction, which is what the database
 * stamped on every legacy row.
 */
export function treatmentOf(key, direction) {
  const found = categoryOf(key);
  if (found && found.direction === direction) return found.treatment;
  return direction === 'in' ? 'revenue' : 'operating';
}
