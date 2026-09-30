import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { orgStore } from '../services/orgStore';
import { docNumber as docNo } from '../services/documentStore';
import { cashPosition, profitAndLoss, periodBounds, issuedInvoices, balanceOf, isOverdue, todayIso } from '../services/financeAnalytics';
import { categoryLabel } from '../services/financeCategories';
import { useAssistant } from '../components/assistant/assistantStore';
import { useShell } from '../shell/shellContext';
import { useSectionList } from '../shell/useSectionList';
import { useCofounder } from '../design/useCofounder';
import { IconIn, IconOut, IconPlus, IconChevronRight, IconFile, IconSparkle, IconLock, IconAlert } from '../design/icons';
import { inr } from '../chat/brief';
import { useMoneyData, docClient } from '../money/useMoneyData';
import BusinessNav from './BusinessNav';
import { useAddFlow } from './useAddFlow';
import '../money/money.css';
import './business.css';

/* ══════════════════════════════════════════════════════════════════════════
   Business — the overview of the hub that gathers Money and Clients.

   Figures are financeAnalytics', as everywhere (Net cash = cashPosition().net;
   To collect = the balance on issued invoices; To pay = the balance on open
   vendor bills). Lists are the same rows Money and Clients show; every row
   opens its record there. Quick actions and the New button share one list
   (useAddFlow), and the cofounder's asks go to Buddy.

   Styled neobrutalist in business.css, scoped under `.nb`.
   ══════════════════════════════════════════════════════════════════════════ */

const STAGES = [
    { id: 'lead', label: 'Lead' },
    { id: 'contacted', label: 'In talks' },
    { id: 'deal', label: 'Won' },
    { id: 'not_deal', label: 'Lost' },
];
const ASKS = [
    ['Who owes me money?', 'Who owes me money?'],
    ['Who should I follow up this week?', 'Which clients should I follow up with this week?'],
    ['Where did the money go this month?', 'Where did we spend money this month?'],
    ['Draft a quote', 'Make a quote'],
];
const fmt = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');
const billBalance = (b) => Math.max(0, (Number(b.total) || 0) - (Number(b.amount_paid) || 0));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** A round initials badge; the colour is stable per name so a client keeps it. */
function Ini({ name = '' }) {
    const ini = String(name).trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '·';
    const hue = [...String(name)].reduce((s, ch) => s + ch.charCodeAt(0), 0) % 4;
    return <span className={`nb-ini c${hue}`} aria-hidden="true">{ini}</span>;
}

function Row({ lead, title, sub, tag, amount, amountIn, late, onClick }) {
    return (
        <button type="button" className={`nb-row${late ? ' late' : ''}`} onClick={onClick}>
            {lead}
            <span className="t"><b>{title}</b>{sub && <small>{sub}</small>}</span>
            {tag && <span className="tag">{tag}</span>}
            {amount !== undefined
                ? <span className={`amt${amountIn ? ' in' : ''}`}>{amount}</span>
                : <span className="chev"><IconChevronRight /></span>}
        </button>
    );
}

function Panel({ id, title, count, link, tone, children }) {
    return (
        <section className={`nb-panel t-${tone}`} aria-labelledby={id}>
            <header>
                <h2 id={id}>{title}</h2>
                {count ? <span className="n">{count}</span> : null}
                {link && <Link to={link.to}>{link.label}<IconChevronRight size={12} /></Link>}
            </header>
            {children}
        </section>
    );
}

export default function BusinessScreen() {
    const navigate = useNavigate();
    const a = useAssistant();
    const shell = useShell();
    const { persona } = useCofounder();
    const data = useMoneyData();
    const { docs, income, expenses, purchases, byId, orgId } = data;
    const leads = useSectionList('crm_leads', orgId);
    const [note, setNote] = useState('');
    const notify = (m) => { if (!m) return; setNote(m); setTimeout(() => setNote(''), 2600); };
    const add = useAddFlow({ data, notify });

    const today = todayIso();
    const seeAll = ['financial_documents', 'income_entries', 'expenses', 'purchase_invoices'].every((r) => orgStore.can(r, 'view'));
    const seeDocs = orgStore.can('financial_documents', 'view');
    const seeBills = orgStore.can('purchase_invoices', 'view');
    const seeMoney = orgStore.can('income_entries', 'view') || orgStore.can('expenses', 'view');
    const seeClients = orgStore.can('clients', 'view');

    const owed = useMemo(() => issuedInvoices(docs).filter((d) => balanceOf(d) > 0.009)
        .sort((x, y) => (isOverdue(y, today) - isOverdue(x, today)) || balanceOf(y) - balanceOf(x)), [docs, today]);
    const owedTotal = owed.reduce((s, d) => s + balanceOf(d), 0);
    const lateCount = owed.filter((d) => isOverdue(d, today)).length;

    const toPay = useMemo(() => purchases.filter((b) => b.status !== 'void' && billBalance(b) > 0.009)
        .sort((x, y) => String(x.due_date || '9999').localeCompare(String(y.due_date || '9999'))), [purchases]);
    const toPayTotal = toPay.reduce((s, b) => s + billBalance(b), 0);
    const dueSoon = toPay.filter((b) => b.due_date && b.due_date <= today).length;

    const figures = useMemo(() => {
        const month = periodBounds('month', new Date());
        return {
            net: cashPosition({ finDocs: docs, income, expenses, purchases }).net,
            pl: profitAndLoss({ docs, purchases, expenses, income }, month.from, month.to),
        };
    }, [docs, income, expenses, purchases]);

    const recent = useMemo(() => [
        ...income.map((e) => ({ ...e, direction: 'in', day: e.date || e.received_on, party: byId.client[e.client_id]?.name })),
        ...expenses.map((e) => ({ ...e, direction: 'out', day: e.date || e.incurred_on, party: byId.vendor[e.vendor_id]?.company_name || byId.employee[e.employee_id]?.name })),
    ].sort((x, y) => String(y.day).localeCompare(String(x.day))).slice(0, 5), [income, expenses, byId]);

    const stageCount = Object.fromEntries(STAGES.map((s) => [s.id, leads.filter((l) => (l.stage || 'lead') === s.id).length]));
    const peak = Math.max(1, ...Object.values(stageCount));
    const openDeals = leads.filter((l) => ['lead', 'contacted'].includes(l.stage || 'lead'));
    const pipelineValue = openDeals.reduce((s, l) => s + (Number(l.value) || 0), 0);
    const inTalks = leads.filter((l) => l.stage === 'contacted').slice(0, 3);

    const ask = (text) => { navigate('/chat'); a.send(text); };
    const QUICK = ['invoice', 'quote', 'in', 'expense', 'bill', 'lead'];
    const quick = QUICK.map((id) => add.actions.find((x) => x.id === id)).filter(Boolean);

    const now = new Date();
    const monthName = now.toLocaleDateString('en-IN', { month: 'long' });
    const cashNeg = figures.net < 0;
    const plNeg = figures.pl.net < 0;

    return (
        <div className="sb-scroll nb">
            <div className="sb-page" style={{ maxWidth: 1120 }}>
                <header className="nb-head">
                    <div>
                        <h1>Business</h1>
                        <span className="when">{now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</span>
                    </div>
                    <div className="acts">
                        <button type="button" className="nb-btn nb-press" onClick={() => shell.openFiles()}>
                            <IconFile size={16} /><span className="lbl">Documents</span>
                        </button>
                        <button type="button" className="nb-btn p nb-press" onClick={add.open}>
                            <IconPlus size={14} /><span className="lbl">New</span>
                        </button>
                    </div>
                </header>

                <BusinessNav counts={{ invoices: lateCount }} />

                {seeAll && (
                    <section className="nb-ledger" aria-label="Where the money stands">
                        <button type="button" className={`nb-cash nb-press${cashNeg ? ' neg' : ''}`} onClick={() => navigate('/money/reports')}>
                            <span className="lbl">Net cash</span>
                            <span className="big nb-fig">{inr(figures.net)}</span>
                            <span className="foot">
                                <span className={`pl${plNeg ? ' neg' : ''}`}>
                                    {plNeg ? 'Loss' : 'Profit'} in {monthName}: {inr(Math.abs(figures.pl.net))}
                                </span>
                                <span className="go">Reports<IconChevronRight size={12} /></span>
                            </span>
                        </button>
                        <div className="nb-side">
                            <button type="button" className="nb-collect nb-press" onClick={() => navigate('/money/invoices?type=invoice')}>
                                <span className="top"><IconIn />To collect
                                    {lateCount > 0 && <span className="nb-flag"><IconAlert size={12} />{lateCount} late</span>}
                                </span>
                                <span className="val nb-fig">{inr(owedTotal)}</span>
                                <span className="note">{owed.length ? plural(owed.length, 'unpaid invoice', 'unpaid invoices') : 'Everyone has paid up'}</span>
                            </button>
                            <button type="button" className="nb-pay nb-press" onClick={() => navigate('/money/bills')}>
                                <span className="top"><IconOut />To pay
                                    {dueSoon > 0 && <span className="nb-flag warn">{dueSoon} due now</span>}
                                </span>
                                <span className="val nb-fig">{inr(toPayTotal)}</span>
                                <span className="note">{toPay.length ? plural(toPay.length, 'open bill', 'open bills') : 'No bills waiting'}</span>
                            </button>
                        </div>
                    </section>
                )}

                {quick.length > 0 && (
                    <section aria-labelledby="nb-qa">
                        <h2 id="nb-qa" className="nb-sec-h">Start something</h2>
                        <div className="nb-quick">
                            {quick.map((x) => {
                                const Icon = x.icon;
                                return (
                                    <button key={x.id} type="button" className="nb-press" onClick={x.run}>
                                        <span className={`nb-chip ${x.tone}`} aria-hidden="true"><Icon /></span>
                                        <span><b>{x.short}</b><small>{x.sub.split(',')[0]}</small></span>
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                )}

                {(seeDocs || seeClients) && (
                    <div className="nb-cols">
                        {seeDocs && (
                            <Panel id="nb-owed" title="Waiting to be paid" count={owed.length} tone="mint"
                                link={{ to: '/money/invoices?type=invoice', label: 'Invoices' }}>
                                {!owed.length && <p className="nb-empty">Nobody owes you money right now.</p>}
                                {owed.slice(0, 5).map((d) => {
                                    const late = isOverdue(d, today);
                                    return (
                                        <Row key={d.id} onClick={() => navigate(`/money/invoices?doc=${d.id}`)} lead={<Ini name={docClient(d)} />}
                                            title={docClient(d)} sub={`${docNo(d) || 'Invoice'}${d.due_date ? ` · due ${fmt(d.due_date)}` : ''}`}
                                            tag={late ? 'Overdue' : null} amount={inr(balanceOf(d))} late={late} />
                                    );
                                })}
                                {lateCount > 0 && (
                                    <div className="nb-foot">
                                        <span>{plural(lateCount, 'invoice is', 'invoices are')} overdue</span>
                                        <button type="button" onClick={() => ask('Draft reminders for my overdue invoices')}>Ask {persona.name} to chase</button>
                                    </div>
                                )}
                            </Panel>
                        )}

                        {seeClients && (
                            <Panel id="nb-pipe" title="Client pipeline" count={leads.length} tone="blue" link={{ to: '/clients', label: 'Board' }}>
                                <div className="nb-stages">
                                    {STAGES.map((s) => (
                                        <Link key={s.id} to="/clients" className={`s-${s.id}`} aria-label={`${s.label}: ${stageCount[s.id]}`}>
                                            <span className="sl">{s.label}</span>
                                            <span className="sv nb-fig">{stageCount[s.id]}</span>
                                            <span className="bar" aria-hidden="true"><i style={{ width: `${(stageCount[s.id] / peak) * 100}%` }} /></span>
                                        </Link>
                                    ))}
                                </div>
                                {inTalks.map((l) => (
                                    <Row key={l.id} onClick={() => navigate(`/clients?client=${l.id}`)} lead={<Ini name={l.name} />}
                                        title={l.name} sub={l.value ? `In talks, worth ${inr(l.value)}` : 'In talks'} />
                                ))}
                                <div className="nb-foot">
                                    <span>{pipelineValue > 0 ? `${inr(pipelineValue)} in open deals` : plural(openDeals.length, 'open deal', 'open deals')}</span>
                                    {orgStore.can('clients', 'create') && <Link to="/clients?addLead=1">Add lead</Link>}
                                </div>
                            </Panel>
                        )}
                    </div>
                )}

                {(seeBills || seeMoney) && (
                    <div className="nb-cols">
                        {seeBills && (
                            <Panel id="nb-pay" title="Bills to pay" count={toPay.length} tone="sun" link={{ to: '/money/bills', label: 'Bills' }}>
                                {!toPay.length && <p className="nb-empty">No vendor bills waiting.</p>}
                                {toPay.slice(0, 4).map((b) => {
                                    const vendor = byId.vendor[b.vendor_id]?.company_name || 'Vendor';
                                    const late = !!b.due_date && b.due_date < today;
                                    return (
                                        <Row key={b.id} onClick={() => navigate('/money/bills')} lead={<Ini name={vendor} />} title={vendor}
                                            sub={[b.bill_number, b.due_date ? `due ${fmt(b.due_date)}` : ''].filter(Boolean).join(' · ')}
                                            tag={late ? 'Late' : null} amount={inr(billBalance(b))} late={late} />
                                    );
                                })}
                            </Panel>
                        )}

                        {seeMoney && (
                            <Panel id="nb-recent" title="Recent money" tone="grey" link={{ to: '/money/transactions', label: 'All' }}>
                                {!recent.length && <p className="nb-empty">No money recorded yet. Tell {persona.name}, or tap New.</p>}
                                {recent.map((r) => (
                                    <Row key={`${r.direction}-${r.id}`} onClick={() => navigate(r.direction === 'in' ? '/money/transactions' : '/money/expenses')}
                                        lead={<span className={`nb-chip ${r.direction === 'in' ? 'g' : 'n'}`} aria-hidden="true">{r.direction === 'in' ? <IconIn /> : <IconOut />}</span>}
                                        title={r.party || r.description || (r.direction === 'in' ? 'Money in' : 'Expense')}
                                        sub={[fmt(r.day), categoryLabel(r.category)].filter(Boolean).join(' · ')}
                                        amount={`${r.direction === 'in' ? '+' : '−'}${inr(r.amount)}`} amountIn={r.direction === 'in'} />
                                ))}
                            </Panel>
                        )}
                    </div>
                )}

                <section className="nb-ask" aria-labelledby="nb-ask">
                    <div className="hd">
                        <h2 id="nb-ask">Ask {persona.name}</h2>
                        <Link to="/chat">Open Buddy<IconChevronRight size={12} /></Link>
                    </div>
                    <div className="nb-prompts">
                        {ASKS.map(([label, prompt]) => (
                            <button key={label} type="button" className="nb-press" onClick={() => ask(prompt)}>
                                <IconSparkle />{label}
                            </button>
                        ))}
                    </div>
                    <p className="fine"><IconLock size={13} />Nothing {persona.name} prepares is saved until you approve it.</p>
                </section>
            </div>

            {add.element}
            {note && <div className="sb sb-toast" role="status">{note}</div>}
        </div>
    );
}
