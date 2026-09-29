import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { documentStore } from '../../services/documentStore';
import { createPortalLink } from '../../services/portalService';
import { customerService } from '../../services/customerService';
import { useOrg } from '../../context/OrgContext';
import ProductPicker from '../shared/ProductPicker';
import { productToLineItem } from '../../services/catalogService';
import CountrySelect from '../shared/CountrySelect';
import { useToast } from '../shared/Toast';
import A4Stage from '../shared/A4Stage';
import DocSteps, { Step } from '../shared/DocSteps';

const GST_RATES = [0, 5, 12, 18, 28];
const ADVANCE_PRESETS = [25, 50, 75, 100];
const UNIT_OPTIONS = ['Nos', 'Hrs', 'Days', 'Months', 'Units', 'Pcs', 'Lots', 'Kg', 'Ltr'];

/** A saved proforma back into the form's shape. Drafts saved from this form
 *  carry the form itself (`editor_form`); older ones are rebuilt from the row. */
function formFromDoc(doc) {
  if (doc.editor_form && typeof doc.editor_form === 'object') return doc.editor_form;
  const c = doc.client || {};
  const pct = Number(doc.advance_percent);
  const preset = [25, 50, 75, 100].includes(pct);
  return {
    clientName: c.name || doc.bill_to_name || doc.issued_to || '',
    clientCompany: c.company || '',
    clientAddress: c.address || doc.bill_to_address || '',
    clientGSTIN: c.gstin || doc.bill_to_gstin || '',
    clientCountry: doc.country_code || '',
    clientEmail: c.email || doc.bill_to_email || '',
    clientPhone: '',
    proformaNumber: doc.doc_number || '',
    date: String(doc.date || doc.issue_date || '').slice(0, 10) || new Date().toISOString().split('T')[0],
    dueDate: String(doc.due_date || '').slice(0, 10),
    advancePercent: preset ? pct : 50,
    customAdvancePercent: preset || Number.isNaN(pct) ? '' : pct,
    isCustomAdvance: !preset && !Number.isNaN(pct),
    items: (doc.items || []).length ? doc.items.map((it, i) => ({
      id: Date.now() + i, description: it.description || '', hsnSac: it.hsn || it.hsn_sac || '',
      quantity: Number(it.quantity) || 1, unit: it.unit || 'Nos', rate: Number(it.rate) || 0,
      gstRate: Number(it.gst_rate ?? doc.gst_rate ?? 18), catalog_item_id: it.catalog_item_id || null,
    })) : [{ id: Date.now(), description: '', hsnSac: '', quantity: 1, unit: 'Nos', rate: 0, gstRate: 18 }],
    notes: doc.notes || '',
  };
}

export default function ProformaInvoiceForm({ editDocId = null }) {
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
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');

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

  // Set Firebase context for cloud sync — and, editing a draft, load it.
  useEffect(() => {
    if (!activeOrg?.id) return undefined;
    let cancelled = false;
    documentStore.setContext(activeOrg.id);
    documentStore.init().catch(() => { }).then(() => {
      if (cancelled || !editDocId) return;
      const doc = documentStore.getById(editDocId);
      if (!doc || doc.type !== 'proforma') { setLoadError('This proforma could not be found.'); return; }
      setFormData(formFromDoc(doc));
    });
    return () => { cancelled = true; };
  }, [activeOrg?.id, editDocId]);

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
      ...(status === 'draft' ? { editor_form: formData } : {}),
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

  // Editing a draft saves into it; a new one is inserted.
  const persist = (status, customerId) => (editDocId
    ? documentStore.saveEdit(editDocId, buildDocument(status, customerId), { send: status === 'sent' }).then((r) => r.doc)
    : documentStore.save(buildDocument(status, customerId)));

  const handleSaveDraft = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const customerId = await syncCustomer();
      await persist('draft', customerId);
      toast('Proforma saved as a draft. Open it in Money to carry on.', 'success');
      navigate('/money/invoices?type=proforma');
    } catch (err) {
      toast(err.message || 'Could not save the proforma', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSendToClient = async () => {
    if (saving) return;
    setSaving(true);
    // The row id and the document number are assigned by the database, so the
    // save has to complete before there is anything to link to.
    let doc;
    try {
      const customerId = await syncCustomer();
      doc = await persist('sent', customerId);
    } catch (err) {
      toast(err.message || 'Could not create the proforma', 'error');
      setSaving(false);
      return;
    }
    documentStore.addNotification({
      type: 'proforma_sent',
      title: 'Proforma Invoice Sent',
      message: `${doc.doc_number || formData.proformaNumber} sent to ${formData.clientCompany || formData.clientName}`,
    });

    // With a phone number, WhatsApp opens with the message and the link ready.
    const phone = (formData.clientPhone || '').replace(/[^0-9]/g, '');
    if (phone) {
      try {
        const issued = await createPortalLink({ orgId: activeOrg?.id, documentId: doc.id, recipientEmail: formData.clientEmail });
        const message = `Hi ${formData.clientName},\n\nPlease find your proforma invoice *${doc.doc_number || ''}* from *${company.company_name}*.\n\nTotal: ₹${totals.grandTotal.toLocaleString('en-IN')}\nAdvance (${activeAdvancePercent}%): ₹${totals.advanceAmount.toLocaleString('en-IN')}\nDue: ${formData.dueDate}\n\nView & respond here:\n${issued.url}\n\nThank you!`;
        window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank', 'noopener');
      } catch (err) {
        toast('Created, but the client link could not be made: ' + err.message, 'error');
      }
    }
    setSaving(false);
    toast(doc.doc_number ? `Proforma ${doc.doc_number} created` : 'Proforma created', 'success');
    // Its sheet in Money has the PDF, the client link and conversion.
    navigate(`/money/invoices?doc=${doc.id}`);
  };

  return (
    <div className="mou-split-layout">
      {/* LEFT: Form */}
      <div className="mou-form-pane">
        <form onSubmit={(e) => e.preventDefault()} className="easy-form animate-in" style={{ maxWidth: '100%' }}>
          {loadError && <p className="sb-steps-err" role="alert">{loadError}</p>}

          <DocSteps
            onDraft={handleSaveDraft}
            onCreate={handleSendToClient}
            createLabel={saving ? 'Creating…' : 'Create proforma'}
            busy={saving}
            finalNote={(formData.clientPhone || '').replace(/[^0-9]/g, '')
              ? 'WhatsApp opens with the proforma and its link, ready to send.'
              : 'It opens in Money, where you can download the PDF or share a link with the client.'}
          >
          {/* 1. Client Details */}
          <Step title="Client" validate={() => (String(formData.clientName || formData.clientCompany || '').trim() ? '' : "Enter the client's name.")}>
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
          </Step>

          <Step title="Billing">
            <div className="easy-row">
              <div className="easy-field full">
                <label className="easy-lbl">Billing address</label>
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
            </div>
            <span className="sb-hint" style={{ marginTop: 12 }}>All optional. The GSTIN and country decide how GST is shown.</span>
          </Step>

          {/* 2. Proforma Details */}
          <Step title="Proforma details">
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
            </div>
          </Step>

          {/* 3. Line Items */}
          <Step title="Items" validate={() => (formData.items.some((i) => String(i.description || '').trim()) ? '' : 'Add at least one item with a description.')}>

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
          </Step>

          {/* 4. Totals */}
          <Step title="Advance & totals">
            <div className="easy-row" style={{ marginBottom: 14 }}>
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
          </Step>

          {/* 5. Notes */}
          <Step title="Notes">
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
          </Step>

          </DocSteps>
        </form>
      </div>

      {/* RIGHT: Live Preview */}
      <div className="mou-preview-pane">
        <div className="mou-preview-toolbar">
          <span className="mou-preview-toolbar-label">Live Preview</span>
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
