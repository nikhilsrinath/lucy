import React, { useState } from 'react';
import { catalogService, UNIT_OPTIONS, TAX_RATES } from '../services/catalogService';
import { orgStore } from '../services/orgStore';
import { confirmDialog } from '../services/confirm';
import { Sheet, Button, Field } from '../design/ui';

/* A catalogue item: what you sell and its default price, unit, HSN/SAC and
   GST — the defaults a document line starts from. catalogService, unchanged:
   "delete" archives (issued invoices keep pointing at it); a hard delete is
   offered only for an item never sold. */

export default function ItemSheet({ item, onClose, notify }) {
    const [p, setP] = useState(item);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const isNew = !item.id;
    const set = (k, v) => setP((x) => ({ ...x, [k]: v }));

    const save = async () => {
        if (!p.name?.trim()) { setError('A name is required.'); return; }
        setSaving(true);
        setError('');
        try {
            const payload = {
                ...p, name: p.name.trim(), sku: (p.sku || '').trim(),
                unit_price: Number(p.unit_price) || 0, tax_rate: Number(p.tax_rate) || 0,
                stock_qty: p.track_inventory ? (Number(p.stock_qty) || 0) : 0,
                low_stock_at: p.track_inventory && p.low_stock_at !== '' ? Number(p.low_stock_at) : null,
            };
            if (p.id) await catalogService.update(p.id, payload);
            else await catalogService.create(payload);
            notify?.(isNew ? 'Item added.' : 'Item saved.');
            onClose();
        } catch (err) {
            setError(err?.code === '23505' ? 'That SKU is already used by another item.' : `Could not save: ${err.message}`);
        } finally { setSaving(false); }
    };
    const archive = async () => {
        try {
            if (p.archived_at) await catalogService.restore(p.id); else await catalogService.archive(p.id);
            notify?.(p.archived_at ? 'Item restored.' : 'Item archived. Past documents keep it.');
            onClose();
        } catch (err) { setError(err.message); }
    };
    const destroy = async () => {
        if (!(await confirmDialog({ title: 'Delete item', message: `Permanently delete “${p.name}”? Archive it instead if you may want it back.` }))) return;
        try { await catalogService.destroy(p.id); notify?.('Item deleted.'); onClose(); }
        catch (err) { setError(err.message); }
    };

    return (
        <Sheet open onClose={onClose} title={isNew ? 'New item' : p.name}
            footer={(
                <>
                    {!isNew && orgStore.can('catalog_items', 'edit') && <Button onClick={archive}>{p.archived_at ? 'Restore' : 'Archive'}</Button>}
                    <Button variant="primary" block onClick={save} disabled={saving}>{saving ? 'Saving…' : isNew ? 'Add item' : 'Save'}</Button>
                </>
            )}>
            {error && <div className="sb-err" role="alert">{error}</div>}
            <Field label="Name"><input value={p.name} data-autofocus onChange={(e) => set('name', e.target.value)} placeholder="e.g. Monthly retainer" /></Field>
            <div className="sb-grid2">
                <Field label="Price (₹)"><input type="number" inputMode="decimal" min="0" step="0.01" value={p.unit_price} onChange={(e) => set('unit_price', e.target.value)} /></Field>
                <Field label="Per" select>
                    <select value={p.unit} onChange={(e) => set('unit', e.target.value)}>{UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}</select>
                </Field>
                <Field label="HSN / SAC"><input value={p.hsn_sac || ''} onChange={(e) => set('hsn_sac', e.target.value)} /></Field>
                <Field label="SKU"><input value={p.sku || ''} onChange={(e) => set('sku', e.target.value)} placeholder="Optional" /></Field>
            </div>
            <div className="sb-field">
                <label>GST rate</label>
                <div className="sb-chips">{TAX_RATES.map((r) => <button key={r} type="button" aria-pressed={Number(p.tax_rate) === r} onClick={() => set('tax_rate', r)}>{r}%</button>)}</div>
            </div>
            <Field label="Description"><textarea rows={2} value={p.description || ''} onChange={(e) => set('description', e.target.value)} /></Field>
            <label className="sb-check"><input type="checkbox" checked={!!p.track_inventory} onChange={(e) => set('track_inventory', e.target.checked)} />Track stock</label>
            {p.track_inventory && (
                <div className="sb-grid2">
                    <Field label="In stock"><input type="number" min="0" step="0.001" value={p.stock_qty} onChange={(e) => set('stock_qty', e.target.value)} /></Field>
                    <Field label="Warn below"><input type="number" min="0" step="0.001" value={p.low_stock_at ?? ''} onChange={(e) => set('low_stock_at', e.target.value)} /></Field>
                </div>
            )}
            {!isNew && !(Number(p.units_sold) > 0) && orgStore.can('catalog_items', 'delete') && (
                <Button variant="ghost" onClick={destroy}>Delete permanently</Button>
            )}
        </Sheet>
    );
}
