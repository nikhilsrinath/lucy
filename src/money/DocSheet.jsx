import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { docNumber as docNo } from '../services/documentStore';
import { orgStore } from '../services/orgStore';
import { isOverdue, daysOverdue, balanceOf } from '../services/financeAnalytics';
import { conversionTargets, recommendTarget } from '../services/documentConversion';
import { advanceOf, DEFAULT_ADVANCE_PERCENT } from '../services/proformaAdvance';
import { canCreateProjects } from '../services/projectService';
import { Sheet, Button, Badge, Card, Field } from '../design/ui';
import { inr } from '../chat/brief';
import { docClient } from './useMoneyData';
import * as act from './docActions';
import { statusOf } from './blanks';

/* ══════════════════════════════════════════════════════════════════════════
   One invoice, quotation or proforma — the mockup's document sheet over the
   real document: its status track, lines and totals (as the database computed
   them), payments, and every action the old list offered, each gated by the
   same rules (documentLifecycle, documentConversion, permissions).
   "Client view" opens the real portal link, minted for this document.
   ══════════════════════════════════════════════════════════════════════════ */

const TRACKS = {
    quotation: [['Draft', ['draft']], ['Sent', ['sent']], ['Viewed', ['viewed', 'revision_requested', 'declined']], ['Accepted', ['accepted', 'converted']]],
    invoice: [['Draft', ['draft']], ['Sent', ['sent', 'overdue']], ['Viewed', ['viewed', 'payment_submitted', 'partially_paid']], ['Paid', ['paid']]],
    proforma: [['Draft', ['draft']], ['Sent', ['sent', 'viewed']], ['Confirmed', ['order_confirmed', 'payment_submitted']], ['Advance paid', ['advance_paid', 'converted', 'paid']]],
};
const stepOf = (d) => {
    const track = TRACKS[d.type] || TRACKS.invoice;
    const i = track.findIndex(([, sts]) => sts.includes(d.status));
    return i < 0 ? 0 : i;
};
const fmt = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export default function DocSheet({ doc, activeOrg, onClose, notify }) {
    const navigate = useNavigate();
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [panel, setPanel] = useState(null);           // 'pay' | 'reject' | 'cancel' | 'convert'
    const [pay, setPay] = useState('');
    const [text, setText] = useState('');
    const [target, setTarget] = useState(null);
    const [percent, setPercent] = useState('');

    const [tone, label] = statusOf(doc);
    const track = TRACKS[doc.type] || TRACKS.invoice;
    const at = stepOf(doc);
    const canEdit = orgStore.can('financial_documents', 'edit');
    const canDelete = orgStore.can('financial_documents', 'delete');
    const life = useMemo(() => act.lifecycle(doc), [doc]);
    const targets = conversionTargets(doc);
    const outstanding = doc.type === 'invoice' ? balanceOf(doc) : 0;
    const cur = (v) => inr(v);

    const run = async (key, fn, { close = false } = {}) => {
        setBusy(key);
        setError('');
        try {
            const msg = await fn();
            if (msg) notify?.(typeof msg === 'string' ? msg : msg.message);
            setPanel(null);
            if (close) onClose();
            return msg;
        } catch (err) {
            setError(err?.message || 'That did not work.');
            return null;
        } finally {
            setBusy('');
        }
    };

    const openPortal = () => run('view', async () => {
        const link = await act.portalLink(doc);
        window.open(link.url, '_blank', 'noopener');
        return '';
    });
    const copyLink = () => run('copy', async () => {
        const link = await act.portalLink(doc);
        await navigator.clipboard.writeText(link.url);
        return 'Link copied. It opens only this document.';
    });
    const startConvert = () => {
        const rec = recommendTarget(doc, []);
        setTarget(targets.includes(rec.target) ? rec.target : targets[0]);
        const p = doc.advance_percent;
        setPercent(String(p === null || p === undefined || p === '' ? DEFAULT_ADVANCE_PERCENT : p));
        setPanel('convert');
    };
    const doConvert = () => run('convert', async () => {
        const pct = Math.min(100, Math.max(0, Number(percent) || 0));
        const { built, message } = await act.convert(doc, target, target === 'proforma' ? { advancePercent: pct } : {});
        notify?.(message);
        navigate(`/money/invoices?doc=${built.id}`, { replace: true });
        return '';
    });

    /* ── actions, by type and state ─────────────────────────────────────── */
    const A = [];
    const add = (key, labelText, onClick, primary = false, extra = {}) => A.push({ key, label: labelText, onClick, primary, ...extra });

    if (doc.status === 'payment_submitted' && canEdit) {
        add('verify', doc.type === 'proforma' ? 'Verify advance' : 'Verify payment', () => run('verify', () => act.verifyPayment(doc)), true);
        add('reject', 'Reject claim', () => { setText(''); setPanel('reject'); });
    }
    if (doc.type === 'invoice' && isOverdue(doc) && (doc.clientEmail || doc.client?.email)) {
        add('remind', 'Send reminder', () => run('remind', () => act.sendReminder(doc)), !A.length);
    }
    if (doc.type === 'invoice' && !['paid', 'cancelled', 'draft'].includes(doc.status) && outstanding > 0) {
        add('pay', 'Record payment', () => { setPay(String(outstanding)); setPanel('pay'); }, !A.length);
    }
    if (targets.length) {
        add('convert', doc.type === 'proforma' ? 'Convert to invoice' : 'Convert', startConvert, !A.length);
    }
    if (doc.type === 'quotation' && targets.includes('proforma')) {
        add('advance', 'Request advance', () => { startConvert(); setTarget('proforma'); });
    }
    if (doc.type === 'quotation' && ['draft', 'sent', 'viewed', 'revision_requested', 'declined'].includes(doc.status) && canEdit) {
        add('edit', doc.status === 'draft' ? 'Edit quote' : 'Revise quote', () => navigate(`/money/invoices/${doc.id}/edit`), !A.length);
    }
    if (doc.type === 'proforma' && doc.status === 'draft' && canEdit) {
        add('edit', 'Continue editing', () => navigate(`/money/invoices/${doc.id}/edit?type=proforma`), !A.length);
    }
    if (doc.type === 'quotation' && doc.status === 'accepted' && canCreateProjects()) {
        add('project', 'Start project', () => navigate(`/work?newProject=1&fromQuotation=${doc.id}`));
    }
    add('pdf', 'Download PDF', () => run('pdf', async () => { await act.downloadPdf(doc, activeOrg); return ''; }), !A.length);
    if (doc.status !== 'draft') add('view', 'Client view', openPortal);
    add('copy', doc.status === 'draft' ? 'Share link' : 'Copy link', copyLink);
    if (doc.customer_id) add('client', 'Open client', () => navigate(`/clients?client=${doc.customer_id}`));
    if (doc.status !== 'cancelled') {
        if (life.delete.allowed && canDelete) add('delete', 'Delete draft', () => run('delete', () => act.deleteDraft(doc), { close: true }), false, { danger: true });
        else if (canEdit) add('cancel', `Cancel ${doc.type === 'invoice' ? 'invoice' : doc.type === 'quotation' ? 'quote' : 'proforma'}`,
            () => { if (!life.cancel.allowed) { setError(life.cancel.reason); return; } setText(''); setPanel('cancel'); }, false, { danger: true });
    }

    const lines = doc.items || [];
    const gst = Number(doc.gst_amount ?? doc.gst) || 0;
    const gstRate = Number(doc.gst_rate ?? doc.gstRate) || 0;
    const adv = doc.type === 'proforma' ? advanceOf(doc) : null;

    return (
        <Sheet open onClose={onClose} className="nb-sheet" title={`${act.typeLabel(doc.type)} ${docNo(doc) || '(draft)'}`}>
            {error && <div className="sb-err" role="alert">{error}</div>}

            <Card className="sb-dsum">
                <div className="top2">
                    <div><b>{docClient(doc)}</b><small>{metaOf(doc)}</small></div>
                    <Badge tone={tone}>{label}</Badge>
                </div>
                <div className="sb-big sb-num">{cur(doc.grand_total ?? doc.amount)}</div>
                <div className="sb-prog" aria-label={`Progress: ${track[at][0]}`}>
                    {track.map(([name], i) => <span key={name} className={i <= at && doc.status !== 'cancelled' ? 'on' : undefined}><i />{name}</span>)}
                </div>
                {(doc.type === 'invoice' && Number(doc.amount_paid) > 0) || adv ? (
                    <div className="sb-two">
                        {doc.type === 'invoice' && <><div><small>Paid</small><b>{cur(doc.amount_paid)}</b></div><div><small>Outstanding</small><b style={outstanding > 0 ? { color: 'var(--r-tx)' } : undefined}>{cur(outstanding)}</b></div></>}
                        {adv && <><div><small>Advance ({adv.percent}%)</small><b>{cur(adv.advance)}</b></div><div><small>Balance on delivery</small><b>{cur(adv.balance)}</b></div></>}
                    </div>
                ) : null}
            </Card>

            {panel === 'pay' && (
                <Card style={{ padding: 16 }}>
                    <div className="sb-inline">
                        <Field label="Amount received (₹)" hint={`Outstanding ${cur(outstanding)}`}>
                            <input type="number" inputMode="decimal" min="0.01" step="0.01" value={pay} onChange={(e) => setPay(e.target.value)} data-autofocus />
                        </Field>
                        <Button variant="primary" disabled={busy === 'pay'} onClick={() => run('pay', () => act.recordPayment(doc, { amount: pay }))}>
                            {busy === 'pay' ? 'Saving…' : 'Record'}
                        </Button>
                        <Button variant="ghost" onClick={() => setPanel(null)}>Cancel</Button>
                    </div>
                </Card>
            )}
            {(panel === 'reject' || panel === 'cancel') && (
                <Card style={{ padding: 16 }}>
                    <p className="sb-say quiet">
                        {panel === 'reject'
                            ? 'The claimed payment is removed and the document goes back to waiting for payment.'
                            : doc.type === 'invoice'
                                ? 'The invoice keeps its number and is marked cancelled. It stops counting towards revenue, receivables and GST.'
                                : 'It is marked cancelled and the client can no longer act on it from their link.'}
                    </p>
                    <Field label="Reason (optional)"><textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} /></Field>
                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                        <Button variant="danger" disabled={!!busy} onClick={() => run(panel, () => (panel === 'reject' ? act.rejectPayment(doc, text) : act.cancelDocument(doc, text)))}>
                            {panel === 'reject' ? 'Reject claim' : 'Cancel it'}
                        </Button>
                        <Button variant="ghost" onClick={() => setPanel(null)}>Keep it</Button>
                    </div>
                </Card>
            )}
            {panel === 'convert' && (
                <Card style={{ padding: 16 }}>
                    <div className="sb-choices" role="radiogroup" aria-label="Convert to">
                        {targets.map((t) => (
                            <button key={t} type="button" role="radio" aria-checked={target === t} className="sb-choice" onClick={() => setTarget(t)}>
                                <span>
                                    {t === 'proforma' ? 'Proforma invoice' : 'Tax invoice'}
                                    <small>{t === 'proforma'
                                        ? 'The client confirms and pays an advance through their link. The tax invoice follows, with the advance set against it.'
                                        : 'Bill now. The invoice is dated today and the full amount becomes receivable once sent.'}</small>
                                </span>
                            </button>
                        ))}
                    </div>
                    {target === 'proforma' && (
                        <Field label="Advance %" hint={`Advance ${cur(advanceOf({ grand_total: doc.grand_total ?? doc.amount, advance_percent: Math.min(100, Math.max(0, Number(percent) || 0)) }).advance)}`}>
                            <input type="number" min="0" max="100" step="any" value={percent} onChange={(e) => setPercent(e.target.value)} />
                        </Field>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                        <Button variant="primary" disabled={busy === 'convert' || !target} onClick={doConvert}>
                            {busy === 'convert' ? 'Converting…' : `Create ${target === 'proforma' ? 'proforma' : 'invoice'}`}
                        </Button>
                        <Button variant="ghost" onClick={() => setPanel(null)}>Cancel</Button>
                    </div>
                </Card>
            )}

            <div className="sb-dsec">
                <h5>Line items</h5>
                <Card list>
                    {lines.map((it, i) => {
                        const amt = (Number(it.quantity) || 0) * (Number(it.rate) || Number(it.price) || 0);
                        return <div key={i} className="sb-kvr"><span>{it.description || 'Item'}{Number(it.quantity) !== 1 ? ` × ${it.quantity}` : ''}</span><b>{cur(amt)}</b></div>;
                    })}
                    {gst > 0 && <div className="sb-kvr"><span>{doc.is_inter_state || doc.isInterState ? `IGST ${gstRate}%` : `CGST + SGST ${gstRate}%`}</span><b>{cur(gst)}</b></div>}
                    <div className="sb-kvr tot"><span>Total</span><b>{cur(doc.grand_total ?? doc.amount)}</b></div>
                    <div className="sb-kvr"><span>{doc.type === 'quotation' ? 'Valid until' : 'Due'}</span><b>{fmt(doc.valid_until || doc.due_date)}</b></div>
                </Card>
            </div>

            {(doc.payments || []).length > 0 && (
                <div className="sb-dsec">
                    <h5>Payments</h5>
                    <Card list>
                        {doc.payments.map((p) => (
                            <div key={p.id} className="sb-kvr">
                                <span>{fmt(p.paid_on || p.created_at)} · {p.method || 'Payment'}{p.confirmed_at ? '' : ' · awaiting check'}{p.note === 'Recorded by EdgeAI' ? ' · by your cofounder' : ''}</span>
                                <b>{cur(p.amount)}</b>
                            </div>
                        ))}
                    </Card>
                </div>
            )}

            {doc.status === 'revision_requested' && doc.revision_notes && <div className="sb-note">{doc.revision_notes}<small>Changes the client asked for</small></div>}
            {doc.status === 'declined' && doc.decline_reason && <div className="sb-note">{doc.decline_reason}<small>Why the client declined</small></div>}

            <div className="sb-dacts">
                {A.map((a) => (
                    <Button key={a.key} variant={a.primary ? 'primary' : a.danger ? 'danger' : 'secondary'} onClick={a.onClick} disabled={!!busy}>
                        {busy === a.key ? 'Working…' : a.label}
                    </Button>
                ))}
            </div>
            {doc.status !== 'draft' && <div className="sb-note b">The client link needs no login. It opens only this document, and you can revoke it at any time.</div>}
        </Sheet>
    );
}

function metaOf(d) {
    if (d.status === 'cancelled') return 'Cancelled';
    if (d.type === 'invoice') {
        if (d.status === 'paid') return 'Paid in full';
        if (isOverdue(d)) return `Due ${fmt(d.due_date)}, ${daysOverdue(d)} days overdue`;
        return d.due_date ? `Due ${fmt(d.due_date)}` : 'No due date';
    }
    if (d.type === 'quotation') return d.valid_until ? `Valid until ${fmt(d.valid_until)}` : 'Quotation';
    return d.due_date ? `Due ${fmt(d.due_date)}` : 'Proforma';
}
