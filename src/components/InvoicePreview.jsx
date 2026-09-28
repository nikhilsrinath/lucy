import DocumentHeader from './DocumentHeader';
import StampPreview from './StampPreview';

const SaffronOrnaments = {
  Top: () => (
    <div className="inv-sf-ornament-top">
      <svg className="ornament-svg" viewBox="0 0 660 90" xmlns="http://www.w3.org/2000/svg" fill="none">
        <g stroke="#2a1e0a" strokeWidth="1.5" fill="none">
          <line x1="20" y1="10" x2="640" y2="10" />
          <line x1="20" y1="82" x2="640" y2="82" />
          <path d="M20,10 C10,10 4,16 4,26 C4,38 12,44 20,44 C28,44 34,38 34,30 C34,22 28,18 22,18 C16,18 13,22 13,27 C13,32 16,35 20,35" />
          <circle cx="7" cy="48" r="2" fill="#2a1e0a" />
          <path d="M20,82 C10,82 4,76 4,66 C4,54 12,48 20,48 C28,48 34,54 34,62 C34,70 28,74 22,74 C16,74 13,70 13,65 C13,60 16,57 20,57" />
          <path d="M640,10 C650,10 656,16 656,26 C656,38 648,44 640,44 C632,44 626,38 626,30 C626,22 632,18 638,18 C644,18 647,22 647,27 C647,32 644,35 640,35" />
          <circle cx="653" cy="48" r="2" fill="#2a1e0a" />
          <path d="M640,82 C650,82 656,76 656,66 C656,54 648,48 640,48 C632,48 626,54 626,62 C626,70 632,74 638,74 C644,74 647,70 647,65 C647,60 644,57 640,57" />
          <path d="M260,10 C260,10 280,10 300,22 C310,28 320,36 330,36 C340,36 350,28 360,22 C380,10 400,10 400,10" />
          <path d="M180,46 C175,42 170,44 168,48 C166,52 168,56 172,57 C176,58 180,55 181,51" /><path d="M180,46 C183,40 190,38 196,42" />
          <path d="M480,46 C485,42 490,44 492,48 C494,52 492,56 488,57 C484,58 480,55 479,51" /><path d="M480,46 C477,40 470,38 464,42" />
          <path d="M260,82 C260,82 280,82 300,70 C310,64 320,56 330,56 C340,56 350,64 360,70 C380,82 400,82 400,82" />
          <circle cx="220" cy="46" r="2.5" fill="#2a1e0a" /><circle cx="440" cy="46" r="2.5" fill="#2a1e0a" /><circle cx="330" cy="14" r="2" fill="#2a1e0a" /><circle cx="330" cy="78" r="2" fill="#2a1e0a" />
        </g>
      </svg>
    </div>
  ),
  HeaderBottom: () => (
    <div className="inv-sf-ornament-header-bottom">
      <svg viewBox="0 0 300 30" width="300" height="30" xmlns="http://www.w3.org/2000/svg" fill="none">
        <g stroke="#2a1e0a" strokeWidth="1.4" fill="none">
          <path d="M10,15 C20,5 35,5 45,15 C55,25 70,25 80,15" /><path d="M290,15 C280,5 265,5 255,15 C245,25 230,25 220,15" />
          <line x1="80" y1="15" x2="130" y2="15" /><line x1="220" y1="15" x2="170" y2="15" />
          <path d="M140,9 L150,15 L140,21 L130,15 Z" /><path d="M160,9 L170,15 L160,21 L150,15 Z" />
          <circle cx="150" cy="15" r="2" fill="#2a1e0a" />
        </g>
      </svg>
    </div>
  ),
  Divider: () => (
    <div className="arrow-divider" style={{ display: 'flex', justifyContent: 'center', margin: '20px 0' }}>
      <svg viewBox="0 0 160 18" width="160" height="18" xmlns="http://www.w3.org/2000/svg" fill="none">
        <g stroke="#2a1e0a" strokeWidth="1.3" fill="none">
          <line x1="0" y1="9" x2="56" y2="9" /><polyline points="56,4 70,9 56,14" fill="#2a1e0a" stroke="#2a1e0a" />
          <polyline points="104,4 90,9 104,14" fill="#2a1e0a" stroke="#2a1e0a" /><line x1="104" y1="9" x2="160" y2="9" />
        </g>
      </svg>
    </div>
  ),
  Footer: () => (
    <div className="ornament-footer" style={{ display: 'flex', justifyContent: 'center', margin: '20px 0' }}>
      <svg viewBox="0 0 220 36" width="220" height="36" xmlns="http://www.w3.org/2000/svg" fill="none">
        <g stroke="#2a1e0a" strokeWidth="1.4" fill="none">
          <path d="M10,18 C15,8 28,6 36,14 C40,18 38,26 32,28 C26,30 20,26 22,20 C24,14 30,14 32,18" />
          <path d="M210,18 C205,8 192,6 184,14 C180,18 182,26 188,28 C194,30 200,26 198,20 C196,14 190,14 188,18" />
          <line x1="50" y1="18" x2="90" y2="18" /><line x1="130" y1="18" x2="170" y2="18" />
          <path d="M90,10 C100,4 110,10 110,18 C110,26 120,32 130,26" /><path d="M90,26 C100,32 110,26 110,18 C110,10 120,4 130,10" /><circle cx="110" cy="18" r="2.5" fill="#2a1e0a" />
        </g>
      </svg>
    </div>
  )
};

export default function InvoicePreview({ formData, totals, isInterState }) {
  if (formData.templateId === 'saffron') {
    return (
      <div className="inv-saffron-wrapper">
        <div className="inv-saffron-page" id="invoice-capture-area">
          <div className="inv-saffron-content">
            <SaffronOrnaments.Top />
            <div className="inv-sf-company-name">{formData.orgName || 'Your Organization'}</div>
            <div style={{ display: 'flex', justifyContent: 'center' }}><SaffronOrnaments.HeaderBottom /></div>

            <div className="inv-sf-company-address">
              {formData.companyAddress}<br />
              {formData.contactEmail} | {formData.contactPhone}
              {formData.sellerGSTIN && <div>GSTIN: {formData.sellerGSTIN}</div>}
            </div>

            <SaffronOrnaments.Divider />

            <div className="inv-sf-billing-row" style={{ marginTop: '24px', alignItems: 'flex-start' }}>
              <div className="inv-sf-bill-col" style={{ flex: '1.5' }}>
                <div className="inv-sf-col-label">Bill To</div>
                <div className="inv-sf-col-value">
                  <div style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px' }}>{formData.clientName || 'Client Name'}</div>
                  <div style={{ opacity: 0.9, lineHeight: '1.6' }}>{formData.clientAddress || 'Address not specified'}</div>
                  <div style={{ opacity: 0.8, marginTop: '4px' }}>{formData.clientEmail}</div>
                  {formData.buyerGSTIN && <div style={{ fontSize: '0.8rem', marginTop: '10px', borderTop: '1px solid rgba(42,30,10,0.15)', paddingTop: '6px', display: 'inline-block' }}>GSTIN: {formData.buyerGSTIN}</div>}
                </div>
              </div>
              <div className="inv-sf-bill-col meta" style={{ flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                <table className="inv-sf-meta-table">
                  <tbody>
                    <tr>
                      <td className="inv-sf-meta-label">Invoice Date</td>
                      <td className="inv-sf-meta-val">{formData.invoiceDate}</td>
                    </tr>
                    <tr>
                      <td className="inv-sf-meta-label">Payment Status</td>
                      <td className="inv-sf-meta-val">{formData.isPaid ? <span style={{ color: '#16a34a', fontWeight: 700 }}>PAID</span> : (formData.dueDate ? `Due: ${formData.dueDate}` : 'UNPAID')}</td>
                    </tr>
                    {formData.buyerState && (
                      <tr>
                        <td className="inv-sf-meta-label">Place of Supply</td>
                        <td className="inv-sf-meta-val">{formData.buyerState}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="inv-sf-invoice-number" style={{ borderTop: '1px solid #3a2a10', borderBottom: '1px solid #3a2a10', padding: '10px 0', margin: '24px 0', textAlign: 'center', letterSpacing: '1px' }}>
              DOCUMENT #&nbsp; <span style={{ fontSize: '20px', fontWeight: 700 }}>{formData.invoiceNumber}</span>
            </div>

            <table className="inv-sf-items-table">
              <thead>
                <tr>
                  <th style={{ width: '60px' }}>QTY</th>
                  <th style={{ textAlign: 'left' }}>DESCRIPTION</th>
                  <th style={{ width: '120px', textAlign: 'right' }}>UNIT PRICE</th>
                  <th style={{ width: '110px', textAlign: 'right' }}>AMOUNT</th>
                </tr>
              </thead>
              <tbody>
                {formData.items.map((item, i) => (
                  <tr key={i}>
                    <td style={{ textAlign: 'center' }}>{item.quantity}</td>
                    <td>{item.description || '-'}</td>
                    <td style={{ textAlign: 'right' }}>{item.price?.toLocaleString()}</td>
                    <td style={{ textAlign: 'right' }}>{(item.quantity * item.price).toLocaleString()}</td>
                  </tr>
                ))}

                {/* Summary Rows */}
                <tr>
                  <td colSpan="2" style={{ border: 'none' }}></td>
                  <td style={{ textAlign: 'right', fontSize: '12px' }}>Subtotal</td>
                  <td style={{ textAlign: 'right' }}>{totals.subtotal.toLocaleString()}</td>
                </tr>
                {formData.gstRate > 0 && (
                  <tr>
                    <td colSpan="2" style={{ border: 'none' }}></td>
                    <td style={{ textAlign: 'right', fontSize: '12px' }}>GST {formData.gstRate}%</td>
                    <td style={{ textAlign: 'right' }}>{(totals.cgst + totals.sgst + totals.igst).toLocaleString()}</td>
                  </tr>
                )}
                <tr className="inv-sf-tr-total">
                  <td colSpan="2" style={{ border: 'none' }}></td>
                  <td style={{ textAlign: 'right', textTransform: 'uppercase' }}>Total</td>
                  <td style={{ textAlign: 'right' }}>₹{totals.grandTotal.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>

            <SaffronOrnaments.Footer />

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
              <div className="inv-sf-terms" style={{ flex: 1 }}>
                <div className="inv-sf-terms-title">Terms & Conditions</div>
                <div className="inv-sf-terms-body" style={{ whiteSpace: 'pre-wrap' }}>
                  {formData.notes || 'Payment is due within the stipulated time.'}
                </div>
              </div>
              <div className="inv-sf-signature" style={{ width: '160px', textAlign: 'right' }}>
                {formData.showStamp && (
                  <div style={{ marginBottom: '10px' }}>
                    {formData.stampType === 'uploaded' && formData.stampUrl ? (
                      <img src={formData.stampUrl} alt="Stamp" style={{ maxHeight: '80px', maxWidth: '140px' }} />
                    ) : (
                      formData.stampType === 'generated' && <StampPreview companyName={formData.companyName} city={formData.stampCity} size={60} />
                    )}
                  </div>
                )}
                <div style={{ borderTop: '1px solid #3a2a10', paddingTop: '5px', fontSize: '11px', fontWeight: 600 }}>
                  Authorized Signatory
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="a4-sheet inv-preview" id="invoice-capture-area">
      {/* Company Header */}
      <DocumentHeader formData={formData} />

      <div className="inv-header-divider" />

      {/* Navy Header */}
      <div className="inv-header">
        <div className="inv-header-title">{formData.gstRate > 0 ? 'TAX INVOICE' : 'INVOICE'}</div>
        <div className="inv-header-number">{formData.invoiceNumber || ''}</div>
      </div>

      {/* FROM / BILL TO */}
      <div className="inv-parties">
        <div className="inv-party-col">
          <div className="inv-party-label">FROM</div>
          <div className="inv-party-name">{formData.orgName || 'Your Organization'}</div>
          {formData.sellerGSTIN && <div className="inv-party-detail">GSTIN: {formData.sellerGSTIN}</div>}
          {formData.sellerState && <div className="inv-party-detail">State: {formData.sellerState}</div>}
        </div>
        <div className="inv-party-col inv-party-right">
          <div className="inv-party-label">BILL TO</div>
          <div className="inv-party-name">{formData.clientName || 'Client Name'}</div>
          {formData.clientEmail && <div className="inv-party-detail">{formData.clientEmail}</div>}
          {formData.clientAddress && <div className="inv-party-detail">{formData.clientAddress}</div>}
          {formData.buyerGSTIN && <div className="inv-party-detail">GSTIN: {formData.buyerGSTIN}</div>}
          {formData.buyerState && <div className="inv-party-detail">State: {formData.buyerState}</div>}
        </div>
      </div>

      {/* Dates Bar */}
      <div className="inv-dates-bar">
        <span>Invoice Date: {formData.invoiceDate || '-'}</span>
        {formData.gstRate > 0 && formData.sellerState && formData.buyerState && (
          <span>Supply Type: {isInterState ? 'Inter-State' : 'Intra-State'}</span>
        )}
        {!formData.isPaid ? (
          <span>Due Date: {formData.dueDate || '-'}</span>
        ) : (
          <span className="inv-paid-badge">PAID</span>
        )}
      </div>

      {/* Table & Others (Standard Template) ... omitted for brevity in replace_file_content if possible, 
          actually I should probably keep it all to avoid errors */}

      {/* Items Table */}
      <table className="inv-table">
        <thead>
          <tr>
            <th className="inv-th-left">Description</th>
            {formData.gstRate > 0 && <th>HSN/SAC</th>}
            <th>Qty</th>
            <th>Rate</th>
            <th className="inv-th-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {(formData.items || []).map((item, i) => {
            const lineTotal = (Number(item.quantity) || 0) * (Number(item.price) || 0);
            return (
              <tr key={i}>
                <td>{item.description || '-'}</td>
                {formData.gstRate > 0 && <td className="inv-td-muted">{item.hsnCode || '-'}</td>}
                <td>{item.quantity || 0}</td>
                <td>{'\u20B9'}{(item.price || 0).toLocaleString()}</td>
                <td className="inv-td-amount">{'\u20B9'}{lineTotal.toLocaleString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Totals */}
      <div className="inv-totals">
        <div className="inv-total-row">
          <span>Subtotal:</span>
          <span>{'\u20B9'}{(totals.subtotal || 0).toLocaleString()}</span>
        </div>
        {formData.discountRate > 0 && (
          <div className="inv-total-row" style={{ color: '#ef4444' }}>
            <span>Discount ({formData.discountRate}%):</span>
            <span>-{'\u20B9'}{(totals.discountAmount || 0).toLocaleString()}</span>
          </div>
        )}
        <div className="inv-total-row">
          <span>Taxable Amount:</span>
          <span>{'\u20B9'}{(totals.taxableAmount || 0).toLocaleString()}</span>
        </div>
        {formData.gstRate > 0 && (
          <>
            <div className="inv-total-divider" />
            {isInterState ? (
              <div className="inv-total-row inv-total-gst">
                <span>IGST @ {formData.gstRate || 0}%:</span>
                <span>{'\u20B9'}{(totals.igst || 0).toLocaleString()}</span>
              </div>
            ) : (
              <>
                <div className="inv-total-row inv-total-gst">
                  <span>CGST @ {(formData.gstRate || 0) / 2}%:</span>
                  <span>{'\u20B9'}{(totals.cgst || 0).toLocaleString()}</span>
                </div>
                <div className="inv-total-row inv-total-gst">
                  <span>SGST @ {(formData.gstRate || 0) / 2}%:</span>
                  <span>{'\u20B9'}{(totals.sgst || 0).toLocaleString()}</span>
                </div>
              </>
            )}
          </>
        )}
        <div className="inv-total-divider inv-total-divider-bold" />
        <div className="inv-total-row inv-total-grand">
          <span>TOTAL AMOUNT:</span>
          <span>{'\u20B9'}{(totals.grandTotal || 0).toLocaleString()}</span>
        </div>
      </div>

      {formData.notes && (
        <div className="inv-notes">
          <div className="inv-notes-label">NOTES / TERMS:</div>
          <div className="inv-notes-text">{formData.notes}</div>
        </div>
      )}

      {formData.showStamp && (
        <div className="inv-stamp-float">
          {formData.stampType === 'uploaded' && formData.stampUrl ? (
            <img src={formData.stampUrl} alt="Company Stamp" className="doc-stamp-img" />
          ) : formData.stampType === 'generated' && formData.companyName ? (
            <StampPreview companyName={formData.companyName} city={formData.stampCity} size={65} />
          ) : null}
        </div>
      )}

      <div className="inv-footer">
        This is a computer-generated invoice. Generated via StartupBuddy.
      </div>
    </div>
  );
}
