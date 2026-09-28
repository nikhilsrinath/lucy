import { documentStore, docNumber as docNo } from '../services/documentStore';
import { orgStore } from '../services/orgStore';
import { invoiceReminderService } from '../services/invoiceReminderService';
import { createPortalLink } from '../services/portalService';
import { advanceOf } from '../services/proformaAdvance';
import { buildConversion, carriedAdvance, existingConversion } from '../services/documentConversion';
import { lifecycleOf, revertedStatusOf, isCarriedAdvance } from '../services/documentLifecycle';
import { esc, safeImageUrl } from '../utils/htmlEscape';

/* ══════════════════════════════════════════════════════════════════════════
   What can be done to an invoice, quotation or proforma — moved here, with
   the same writes in the same order, from the old InvoiceList screen so the
   new document sheet can use them. Each returns a message (or throws) instead
   of raising a toast itself. The rules they follow are unchanged and live
   where they always did:
     documentLifecycle.js   what may be deleted or cancelled, and why not
     documentConversion.js  quotation → proforma → invoice
     the database           totals, amount paid, paid / partially_paid
   ══════════════════════════════════════════════════════════════════════════ */

export const typeLabel = (type) => ({ invoice: 'Invoice', quotation: 'Quotation', proforma: 'Proforma invoice' }[type] || 'Document');

/**
 * Marking paid means recording the money, not setting a flag: paid /
 * partially_paid and amount_paid are derived by the database from payments.
 */
export async function recordPayment(doc, { amount, method = 'Manual entry', note = 'Recorded from the document', reference = null, paidOn = null } = {}) {
    const outstanding = documentStore.outstandingOf(doc);
    const amt = amount === undefined ? outstanding : Number(amount);
    if (!(amt > 0)) throw new Error('Enter an amount greater than zero.');
    if (outstanding <= 0) return 'This invoice is already fully paid.';
    await documentStore.recordPayment(doc.id, { amount: amt, method, note, reference, paidOn });
    return amt >= outstanding - 0.009 ? 'Payment recorded. The invoice is paid.' : 'Payment recorded.';
}

/** An admin confirming a payment the client submitted through the portal. */
export async function verifyPayment(doc) {
    const id = doc.id;
    const pending = documentStore.getPendingPayment(id);
    // Written first, while the status is still whatever the portal set.
    await documentStore.updateMeta(id, { verified_at: new Date().toISOString() });
    if (pending) {
        await documentStore.confirmPayment(pending.id, id);
    } else {
        const claimed = Number(doc?.payment_confirmation?.amountPaid) || 0;
        await documentStore.recordPayment(id, {
            amount: claimed > 0 ? claimed : documentStore.outstandingOf(doc),
            method: doc?.payment_confirmation?.paymentMethod || 'Portal confirmation',
            reference: doc?.payment_confirmation?.transactionId || null,
            paidOn: doc?.payment_confirmation?.paymentDate || null,
            bySubmitter: true,
        });
    }
    // On a proforma the money is the advance, and advance_paid unlocks the invoice.
    if (doc?.type === 'proforma') {
        const after = documentStore.getById(id);
        if (after && after.status !== 'paid' && after.status !== 'advance_paid') {
            await documentStore.updateStatus(id, 'advance_paid');
        }
    }
    return doc?.type === 'proforma' ? 'Advance verified and recorded.' : 'Payment verified and recorded.';
}

export async function rejectPayment(doc, reason = '') {
    const pending = documentStore.getPendingPayment(doc.id);
    if (pending) await documentStore.deletePayment(pending.id, doc.id);
    await documentStore.updateStatus(doc.id, doc?.type === 'proforma' ? 'order_confirmed' : 'sent', {
        payment_rejected: true,
        rejection_reason: reason,
    });
    return 'Payment confirmation rejected.';
}

/** Emails the client a reminder now (their Gmail, via /api/email). */
export async function sendReminder(doc) {
    const res = await invoiceReminderService.send(doc);
    if (!res.success) throw new Error(res.message || 'The reminder could not be sent.');
    return res.message || 'Reminder sent.';
}

/** A signed link to the client's view of this document (mints a portal token). */
export async function portalLink(doc) {
    const recipientEmail = doc.clientEmail || doc.client?.email || undefined;
    return createPortalLink({ orgId: orgStore.getOrgId(), documentId: doc.id, recipientEmail });
}

/**
 * Quotation → proforma / invoice, proforma → invoice, in an order that
 * survives a failure halfway: reuse a document already built from this source,
 * carry a proforma's advance as a payment, then mark the source converted.
 */
export async function convert(source, target, opts = {}) {
    let built = existingConversion(source, documentStore.getAll());
    const resumed = !!built;
    if (!built) built = await documentStore.save(buildConversion(source, target, opts));

    const advance = source.type === 'proforma' ? carriedAdvance(source) : null;
    if (advance && !(built.payments || []).some((p) => p.method === advance.method && p.reference === advance.reference)) {
        await documentStore.recordPayment(built.id, advance);
    }
    try {
        await documentStore.updateStatus(source.id, 'converted', { converted_to: built.id });
    } catch (err) {
        if (/SOURCE_NOT_LOCKED/.test(err.message || '')) throw new Error('The client has not accepted this version yet, so it cannot be converted.');
        throw err;
    }
    const label = built.type === 'proforma' ? 'proforma' : 'invoice';
    return {
        built,
        message: resumed
            ? `${docNo(source)} was already converted to ${label} ${docNo(built)}. Marked converted.`
            : `Converted to ${label} ${docNo(built)}${advance ? ` with ₹${advance.amount.toLocaleString('en-IN')} advance applied` : ''}.`,
    };
}

/** The document this one came from goes back to where it was, so it can be converted again. */
async function releaseParent(doc) {
    if (!doc.converted_from) return null;
    const parent = documentStore.getById(doc.converted_from);
    const status = revertedStatusOf(parent);
    if (!status) return null;
    await documentStore.updateStatus(parent.id, status, { converted_to: null });
    return parent;
}

export const lifecycle = (doc) => lifecycleOf(doc, documentStore.getAll());

/** Deletes a draft that was never sent. */
export async function deleteDraft(doc) {
    const rule = lifecycle(doc).delete;
    if (!rule.allowed) throw new Error(rule.reason);
    await documentStore.delete(doc.id);
    const parent = await releaseParent(doc);
    return parent ? `Deleted. ${docNo(parent)} can be converted again.` : `${docNo(doc) || 'Draft'} deleted.`;
}

/** Cancels an issued document; an invoice keeps its number. */
export async function cancelDocument(doc, reason = '') {
    const rule = lifecycle(doc).cancel;
    if (!rule.allowed) throw new Error(rule.reason);
    const parent = doc.converted_from ? documentStore.getById(doc.converted_from) : null;
    for (const p of (doc.payments || []).filter((row) => isCarriedAdvance(row, parent))) {
        await documentStore.deletePayment(p.id, doc.id);
    }
    await documentStore.updateStatus(doc.id, 'cancelled');
    const released = await releaseParent(doc);
    const why = reason.trim();
    Promise.resolve(documentStore.addNotification({
        type: 'document_cancelled',
        title: `${typeLabel(doc.type)} Cancelled`,
        message: `${docNo(doc)} for ${doc.issued_to || doc.clientName || 'client'} cancelled${why ? ` — ${why}` : ''}`,
        documentId: doc.id,
    })).catch(() => {});
    return released ? `${docNo(doc)} cancelled. ${docNo(released)} can be converted again.` : `${docNo(doc)} cancelled.`;
}

/** The PDF the list always produced: the document drawn off-screen, then captured. */
export async function downloadPdf(doc, activeOrg) {
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
    const company = {
        company_name: activeOrg?.company_name || '',
        company_address: activeOrg?.company_address || activeOrg?.address || '',
        company_email: activeOrg?.company_email || activeOrg?.email || '',
        company_phone: activeOrg?.company_phone || activeOrg?.phone || '',
        company_website: activeOrg?.company_website || '',
        gstin: activeOrg?.gstin || '',
        cin: activeOrg?.cin || '',
        logo_url: activeOrg?.logo_url || '',
        stamp_url: activeOrg?.stamp_url || '',
        company_tagline: activeOrg?.company_tagline || '',
    };
    const docTypeLabel = doc.type === 'proforma' ? 'Proforma_Invoice' : doc.type === 'quotation' ? 'Quotation' : 'Tax_Invoice';
    const titleText = doc.type === 'proforma' ? 'PROFORMA INVOICE' : doc.type === 'quotation' ? 'QUOTATION' : (doc.gstRate > 0 || doc.gst > 0) ? 'TAX INVOICE' : 'INVOICE';
    const subtotal = doc.subtotal || 0;
    const gstRate = Number(doc.gst_rate ?? doc.gstRate) || 0;
    const gstAmount = Number(doc.gst_amount ?? doc.gst) || 0;
    const halfRate = gstRate / 2;
    const cgst = gstAmount / 2;
    const sgst = gstAmount / 2;
    const grandTotal = doc.grand_total || doc.amount || subtotal;
    const discountAmt = doc.discount?.amount || 0;
    const taxableAmount = subtotal - discountAmt;
    const isPaid = doc.status === 'paid';
    const advance = doc.type === 'proforma' ? advanceOf(doc) : null;

    // String-built markup assigned to innerHTML: every value goes through esc()
    // and every image URL through safeImageUrl().
    const logoUrl = safeImageUrl(company.logo_url);
    const stampUrl = safeImageUrl(company.stamp_url);
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;top:0;width:794px;min-width:794px;max-width:794px;';
    container.innerHTML = `
      <div class="a4-sheet inv-preview" style="box-shadow:none;border:none;">
        <div class="doc-header">
          <div class="doc-header-left">
            ${logoUrl ? `<img src="${logoUrl}" alt="Logo" class="doc-header-logo" />` : ''}
            ${company.company_tagline ? `<div class="doc-header-tagline">${esc(company.company_tagline)}</div>` : ''}
          </div>
          <div class="doc-header-right">
            <div class="doc-header-name">${esc((company.company_name || doc.issued_by || '').toUpperCase())}</div>
            ${company.cin ? `<div class="doc-header-detail">CIN: ${esc(company.cin)}</div>` : ''}
            ${company.company_address ? `<div class="doc-header-detail">${esc(company.company_address)}</div>` : ''}
            ${company.company_email ? `<div class="doc-header-detail">${esc(company.company_email)}</div>` : ''}
            ${company.company_phone ? `<div class="doc-header-detail">${esc(company.company_phone)}</div>` : ''}
            ${company.company_website ? `<div class="doc-header-detail">${esc(company.company_website)}</div>` : ''}
          </div>
        </div>
        <div class="inv-header-divider"></div>
        <div class="inv-header">
          <div class="inv-header-title">${esc(titleText)}${doc.status === 'cancelled' ? ' <span style="color:#dc2626">— CANCELLED</span>' : ''}</div>
          <div class="inv-header-number">${esc(docNo(doc))}</div>
        </div>
        <div class="inv-parties">
          <div class="inv-party-col">
            <div class="inv-party-label">FROM</div>
            <div class="inv-party-name">${esc(company.company_name || doc.issued_by || '')}</div>
            ${company.gstin ? `<div class="inv-party-detail">GSTIN: ${esc(company.gstin)}</div>` : ''}
          </div>
          <div class="inv-party-col inv-party-right">
            <div class="inv-party-label">BILL TO</div>
            <div class="inv-party-name">${esc(doc.issued_to || doc.client?.name || '')}</div>
            ${doc.client?.email ? `<div class="inv-party-detail">${esc(doc.client.email)}</div>` : ''}
            ${doc.client?.address ? `<div class="inv-party-detail">${esc(doc.client.address)}</div>` : ''}
            ${doc.client?.gstin ? `<div class="inv-party-detail">GSTIN: ${esc(doc.client.gstin)}</div>` : ''}
          </div>
        </div>
        <div class="inv-dates-bar">
          <span>${doc.type === 'quotation' ? 'Date' : 'Invoice Date'}: ${esc(doc.issue_date || '-')}</span>
          ${isPaid ? '<span class="inv-paid-badge">PAID</span>' : `<span>${doc.type === 'quotation' ? 'Valid Until' : 'Due Date'}: ${esc(doc.valid_until || doc.due_date || '-')}</span>`}
        </div>
        <table class="inv-table">
          <thead><tr>
            <th class="inv-th-left">Description</th>
            ${gstRate > 0 ? '<th>HSN/SAC</th>' : ''}
            <th>Qty</th><th>Rate</th><th class="inv-th-right">Amount</th>
          </tr></thead>
          <tbody>
            ${(doc.items || []).map((item) => {
        const lineTotal = (Number(item.quantity) || 0) * (Number(item.rate) || Number(item.price) || 0);
        return `<tr>
                <td>${esc(item.description || '-')}</td>
                ${gstRate > 0 ? `<td class="inv-td-muted">${esc(item.hsnSac || item.hsnCode || '-')}</td>` : ''}
                <td>${esc(item.quantity || 0)}</td>
                <td>₹${(Number(item.rate) || Number(item.price) || 0).toLocaleString('en-IN')}</td>
                <td class="inv-td-amount">₹${lineTotal.toLocaleString('en-IN')}</td>
              </tr>`;
    }).join('')}
          </tbody>
        </table>
        <div class="inv-totals">
          <div class="inv-total-row"><span>Subtotal:</span><span>₹${subtotal.toLocaleString('en-IN')}</span></div>
          ${discountAmt > 0 ? `<div class="inv-total-row" style="color:#ef4444"><span>Discount (${doc.discount?.type === 'percentage' ? `${esc(doc.discount.value)}%` : 'flat'}):</span><span>-₹${discountAmt.toLocaleString('en-IN')}</span></div>` : ''}
          <div class="inv-total-row"><span>Taxable Amount:</span><span>₹${taxableAmount.toLocaleString('en-IN')}</span></div>
          ${gstRate > 0 ? `
            <div class="inv-total-divider"></div>
            <div class="inv-total-row inv-total-gst"><span>CGST @ ${halfRate}%:</span><span>₹${cgst.toLocaleString('en-IN')}</span></div>
            <div class="inv-total-row inv-total-gst"><span>SGST @ ${halfRate}%:</span><span>₹${sgst.toLocaleString('en-IN')}</span></div>
          ` : ''}
          <div class="inv-total-divider inv-total-divider-bold"></div>
          <div class="inv-total-row inv-total-grand"><span>${doc.type === 'proforma' ? 'ORDER VALUE' : 'TOTAL AMOUNT'}:</span><span>₹${grandTotal.toLocaleString('en-IN')}</span></div>
          ${advance && advance.percent > 0 ? `
            <div class="inv-total-row"><span>Advance payable now (${advance.percent}%):</span><span>₹${advance.advance.toLocaleString('en-IN')}</span></div>
            <div class="inv-total-row"><span>Balance on delivery:</span><span>₹${advance.balance.toLocaleString('en-IN')}</span></div>
          ` : ''}
        </div>
        ${doc.type === 'proforma' ? '<div class="inv-notes"><div class="inv-notes-text">This is a proforma invoice issued to confirm the order. It is not a tax invoice and cannot be used to claim input tax credit.</div></div>' : ''}
        ${doc.terms || doc.payment_instructions ? `
          <div class="inv-notes">
            <div class="inv-notes-label">NOTES / TERMS:</div>
            <div class="inv-notes-text">${esc(doc.terms || doc.payment_instructions || '')}</div>
          </div>` : ''}
        ${stampUrl ? `<div class="inv-stamp-float"><img src="${stampUrl}" alt="Company Stamp" class="doc-stamp-img" /></div>` : ''}
        <div class="inv-footer">
          This is a computer-generated ${doc.type === 'quotation' ? 'quotation' : doc.type === 'proforma' ? 'proforma invoice' : 'invoice'}. Generated via EdgeOS.
        </div>
      </div>`;
    document.body.appendChild(container);
    await new Promise((r) => setTimeout(r, 300));
    try {
        const canvas = await html2canvas(container.firstElementChild, {
            scale: 2, useCORS: true, allowTaint: true, backgroundColor: '#fff', width: 794, windowWidth: 794,
        });
        const imgData = canvas.toDataURL('image/png');
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pdfW = pdf.internal.pageSize.getWidth();
        const pdfH = pdf.internal.pageSize.getHeight();
        const totalH = pdfW * (canvas.height / canvas.width);
        if (totalH <= pdfH) {
            pdf.addImage(imgData, 'PNG', 0, 0, pdfW, totalH);
        } else {
            const pageCanvasH = Math.floor(canvas.width * (pdfH / pdfW));
            let yOffset = 0;
            let page = 0;
            while (yOffset < canvas.height) {
                const sliceH = Math.min(pageCanvasH, canvas.height - yOffset);
                const pageCanvas = document.createElement('canvas');
                pageCanvas.width = canvas.width;
                pageCanvas.height = sliceH;
                pageCanvas.getContext('2d').drawImage(canvas, 0, -yOffset);
                if (page > 0) pdf.addPage();
                pdf.addImage(pageCanvas.toDataURL('image/png'), 'PNG', 0, 0, pdfW, (sliceH / canvas.width) * pdfW);
                yOffset += pageCanvasH;
                page++;
            }
        }
        const clientName = (doc.issued_to || doc.client?.name || 'Client').replace(/\s+/g, '_');
        pdf.save(`${docTypeLabel}_${docNo(doc)}_${clientName}.pdf`);
    } finally {
        document.body.removeChild(container);
    }
}
