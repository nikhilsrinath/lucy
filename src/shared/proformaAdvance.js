// What a proforma asks for up front, derived from the columns every time.
//
// The proforma form used to save `advance_amount` / `balance_due` into the
// payload as figures of the moment, and "Convert to Proforma" saved neither,
// so the client portal read ₹0 for the advance. The only stored fact is
// financial_documents.advance_percent; the amounts follow from it and the
// trigger-computed grand_total.

/** The form's default, and what a proforma with no percentage recorded asks for. */
export const DEFAULT_ADVANCE_PERCENT = 50;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {object} doc  a financial document (grand_total, advance_percent, amount_paid)
 * @returns {{ percent: number, total: number, advance: number, balance: number,
 *             paid: number, advanceDue: number }}
 *   advance     the advance the proforma asks for
 *   balance     what is left for the tax invoice on delivery
 *   advanceDue  the part of the advance not yet received (confirmed payments only)
 */
export function advanceOf(doc = {}) {
  const raw = doc.advance_percent ?? doc.advancePercent;
  const percent = Math.min(100, Math.max(0,
    raw === null || raw === undefined || raw === '' ? DEFAULT_ADVANCE_PERCENT : Number(raw) || 0));
  const total = round2(doc.grand_total ?? doc.total ?? doc.amount);
  const advance = round2(total * percent / 100);
  const paid = round2(doc.amount_paid);
  return {
    percent,
    total,
    advance,
    balance: round2(total - advance),
    paid,
    advanceDue: round2(Math.max(0, advance - paid)),
  };
}

// Portal response fields: what a client did to ONE document. A document built
// from another (quotation → proforma → invoice) must start without them, or it
// arrives already "accepted" and "signed" by someone who never saw it.
export const RESPONSE_KEYS = [
  'first_viewed_at', 'last_viewed_at', 'responded_at', 'sent_at',
  'accepted_by', 'accepted_at', 'signed_at', 'candidate_name', 'candidate_signature',
  'signature_path', 'signature_method', 'decline_reason', 'revision_notes',
  'payment_confirmation', 'verified_at', 'payment_rejected', 'rejection_reason',
  'acknowledged_by', 'acknowledged_at', 'reminder_count', 'last_reminder_at',
  'converted_to', 'converted_from_version_id',
  'current_version_id', 'locked_version_id', 'payments', 'amount_paid',
  'advance_amount', 'balance_due',
];

/** A copy of `doc` with every response field removed, ready to become a new document. */
export function withoutResponses(doc) {
  const copy = { ...doc };
  for (const key of RESPONSE_KEYS) delete copy[key];
  return copy;
}
