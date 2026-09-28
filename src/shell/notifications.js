/* Where a portal notification leads — the same targets the old top bar's
   bell used (they are legacy paths; the redirect table moves each one to its
   new screen once that screen exists). */
export function notificationTarget(n) {
    if (n.type === 'quotation_accepted' && n.financial_doc_id) return `/projects/new?fromQuotation=${n.financial_doc_id}`;
    if (n.project_id) return `/projects/${n.project_id}`;
    switch (n.type) {
        case 'offer_signed':
        case 'role_change_acknowledged':
        case 'termination_acknowledged':
            return '/offer-tracker';
        case 'document_declined':
            return n.document_id?.startsWith('OL') ? '/offer-tracker' : null;
        case 'quotation_accepted':
        case 'quotation_sent':
        case 'revision_requested':
            return '/quotations';
        case 'payment_submitted':
            return '/invoices';
        case 'order_confirmed':
        case 'advance_submitted':
            return '/proforma';
        default:
            return null;
    }
}
