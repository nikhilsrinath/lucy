import React, { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { orgStore } from '../services/orgStore';
import { docNumber as docNo } from '../services/documentStore';
import {
    cashPosition, profitAndLoss, taxSummary, sixMonthSeries, periodBounds, balanceOf, isOverdue, todayIso,
} from '../services/financeAnalytics';
import { categoryLabel, methodLabel, rowTreatment } from '../services/financeCategories';
import { useAssistant } from '../components/assistant/assistantStore';
import { useShell } from '../shell/shellContext';
import { Button, Badge, Card, ListRow, ListHeader, PageHeader, KpiStrip, Segmented, Sheet, IconTile, Initials } from '../design/ui';
import { IconIn, IconOut, IconDoc, IconPlus, IconChat } from '../design/icons';
import { inr } from '../chat/brief';
import { useMoneyData, docClient } from './useMoneyData';
import DocSheet from './DocSheet';
import EntrySheet from './EntrySheet';
import BillSheet from './BillSheet';
import ItemSheet from './ItemSheet';
import { statusOf, blankEntry, blankBill, blankItem } from './blanks';
import '../chat/chat.css';
import './money.css';

/* ══════════════════════════════════════════════════════════════════════════
   Money — transactions, invoices & quotes, bills, items and reports, over
   the same rows and rules as before (orgStore sections; financeAnalytics for
   every figure). Nothing here computes a number the rest of the app doesn't:
     Net cash  cashPosition().net            (the brief and the old hub)
     Earned    profitAndLoss().income         net of GST, this month
     Spent     profitAndLoss().expenses       net of GST, this month
   ══════════════════════════════════════════════════════════════════════════ */

const TABS = [
    { id: 'transactions', label: 'Transactions' },
    { id: 'invoices', label: 'Invoices & quotes' },
    { id: 'bills', label: 'Bills' },
    { id: 'items', label: 'Items' },
    { id: 'reports', label: 'Reports' },
];
const fmt = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');
const PAGE = 60;

export default function MoneyScreen() {
    const { tab = 'transactions' } = useParams();
    const [params, setParams] = useSearchParams();
    const navigate = useNavigate();
    const a = useAssistant();
    const shell = useShell();
    const data = useMoneyData();
    const { docs, income, expenses, purchases, vendors, catalog, byId } = data;
    const [note, setNote] = useState('');
    const [sheet, setSheet] = useState(null);   // { kind, value }
    const [newOpen, setNewOpen] = useState(false);
    const notify = (m) => { if (!m) return; setNote(m); setTimeout(() => setNote(''), 2600); };

    const now = new Date();
    const seeAll = ['financial_documents', 'income_entries', 'expenses', 'purchase_invoices'].every((r) => orgStore.can(r, 'view'));
    const figures = useMemo(() => {
        const at = new Date();
        const month = periodBounds('month', at);
        const prevFrom = periodBounds('month', new Date(at.getFullYear(), at.getMonth() - 1, 1)).from;
        const d = new Date(at.getFullYear(), at.getMonth() - 1, at.getDate());
        const prevSameDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const set = { docs, purchases, expenses, income };
        const pl = profitAndLoss(set, month.from, month.to);
        const prev = profitAndLoss(set, prevFrom, prevSameDay);
        const top = pl.byGroup[0];
        return {
            net: cashPosition({ finDocs: docs, income, expenses, purchases }).net,
            pl, prev,
            topShare: top && pl.expenses > 0 ? { name: top.name, pct: Math.round((top.value / pl.expenses) * 100) } : null,
            gst: taxSummary({ docs, purchases, expenses, income, vendors }, month.from, month.to).netPayable,
            series: sixMonthSeries(set),
        };
    }, [docs, purchases, expenses, income, vendors]);

    const pct = (x, y) => (y > 0 ? Math.round(((x - y) / y) * 100) : null);
    const earnedDelta = pct(figures.pl.income, figures.prev.income);

    // ?doc=<id> opens a document; the agent's and the brief's links land here.
    const openDocId = params.get('doc');
    const openDoc = openDocId ? docs.find((d) => d.id === openDocId) : null;
    const closeDoc = () => { const n = new URLSearchParams(params); n.delete('doc'); setParams(n, { replace: true }); };

    const counts = {
        invoices: docs.filter((d) => d.status !== 'cancelled' && d.status !== 'converted').length,
        bills: purchases.filter((b) => b.status !== 'void' && b.status !== 'paid').length,
    };

    const ask = (text) => { navigate('/chat'); a.send(text); };

    return (
        <div className="sb-scroll">
            <div className="sb-page">
                <PageHeader title="Money" sub={now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
                    actions={(
                        <>
                            {shell.brainBuilt && <Button onClick={() => ask('How did we do this month?')}><IconChat size={14} /><span className="lbl">Ask</span></Button>}
                            <Button variant="primary" onClick={() => setNewOpen(true)}><IconPlus /><span className="lbl">New</span></Button>
                        </>
                    )} />

                {seeAll && (
                    <KpiStrip items={[
                        { label: 'Net cash', value: inr(figures.net), sub: 'Recorded money in, less out', tone: figures.net >= 0 ? 'g' : 'r' },
                        { label: 'Earned this month', value: inr(figures.pl.income), sub: earnedDelta === null ? 'Net of GST' : `${earnedDelta >= 0 ? '↑' : '↓'} ${Math.abs(earnedDelta)}% vs last month so far` },
                        { label: 'Spent this month', value: inr(figures.pl.expenses), sub: figures.topShare ? `${figures.topShare.name} is ${figures.topShare.pct}%` : 'Net of GST' },
                    ]} />
                )}

                <div className="sb-tabs" role="tablist" aria-label="Money">
                    {TABS.map((t) => (
                        <Link key={t.id} to={`/money/${t.id}`} role="tab" aria-selected={tab === t.id} aria-current={tab === t.id ? 'page' : undefined}>
                            {t.label}{counts[t.id] ? <span className="c">{counts[t.id]}</span> : null}
                        </Link>
                    ))}
                </div>

                {tab === 'transactions' && <Transactions data={data} onOpen={(e) => setSheet({ kind: 'entry', value: { ...e, date: e.day } })} />}
                {tab === 'invoices' && <Documents docs={docs} type={params.get('type') || 'all'} setType={(t) => setParams(t === 'all' ? {} : { type: t })}
                    onOpen={(d) => setParams((p) => { const n = new URLSearchParams(p); n.set('doc', d.id); return n; })} />}
                {tab === 'bills' && <Bills bills={purchases} vendorsById={byId.vendor} onOpen={(b) => setSheet({ kind: 'bill', value: b })} />}
                {tab === 'items' && <Items items={catalog} onOpen={(p) => setSheet({ kind: 'item', value: p })} />}
                {tab === 'reports' && <Reports figures={figures} />}
            </div>

            <Sheet open={newOpen} onClose={() => setNewOpen(false)} title="Add to Money">
                <Card list>
                    {[
                        ['Invoice', 'A tax invoice to bill a client', () => navigate('/money/invoices/new?type=invoice'), 'financial_documents'],
                        ['Quote', 'A quotation the client can accept online', () => navigate('/money/invoices/new?type=quotation'), 'financial_documents'],
                        ['Proforma', 'Ask for an advance before the tax invoice', () => navigate('/money/invoices/new?type=proforma'), 'financial_documents'],
                        ['Money in', 'Anything received without an invoice', () => setSheet({ kind: 'entry', value: blankEntry('in') }), 'income_entries'],
                        ['Expense', 'Anything paid without a vendor bill', () => setSheet({ kind: 'entry', value: blankEntry('out') }), 'expenses'],
                        ['Bill', 'A bill from a vendor, to pay later', () => setSheet({ kind: 'bill', value: blankBill() }), 'purchase_invoices'],
                        ['Item', 'Something you sell, with its price and GST', () => setSheet({ kind: 'item', value: blankItem() }), 'catalog_items'],
                    ].filter(([, , , r]) => orgStore.can(r, 'create')).map(([t, s, go]) => (
                        <ListRow key={t} title={t} sub={s} onClick={() => { setNewOpen(false); go(); }} />
                    ))}
                </Card>
                <p className="sb-acnote">Or tell your cofounder in the chat, for example “spent 4,500 on chairs yesterday”.</p>
            </Sheet>

            {openDoc && <DocSheet key={openDoc.id} doc={openDoc} activeOrg={data.activeOrg} onClose={closeDoc} notify={notify} />}
            {sheet?.kind === 'entry' && <EntrySheet entry={sheet.value} data={data} onClose={() => setSheet(null)} onSaved={notify} />}
            {sheet?.kind === 'bill' && <BillSheet bill={sheet.value} vendors={vendors} onClose={() => setSheet(null)} notify={notify} />}
            {sheet?.kind === 'item' && <ItemSheet item={sheet.value} onClose={() => setSheet(null)} notify={notify} />}
            {note && <div className="sb sb-toast" role="status">{note}</div>}
        </div>
    );
}

/* ── Transactions ─────────────────────────────────────────────────────── */

function Transactions({ data, onOpen }) {
    const { income, expenses, byId, catsReady } = data;
    const [view, setView] = useState('all');
    const [q, setQ] = useState('');
    const [shown, setShown] = useState(PAGE);
    const rows = useMemo(() => {
        const party = (e, dir) => (dir === 'in'
            ? byId.client[e.client_id]?.name
            : byId.vendor[e.vendor_id]?.company_name || byId.employee[e.employee_id]?.name);
        return [
            ...income.map((e) => ({ ...e, direction: 'in', day: e.date || e.received_on, party: party(e, 'in'), treatment: rowTreatment(e, 'in') })),
            ...expenses.map((e) => ({ ...e, direction: 'out', day: e.date || e.incurred_on, party: party(e, 'out'), treatment: rowTreatment(e, 'out') })),
        ].sort((x, y) => String(y.day).localeCompare(String(x.day)));
    }, [income, expenses, byId]);
    const needle = q.trim().toLowerCase();
    const list = rows
        .filter((r) => view === 'all' || r.direction === view)
        .filter((r) => !needle || [r.description, r.party, r.reference, categoryLabel(r.category)].some((f) => String(f || '').toLowerCase().includes(needle)));

    return (
        <>
            <div className="sb-toolbar">
                <input className="sb-search" type="search" placeholder="Search transactions" aria-label="Search transactions" value={q} onChange={(e) => setQ(e.target.value)} />
                <Segmented label="Show" value={view} onChange={setView} options={[{ value: 'all', label: 'All' }, { value: 'in', label: 'In' }, { value: 'out', label: 'Out' }]} />
            </div>
            <Card list>
                {list.length === 0 && <div className="sb-empty">{rows.length ? 'Nothing matches.' : 'No money recorded yet. Tell your cofounder, or tap New.'}</div>}
                {list.slice(0, shown).map((r) => (
                    <ListRow key={`${r.direction}-${r.id}`} onClick={() => onOpen(r)}
                        lead={<IconTile tone={r.direction === 'in' ? 'g' : 'n'}>{r.direction === 'in' ? <IconIn /> : <IconOut />}</IconTile>}
                        title={r.party || r.description}
                        sub={[fmt(r.day), methodLabel(r.payment_method), catsReady ? categoryLabel(r.category) : '', r.status === 'pending' ? 'Not paid yet' : '', r.party ? r.description : ''].filter(Boolean).join(' · ')}
                        amount={`${r.direction === 'in' ? '+' : '−'}${inr(r.amount)}`} amountIn={r.direction === 'in'} />
                ))}
            </Card>
            {list.length > shown && <div style={{ textAlign: 'center', marginTop: 12 }}><Button onClick={() => setShown((n) => n + PAGE)}>Show more</Button></div>}
        </>
    );
}

/* ── Invoices & quotes ────────────────────────────────────────────────── */

function Documents({ docs, type, setType, onOpen }) {
    const [q, setQ] = useState('');
    const [showDone, setShowDone] = useState(false);
    const needle = q.trim().toLowerCase();
    const list = docs
        .filter((d) => type === 'all' || d.type === type)
        .filter((d) => !needle || [docNo(d), docClient(d)].some((f) => String(f || '').toLowerCase().includes(needle)))
        .sort((x, y) => String(y.issue_date || y.created_at).localeCompare(String(x.issue_date || x.created_at)));

    const awaiting = list.filter((d) => (d.type === 'invoice' && !['draft', 'cancelled', 'paid'].includes(d.status) && balanceOf(d) > 0.009)
        || (d.type === 'proforma' && ['sent', 'viewed', 'order_confirmed', 'payment_submitted'].includes(d.status)));
    const quotes = list.filter((d) => d.type === 'quotation' && ['sent', 'viewed', 'revision_requested', 'accepted'].includes(d.status));
    const drafts = list.filter((d) => d.status === 'draft');
    const taken = new Set([...awaiting, ...quotes, ...drafts].map((d) => d.id));
    const done = list.filter((d) => !taken.has(d.id));
    awaiting.sort((x, y) => (isOverdue(y) ? 1 : 0) - (isOverdue(x) ? 1 : 0));

    const row = (d) => {
        const [tone, label] = statusOf(d);
        return (
            <ListRow key={d.id} onClick={() => onOpen(d)} lead={<IconTile><IconDoc /></IconTile>}
                title={docClient(d)}
                sub={`${d.type === 'quotation' ? 'Quote' : d.type === 'proforma' ? 'Proforma' : 'Invoice'} ${docNo(d) || '(draft)'} · ${d.type === 'quotation' ? (d.valid_until ? `valid till ${fmt(d.valid_until)}` : fmt(d.issue_date)) : d.due_date ? `due ${fmt(d.due_date)}` : fmt(d.issue_date)}`}
                trail={<Badge tone={tone} className="hide-m">{label}</Badge>}
                amount={inr(d.type === 'invoice' && balanceOf(d) > 0 && d.status !== 'draft' ? balanceOf(d) : d.grand_total ?? d.amount)} />
        );
    };
    const group = (title, items) => (items.length ? (
        <React.Fragment key={title}>
            <ListHeader count={items.length}>{title}</ListHeader>
            <Card list>{items.map(row)}</Card>
        </React.Fragment>
    ) : null);

    return (
        <>
            <div className="sb-toolbar">
                <input className="sb-search" type="search" placeholder="Search by client or number" aria-label="Search documents" value={q} onChange={(e) => setQ(e.target.value)} />
                <Segmented label="Type" value={type} onChange={setType}
                    options={[{ value: 'all', label: 'All' }, { value: 'invoice', label: 'Invoices' }, { value: 'quotation', label: 'Quotes' }, { value: 'proforma', label: 'Proformas' }]} />
            </div>
            {!awaiting.length && !quotes.length && !drafts.length && !done.length && <Card><div className="sb-empty">No documents yet. Ask your cofounder to “invoice Acme 50k for the website”, or tap New.</div></Card>}
            {group('Awaiting payment', awaiting)}
            {group('Quotes out', quotes)}
            {group('Drafts', drafts)}
            {done.length > 0 && (showDone
                ? group('Completed and closed', done)
                : <div style={{ marginTop: 16 }}><Button variant="ghost" onClick={() => setShowDone(true)}>Show completed ({done.length})</Button></div>)}
        </>
    );
}

/* ── Bills ────────────────────────────────────────────────────────────── */

function Bills({ bills, vendorsById, onOpen }) {
    const today = todayIso();
    const [showDone, setShowDone] = useState(false);
    const bal = (b) => Math.max(0, (Number(b.total) || 0) - (Number(b.amount_paid) || 0));
    const sorted = bills.slice().sort((x, y) => String(y.bill_date).localeCompare(String(x.bill_date)));
    const open = sorted.filter((b) => b.status !== 'void' && bal(b) > 0.009);
    const closed = sorted.filter((b) => !open.includes(b));
    const row = (b) => {
        const late = b.due_date && b.due_date < today;
        const [tone, label] = b.status === 'void' ? ['n', 'Void'] : bal(b) <= 0.009 ? ['g', 'Paid'] : late ? ['r', 'Overdue'] : Number(b.amount_paid) > 0 ? ['a', 'Part paid'] : ['a', 'To pay'];
        const vendor = vendorsById[b.vendor_id]?.company_name || 'Vendor';
        return (
            <ListRow key={b.id} onClick={() => onOpen(b)} lead={<Initials name={vendor} />} title={vendor}
                sub={[b.bill_number, b.due_date && bal(b) > 0.009 ? `due ${fmt(b.due_date)}` : fmt(b.bill_date), Number(b.tax_amount) > 0 ? `${inr(b.tax_amount)} input GST` : ''].filter(Boolean).join(' · ')}
                trail={<Badge tone={tone} className="hide-m">{label}</Badge>} amount={inr(b.total)} />
        );
    };
    return (
        <>
            {!bills.length && <Card><div className="sb-empty">No vendor bills yet. Tell your cofounder “got Dell's bill for 85k”, or tap New.</div></Card>}
            {open.length > 0 && <><ListHeader count={open.length}>To pay</ListHeader><Card list>{open.map(row)}</Card></>}
            {closed.length > 0 && (showDone
                ? <><ListHeader count={closed.length}>Paid and void</ListHeader><Card list>{closed.map(row)}</Card></>
                : <div style={{ marginTop: 16 }}><Button variant="ghost" onClick={() => setShowDone(true)}>Show paid ({closed.length})</Button></div>)}
        </>
    );
}

/* ── Items ────────────────────────────────────────────────────────────── */

function Items({ items, onOpen }) {
    const [archived, setArchived] = useState(false);
    const list = items.filter((p) => !!p.archived_at === archived).sort((x, y) => String(x.name).localeCompare(String(y.name)));
    return (
        <>
            <Card list>
                {!list.length && <div className="sb-empty">{archived ? 'Nothing archived.' : 'No items yet. Add what you sell, and invoices can pick it with its price and GST.'}</div>}
                {list.map((p) => (
                    <ListRow key={p.id} onClick={() => onOpen(p)} lead={<IconTile>#</IconTile>} title={p.name}
                        sub={[p.unit ? `per ${p.unit}` : '', `GST ${Number(p.tax_rate) || 0}%`, p.hsn_sac ? `HSN/SAC ${p.hsn_sac}` : '', p.track_inventory ? `${Number(p.stock_qty) || 0} in stock` : ''].filter(Boolean).join(' · ')}
                        amount={inr(p.unit_price)} />
                ))}
            </Card>
            <div style={{ marginTop: 12 }}><Button variant="ghost" onClick={() => setArchived((v) => !v)}>{archived ? 'Show active items' : 'Show archived'}</Button></div>
        </>
    );
}

/* ── Reports ──────────────────────────────────────────────────────────── */

function Reports({ figures }) {
    const { series, pl, gst } = figures;
    const peak = Math.max(1, ...series.flatMap((m) => [m.income, m.expenses]));
    const last = series[series.length - 1];
    const lakh = (v) => (Math.abs(v) >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : inr(v));
    return (
        <>
            <Card className="sb-chart">
                <div className="ch">
                    <div><b>Earned and spent</b><small>Last 6 months, net of GST</small></div>
                    <div className="sb-legend"><span><i style={{ background: 'var(--ink)' }} />Earned</span><span><i style={{ background: '#DAD8D2' }} />Spent</span></div>
                </div>
                <div className="sb-bars" role="img" aria-label={series.map((m) => `${m.month}: earned ${inr(m.income)}, spent ${inr(m.expenses)}`).join('; ')}>
                    {series.map((m, i) => (
                        <div key={m.month} className={i === series.length - 1 ? 'cur' : undefined}>
                            {i === series.length - 1 && <span className="tip">In {lakh(last.income)} · Out {lakh(last.expenses)}</span>}
                            <i className="in" style={{ height: `${(m.income / peak) * 100}%` }} />
                            <i style={{ height: `${(m.expenses / peak) * 100}%` }} />
                        </div>
                    ))}
                </div>
                <div className="sb-xl" aria-hidden="true">{series.map((m) => <span key={m.month}>{m.month}</span>)}</div>
            </Card>
            <ListHeader>{new Date().toLocaleDateString('en-IN', { month: 'long' })} so far</ListHeader>
            <Card list>
                <div className="sb-kvr"><span>Earned</span><b>{inr(pl.income)}</b></div>
                <div className="sb-kvr"><span>Spent</span><b>{inr(pl.expenses)}</b></div>
                <div className="sb-kvr tot"><span>Profit</span><b>{inr(pl.net)}</b></div>
                <div className="sb-kvr"><span>{gst >= 0 ? 'GST payable (estimate)' : 'GST input credit'}</span><b>{inr(Math.abs(gst))}</b></div>
            </Card>
            <p className="sb-acnote">GST here is a preparation aid, not a filing. Reconcile with GSTR-2B and your accountant before you file.</p>
        </>
    );
}
