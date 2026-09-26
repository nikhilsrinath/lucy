// Maps the agent's document payload (api/_lib/agent/tools/finance.js docPreview)
// onto the props InvoicePreview reads, so the card draws the real invoice.

/** The agent's document payload in the shape InvoicePreview reads. */
export function toInvoiceForm(doc) {
    return {
        formData: {
            clientName: doc.client?.name || '', clientEmail: doc.client?.email || '',
            clientAddress: doc.client?.address || '', buyerGSTIN: doc.client?.gstin || '',
            buyerState: doc.client?.state || '',
            invoiceNumber: doc.number, invoiceDate: doc.issueDate, dueDate: doc.dueDate || '',
            sellerGSTIN: '', sellerState: '',
            gstRate: doc.gstRate, discountRate: doc.discountRate || 0,
            items: (doc.items || []).map((it, i) => ({
                id: i + 1, description: it.description, hsnCode: it.hsn || '', quantity: it.quantity, price: it.rate,
            })),
            notes: doc.notes || '',
            orgName: doc.company?.name || '', companyName: doc.company?.name || '',
            companyAddress: doc.company?.address || '', contactEmail: doc.company?.email || '',
            contactPhone: doc.company?.phone || '', stampCity: doc.company?.city || '',
            stampType: 'generated', showStamp: false, isPaid: false, templateId: 'standard',
        },
        totals: doc.totals,
        isInterState: !!doc.isInterState,
    };
}
