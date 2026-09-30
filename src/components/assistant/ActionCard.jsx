import React, { Suspense, lazy, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
    Check, X, Pencil, Undo2, ExternalLink, Loader2, AlertTriangle, ShieldAlert, Clock, FileText,
} from 'lucide-react';

const DocPaper = lazy(() => import('./DocPaper'));

/* ══════════════════════════════════════════════════════════════════════════
   A change EdgeAI has proposed, and what became of it.

   The agent never writes on its own: it sends this card, and the change
   happens only when the person presses the card's button. What the card
   shows is what the server stored as the proposal — the same diff, the same
   rows — and the server re-checks all of it at the moment of the tap.

     proposed   low risk:  the record and a field-by-field diff.
                high risk: the exact row / output that will be written, a
                           button that names the action, and a warning when
                           it cannot be undone.
     executing  a spinner while the server runs it as you.
     executed   a receipt, with Undo for ten minutes and Open.
     failed / expired / cancelled / undone   a single quiet line.

   Keyboard: the buttons are real buttons; Ctrl/⌘+Enter confirms and Escape
   cancels while focus is anywhere in the card.
   ══════════════════════════════════════════════════════════════════════════ */

/** **bold** in a summary line, without a Markdown renderer for one feature. */
function Rich({ text }) {
    const parts = String(text || '').split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, i) => (p.startsWith('**') && p.endsWith('**')
        ? <strong key={i}>{p.slice(2, -2)}</strong>
        : <React.Fragment key={i}>{p}</React.Fragment>));
}

function useNow(active) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return undefined;
        const id = setInterval(() => setNow(Date.now()), 15000);
        return () => clearInterval(id);
    }, [active]);
    return now;
}

export default function ActionCard({ card, onConfirm, onCancel, onUndo, onOpen }) {
    const headingId = useId();
    const statusId = useId();
    const ref = useRef(null);
    const [editing, setEditing] = useState(false);
    const [edits, setEdits] = useState({});
    const [selected, setSelected] = useState(() => new Set((card.items || []).filter((i) => i.checked && !i.disabled).map((i) => i.id)));

    const status = card.status;
    const high = card.risk === 'high';
    const now = useNow(status === 'executed' || status === 'proposed');
    const canUndo = status === 'executed' && card.undo_until && Date.parse(card.undo_until) > now;
    const expiresIn = status === 'proposed' && card.expires_at ? Math.max(0, Math.round((Date.parse(card.expires_at) - now) / 60000)) : null;
    const expired = expiresIn === 0;

    const fields = card.fields || [];
    const hasItems = (card.items || []).length > 0;

    const confirm = () => {
        if (status !== 'proposed' || expired) return;
        if (hasItems && selected.size === 0) return;
        onConfirm({
            selected: hasItems ? [...selected] : undefined,
            edits: editing && Object.keys(edits).length ? edits : undefined,
        });
        setEditing(false);
    };

    const onKeyDown = (e) => {
        if (status !== 'proposed') return;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirm(); }
        if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); if (editing) setEditing(false); else onCancel(); }
    };

    const statusText = useMemo(() => ({
        proposed: expired ? 'Expired — nothing was changed.' : 'Waiting for your confirmation. Nothing has changed yet.',
        executing: 'Working…',
        executed: 'Done.',
        failed: 'Not done.',
        cancelled: 'Cancelled — nothing was changed.',
        expired: 'Expired — nothing was changed.',
        undone: 'Undone.',
    }[status] || ''), [status, expired]);

    /* ── the quiet end states ─────────────────────────────────────────── */
    if (status === 'cancelled' || status === 'expired' || status === 'undone' || (status === 'proposed' && expired)) {
        return (
            <div className="cp-card is-closed" role="group" aria-labelledby={headingId}>
                <span id={headingId} className="cp-card-closed">
                    {status === 'undone' ? <Undo2 size={13} aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
                    <span>{card.title}</span>
                    <span className="cp-card-dim">— {statusText}{card.error && status === 'expired' ? ` ${card.error}` : ''}</span>
                </span>
            </div>
        );
    }

    /* ── the receipt ──────────────────────────────────────────────────── */
    if (status === 'executed') {
        return (
            <div className="cp-card is-done" role="group" aria-labelledby={headingId} ref={ref}>
                <div className="cp-card-receipt">
                    <Check size={15} strokeWidth={2.2} className="cp-card-ok" aria-hidden="true" />
                    <div id={headingId} className="cp-card-summary"><Rich text={card.summary || card.title} /></div>
                </div>
                {card.error && <p className="cp-card-error" role="alert">{card.error}</p>}
                <div className="cp-card-actions">
                    {canUndo && (
                        <button type="button" className="cp-btn" onClick={onUndo}>
                            <Undo2 size={13} aria-hidden="true" /> Undo
                        </button>
                    )}
                    {card.href && (
                        <button type="button" className="cp-btn" onClick={() => onOpen(card.href)}>
                            <ExternalLink size={13} aria-hidden="true" /> Open
                        </button>
                    )}
                    {!card.undo_until && high && <span className="cp-card-dim">Can’t be undone from here.</span>}
                </div>
                <span id={statusId} className="cp-sr" aria-live="polite">{statusText}</span>
            </div>
        );
    }

    if (status === 'failed') {
        return (
            <div className="cp-card is-failed" role="group" aria-labelledby={headingId}>
                <div className="cp-card-receipt">
                    <AlertTriangle size={15} className="cp-card-bad" aria-hidden="true" />
                    <div id={headingId} className="cp-card-summary">{card.title} — not done</div>
                </div>
                <p className="cp-card-error" role="alert">{card.error || 'The change could not be saved.'}</p>
                <p className="cp-card-dim cp-card-pad">Ask again and I’ll prepare it fresh.</p>
            </div>
        );
    }

    /* ── the proposal ─────────────────────────────────────────────────── */
    const busy = status === 'executing';
    const confirmLabel = card.confirmLabel || 'Confirm';

    return (
        <section
            ref={ref}
            className={`cp-card${high ? ' is-high' : ''}`}
            aria-labelledby={headingId}
            aria-describedby={statusId}
            onKeyDown={onKeyDown}
        >
            <header className="cp-card-head">
                {high ? <ShieldAlert size={14} className="cp-card-warn" aria-hidden="true" /> : <Pencil size={13} aria-hidden="true" />}
                <span className="cp-card-kicker">{high ? 'Review before confirming' : 'Proposed change'}</span>
                {expiresIn !== null && (
                    <span className="cp-card-dim cp-card-expiry">
                        <Clock size={11} aria-hidden="true" /> {expiresIn} min
                    </span>
                )}
            </header>

            <div className="cp-card-body">
                <h3 id={headingId} className="cp-card-title">{card.title}</h3>
                {card.target && (
                    <button type="button" className="cp-card-target" onClick={() => onOpen(card.target.href)}>
                        {card.target.label} <ExternalLink size={11} aria-hidden="true" />
                    </button>
                )}

                {!editing && (card.diff || []).length > 0 && <Diff rows={card.diff} />}

                {hasItems && (
                    <fieldset className="cp-card-items">
                        <legend className="cp-sr">Choose which to include</legend>
                        {card.items.map((it) => (
                            <label key={it.id} className={`cp-card-item${it.disabled ? ' is-off' : ''}`}>
                                <input
                                    type="checkbox" disabled={it.disabled || busy}
                                    checked={selected.has(it.id)}
                                    onChange={(e) => setSelected((s) => {
                                        const n = new Set(s);
                                        if (e.target.checked) n.add(it.id); else n.delete(it.id);
                                        return n;
                                    })}
                                />
                                <span className="cp-card-item-main">
                                    <span className="cp-card-item-label">{it.label}</span>
                                    {it.sub && <span className="cp-card-dim">{it.sub}</span>}
                                    {it.disabled && <span className="cp-card-dim"> · already so</span>}
                                    {!it.disabled && (it.diff || []).length > 0 && (
                                        <span className="cp-card-dim"> · {it.diff.map((d) => `${d.from} → ${d.to}`).join(', ')}</span>
                                    )}
                                </span>
                            </label>
                        ))}
                    </fieldset>
                )}

                {!editing && card.preview?.rows && (
                    <dl className="cp-card-rows">
                        {card.preview.rows.map(([k, v]) => (
                            <div key={k} className="cp-card-row"><dt>{k}</dt><dd>{v}</dd></div>
                        ))}
                    </dl>
                )}
                {!editing && card.message && (
                    <p className="cp-card-note" style={{ whiteSpace: 'pre-wrap' }} aria-label="The message that will be sent">{card.message.text}</p>
                )}
                {!editing && card.preview?.document && <DocTable doc={card.preview.document} full={!!card.preview.full} />}
                {!editing && card.preview?.note && <p className="cp-card-note">{card.preview.note}</p>}

                {editing && (
                    <div className="cp-card-edit">
                        {fields.map((f) => (
                            <EditField key={f.key} field={f} value={edits[f.key] ?? f.value ?? ''}
                                onChange={(v) => setEdits((e) => ({ ...e, [f.key]: v }))} />
                        ))}
                    </div>
                )}

                {(card.notes || []).map((n) => <p key={n} className="cp-card-dim">{n}</p>)}
                {card.irreversible && (
                    <p className="cp-card-irrev"><AlertTriangle size={12} aria-hidden="true" /> {card.irreversible}</p>
                )}
                {card.error && <p className="cp-card-error" role="alert">{card.error}</p>}

                <div className="cp-card-actions">
                    <button type="button" className="cp-btn is-primary" onClick={confirm}
                        disabled={busy || (hasItems && selected.size === 0)} aria-keyshortcuts="Control+Enter Meta+Enter">
                        {busy
                            ? <><Loader2 size={13} className="ai-spin" aria-hidden="true" /> Working…</>
                            : <><Check size={13} aria-hidden="true" /> {hasItems && selected.size !== card.items.length ? `${confirmLabel} (${selected.size})` : confirmLabel}</>}
                    </button>
                    {fields.length > 0 && !busy && (
                        <button type="button" className="cp-btn" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
                            <Pencil size={12} aria-hidden="true" /> {editing ? 'Done editing' : 'Edit'}
                        </button>
                    )}
                    <button type="button" className="cp-btn" onClick={onCancel} disabled={busy} aria-keyshortcuts="Escape">
                        <X size={13} aria-hidden="true" /> Cancel
                    </button>
                </div>
            </div>
            <span id={statusId} className="cp-sr" aria-live="polite">{statusText}</span>
        </section>
    );
}

const inr = (v, currency = 'INR') => {
    try {
        return (Number(v) || 0).toLocaleString('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 });
    } catch {
        return `${currency} ${(Number(v) || 0).toLocaleString('en-IN')}`;
    }
};

/* The lines and the GST split of an invoice, quotation or proforma — the
   figures the database will store — with the real invoice one tap away. */
function DocTable({ doc, full }) {
    const [paper, setPaper] = useState(full && doc.type === 'invoice');
    const t = doc.totals || {};
    const cur = doc.currency || 'INR';
    const half = (doc.gstRate || 0) / 2;
    return (
        <div className="cp-doc">
            <table className="cp-doc-table">
                <caption className="cp-sr">{doc.title} {doc.number} line items and totals</caption>
                <thead>
                    <tr><th scope="col">Item</th><th scope="col" className="is-num">Qty × rate</th><th scope="col" className="is-num">Amount</th></tr>
                </thead>
                <tbody>
                    {(doc.items || []).map((it, i) => (
                        <tr key={i}>
                            <td>{it.description}{it.hsn ? <span className="cp-card-dim"> · {it.hsn}</span> : null}</td>
                            <td className="is-num">{it.quantity} × {inr(it.rate, cur)}</td>
                            <td className="is-num">{inr(it.amount, cur)}</td>
                        </tr>
                    ))}
                </tbody>
                <tfoot>
                    <tr><th scope="row" colSpan={2}>Subtotal</th><td className="is-num">{inr(t.subtotal, cur)}</td></tr>
                    {t.discountAmount > 0 && <tr><th scope="row" colSpan={2}>Discount</th><td className="is-num">− {inr(t.discountAmount, cur)}</td></tr>}
                    {doc.gstRate > 0 && (doc.isInterState
                        ? <tr><th scope="row" colSpan={2}>IGST {doc.gstRate}%</th><td className="is-num">{inr(t.igst, cur)}</td></tr>
                        : <>
                            <tr><th scope="row" colSpan={2}>CGST {half}%</th><td className="is-num">{inr(t.cgst, cur)}</td></tr>
                            <tr><th scope="row" colSpan={2}>SGST {half}%</th><td className="is-num">{inr(t.sgst, cur)}</td></tr>
                        </>)}
                    <tr className="is-total"><th scope="row" colSpan={2}>Total</th><td className="is-num">{inr(t.grandTotal, cur)}</td></tr>
                </tfoot>
            </table>
            {doc.type === 'invoice' && (
                <>
                    <button type="button" className="cp-btn cp-doc-toggle" aria-expanded={paper} onClick={() => setPaper((v) => !v)}>
                        <FileText size={12} aria-hidden="true" /> {paper ? 'Hide the invoice' : 'Show the invoice'}
                    </button>
                    {paper && (
                        <Suspense fallback={<p className="cp-card-dim">Loading the invoice…</p>}>
                            <DocPaper doc={doc} />
                        </Suspense>
                    )}
                </>
            )}
        </div>
    );
}

function Diff({ rows }) {
    return (
        <dl className="cp-card-rows is-diff">
            {rows.map((d) => (
                <div key={d.key} className="cp-card-row">
                    <dt>{d.label}</dt>
                    <dd>
                        {d.from !== '—' && <><span className="cp-card-from">{d.from}</span><span aria-label="changes to"> → </span></>}
                        <strong>{d.to}</strong>
                    </dd>
                </div>
            ))}
        </dl>
    );
}

function EditField({ field, value, onChange }) {
    const id = useId();
    let control;
    if (field.type === 'select') {
        const groups = [];
        for (const o of field.options || []) {
            const g = o.group || '';
            let bucket = groups.find((x) => x.g === g);
            if (!bucket) { bucket = { g, items: [] }; groups.push(bucket); }
            bucket.items.push(o);
        }
        control = (
            <select id={id} className="cp-input" value={value} onChange={(e) => onChange(e.target.value)}>
                {groups.map((b) => (b.g
                    ? <optgroup key={b.g} label={b.g}>{b.items.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>
                    : b.items.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)))}
            </select>
        );
    } else if (field.type === 'textarea') {
        control = <textarea id={id} className="cp-input" rows={3} value={value} onChange={(e) => onChange(e.target.value)} />;
    } else {
        control = (
            <input id={id} className="cp-input" type={field.type === 'date' ? 'date' : 'text'} value={value}
                min={field.min || undefined} max={field.max || undefined}
                onChange={(e) => onChange(e.target.value)} />
        );
    }
    return (
        <div className="cp-field">
            <label htmlFor={id}>{field.label}</label>
            {control}
        </div>
    );
}
