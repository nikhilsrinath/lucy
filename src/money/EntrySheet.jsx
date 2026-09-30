import React, { useEffect, useRef, useState } from 'react';
import { orgStore } from '../services/orgStore';
import { receiptService, validateReceipt, RECEIPT_ACCEPT } from '../services/receiptService';
import { PAYMENT_METHODS, TREATMENTS, categoryLabel, categoryOf, groupedCategories } from '../services/financeCategories';
import { friendlyError } from '../services/projectService';
import { confirmDialog } from '../services/confirm';
import { INDIAN_STATES } from '../data/indianStates';
import { Sheet, Button, Field, Segmented } from '../design/ui';
import { inr } from '../chat/brief';
import { blankEntry } from './blanks';

/* ══════════════════════════════════════════════════════════════════════════
   Record or edit money in / money out — the cash book's entry, in a sheet.

   Same fields, same save (orgStore → income_entries / expenses, RLS as you),
   same rules: `original_amount` is typed, the rupee `amount` is derived by the
   database from it and the rate; GST is part of the amount, never on top; a
   category carries its treatment, which says whether profit moves.
   The rarer fields sit under "More details". The project split is not offered
   here (project money links are out of this UI); a split an entry already has
   is left as it is, and the database still refuses an amount below it.
   ══════════════════════════════════════════════════════════════════════════ */

const GST_RATES = [0, 5, 12, 18, 28];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY'];
const SECTION = { in: 'income_entries', out: 'expenses' };

export default function EntrySheet({ entry, onClose, data, onSaved }) {
    const [e, setE] = useState(entry);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [countries, setCountries] = useState(null);
    const isNew = !entry.id;

    useEffect(() => {
        let gone = false;
        import('../data/worldMap.js').then((m) => { if (!gone) setCountries(m.ALL_COUNTRIES); }).catch(() => setCountries([]));
        return () => { gone = true; };
    }, []);

    const set = (k, v) => setE((x) => ({ ...x, [k]: v }));
    const base = Math.round((Number(e.original_amount) || 0) * (Number(e.fx_rate) || 1) * 100) / 100;
    // Picking a rate fills the GST inside the amount — app.cash_entry_tax()'s arithmetic.
    const setRate = (rate) => setE((x) => {
        const gross = (Number(x.original_amount) || 0) * (Number(x.fx_rate) || 1);
        const tax = rate > 0 ? Math.round((gross - gross / (1 + rate / 100)) * 100) / 100 : 0;
        return { ...x, tax_rate: rate, tax_amount: tax ? String(tax) : '' };
    });
    const switchDirection = (direction) => setE((x) => ({
        ...blankEntry(direction),
        description: x.description, original_amount: x.original_amount, currency: x.currency, fx_rate: x.fx_rate,
        tax_amount: x.tax_amount, tax_rate: x.tax_rate, date: x.date, payment_method: x.payment_method, reference: x.reference,
        country_code: x.country_code, place_of_supply: x.place_of_supply, is_inter_state: x.is_inter_state,
        quantity: x.quantity, unit: x.unit, receipt_path: x.receipt_path, notes: x.notes,
    }));

    const picked = categoryOf(e.category);
    const treatment = TREATMENTS[picked?.treatment || (e.direction === 'in' ? 'revenue' : 'operating')];

    const save = async (ev) => {
        ev?.preventDefault();
        if (!e.description.trim()) { setError('Say what this was for.'); return; }
        if (!(Number(e.original_amount) > 0)) { setError('Enter an amount greater than zero.'); return; }
        if (!(Number(e.fx_rate) > 0)) { setError('Enter an exchange rate greater than zero.'); return; }
        if (Number(e.tax_amount || 0) > base) { setError('The GST cannot be more than the amount it is part of.'); return; }
        setSaving(true);
        setError('');
        const { direction, day: _day, party: _party, treatment: _t, _picker: _p, ...row } = e;
        try {
            if (e.id) await orgStore.updateItem(SECTION[direction], e.id, row);
            else await orgStore.addItem(SECTION[direction], row);
            onSaved?.(e.id ? 'Entry updated.' : 'Entry recorded.');
            onClose();
        } catch (err) {
            setError(friendlyError(err).message || 'Could not save this entry.');
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        if (!(await confirmDialog({ title: 'Delete entry', message: `Delete “${e.description}”? This cannot be undone.` }))) return;
        try {
            await orgStore.removeItem(SECTION[e.direction], e.id);
            if (e.receipt_path) receiptService.remove(e.receipt_path);
            onSaved?.('Entry deleted.');
            onClose();
        } catch (err) { setError(`Could not delete: ${err.message}`); }
    };

    const canDelete = !isNew && orgStore.can(SECTION[e.direction], 'delete');
    const sym = e.currency === 'INR' ? '₹' : `${e.currency} `;

    return (
        <Sheet open onClose={onClose} className="nb-sheet" title={isNew ? 'Record money' : `Edit money ${e.direction === 'in' ? 'in' : 'out'}`}
            footer={(
                <>
                    {canDelete && <Button variant="danger" onClick={remove}>Delete</Button>}
                    <Button variant="primary" block onClick={save} disabled={saving}>{saving ? 'Saving…' : isNew ? 'Record entry' : 'Save changes'}</Button>
                </>
            )}>
            <form onSubmit={save}>
                {error && <div className="sb-err" role="alert">{error}</div>}
                {isNew && (
                    <Segmented block label="Direction" value={e.direction} onChange={switchDirection}
                        options={[{ value: 'in', label: 'Money in' }, { value: 'out', label: 'Money out' }]} />
                )}
                <Field label="What was it for?">
                    <input value={e.description} data-autofocus onChange={(x) => set('description', x.target.value)}
                        placeholder={e.direction === 'in' ? 'e.g. Counter sale, 3 units' : 'e.g. September salaries'} />
                </Field>
                <Field label="Reason" select hint={`${picked?.hint ? `${picked.hint} ` : ''}${treatment ? `${treatment.label}: ${treatment.note}` : ''}`}>
                    <select value={e.category} onChange={(x) => set('category', x.target.value)}>
                        {groupedCategories(e.direction).map((g) => (
                            <optgroup key={g.label} label={g.label}>
                                {g.items.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                            </optgroup>
                        ))}
                        {e.category && !categoryOf(e.category)?.active && <option value={e.category}>{categoryLabel(e.category)}</option>}
                    </select>
                </Field>
                <div className="sb-grid2">
                    <Field label={`Amount (${sym.trim()})`}
                        hint={e.currency !== 'INR' ? `Recorded as ${inr(base)} at the rate below.` : undefined}>
                        <input type="number" inputMode="decimal" min="0.01" step="0.01" value={e.original_amount}
                            onChange={(x) => set('original_amount', x.target.value)} />
                    </Field>
                    <Field label={e.direction === 'in' ? 'Received on' : 'Paid on'}>
                        <input type="date" value={e.date || ''} onChange={(x) => set('date', x.target.value)} />
                    </Field>
                </div>
                <div className="sb-field">
                    <label>GST rate, {e.direction === 'in' ? 'collected' : 'claimable'}</label>
                    <div className="sb-chips">
                        {GST_RATES.map((r) => (
                            <button key={r} type="button" aria-pressed={Number(e.tax_rate) === r} onClick={() => setRate(r)}>{r}%</button>
                        ))}
                    </div>
                </div>
                <div className="sb-grid2">
                    <Field label={`GST included (${sym.trim()})`} hint="Part of the amount, not on top of it.">
                        <input type="number" inputMode="decimal" min="0" step="0.01" value={e.tax_amount} onChange={(x) => set('tax_amount', x.target.value)} />
                    </Field>
                    <Field label="Paid by" select>
                        <select value={e.payment_method} onChange={(x) => set('payment_method', x.target.value)}>
                            {PAYMENT_METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                        </select>
                    </Field>
                </div>
                {e.direction === 'in' ? (
                    <Field label="Who paid you" select>
                        <select value={e.client_id || ''} onChange={(x) => set('client_id', x.target.value)}>
                            <option value="">Not recorded</option>
                            {data.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                    </Field>
                ) : (
                    <div className="sb-grid2">
                        <Field label="Paid to (vendor)" select>
                            <select value={e.vendor_id || ''} onChange={(x) => set('vendor_id', x.target.value)}>
                                <option value="">Not a vendor</option>
                                {data.vendors.filter((v) => !v.archived_at).map((v) => <option key={v.id} value={v.id}>{v.company_name}</option>)}
                            </select>
                        </Field>
                        <Field label="Has it left the bank?" select>
                            <select value={e.status} onChange={(x) => set('status', x.target.value)}>
                                <option value="paid">Yes, paid</option>
                                <option value="pending">Not yet, committed</option>
                            </select>
                        </Field>
                    </div>
                )}
                <ReceiptInput path={e.receipt_path} kind={e.direction === 'in' ? 'income' : 'expenses'} onChange={(p) => set('receipt_path', p)} />

                <details className="sb-details" style={{ marginTop: 16 }}>
                    <summary>More details</summary>
                    <div className="sb-grid2">
                        <Field label="Currency" select>
                            <select value={e.currency} onChange={(x) => set('currency', x.target.value)}>
                                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </Field>
                        {e.currency !== 'INR' && (
                            <Field label={`Rate: 1 ${e.currency} in ₹`} hint="The rate on the day the money moved.">
                                <input type="number" min="0.000001" step="0.000001" value={e.fx_rate} onChange={(x) => set('fx_rate', x.target.value)} />
                            </Field>
                        )}
                        <Field label="Reference">
                            <input value={e.reference || ''} placeholder="UTR, cheque no., payout id" onChange={(x) => set('reference', x.target.value)} />
                        </Field>
                        <Field label="Place of supply" select>
                            <select value={e.place_of_supply || ''} onChange={(x) => set('place_of_supply', x.target.value)}>
                                <option value="">Not recorded</option>
                                {INDIAN_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
                            </select>
                        </Field>
                        <Field label="Country" select hint="Blank: inferred from the party, then your company.">
                            <select value={e.country_code || ''} disabled={!countries} onChange={(x) => set('country_code', x.target.value)}>
                                <option value="">{countries ? 'Infer it' : 'Loading…'}</option>
                                {(countries || []).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                            </select>
                        </Field>
                        <label className="sb-check full">
                            <input type="checkbox" checked={!!e.is_inter_state} onChange={(x) => set('is_inter_state', x.target.checked)} />
                            Inter-state supply (IGST)
                        </label>
                        <Field label="Quantity">
                            <input type="number" min="0" step="0.001" value={e.quantity ?? ''} placeholder="Optional" onChange={(x) => set('quantity', x.target.value)} />
                        </Field>
                        <Field label="Unit">
                            <input value={e.unit || ''} placeholder="Nos, kg, hours" onChange={(x) => set('unit', x.target.value)} />
                        </Field>
                        {e.direction === 'in' ? (
                            <Field label="What was sold" select>
                                <select value={e.catalog_item_id || ''} onChange={(x) => set('catalog_item_id', x.target.value)}>
                                    <option value="">Not a catalogue item</option>
                                    {data.catalog.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                </select>
                            </Field>
                        ) : (
                            <>
                                <Field label="Paid to (person)" select>
                                    <select value={e.employee_id || ''} onChange={(x) => set('employee_id', x.target.value)}>
                                        <option value="">Not a person</option>
                                        {data.employees.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                                    </select>
                                </Field>
                                <Field label="For a client" select>
                                    <select value={e.client_id || ''} onChange={(x) => set('client_id', x.target.value)}>
                                        <option value="">Not client-specific</option>
                                        {data.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                    </select>
                                </Field>
                                <label className="sb-check full">
                                    <input type="checkbox" checked={!!e.billable} disabled={!e.client_id} onChange={(x) => set('billable', x.target.checked)} />
                                    Re-billable to that client
                                </label>
                            </>
                        )}
                        <Field label="Notes">
                            <textarea rows={2} value={e.notes || ''} onChange={(x) => set('notes', x.target.value)} />
                        </Field>
                    </div>
                </details>
                <button type="submit" hidden />
            </form>
        </Sheet>
    );
}

/** Receipt or proof: the private receipts bucket, five-minute links. */
export function ReceiptInput({ path, kind, onChange }) {
    const ref = useRef(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const pick = async (ev) => {
        const file = ev.target.files?.[0];
        ev.target.value = '';
        if (!file) return;
        const problem = validateReceipt(file);
        if (problem) { setError(problem); return; }
        setBusy(true);
        setError('');
        try {
            const next = await receiptService.upload(orgStore.getOrgId(), kind, file);
            if (path) receiptService.remove(path);
            onChange(next);
        } catch (err) { setError(err.message || 'Upload failed.'); }
        finally { setBusy(false); }
    };
    return (
        <div className="sb-field">
            <label>Receipt or proof</label>
            <input ref={ref} type="file" accept={RECEIPT_ACCEPT} hidden onChange={pick} />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button size="sm" onClick={() => ref.current?.click()} disabled={busy}>{busy ? 'Uploading…' : path ? 'Replace' : 'Attach receipt'}</Button>
                {path && <Button size="sm" onClick={() => receiptService.open(path)}>View</Button>}
                {path && (
                    <Button size="sm" variant="ghost" onClick={async () => {
                        if (await confirmDialog({ title: 'Remove receipt', message: 'Remove the attached receipt? The file is deleted.', confirmLabel: 'Remove' })) {
                            receiptService.remove(path); onChange(null);
                        }
                    }}>Remove</Button>
                )}
            </div>
            <span className="hint">PDF, PNG, JPEG or WebP, up to 5 MB. Stored privately.</span>
            {error && <span className="err">{error}</span>}
        </div>
    );
}
