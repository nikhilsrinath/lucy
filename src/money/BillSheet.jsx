import React, { useState } from 'react';
import { orgStore } from '../services/orgStore';
import { receiptService } from '../services/receiptService';
import { TAX_RATES } from '../services/catalogService';
import { friendlyError } from '../services/projectService';
import { confirmDialog } from '../services/confirm';
import { Sheet, Button, Field, Card } from '../design/ui';
import { inr } from '../chat/brief';
import { ReceiptInput } from './EntrySheet';

/* ══════════════════════════════════════════════════════════════════════════
   A vendor bill — purchase_invoices through orgStore, as the old Purchase
   Bills page saved it. Vendors and bills are one list now: the vendor is a
   field, and a new one is added right here (vendors, through orgStore).
   The total, tax and status are the database's (from subtotal and rate).
   ══════════════════════════════════════════════════════════════════════════ */

const CATEGORIES = ['Operations', 'Inventory', 'Software', 'Hardware', 'Marketing', 'Travel', 'Utilities', 'Professional fees', 'Rent', 'Other'];
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

const addDays = (isoDate, days) => {
    const d = new Date(`${isoDate}T00:00:00`);
    d.setDate(d.getDate() + (Number(days) || 0));
    return d.toISOString().slice(0, 10);
};
export default function BillSheet({ bill, vendors, onClose, notify }) {
    const [b, setB] = useState(bill);
    const [touchedDue, setTouchedDue] = useState(!!bill.id);
    const [newVendor, setNewVendor] = useState(null);
    const [pay, setPay] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const byId = Object.fromEntries(vendors.map((v) => [v.id, v]));
    const isNew = !bill.id;
    const balance = Math.max(0, (Number(b.total) || 0) - (Number(b.amount_paid) || 0));

    const set = (k, v) => setB((x) => {
        const next = { ...x, [k]: v };
        // A vendor's terms fill the due date unless one was typed.
        if ((k === 'vendor_id' || k === 'bill_date') && !touchedDue) {
            const vendor = byId[next.vendor_id];
            if (vendor && next.bill_date) next.due_date = addDays(next.bill_date, vendor.payment_terms_days);
        }
        return next;
    });
    const tax = Math.round((Number(b.subtotal) || 0) * (Number(b.tax_rate) || 0)) / 100;

    const save = async () => {
        let vendorId = b.vendor_id;
        setError('');
        if (newVendor) {
            const gstin = (newVendor.gstin || '').trim().toUpperCase();
            if (!newVendor.company_name.trim()) { setError('Name the vendor.'); return; }
            if (gstin && !GSTIN_RE.test(gstin)) { setError('GSTIN must be 15 letters and digits.'); return; }
        } else if (!vendorId) { setError('Choose a vendor.'); return; }
        if (!b.bill_number.trim()) { setError('Bill number is required.'); return; }
        setSaving(true);
        try {
            if (newVendor) {
                const v = await orgStore.addItem('vendors', { ...newVendor, gstin: (newVendor.gstin || '').trim().toUpperCase() });
                vendorId = v.id;
            }
            const { total: _t, tax_amount: _ta, status: _s, ...row } = { ...b, vendor_id: vendorId };
            if (b.id) await orgStore.updateItem('purchase_invoices', b.id, row);
            else await orgStore.addItem('purchase_invoices', row);
            notify?.(b.id ? 'Bill updated.' : 'Bill recorded.');
            onClose();
        } catch (err) {
            setError(err.code === '23505' ? 'This vendor already has a bill with that number.' : (friendlyError(err).message || 'Could not save the bill.'));
        } finally { setSaving(false); }
    };

    const recordPay = async () => {
        const amt = Number(pay);
        if (!(amt > 0)) return;
        const paid = Math.min(Number(b.total) || 0, (Number(b.amount_paid) || 0) + amt);
        try {
            await orgStore.updateItem('purchase_invoices', b.id, { amount_paid: paid });
            notify?.(paid >= (Number(b.total) || 0) - 0.01 ? 'Bill marked as paid.' : 'Payment recorded.');
            onClose();
        } catch (err) { setError(`Could not record the payment: ${err.message}`); }
    };
    const voidBill = async () => {
        if (!(await confirmDialog({ title: 'Void bill', message: `Void bill ${b.bill_number}? It will be left out of payables, P&L and tax.`, confirmLabel: 'Void' }))) return;
        try { await orgStore.updateItem('purchase_invoices', b.id, { status: 'void' }); notify?.('Bill voided.'); onClose(); }
        catch (err) { setError(err.message); }
    };
    const remove = async () => {
        if (!(await confirmDialog({ title: 'Delete bill', message: `Delete bill ${b.bill_number}? This cannot be undone.` }))) return;
        try { await orgStore.removeItem('purchase_invoices', b.id); receiptService.remove(b.receipt_path); notify?.('Bill deleted.'); onClose(); }
        catch (err) { setError(`Could not delete: ${err.message}`); }
    };

    const canDelete = !isNew && orgStore.can('purchase_invoices', 'delete');
    const active = vendors.filter((v) => !v.archived_at);

    return (
        <Sheet open onClose={onClose} className="nb-sheet" title={isNew ? 'New bill' : `Bill ${b.bill_number}`}
            footer={(
                <>
                    {canDelete && <Button variant="danger" onClick={remove}>Delete</Button>}
                    <Button variant="primary" block onClick={save} disabled={saving}>{saving ? 'Saving…' : isNew ? 'Record bill' : 'Save changes'}</Button>
                </>
            )}>
            {error && <div className="sb-err" role="alert">{error}</div>}

            {!isNew && b.status !== 'void' && balance > 0.009 && (
                <Card style={{ padding: 16 }}>
                    <div className="sb-inline">
                        <Field label="Record a payment (₹)" hint={`${inr(balance)} still to pay`}>
                            <input type="number" inputMode="decimal" min="0.01" step="0.01" value={pay} onChange={(e) => setPay(e.target.value)} />
                        </Field>
                        <Button onClick={recordPay} disabled={!(Number(pay) > 0)}>Record</Button>
                        <Button variant="ghost" onClick={() => setPay(String(balance))}>Full</Button>
                    </div>
                </Card>
            )}

            {newVendor ? (
                <Card style={{ padding: '4px 16px 16px' }}>
                    <Field label="New vendor"><input value={newVendor.company_name} data-autofocus onChange={(e) => setNewVendor((v) => ({ ...v, company_name: e.target.value }))} /></Field>
                    <div className="sb-grid2">
                        <Field label="GSTIN"><input value={newVendor.gstin} maxLength={15} onChange={(e) => setNewVendor((v) => ({ ...v, gstin: e.target.value.toUpperCase() }))} /></Field>
                        <Field label="Pays in (days)"><input type="number" min="0" value={newVendor.payment_terms_days} onChange={(e) => setNewVendor((v) => ({ ...v, payment_terms_days: e.target.value }))} /></Field>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setNewVendor(null)} style={{ marginTop: 8 }}>Pick an existing vendor instead</Button>
                </Card>
            ) : (
                <div className="sb-inline">
                    <Field label="Vendor" select>
                        <select value={b.vendor_id} onChange={(e) => set('vendor_id', e.target.value)} data-autofocus>
                            <option value="">Choose…</option>
                            {active.map((v) => <option key={v.id} value={v.id}>{v.company_name}</option>)}
                        </select>
                    </Field>
                    {isNew && orgStore.can('vendors', 'create') && (
                        <Button onClick={() => setNewVendor({ company_name: '', gstin: '', payment_terms_days: 30 })}>New vendor</Button>
                    )}
                </div>
            )}

            <div className="sb-grid2">
                <Field label="Bill number"><input value={b.bill_number} onChange={(e) => set('bill_number', e.target.value)} /></Field>
                <Field label="Category" select>
                    <select value={b.category} onChange={(e) => set('category', e.target.value)}>
                        {[...new Set([...CATEGORIES, b.category].filter(Boolean))].map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                </Field>
                <Field label="Bill date"><input type="date" value={b.bill_date || ''} onChange={(e) => set('bill_date', e.target.value)} /></Field>
                <Field label="Due date"><input type="date" value={b.due_date || ''} onChange={(e) => { setTouchedDue(true); set('due_date', e.target.value); }} /></Field>
                <Field label="Amount before GST (₹)"><input type="number" inputMode="decimal" min="0" step="0.01" value={b.subtotal} onChange={(e) => set('subtotal', e.target.value)} /></Field>
                <div className="sb-field">
                    <label>GST rate</label>
                    <div className="sb-chips">{TAX_RATES.map((r) => <button key={r} type="button" aria-pressed={Number(b.tax_rate) === r} onClick={() => set('tax_rate', r)}>{r}%</button>)}</div>
                    <span className="hint">Input GST {inr(tax)} · total {inr((Number(b.subtotal) || 0) + tax)}</span>
                </div>
            </div>
            <Field label="What it was for"><input value={b.description || ''} onChange={(e) => set('description', e.target.value)} /></Field>
            <ReceiptInput path={b.receipt_path} kind="purchases" onChange={(p) => set('receipt_path', p)} />
            <Field label="Notes"><textarea rows={2} value={b.notes || ''} onChange={(e) => set('notes', e.target.value)} /></Field>
            {!isNew && b.status !== 'void' && orgStore.can('purchase_invoices', 'edit') && (
                <Button variant="ghost" onClick={voidBill}>Void this bill</Button>
            )}
        </Sheet>
    );
}
