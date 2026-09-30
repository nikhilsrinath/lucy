import React, { Suspense, lazy, useEffect, useId, useMemo, useState } from 'react';
import { Badge, Button, IconTile } from '../design/ui';
import { IconDoc, IconCheckCircle, IconClock, IconAlert, IconUndo, IconExternal, IconRefresh, IconMail } from '../design/icons';
import { cardMeta } from './cardMeta';
import './operator.css';

const DocPaper = lazy(() => import('../components/assistant/DocPaper'));

/* ══════════════════════════════════════════════════════════════════════════
   A change the cofounder has proposed, and what became of it — the mockup's
   action card over the agent's real card (api/_lib/agent/actions.toCard).

   Nothing here decides anything. The server stored the proposal; the card
   shows it; the buttons call confirm / cancel / undo with the card's id and
   the server re-checks everything at that moment.

     proposed   header (type, risk badge, minutes left), title, the diff or
                the exact rows to be written, optional items and fields,
                primary button named by the tool, Edit when fields exist,
                Cancel. Ctrl/⌘+Enter confirms, Escape cancels.
     executing  the primary button says Working…
     executed   green strip: summary, Undo while the window is open, Open
     failed     what went wrong, and Try again (a fresh proposal, re-checked)
     cancelled / expired / undone   one quiet strip

   Every proposal carries Buddy's one-line why (card.reason) and, for an
   email, the exact message that will go out.
   ══════════════════════════════════════════════════════════════════════════ */

/** **bold** inside a summary line. */
function Rich({ text }) {
    return String(text || '').split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**')
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

export default function ActionCard({ card, onConfirm, onCancel, onUndo, onRetry, onOpen, compact = false }) {
    const headingId = useId();
    const statusId = useId();
    const [editing, setEditing] = useState(false);
    const [edits, setEdits] = useState({});
    const [selected, setSelected] = useState(() => new Set((card.items || []).filter((i) => i.checked && !i.disabled).map((i) => i.id)));
    const { label, Icon, tone } = cardMeta(card);

    const status = card.status;
    const high = card.risk === 'high';
    const now = useNow(status === 'executed' || status === 'proposed');
    const canUndo = status === 'executed' && card.undo_until && Date.parse(card.undo_until) > now;
    const minutesLeft = status === 'proposed' && card.expires_at ? Math.max(0, Math.round((Date.parse(card.expires_at) - now) / 60000)) : null;
    const lapsed = minutesLeft === 0;
    const fields = card.fields || [];
    const hasItems = (card.items || []).length > 0;
    const busy = status === 'executing' || status === 'confirmed';

    const confirm = () => {
        if (status !== 'proposed' || lapsed) return;
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
        proposed: lapsed ? 'Expired. Nothing was changed.' : 'Waiting for your confirmation. Nothing has changed yet.',
        executing: 'Working…', confirmed: 'Working…', executed: 'Done.', failed: 'Not done.',
        cancelled: 'Cancelled. Nothing was changed.', expired: 'Expired. Nothing was changed.', undone: 'Undone.',
    }[status] || ''), [status, lapsed]);

    const header = (
        <div className="sb-ach">
            <IconTile tone={tone}><Icon size={14} /></IconTile>
            <span>{label}</span>
            <span className="right">
                {minutesLeft !== null && !lapsed && !compact && (
                    <span className="exp" title="Minutes left to confirm"><IconClock size={12} />{minutesLeft} min</span>
                )}
                {(status === 'proposed' || busy) && (high
                    ? <Badge tone="a">Review first</Badge>
                    : <Badge tone="n">Undo in 10 min</Badge>)}
            </span>
        </div>
    );

    /* ── quiet end states ─────────────────────────────────────────────── */
    if (status === 'cancelled' || status === 'expired' || status === 'undone' || (status === 'proposed' && lapsed)) {
        return (
            <section className="sb-cd sb-ac dim" aria-labelledby={headingId}>
                {header}
                <div className="sb-acb"><h4 id={headingId}>{card.title}</h4></div>
                <div className="sb-acdone x">
                    {status === 'undone' ? <IconUndo /> : null}
                    <span className="txt">{status === 'expired' && card.error ? card.error : statusText}</span>
                </div>
            </section>
        );
    }

    if (status === 'failed') {
        return (
            <section className="sb-cd sb-ac" aria-labelledby={headingId}>
                {header}
                <div className="sb-acb"><h4 id={headingId}>{card.title}</h4></div>
                <div className="sb-acdone bad" role="alert">
                    <IconAlert />
                    <span className="txt">{card.error || 'The change could not be saved.'} Nothing was changed.</span>
                </div>
                {onRetry && !compact && (
                    <div className="sb-acf"><Button size="sm" onClick={onRetry}><IconRefresh /> Try again</Button></div>
                )}
            </section>
        );
    }

    if (status === 'executed') {
        return (
            <section className="sb-cd sb-ac" aria-labelledby={headingId}>
                {header}
                <div className="sb-acb"><h4 id={headingId}>{card.title}</h4></div>
                {card.error && <p className="sb-acerr" role="alert" style={{ padding: '0 16px' }}>{card.error}</p>}
                <div className="sb-acdone">
                    <IconCheckCircle />
                    <span className="txt"><Rich text={card.summary || 'Done.'} /></span>
                    {canUndo && <button type="button" className="lnk" onClick={onUndo}>Undo</button>}
                    {card.href && <button type="button" className="lnk" onClick={() => onOpen(card.href, card)}>Open</button>}
                </div>
                {!card.undo_until && high && !compact && <p className="sb-acnote" style={{ padding: '0 16px 12px', margin: 0 }}>This one can’t be undone from here.</p>}
                <span id={statusId} className="sb-sr" aria-live="polite">{statusText}</span>
            </section>
        );
    }

    /* ── the proposal ─────────────────────────────────────────────────── */
    const confirmLabel = card.confirmLabel || 'Confirm';
    return (
        <section className="sb-cd sb-ac" aria-labelledby={headingId} aria-describedby={statusId} onKeyDown={onKeyDown}>
            {header}
            <div className="sb-acb">
                <h4 id={headingId}>{card.title}</h4>
                {card.reason && !editing && <p className="sb-why"><b>Why</b>{card.reason}</p>}

                {!editing && card.email && (
                    <div className="sb-mail" aria-label="The email that will be sent">
                        <div className="mh"><IconMail size={13} /><span>To <b>{card.email.to}</b></span></div>
                        <div className="ms">{card.email.subject}</div>
                        <pre className="mb">{card.email.text}</pre>
                    </div>
                )}

                {!editing && (card.diff || []).length > 0 && (
                    <dl>
                        {card.diff.map((d) => (
                            <div key={d.key} className="sb-kv2">
                                <dt>{d.label}</dt>
                                <dd>{d.from !== '—' && <span className="from">{d.from}</span>}<span className="sb-sr"> changes to </span>{d.to}</dd>
                            </div>
                        ))}
                    </dl>
                )}

                {hasItems && (
                    <fieldset className="sb-acitems">
                        <legend className="sb-sr">Choose which to include</legend>
                        {card.items.map((it) => (
                            <label key={it.id} className={it.disabled ? 'off' : undefined}>
                                <input type="checkbox" disabled={it.disabled || busy} checked={selected.has(it.id)}
                                    onChange={(e) => setSelected((s) => {
                                        const n = new Set(s);
                                        if (e.target.checked) n.add(it.id); else n.delete(it.id);
                                        return n;
                                    })} />
                                <span>
                                    {it.label}
                                    {(it.sub || it.disabled || (it.diff || []).length > 0) && (
                                        <small>
                                            {[it.sub, it.disabled && 'already so', !it.disabled && (it.diff || []).map((d) => `${d.from} → ${d.to}`).join(', ')].filter(Boolean).join(' · ')}
                                        </small>
                                    )}
                                </span>
                            </label>
                        ))}
                    </fieldset>
                )}

                {!editing && card.preview?.rows && (
                    <dl>
                        {card.preview.rows.map(([k, v]) => (
                            <div key={k} className={`sb-kv2${/^total$/i.test(k) ? ' tot' : ''}`}><dt>{k}</dt><dd>{v}</dd></div>
                        ))}
                    </dl>
                )}
                {!editing && card.preview?.document && <DocTable doc={card.preview.document} full={!!card.preview.full} />}
                {!editing && card.preview?.note && <p className="sb-acnote">{card.preview.note}</p>}

                {editing && (
                    <div className="sb-acedit">
                        {fields.map((f) => (
                            <EditField key={f.key} field={f} value={edits[f.key] ?? f.value ?? ''}
                                onChange={(v) => setEdits((e) => ({ ...e, [f.key]: v }))} />
                        ))}
                    </div>
                )}

                {(card.notes || []).map((n) => <p key={n} className="sb-acnote">{n}</p>)}
                {card.irreversible && <p className="sb-acwarn"><IconAlert size={13} /> {card.irreversible}</p>}
                {card.error && <p className="sb-acerr" role="alert">{card.error}</p>}
            </div>
            <div className="sb-acf">
                <Button variant="primary" size="sm" onClick={confirm} disabled={busy || (hasItems && selected.size === 0)}
                    aria-keyshortcuts="Control+Enter Meta+Enter">
                    {busy ? 'Working…' : hasItems && selected.size !== card.items.length ? `${confirmLabel} (${selected.size})` : confirmLabel}
                </Button>
                {fields.length > 0 && !busy && (
                    <Button size="sm" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>{editing ? 'Done editing' : 'Edit'}</Button>
                )}
                <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy} aria-keyshortcuts="Escape">Cancel</Button>
                {card.target?.href && !compact && (
                    <Button variant="ghost" size="sm" onClick={() => onOpen(card.target.href, card)} style={{ marginLeft: 'auto' }}>
                        {card.target.label} <IconExternal />
                    </Button>
                )}
            </div>
            <span id={statusId} className="sb-sr" aria-live="polite">{statusText}</span>
        </section>
    );
}

const money = (v, currency = 'INR') => {
    try { return (Number(v) || 0).toLocaleString('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }); }
    catch { return `${currency} ${(Number(v) || 0).toLocaleString('en-IN')}`; }
};

/* The lines and GST split of a draft invoice, quotation or proforma — the
   figures the database will store — with the rendered invoice one tap away. */
function DocTable({ doc, full }) {
    const [paper, setPaper] = useState(full && doc.type === 'invoice');
    const t = doc.totals || {};
    const cur = doc.currency || 'INR';
    const half = (doc.gstRate || 0) / 2;
    return (
        <>
            <table className="sb-doctable">
                <caption className="sb-sr">{doc.title} {doc.number} line items and totals</caption>
                <thead><tr><th scope="col">Item</th><th scope="col" className="num">Qty × rate</th><th scope="col" className="num">Amount</th></tr></thead>
                <tbody>
                    {(doc.items || []).map((it, i) => (
                        <tr key={i}>
                            <td>{it.description}{it.hsn ? <span style={{ color: 'var(--faint)' }}> · {it.hsn}</span> : null}</td>
                            <td className="num">{it.quantity} × {money(it.rate, cur)}</td>
                            <td className="num">{money(it.amount, cur)}</td>
                        </tr>
                    ))}
                </tbody>
                <tfoot>
                    <tr><th scope="row" colSpan={2}>Subtotal</th><td className="num">{money(t.subtotal, cur)}</td></tr>
                    {t.discountAmount > 0 && <tr><th scope="row" colSpan={2}>Discount</th><td className="num">− {money(t.discountAmount, cur)}</td></tr>}
                    {doc.gstRate > 0 && (doc.isInterState
                        ? <tr><th scope="row" colSpan={2}>IGST {doc.gstRate}%</th><td className="num">{money(t.igst, cur)}</td></tr>
                        : <>
                            <tr><th scope="row" colSpan={2}>CGST {half}%</th><td className="num">{money(t.cgst, cur)}</td></tr>
                            <tr><th scope="row" colSpan={2}>SGST {half}%</th><td className="num">{money(t.sgst, cur)}</td></tr>
                        </>)}
                    <tr className="tot"><th scope="row" colSpan={2}>Total</th><td className="num">{money(t.grandTotal, cur)}</td></tr>
                </tfoot>
            </table>
            {doc.type === 'invoice' && (
                <>
                    <Button variant="ghost" size="sm" aria-expanded={paper} onClick={() => setPaper((v) => !v)}>
                        <IconDoc size={13} /> {paper ? 'Hide the invoice' : 'Show the invoice'}
                    </Button>
                    {paper && (
                        <Suspense fallback={<p className="sb-acnote">Loading the invoice…</p>}>
                            <DocPaper doc={doc} />
                        </Suspense>
                    )}
                </>
            )}
        </>
    );
}

export function EditField({ field, value, onChange }) {
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
            <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
                {groups.map((b) => (b.g
                    ? <optgroup key={b.g} label={b.g}>{b.items.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>
                    : b.items.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)))}
            </select>
        );
    } else if (field.type === 'textarea') {
        control = <textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />;
    } else {
        control = (
            <input id={id} type={field.type === 'date' ? 'date' : 'text'} value={value}
                min={field.min || undefined} max={field.max || undefined} onChange={(e) => onChange(e.target.value)} />
        );
    }
    return (
        <div className="sb-field">
            <label htmlFor={id}>{field.label}</label>
            {field.type === 'select' ? <div className="sb-selwrap">{control}</div> : control}
        </div>
    );
}
