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
import { Button, Badge, Card, ListRow, PageHeader, KpiStrip, IconTile, Initials } from '../design/ui';
import { IconIn, IconOut, IconDoc, IconPlus, IconChevronRight, IconFile, IconSparkle } from '../design/icons';
import { inr } from '../chat/brief';
import { useMoneyData, docClient } from '../money/useMoneyData';
import BusinessNav from './BusinessNav';
import { useAddFlow } from './useAddFlow';
import '../money/money.css';
import '../design/hub.css';

/* ══════════════════════════════════════════════════════════════════════════
   Business — the overview of the hub that gathers Money and Clients.

   Figures are financeAnalytics', as everywhere (Net cash = cashPosition().net;
   To collect = the balance on issued invoices; To pay = the balance on open
   vendor bills). Lists are the same rows Money and Clients show; every row
   opens its record there. Quick actions and the New button share one list
   (useAddFlow), and the cofounder's asks go to Buddy.
   ══════════════════════════════════════════════════════════════════════════ */

const STAGES = [
    { id: 'lead', label: 'Lead', tone: 'b' },
    { id: 'contacted', label: 'In talks', tone: 'a' },
    { id: 'deal', label: 'Won', tone: 'g' },
    { id: 'not_deal', label: 'Lost', tone: 'n' },
];
const fmt = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');
const billBalance = (b) => Math.max(0, (Number(b.total) || 0) - (Number(b.amount_paid) || 0));

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

    return (
        <div className="sb-scroll">
            <div className="sb-page" style={{ maxWidth: 1100 }}>
                <PageHeader title="Business" sub={`Money and clients · ${new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}`}
                    actions={(
                        <>
                            <Button onClick={() => shell.openFiles()}><IconFile /><span className="lbl">Documents</span></Button>
                            <Button variant="primary" onClick={add.open}><IconPlus /><span className="lbl">New</span></Button>
                        </>
                    )} />
                <BusinessNav counts={{ invoices: lateCount }} />

                {seeAll && (
                    <KpiStrip items={[
                        { label: 'Net cash', value: inr(figures.net), sub: `Profit this month ${inr(figures.pl.net)}`, tone: figures.net >= 0 ? 'g' : 'r', onClick: () => navigate('/money/reports') },
                        { label: 'To collect', value: inr(owedTotal), sub: lateCount ? `${lateCount} overdue` : `${owed.length} open ${owed.length === 1 ? 'invoice' : 'invoices'}`, tone: lateCount ? 'r' : 'g', onClick: () => navigate('/money/invoices?type=invoice') },
                        { label: 'To pay', value: inr(toPayTotal), sub: dueSoon ? `${dueSoon} due now` : `${toPay.length} open ${toPay.length === 1 ? 'bill' : 'bills'}`, tone: dueSoon ? 'a' : 'n', onClick: () => navigate('/money/bills') },
                    ]} />
                )}

                {quick.length > 0 && (
                    <section aria-labelledby="biz-qa">
                        <h2 id="biz-qa" className="sb-sr">Quick actions</h2>
                        <div className="sb-qa">
                            {quick.map((x) => {
                                const Icon = x.icon;
                                return (
                                    <button key={x.id} type="button" className="sb-cd" onClick={x.run}>
                                        <IconTile tone={x.tone}><Icon /></IconTile>
                                        <span><b>{x.short}</b><small>{x.sub.split(',')[0]}</small></span>
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                )}

                <div className="sb-cols">
                    {seeDocs && (
                        <Card as="section" className="sb-panel" aria-labelledby="biz-owed">
                            <div className="ph">
                                <h2 id="biz-owed">Outstanding payments</h2>
                                <span className="c">{owed.length || ''}</span>
                                <Link to="/money/invoices?type=invoice">Invoices<IconChevronRight size={12} /></Link>
                            </div>
                            {!owed.length && <p className="pe">Nobody owes you money right now.</p>}
                            {owed.slice(0, 5).map((d) => {
                                const late = isOverdue(d, today);
                                return (
                                    <ListRow key={d.id} onClick={() => navigate(`/money/invoices?doc=${d.id}`)} lead={<Initials name={docClient(d)} />}
                                        title={docClient(d)} sub={`${docNo(d) || 'Invoice'}${d.due_date ? ` · due ${fmt(d.due_date)}` : ''}`}
                                        trail={late ? <Badge tone="r" className="hide-m">Overdue</Badge> : null}
                                        amount={inr(balanceOf(d))} className={late ? 'late' : undefined} />
                                );
                            })}
                            {owed.length > 0 && lateCount > 0 && (
                                <div className="pf"><span>{lateCount} overdue</span>
                                    <button type="button" onClick={() => ask('Draft reminders for my overdue invoices')}>Ask {persona.name} to chase</button>
                                </div>
                            )}
                        </Card>
                    )}

                    {orgStore.can('clients', 'view') && (
                        <Card as="section" className="sb-panel" aria-labelledby="biz-pipe">
                            <div className="ph">
                                <h2 id="biz-pipe">Client pipeline</h2>
                                <span className="c">{leads.length || ''}</span>
                                <Link to="/clients">Board<IconChevronRight size={12} /></Link>
                            </div>
                            <div className="sb-pipe">
                                {STAGES.map((s) => (
                                    <Link key={s.id} to="/clients" aria-label={`${s.label}: ${stageCount[s.id]}`}>
                                        <span className="pl"><i className={`sb-dot ${s.tone === 'b' ? 'n' : s.tone}`} aria-hidden="true" />{s.label}</span>
                                        <span className="pv">{stageCount[s.id]}</span>
                                        <span className="pb" aria-hidden="true"><i style={{ width: `${(stageCount[s.id] / peak) * 100}%` }} /></span>
                                    </Link>
                                ))}
                            </div>
                            {inTalks.map((l) => (
                                <ListRow key={l.id} onClick={() => navigate(`/clients?client=${l.id}`)} lead={<Initials name={l.name} />}
                                    title={l.name} sub={l.value ? `In talks · worth ${inr(l.value)}` : 'In talks'}
                                    trail={<span style={{ color: 'var(--faint)' }}><IconChevronRight /></span>} />
                            ))}
                            <div className="pf">
                                <span>{pipelineValue > 0 ? `${inr(pipelineValue)} in open deals` : `${openDeals.length} open ${openDeals.length === 1 ? 'deal' : 'deals'}`}</span>
                                {orgStore.can('clients', 'create') && <Link to="/clients?addLead=1">Add lead</Link>}
                            </div>
                        </Card>
                    )}
                </div>

                <div className="sb-cols">
                    {orgStore.can('purchase_invoices', 'view') && (
                        <Card as="section" className="sb-panel" aria-labelledby="biz-pay">
                            <div className="ph">
                                <h2 id="biz-pay">Bills to pay</h2>
                                <span className="c">{toPay.length || ''}</span>
                                <Link to="/money/bills">Bills<IconChevronRight size={12} /></Link>
                            </div>
                            {!toPay.length && <p className="pe">No vendor bills waiting.</p>}
                            {toPay.slice(0, 4).map((b) => {
                                const vendor = byId.vendor[b.vendor_id]?.company_name || 'Vendor';
                                const late = b.due_date && b.due_date < today;
                                return (
                                    <ListRow key={b.id} onClick={() => navigate('/money/bills')} lead={<Initials name={vendor} />} title={vendor}
                                        sub={[b.bill_number, b.due_date ? `due ${fmt(b.due_date)}` : ''].filter(Boolean).join(' · ')}
                                        amount={inr(billBalance(b))} className={late ? 'late' : undefined} />
                                );
                            })}
                        </Card>
                    )}

                    {(orgStore.can('income_entries', 'view') || orgStore.can('expenses', 'view')) && (
                        <Card as="section" className="sb-panel" aria-labelledby="biz-recent">
                            <div className="ph">
                                <h2 id="biz-recent">Recent transactions</h2>
                                <Link to="/money/transactions">All<IconChevronRight size={12} /></Link>
                            </div>
                            {!recent.length && <p className="pe">No money recorded yet. Tell {persona.name}, or tap New.</p>}
                            {recent.map((r) => (
                                <ListRow key={`${r.direction}-${r.id}`} onClick={() => navigate(r.direction === 'in' ? '/money/transactions' : '/money/expenses')}
                                    lead={<IconTile tone={r.direction === 'in' ? 'g' : 'n'}>{r.direction === 'in' ? <IconIn /> : <IconOut />}</IconTile>}
                                    title={r.party || r.description} sub={[fmt(r.day), categoryLabel(r.category)].filter(Boolean).join(' · ')}
                                    amount={`${r.direction === 'in' ? '+' : '−'}${inr(r.amount)}`} amountIn={r.direction === 'in'} />
                            ))}
                        </Card>
                    )}
                </div>

                <Card as="section" className="sb-panel" aria-labelledby="biz-ask" style={{ marginBottom: 8 }}>
                    <div className="ph"><h2 id="biz-ask">Ask {persona.name}</h2><Link to="/chat">Open Buddy<IconChevronRight size={12} /></Link></div>
                    {[
                        ['Who owes me money?', 'Who owes me money?'],
                        ['Which clients are worth following up this week?', 'Which clients should I follow up with this week?'],
                        ['Where is the money going this month?', 'Where did we spend money this month?'],
                        ['Draft a quote', 'Make a quote'],
                    ].map(([label, prompt]) => (
                        <ListRow key={label} onClick={() => ask(prompt)} lead={<IconTile tone="n"><IconSparkle /></IconTile>} title={label}
                            trail={<span style={{ color: 'var(--faint)' }}><IconChevronRight /></span>} />
                    ))}
                    <div className="pf"><IconDoc size={13} /><span>Every change {persona.name} prepares waits for your tap before it is saved.</span></div>
                </Card>
            </div>

            {add.element}
            {note && <div className="sb sb-toast" role="status">{note}</div>}
        </div>
    );
}
