import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Eye, Send, Save, ArrowLeft } from 'lucide-react';
import { documentStore } from '../../services/documentStore';
import { createPortalLink } from '../../services/portalService';
import { customerService } from '../../services/customerService';
import { useOrg } from '../../context/OrgContext';
import PortalLinkGenerator from '../shared/PortalLinkGenerator';
import ProductPicker from '../shared/ProductPicker';
import { productToLineItem } from '../../services/catalogService';
import CountrySelect from '../shared/CountrySelect';
import { useToast } from '../shared/Toast';
import A4Stage from '../shared/A4Stage';

const GST_RATES = [0, 5, 12, 18, 28];
const ADVANCE_PRESETS = [25, 50, 75, 100];
const UNIT_OPTIONS = ['Nos', 'Hrs', 'Days', 'Months', 'Units', 'Pcs', 'Lots', 'Kg', 'Ltr'];

export default function ProformaInvoiceForm() {
  const navigate = useNavigate();
  const toast = useToast();
  const { activeOrg } = useOrg();
  const savedClients = documentStore.getSavedClients();

  // Build company info from activeOrg (dynamic, not stale localStorage)
  const company = {
    company_name: activeOrg?.company_name || '',
    address: activeOrg?.company_address || activeOrg?.address || '',
    email: activeOrg?.company_email || activeOrg?.email || '',
    phone: activeOrg?.company_phone || activeOrg?.phone || '',
    gstin: activeOrg?.gstin || '',
    logo_url: activeOrg?.logo_url || '',
    stamp_url: activeOrg?.stamp_url || '',
    cin: activeOrg?.cin || '',
    company_tagline: activeOrg?.company_tagline || '',
    company_website: activeOrg?.company_website || '',
    signature_url: activeOrg?.signature_url || '',
    upi_id: activeOrg?.upi_id || '',
    bank_name: activeOrg?.bank_name || '',
    bank_account_number: activeOrg?.bank_account_number || '',
    bank_ifsc: activeOrg?.bank_ifsc || '',
    bank_account_type: activeOrg?.bank_account_type || '',
  };

  const [clientSearch, setClientSearch] = useState('');
  const [showClientDropdown, setShowClientDropdown] = useState(false);
  const clientDropdownRef = useRef(null);
  const [showPortalLink, setShowPortalLink] = useState(false);
  const [savedDocId, setSavedDocId] = useState(null);
  const [portalLink, setPortalLink] = useState(null);

  const [formData, setFormData] = useState(() => ({
    clientName: '',
    clientCompany: '',
    clientAddress: '',
    clientGSTIN: '',
    // ISO alpha-2 -> financial_documents.country_code. Blank defers to the
    // insert trigger, which reads the customer record then the organisation.
    clientCountry: '',
    clientEmail: '',
    clientPhone: '',
    proformaNumber: '', // allocated by the database on save
    date: new Date().toISOString().split('T')[0],
    dueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    advancePercent: 50,
    customAdvancePercent: '',
    isCustomAdvance: false,
    items: [
      { id: Date.now(), description: '', hsnSac: '', quantity: 1, unit: 'Nos', rate: 0, gstRate: 18 },
    ],
    notes: 'This is a proforma invoice and is not valid for GST input tax credit. GST amounts shown are indicative and subject to actuals at the time of invoicing.',
  }));

  // Set Firebase context for cloud sync
  useEffect(() => {
    if (activeOrg?.id) {
      documentStore.setContext(activeOrg.id);
      documentStore.init().catch(() => { });
    }
  }, [activeOrg]);

  // Close client dropdown on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (clientDropdownRef.current && !clientDropdownRef.current.contains(e.target)) {
        setShowClientDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Filtered clients for autocomplete
  const filteredClients = useMemo(() => {
    if (!clientSearch) return savedClients;
    const q = clientSearch.toLowerCase();
    return savedClients.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.person_name || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q)
    );
  }, [clientSearch, savedClients]);

  const handleSelectClient = (client) => {
    // A saved client's name is the billing name (the company); person_name is
    // the contact. An individual carries their name in both.
    const contact = client.person_name || client.name || '';
    const billedCompany = client.person_name && client.person_name !== client.name ? client.name : '';
    setClientSearch(contact);
    setShowClientDropdown(false);
    setFormData((prev) => ({
      ...prev,
      clientName: contact,
      clientCompany: billedCompany,
      clientAddress: client.address || '',
      clientGSTIN: client.gstin || '',
      clientCountry: client.country_code || '',
      clientEmail: client.email || '',
    }));
  };

  const handleClientSearchChange = (value) => {
    setClientSearch(value);
    setShowClientDropdown(value.length > 0 || savedClients.length > 0);
    setFormData((prev) => ({ ...prev, clientName: value }));
  };

  // Active advance percent (resolves custom vs preset)
  const activeAdvancePercent = formData.isCustomAdvance
    ? Number(formData.customAdvancePercent) || 0
    : formData.advancePercent;

  // Per-item calculations
  const itemCalcs = useMemo(() => {
    return formData.items.map((item) => {
      const taxable = (Number(item.quantity) || 0) * (Number(item.rate) || 0);
      const gstAmt = taxable * ((Number(item.gstRate) || 0) / 100);
      const cgst = gstAmt / 2;
      const sgst = gstAmt / 2;
      return { taxable, gstAmt, cgst, sgst };
    });
  }, [formData.items]);

  // Totals
  const totals = useMemo(() => {
    const subtotal = itemCalcs.reduce((sum, c) => sum + c.taxable, 0);
    const totalCGST = itemCalcs.reduce((sum, c) => sum + c.cgst, 0);
    const totalSGST = itemCalcs.reduce((sum, c) => sum + c.sgst, 0);
    const grandTotal = subtotal + totalCGST + totalSGST;
    const advanceAmount = grandTotal * (activeAdvancePercent / 100);
    const balanceDue = grandTotal - advanceAmount;
    return { subtotal, totalCGST, totalSGST, grandTotal, advanceAmount, balanceDue };
  }, [itemCalcs, activeAdvancePercent]);

  // Item handlers
  const handleAddItem = () => {
    setFormData((prev) => ({
      ...prev,
      items: [
        ...prev.items,
        { id: Date.now(), description: '', hsnSac: '', quantity: 1, unit: 'Nos', rate: 0, gstRate: 18 },
      ],
    }));
  };

  const handleRemoveItem = (id) => {
    if (formData.items.length === 1) return;
    setFormData((prev) => ({ ...prev, items: prev.items.filter((item) => item.id !== id) }));
  };

  const handleItemChange = (id, field, value) => {
    let processedValue = value;
    if (['quantity', 'rate', 'gstRate'].includes(field)) {
      processedValue = value === '' ? '' : Number(value);
    }
    setFormData((prev) => ({
      ...prev,
      items: prev.items.map((item) => (item.id === id ? { ...item, [field]: processedValue } : item)),
    }));
  };

  // The catalogue supplies defaults; the line owns them from here. This form is
  // the only one of the three with a per-line GST rate, so it takes the
  // product's tax_rate as well as its HSN and price.
  const handleSelectProduct = (id, product) => {
    setFormData((prev) => ({
      ...prev,
      items: prev.items.map((item) =>
        item.id === id
          ? { ...item, ...productToLineItem(product, { hsn: 'hsnSac', rate: 'rate', tax: 'gstRate' }) }
          : item
      ),
    }));
  };

  const handleClearProduct = (id) => {
    setFormData((prev) => ({
      ...prev,
      items: prev.items.map((item) => (item.id === id ? { ...item, catalog_item_id: null } : item)),
    }));
  };

  // Advance preset handler
  const handleAdvancePreset = (pct) => {
    setFormData((prev) => ({
      ...prev,
      advancePercent: pct,
      isCustomAdvance: false,
      customAdvancePercent: '',
    }));
  };

  const handleCustomAdvance = () => {
    setFormData((prev) => ({
      ...prev,
      isCustomAdvance: true,
      advancePercent: 0,
    }));
  };

  const fmt = (num) => {
    return (num || 0).toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
  };

  // Build a save payload for documentStore
  const buildDocument = (status, customerId = null) => {
    return {
      id: undefined,
      type: 'proforma',
      status,
      // The FK to the client row, resolved by syncCustomer() before the save.
      // Null only when there is no client name to resolve.
      customer_id: customerId,
      title: 'Proforma Invoice',
      issued_by: company.company_name,
      issued_to: formData.clientCompany || formData.clientName,
      company_profile: { ...company },
      client: {
        name: formData.clientName,
        company: formData.clientCompany,
        address: formData.clientAddress,
        gstin: formData.clientGSTIN,
        email: formData.clientEmail,
      },
      proforma_number: formData.proformaNumber,
      date: formData.date,
      // Picked by hand, so it overrides whatever the trigger would infer.
      country_code: formData.clientCountry || undefined,
      country_source: formData.clientCountry ? 'manual' : undefined,
      due_date: formData.dueDate,
      advance_percent: activeAdvancePercent,
      advance_amount: totals.advanceAmount,
      balance_due: totals.balanceDue,
      items: formData.items.map((item, i) => ({
        description: item.description,
        hsn_sac: item.hsnSac,
        quantity: Number(item.quantity) || 0,
        unit: item.unit,
        rate: Number(item.rate) || 0,
        gstRate: Number(item.gstRate) || 0,
        // A proforma requests an advance rather than recording a sale, so this
        // does not reach Product Performance yet; it has to persist so the
        // invoice raised from it inherits the attribution.
        catalog_item_id: item.catalog_item_id || null,
        taxable: itemCalcs[i].taxable,
        cgst: itemCalcs[i].cgst,
        sgst: itemCalcs[i].sgst,
      })),
      subtotal: totals.subtotal,
      total_cgst: totals.totalCGST,
      total_sgst: totals.totalSGST,
      grand_total: totals.grandTotal,
      notes: formData.notes,
      created_at: new Date().toISOString(),
    };
  };

  // Now awaited and run BEFORE the save, and it returns the client row's id so
  // the document can carry customer_id. It used to be fire-and-forget after the
  // save with the id discarded, which is why financial_documents.customer_id was
  // null on every proforma.
  const syncCustomer = async () => {
    if (!activeOrg?.id || !(formData.clientName || formData.clientCompany)) return null;
    try {
      const row = await customerService.upsert(activeOrg.id, {
        clientName: formData.clientCompany || formData.clientName,
        person_name: formData.clientName || '',
        clientEmail: formData.clientEmail || '',
        clientAddress: formData.clientAddress || '',
        buyerGSTIN: formData.clientGSTIN || '',
        country_code: formData.clientCountry || '',
      });
      return row?.id || null;
    } catch {
      // A failed client upsert must not block saving the proforma; the document
      // simply keeps a null FK and falls back to the name match.
      return null;
    }
  };

  const handleSaveDraft = async () => {
    const customerId = await syncCustomer();
    await documentStore.save(buildDocument('draft', customerId));
    toast('Proforma invoice saved as draft', 'success');
    navigate('/proforma');
  };

  const handleSendToClient = async () => {
    if (!formData.clientName && !formData.clientCompany) {
      toast('Please fill in client details before sending', 'warning');
      return;
    }
    // The row id and the document number are assigned by the database, so the
    // save has to complete before there is anything to link to.
    const customerId = await syncCustomer();
    const doc = await documentStore.save(buildDocument('sent', customerId));
    documentStore.addNotification({
      type: 'proforma_sent',
      title: 'Proforma Invoice Sent',
      message: `${doc.doc_number || formData.proformaNumber} sent to ${formData.clientCompany || formData.clientName}`,
    });

    let issued;
    try {
      issued = await createPortalLink({
        orgId: activeOrg?.id,
        documentId: doc.id,
        recipientEmail: formData.clientEmail,
      });
    } catch (err) {
      toast('Saved, but the portal link could not be created: ' + err.message, 'error');
      return;
    }
    const portalUrl = issued.url;

    // Open WhatsApp with pre-filled message
    const phone = (formData.clientPhone || '').replace(/[^0-9+]/g, '');
    const message = `Hi ${formData.clientName},\n\nPlease find your proforma invoice *${doc.id}* from *${company.company_name}*.\n\nTotal: ₹${totals.grandTotal.toLocaleString('en-IN')}\nAdvance (${activeAdvancePercent}%): ₹${totals.advanceAmount.toLocaleString('en-IN')}\nDue: ${formData.dueDate}\n\nView & respond here:\n${portalUrl}\n\nThank you!`;
    const waUrl = `https://wa.me/${phone.replace('+', '')}?text=${encodeURIComponent(message)}`;
    window.open(waUrl, '_blank');

    setSavedDocId(doc.id);
    setPortalLink(issued);
    setShowPortalLink(true);
    toast('Proforma sent — WhatsApp opened', 'success');
    setTimeout(() => navigate('/proforma'), 2000);
  };

  return (
    <div className="mou-split-layout">
      {/* LEFT: Form */}
      <div className="mou-form-pane">
        <form onSubmit={(e) => e.preventDefault()} className="easy-form animate-in" style={{ maxWidth: '100%' }}>
          {/* Header with Back button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
            <button
              type="button"
              onClick={() => navigate('/proforma')}
              style={{
                background: 'none', border: '1px solid var(--border-default)', borderRadius: '8px',
                padding: '0.5rem 0.75rem', cursor: 'pointer', color: 'var(--text-secondary)',
                fontSize: '0.8rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem'
              }}
            >
              <ArrowLeft size={16} /> Back
            </button>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>New Proforma Invoice</h2>
          </div>

          {/* 1. Client Details */}
          <div className="easy-section">
            <div className="easy-section-head">
              <div className="easy-num">1</div>
              <span className="easy-section-title">Client details</span>
            </div>
            <div className="easy-row">
              <div className="easy-field" ref={clientDropdownRef} style={{ position: 'relative' }}>
                <label className="easy-lbl">Client name</label>
                <input aria-label="Client name"
                  type="text"
                  placeholder="Search or type client name..."
                  value={clientSearch || formData.clientName}
                  onChange={(e) => handleClientSearchChange(e.target.value)}
                  onFocus={() => setShowClientDropdown(true)}
                  className="easy-inp"
                  autoComplete="off"
                />
                {showClientDropdown && filteredClients.length > 0 && (
                  <div className="customer-dropdown">
                    {filteredClients.map((c) => (
                      <div key={c.id} className="customer-dropdown-item" onClick={() => handleSelectClient(c)}>
                        <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>{c.name}</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          {[c.person_name !== c.name && c.person_name, c.email].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Client company</label>
                <input aria-label="Client company"
                  type="text"
                  placeholder="Company name"
                  value={formData.clientCompany}
                  onChange={(e) => setFormData({ ...formData, clientCompany: e.target.value })}
                  className="easy-inp"
                />
              </div>
              <div className="easy-field full">
                <label className="easy-lbl">Client address</label>
                <input aria-label="Client address"
                  type="text"
                  placeholder="Full billing address"
                  value={formData.clientAddress}
                  onChange={(e) => setFormData({ ...formData, clientAddress: e.target.value })}
                  className="easy-inp"
                />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Client GSTIN</label>
                <input aria-label="Client GSTIN"
                  type="text"
                  placeholder="22AAAAA0000A1Z5"
                  value={formData.clientGSTIN}
                  onChange={(e) => setFormData({ ...formData, clientGSTIN: e.target.value.toUpperCase() })}
                  className="easy-inp"
                  maxLength={15}
                  style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}
                />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Client country</label>
                <CountrySelect ariaLabel="Client country"
                  value={formData.clientCountry}
                  placeholder="From customer record"
                  onChange={(code) => setFormData({ ...formData, clientCountry: code || '' })}
                />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Client email</label>
                <input aria-label="Client email"
                  type="email"
                  placeholder="billing@client.com"
                  value={formData.clientEmail}
                  onChange={(e) => setFormData({ ...formData, clientEmail: e.target.value })}
                  className="easy-inp"
                />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Client phone (WhatsApp)</label>
                <input aria-label="Client phone (WhatsApp)"
                  type="tel"
                  placeholder="+91 98765 43210"
                  value={formData.clientPhone}
                  onChange={(e) => setFormData({ ...formData, clientPhone: e.target.value })}
                  className="easy-inp"
                />
              </div>
            </div>
          </div>

          {/* 2. Proforma Details */}
          <div className="easy-section">
            <div className="easy-section-head">
              <div className="easy-num">2</div>
              <span className="easy-section-title">Proforma details</span>
            </div>
            <div className="easy-row">
              <div className="easy-field">
                <label className="easy-lbl">Proforma number</label>
                <input aria-label="Proforma number"
                  type="text"
                  value={formData.proformaNumber}
                  onChange={(e) => setFormData({ ...formData, proformaNumber: e.target.value })}
                  className="easy-inp"
                  style={{ fontWeight: 700 }}
                />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Date</label>
                <input aria-label="Date"
                  type="date"
                  value={formData.date}
                  onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                  className="easy-inp"
                />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Due date</label>
                <input aria-label="Due date"
                  type="date"
                  value={formData.dueDate}
                  onChange={(e) => setFormData({ ...formData, dueDate: e.target.value })}
                  className="easy-inp"
                />
              </div>
              <div className="easy-field full">
                <label className="easy-lbl">Advance required</label>
                <div className="easy-chips">
                  {ADVANCE_PRESETS.map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => handleAdvancePreset(pct)}
                      aria-pressed={!!(!formData.isCustomAdvance && formData.advancePercent === pct)} className={`easy-chip ${!formData.isCustomAdvance && formData.advancePercent === pct ? 'active' : ''}`}
                    >
                      {pct}%
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={handleCustomAdvance}
                    aria-pressed={!!formData.isCustomAdvance} className={`easy-chip ${formData.isCustomAdvance ? 'active' : ''}`}
                  >
                    Custom
                  </button>
                </div>
                {formData.isCustomAdvance && (
                  <div style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      placeholder="Enter %"
                      value={formData.customAdvancePercent}
                      onChange={(e) =>
                        setFormData({ ...formData, customAdvancePercent: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })
                      }
                      className="easy-inp"
                      style={{ width: '90px', textAlign: 'center' }}
                    />
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>%</span>
                  </div>
                )}
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Advance amount</label>
                <div style={{ padding: '0.625rem 0', fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9375rem' }}>
                  {fmt(totals.advanceAmount)}
                </div>
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Balance due</label>
                <div style={{ padding: '0.625rem 0', fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9375rem' }}>
                  {fmt(totals.balanceDue)}
                </div>
              </div>
            </div>
          </div>

          {/* 3. Line Items */}
          <div className="easy-section">
            <div className="easy-section-head">
              <div className="easy-num">3</div>
              <span className="easy-section-title">Line items</span>
            </div>

            {formData.items.map((item, index) => {
              const calc = itemCalcs[index];
              return (
                <div key={item.id} className="easy-line-item">
                  <div className="easy-line-num">{index + 1}</div>
                  <div className="easy-line-fields">
                    <div style={{ marginBottom: '0.5rem' }}>
                      <ProductPicker
                        linkedId={item.catalog_item_id}
                        onSelect={(p) => handleSelectProduct(item.id, p)}
                        onClear={() => handleClearProduct(item.id)}
                      />
                    </div>
                    <div className="easy-line-top">
                      <input aria-label="Item description"
                        type="text"
                        placeholder="Item description..."
                        value={item.description}
                        onChange={(e) => handleItemChange(item.id, 'description', e.target.value)}
                        className="easy-inp"
                      />
                      <input aria-label="HSN/SAC code"
                        type="text"
                        placeholder="HSN/SAC"
                        value={item.hsnSac}
                        onChange={(e) => handleItemChange(item.id, 'hsnSac', e.target.value)}
                        className="easy-inp"
                        style={{ maxWidth: '120px' }}
                      />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0.625rem' }}>
                      <div>
                        <label className="easy-lbl-sm">Qty</label>
                        <input aria-label="Qty"
                          type="number"
                          value={item.quantity}
                          min="1"
                          onChange={(e) => handleItemChange(item.id, 'quantity', e.target.value)}
                          className="easy-inp"
                        />
                      </div>
                      <div>
                        <label className="easy-lbl-sm">Unit</label>
                        <select aria-label="Unit"
                          value={item.unit}
                          onChange={(e) => handleItemChange(item.id, 'unit', e.target.value)}
                          className="easy-inp"
                        >
                          {UNIT_OPTIONS.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="easy-lbl-sm">Rate</label>
                        <input aria-label="Rate"
                          type="number"
                          value={item.rate}
                          min="0"
                          onChange={(e) => handleItemChange(item.id, 'rate', e.target.value)}
                          className="easy-inp"
                        />
                      </div>
                      <div>
                        <label className="easy-lbl-sm">GST Rate</label>
                        <select aria-label="GST Rate"
                          value={item.gstRate}
                          onChange={(e) => handleItemChange(item.id, 'gstRate', e.target.value)}
                          className="easy-inp"
                        >
                          {GST_RATES.map((r) => (
                            <option key={r} value={r}>
                              {r}%
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.625rem', marginTop: '0.5rem' }}>
                      <div>
                        <label className="easy-lbl-sm">Taxable</label>
                        <div className="easy-line-amount">{fmt(calc.taxable)}</div>
                      </div>
                      <div>
                        <label className="easy-lbl-sm" style={{ color: 'var(--text-secondary)' }}>CGST</label>
                        <div className="easy-line-amount" style={{ color: 'var(--text-primary)' }}>{fmt(calc.cgst)}</div>
                      </div>
                      <div>
                        <label className="easy-lbl-sm" style={{ color: 'var(--text-secondary)' }}>SGST</label>
                        <div className="easy-line-amount" style={{ color: 'var(--text-primary)' }}>{fmt(calc.sgst)}</div>
                      </div>
                    </div>
                  </div>
                  <button type="button" onClick={() => handleRemoveItem(item.id)} className="easy-delete-btn" title="Remove" aria-label="Remove">
                    <Trash2 size={16} />
                  </button>
                </div>
              );
            })}

            <button type="button" onClick={handleAddItem} className="easy-add-btn">
              <Plus size={16} /> Add item
            </button>
          </div>

          {/* 4. Totals */}
          <div className="easy-section">
            <div className="easy-section-head">
              <div className="easy-num">4</div>
              <span className="easy-section-title">Totals</span>
            </div>

            <div className="easy-totals">
              <div className="easy-total-row">
                <span>Subtotal</span>
                <strong>{fmt(totals.subtotal)}</strong>
              </div>

              <div className="easy-total-divider" />

              <div className="easy-total-row" style={{ color: 'var(--text-secondary)' }}>
                <span>Total CGST</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{fmt(totals.totalCGST)}</span>
              </div>
              <div className="easy-total-row" style={{ color: 'var(--text-secondary)' }}>
                <span>Total SGST</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{fmt(totals.totalSGST)}</span>
              </div>

              <div className="easy-total-divider" />

              <div className="easy-total-row easy-total-grand">
                <span style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)' }}>
                  Grand Total
                </span>
                <span>{fmt(totals.grandTotal)}</span>
              </div>

              <div className="easy-total-divider" />

              <div className="easy-total-row" style={{ color: 'var(--success)' }}>
                <span>Advance ({activeAdvancePercent}%)</span>
                <span style={{ fontWeight: 600 }}>{fmt(totals.advanceAmount)}</span>
              </div>
              <div className="easy-total-row" style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                <span>Balance due</span>
                <span>{fmt(totals.balanceDue)}</span>
              </div>
            </div>
          </div>

          {/* 5. Notes */}
          <div className="easy-section">
            <div className="easy-section-head">
              <div className="easy-num">5</div>
              <span className="easy-section-title">Notes</span>
            </div>
            <div className="easy-field">
              <label className="easy-lbl">Notes / terms</label>
              <textarea aria-label="Notes / terms"
                placeholder="Additional notes, payment terms, bank details..."
                rows={5}
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                className="easy-inp"
                style={{ resize: 'vertical' }}
              />
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem', lineHeight: 1.5 }}>
              Note is pre-filled with GST disclaimer. Edit as needed.
            </p>
          </div>

          {/* 6. Actions */}
          <div className="form-actions">
            <button type="button" onClick={handleSaveDraft} className="easy-submit-outline">
              <Save size={16} /> Save Draft
            </button>
            <button
              type="button"
              onClick={handleSendToClient}
              className="easy-submit"
            >
              <Send size={16} /> Send to client
            </button>
          </div>

          {/* Portal Link Generator */}
          {showPortalLink && savedDocId && (
            <div style={{ marginTop: '1.5rem' }}>
              <PortalLinkGenerator documentId={savedDocId} documentType="proforma" link={portalLink} />
            </div>
          )}

        </form>
      </div>

      {/* RIGHT: Live Preview */}
      <div className="mou-preview-pane">
        <div className="mou-preview-toolbar">
          <span className="mou-preview-toolbar-label">Live Preview</span>
          <button type="button" className="easy-submit-outline" style={{ padding: '0.375rem 0.875rem', fontSize: '0.75rem', width: 'auto' }}>
            <Eye size={14} /> Preview
          </button>
        </div>
        <A4Stage>
          <ProformaPreview formData={formData} totals={totals} itemCalcs={itemCalcs} company={company} activeAdvancePercent={activeAdvancePercent} />
        </A4Stage>
      </div>
    </div>
  );
}


/* ─────────────────────────────────────
   INLINE LIVE A4 PREVIEW COMPONENT
   ───────────────────────────────────── */

function ProformaPreview({ formData, totals, itemCalcs, company, activeAdvancePercent }) {
  const fmtDate = (dateStr) => {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  return (
    <div className="a4-sheet inv-preview" style={{ fontSize: '10pt' }}>
      {/* Company Header */}
      <div style={{ textAlign: 'center', marginBottom: '8px' }}>
        <div style={{ fontSize: '16pt', fontWeight: 700, color: '#0f172a', marginBottom: '2px' }}>
          {company.company_name}
        </div>
        <div style={{ fontSize: '8pt', color: '#64748b', lineHeight: 1.6 }}>
          {company.address}
          <br />
          {company.email} | {company.phone}
          {company.gstin && (
            <>
              <br />
              GSTIN: {company.gstin}
            </>
          )}
        </div>
      </div>

      <div className="inv-header-divider" style={{ margin: '16px 0' }} />

      {/* Title */}
      <div className="inv-header">
        <div className="inv-header-title">PROFORMA INVOICE</div>
        <div className="inv-header-number">{formData.proformaNumber || ''}</div>
      </div>

      {/* Bill To / Meta */}
      <div className="inv-parties">
        <div className="inv-party-col">
          <div className="inv-party-label">BILL TO</div>
          <div className="inv-party-name">{formData.clientName || formData.clientCompany || 'Client Name'}</div>
          {formData.clientCompany && formData.clientName && (
            <div className="inv-party-detail">{formData.clientCompany}</div>
          )}
          {formData.clientAddress && <div className="inv-party-detail">{formData.clientAddress}</div>}
          {formData.clientEmail && <div className="inv-party-detail">{formData.clientEmail}</div>}
          {formData.clientGSTIN && <div className="inv-party-detail">GSTIN: {formData.clientGSTIN}</div>}
        </div>
        <div className="inv-party-col inv-party-right">
          <div className="inv-party-label">DETAILS</div>
          <div className="inv-party-detail">Date: {fmtDate(formData.date)}</div>
          <div className="inv-party-detail">Due Date: {fmtDate(formData.dueDate)}</div>
          <div className="inv-party-detail">Advance: {activeAdvancePercent}%</div>
        </div>
      </div>

      {/* Dates Bar */}
      <div className="inv-dates-bar">
        <span>Proforma Date: {fmtDate(formData.date)}</span>
        <span>Due: {fmtDate(formData.dueDate)}</span>
        <span style={{ color: '#f59e0b', fontWeight: 600 }}>Advance: {activeAdvancePercent}%</span>
      </div>

      {/* Items Table */}
      <table className="inv-table">
        <thead>
          <tr>
            <th className="inv-th-left" style={{ textAlign: 'left' }}>Description</th>
            <th>HSN/SAC</th>
            <th>Qty</th>
            <th>Unit</th>
            <th>Rate</th>
            <th>GST%</th>
            <th>Taxable</th>
            <th>CGST</th>
            <th>SGST</th>
            <th className="inv-th-right" style={{ textAlign: 'right' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {formData.items.map((item, i) => {
            const c = itemCalcs[i];
            const lineTotal = c.taxable + c.cgst + c.sgst;
            return (
              <tr key={item.id}>
                <td style={{ textAlign: 'left' }}>{item.description || '-'}</td>
                <td className="inv-td-muted">{item.hsnSac || '-'}</td>
                <td>{item.quantity || 0}</td>
                <td className="inv-td-muted">{item.unit}</td>
                <td>{'\u20B9'}{(Number(item.rate) || 0).toLocaleString('en-IN')}</td>
                <td>{item.gstRate}%</td>
                <td>{'\u20B9'}{c.taxable.toLocaleString('en-IN')}</td>
                <td style={{ color: '#3b82f6', fontSize: '8pt' }}>{'\u20B9'}{c.cgst.toLocaleString('en-IN')}</td>
                <td style={{ color: '#3b82f6', fontSize: '8pt' }}>{'\u20B9'}{c.sgst.toLocaleString('en-IN')}</td>
                <td className="inv-td-amount">{'\u20B9'}{lineTotal.toLocaleString('en-IN')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Totals */}
      <div className="inv-totals">
        <div className="inv-total-row">
          <span>Subtotal:</span>
          <span>{'\u20B9'}{totals.subtotal.toLocaleString('en-IN')}</span>
        </div>
        <div className="inv-total-divider" />
        <div className="inv-total-row inv-total-gst">
          <span>Total CGST:</span>
          <span>{'\u20B9'}{totals.totalCGST.toLocaleString('en-IN')}</span>
        </div>
        <div className="inv-total-row inv-total-gst">
          <span>Total SGST:</span>
          <span>{'\u20B9'}{totals.totalSGST.toLocaleString('en-IN')}</span>
        </div>
        <div className="inv-total-divider inv-total-divider-bold" />
        <div className="inv-total-row inv-total-grand">
          <span>GRAND TOTAL:</span>
          <span>{'\u20B9'}{totals.grandTotal.toLocaleString('en-IN')}</span>
        </div>

        <div className="inv-total-divider" />

        <div className="inv-total-row" style={{ color: '#059669' }}>
          <span>Advance ({activeAdvancePercent}%):</span>
          <span>{'\u20B9'}{totals.advanceAmount.toLocaleString('en-IN')}</span>
        </div>
        <div className="inv-total-row" style={{ fontWeight: 700, color: '#d97706' }}>
          <span>Balance Due:</span>
          <span>{'\u20B9'}{totals.balanceDue.toLocaleString('en-IN')}</span>
        </div>
      </div>

      {/* Notes */}
      <div className="inv-notes">
        <div className="inv-notes-label">NOTES:</div>
        <div className="inv-notes-text" style={{ whiteSpace: 'pre-wrap' }}>
          {formData.notes || ''}
        </div>
      </div>

      {/* Disclaimer */}
      <div style={{
        marginTop: '24px',
        padding: '10px 12px',
        background: '#fffbeb',
        border: '1px solid #fde68a',
        borderRadius: '4px',
        fontSize: '7.5pt',
        color: '#92400e',
        lineHeight: 1.5,
      }}>
        <strong>Important:</strong> This is a Proforma Invoice and is not a demand for payment. It is not valid for GST input tax credit.
        GST amounts shown herein are indicative and subject to actuals at the time of actual invoicing.
      </div>

      {/* Footer */}
      <div className="inv-footer">
        This is a computer-generated proforma invoice. Generated via StartupBuddy.
      </div>
    </div>
  );
}
