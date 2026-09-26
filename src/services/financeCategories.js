// financeCategories.js — the reasons money moves, and what each one does to
// profit.
//
// Reads public.finance_categories (0038). That table, not this file, is the
// definition: the same treatments drive EdgeBrain's spend.* and income.*
// aggregates, and a second list here would eventually disagree with them.
//
// Reference data shared by every org, so it is fetched once per session and
// mirrored to localStorage for instant paint — the country_codes arrangement,
// for the same reason.
import { supabase } from '../lib/supabase';
import {
  TREATMENTS, INCOME_TREATMENTS, EXPENSE_TREATMENTS, PAYMENT_METHODS, methodLabel,
  setCategories, allCategories, categoriesFor, categoryOf, categoryLabel, treatmentOf,
} from '../shared/financeTaxonomy';

const LS_KEY = 'edgeos_finance_categories_v1';

let _inflight = null;

// ─── Treatments, rails and the loaded rows ────────────────────────────────────
//
// Defined in src/shared/financeTaxonomy.js so the agent's server-side
// executors use the same ones; re-exported here so no screen changes import.
// Two questions decide where an entry lands, and they are not the same
// question: does this change PROFIT, and does it change CASH? Everything here
// changes cash. Only some of it changes profit.
export {
  TREATMENTS, INCOME_TREATMENTS, EXPENSE_TREATMENTS, PAYMENT_METHODS, methodLabel,
  allCategories, categoriesFor, categoryOf, categoryLabel, treatmentOf,
} from '../shared/financeTaxonomy';

// ─── Loading ──────────────────────────────────────────────────────────────────

function readCache() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch { return null; }
}

/**
 * Fetches the taxonomy once. Concurrent callers share one request. A failure
 * leaves the loaded rows as they were rather than caching an empty list, so the next caller
 * retries instead of the app deciding there are no categories.
 */
export async function loadFinanceCategories() {
  if (allCategories().length) return allCategories();
  if (_inflight) return _inflight;

  const cached = readCache();
  if (cached) setCategories(cached);   // paint from it; the fetch below still refreshes

  _inflight = (async () => {
    const { data, error } = await supabase
      .from('finance_categories')
      .select('key, label, direction, group_label, treatment, hint, sort_order, active')
      .order('sort_order');
    if (error) {
      console.warn('[financeCategories] load failed:', error.message);
      return allCategories();
    }
    setCategories(data || []);
    try { localStorage.setItem(LS_KEY, JSON.stringify(data || [])); } catch { /* quota or private mode */ }
    return allCategories();
  })();

  try { return await _inflight; } finally { _inflight = null; }
}

/**
 * Pickable categories grouped for an <optgroup> list, groups in the order the
 * sort_order puts their first member in.
 */
export function groupedCategories(direction) {
  const groups = [];
  const byLabel = new Map();
  for (const c of categoriesFor(direction)) {
    if (!byLabel.has(c.group_label)) {
      const g = { label: c.group_label, items: [] };
      byLabel.set(c.group_label, g);
      groups.push(g);
    }
    byLabel.get(c.group_label).items.push(c);
  }
  return groups;
}

export const groupOf = (key) => categoryOf(key)?.group_label || 'Other';

/**
 * The treatment to use for a row. Rows carry their own, stamped by the database
 * at write time so that re-categorising the taxonomy cannot restate a reported
 * period; this only resolves it for a row written before 0038.
 */
export const rowTreatment = (row, direction) => row?.treatment || treatmentOf(row?.category, direction);

/** Does this money-in row belong in P&L income? */
export const countsAsIncome = (row) => !row?.document_id && INCOME_TREATMENTS.has(rowTreatment(row, 'in'));
/** Does this money-out row belong in the P&L expense line? */
export const countsAsExpense = (row) => EXPENSE_TREATMENTS.has(rowTreatment(row, 'out'));
/** Money coming back: reduces an expense rather than adding to income. */
export const isCostRecovery = (row) => rowTreatment(row, 'in') === 'cost_recovery';

export default {
  loadFinanceCategories, allCategories, categoriesFor, groupedCategories,
  categoryOf, categoryLabel, groupOf, treatmentOf, rowTreatment,
  countsAsIncome, countsAsExpense, isCostRecovery,
  TREATMENTS, PAYMENT_METHODS, methodLabel,
};
