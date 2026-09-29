import React, { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useOrg } from '../context/OrgContext';
import { orgStore } from '../services/orgStore';
import { docNumber as docNo } from '../services/documentStore';
import { issuedInvoices, balanceOf, isOverdue } from '../services/financeAnalytics';
import { useSectionList } from '../shell/useSectionList';
import { useShell } from '../shell/shellContext';
import { useMe } from '../shell/useMe';
import { useCofounder } from '../design/useCofounder';
import { useBrief } from '../chat/useBrief';
import { useBriefActions } from '../chat/useBriefActions';
import { isoDay, inr } from '../chat/brief';
import { docClient } from '../money/useMoneyData';
import BuddyHero from '../design/BuddyHero';
import { Button, Card, ListRow, IconTile, Initials, PixelAvatar } from '../design/ui';
import { personAvatar } from '../design/personas';
import {
    IconDoc, IconMail, IconTask, IconBolt, IconCheckCircle, IconChevronRight, IconClock, IconInvoice, IconTeam, IconWork,
} from '../design/icons';
import '../design/hub.css';

/* ══════════════════════════════════════════════════════════════════════════
   Home — the company's command centre.

   Everything on it is read from rows the app already loads (orgStore lists,
   live) and built by the same rules as elsewhere: the brief (brief.js) gives
   the greeting, the four figures and today's suggestions; deadlines, active
   work and client items are the Work, Money and Clients rows, sorted by what
   is soonest or most owed. Nothing is written from here; every row opens
   the screen that owns it, and every ask goes to Buddy.
   ══════════════════════════════════════════════════════════════════════════ */

const SUG_ICONS = { doc: IconDoc, mail: IconMail, task: IconTask, bolt: IconBolt, bell: IconCheckCircle };
const isOpenProject = (p) => !p.archived_at && !['completed', 'cancelled'].includes(p.status);
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return isoDay(d); };
const whenLabel = (d, today) => {
    if (d < today) {
        const days = Math.round((new Date(`${today}T00:00:00`) - new Date(`${d}T00:00:00`)) / 86400000);
        return `${days}d late`;
    }
    if (d === today) return 'Today';
    if (d === addDays(today, 1)) return 'Tomorrow';
    return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
};

export default function HomeScreen() {
    const { activeOrg } = useOrg();
    const orgId = activeOrg?.id || null;
    const navigate = useNavigate();
    const shell = useShell();
    const me = useMe();
    const { persona } = useCofounder();
    const { brief, build, building, buildError } = useBrief({ persona, name: me.name });
    const { onKpi, onSuggestion } = useBriefActions({ build });

    const tasks = useSectionList('tasks', orgId);
    const projects = useSectionList('projects', orgId);
    const docs = useSectionList('fin_docs', orgId);
    const bills = useSectionList('purchase_invoices', orgId);
    const vendors = useSectionList('vendors', orgId);
    const leads = useSectionList('crm_leads', orgId);
    const people = useSectionList('employees', orgId);

    const today = isoDay(new Date());
    const horizon = addDays(today, 7);

    /* Upcoming deadlines: anything dated in the next week, or already late. */
    const deadlines = useMemo(() => {
        const out = [];
        const vendorName = Object.fromEntries(vendors.map((v) => [v.id, v.company_name]));
        const projectName = Object.fromEntries(projects.map((p) => [p.id, p.name]));
        for (const t of tasks) {
            if (t.status === 'done' || !t.deadline || t.deadline > horizon) continue;
            out.push({ id: `t-${t.id}`, date: t.deadline, icon: IconTask, title: t.title,
                sub: [t.projectId ? projectName[t.projectId] || 'Project' : 'Task', t.assignedName].filter(Boolean).join(' · '), to: `/work?task=${t.id}` });
        }
        for (const d of issuedInvoices(docs)) {
            if (!d.due_date || balanceOf(d) <= 0.009 || d.due_date > horizon) continue;
            out.push({ id: `d-${d.id}`, date: String(d.due_date).slice(0, 10), icon: IconInvoice, title: `${docClient(d)} pays ${inr(balanceOf(d))}`,
                sub: `Invoice ${docNo(d) || ''}`.trim(), to: `/money/invoices?doc=${d.id}` });
        }
        for (const q of docs) {
            if (q.type !== 'quotation' || !['sent', 'viewed', 'revision_requested'].includes(q.status) || !q.valid_until) continue;
            const v = String(q.valid_until).slice(0, 10);
            if (v < today || v > horizon) continue;
            out.push({ id: `q-${q.id}`, date: v, icon: IconDoc, title: `Quote to ${docClient(q)} expires`, sub: `Quote ${docNo(q) || ''}`.trim(), to: `/money/invoices?doc=${q.id}` });
        }
        for (const b of bills) {
            const bal = Math.max(0, (Number(b.total) || 0) - (Number(b.amount_paid) || 0));
            if (b.status === 'void' || bal <= 0.009 || !b.due_date || b.due_date > horizon) continue;
            out.push({ id: `b-${b.id}`, date: b.due_date, icon: IconInvoice, title: `Pay ${vendorName[b.vendor_id] || 'vendor'} ${inr(bal)}`,
                sub: `Bill ${b.bill_number || ''}`.trim(), to: '/money/bills' });
        }
        for (const p of people) {
            if (!p.startDate || p.startDate < today || p.startDate > horizon) continue;
            out.push({ id: `p-${p.id}`, date: p.startDate, icon: IconTeam, title: `${p.name} joins`, sub: p.role || 'New teammate', to: `/team?person=${p.id}` });
        }
        return out.sort((x, y) => x.date.localeCompare(y.date));
    }, [tasks, projects, docs, bills, vendors, people, today, horizon]);

    /* Active work: open projects with their task progress, busiest first. */
    const work = useMemo(() => projects.filter(isOpenProject).map((p) => {
        const mine = tasks.filter((t) => t.projectId === p.id);
        const done = mine.filter((t) => t.status === 'done').length;
        const late = mine.filter((t) => t.status !== 'done' && t.deadline && t.deadline < today).length;
        return { ...p, total: mine.length, done, open: mine.length - done, late };
    }).sort((x, y) => y.late - x.late || y.open - x.open), [projects, tasks, today]);
    const looseTasks = tasks.filter((t) => t.status !== 'done' && !t.projectId).length;

    /* Client items: who owes the most (late first), then how many are in talks. */
    const clientItems = useMemo(() => {
        const by = new Map();
        for (const d of issuedInvoices(docs)) {
            const bal = balanceOf(d);
            if (bal <= 0.009) continue;
            const key = d.customer_id || docClient(d);
            const x = by.get(key) || { key, name: docClient(d), customerId: d.customer_id, owed: 0, count: 0, late: false, firstDoc: d.id };
            x.owed += bal; x.count += 1; x.late = x.late || isOverdue(d, today);
            by.set(key, x);
        }
        return [...by.values()].sort((a, b) => (b.late - a.late) || b.owed - a.owed);
    }, [docs, today]);
    const inTalks = leads.filter((l) => l.stage === 'contacted');

    const seeWork = orgStore.can('tasks', 'view');
    const seeMoney = orgStore.can('financial_documents', 'view');
    const n = brief.kpis.length;

    return (
        <div className="sb-scroll">
            <div className="sb-page" style={{ maxWidth: 1100 }}>
                <BuddyHero
                    eyebrow={`${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })} · ${persona.name}`}
                    title={brief.greeting}
                    lede={brief.lede}
                    steps
                    chips={[
                        { label: 'Who owes me money?', prompt: 'Who owes me money?' },
                        { label: "What's due this week?", prompt: "What's due this week?" },
                        { label: 'Record an expense', prompt: 'Record an expense' },
                        { label: 'Add a task', prompt: 'Add a task' },
                        ...(shell.brainBuilt ? [{ label: "How's the month?", prompt: 'How did we do this month?' }] : []),
                    ]} />

                {n > 0 && (
                    <section aria-labelledby="home-snap" style={{ marginBottom: 20 }}>
                        <h2 id="home-snap" className="sb-sr">Financial snapshot</h2>
                        <div className={`sb-cd sb-bk n${n}`}>
                            {brief.kpis.map((k) => (
                                <button key={k.id} type="button" className="sb-kpi" onClick={() => onKpi(k)}>
                                    <span className="kl">{k.label}</span>
                                    <span className="kv sb-num">{k.value}</span>
                                    <span className="ks"><i className={`sb-dot ${k.tone}`} aria-hidden="true" />{k.sub}</span>
                                </button>
                            ))}
                        </div>
                    </section>
                )}

                <div className="sb-cols w">
                    <Card as="section" className="sb-panel sb-todo" aria-labelledby="home-today">
                        <div className="ph">
                            <h2 id="home-today">Suggested by {persona.name}</h2>
                            <span className="c">{brief.suggestions.length || ''}</span>
                            <Link to="/chat">Ask more<IconChevronRight size={12} /></Link>
                        </div>
                        {brief.suggestions.length === 0 ? (
                            <p className="pe">Nothing needs you today. When something does — a late invoice, a signed offer, an overdue task — it shows up here first.</p>
                        ) : brief.suggestions.map((s) => {
                            const Icon = SUG_ICONS[s.icon] || IconDoc;
                            const isBuild = s.build;
                            return (
                                <ListRow key={s.id} lead={<IconTile tone={s.tone}><Icon /></IconTile>} title={s.title}
                                    sub={isBuild && buildError ? buildError : s.sub}
                                    trail={<Button size="sm" onClick={() => onSuggestion(s)} disabled={isBuild && building}>{isBuild && building ? 'Building…' : s.action}</Button>} />
                            );
                        })}
                    </Card>

                    <Card as="section" className="sb-panel" aria-labelledby="home-dl">
                        <div className="ph">
                            <h2 id="home-dl">Upcoming deadlines</h2>
                            <span className="c">{deadlines.length || ''}</span>
                            {seeWork && <Link to="/work">Work<IconChevronRight size={12} /></Link>}
                        </div>
                        {deadlines.length === 0 && <p className="pe">Nothing due in the next seven days.</p>}
                        {deadlines.slice(0, 6).map((d) => {
                            const Icon = d.icon;
                            const late = d.date < today;
                            return (
                                <ListRow key={d.id} onClick={() => navigate(d.to)} lead={<IconTile tone={late ? 'r' : d.date === today ? 'a' : 'n'}><Icon /></IconTile>}
                                    title={d.title} sub={d.sub}
                                    trail={<span className={`sb-when${late ? ' r' : d.date === today ? ' a' : ''}`}>{whenLabel(d.date, today)}</span>} />
                            );
                        })}
                        {deadlines.length > 6 && <div className="pf"><span>{deadlines.length - 6} more this week</span><Link to="/work">See all</Link></div>}
                    </Card>
                </div>

                <div className="sb-cols">
                    {seeWork && (
                        <Card as="section" className="sb-panel" aria-labelledby="home-work">
                            <div className="ph">
                                <h2 id="home-work">Active work</h2>
                                <span className="c">{work.length || ''}</span>
                                <Link to="/work">Open Work<IconChevronRight size={12} /></Link>
                            </div>
                            {work.length === 0 && (
                                <p className="pe">{looseTasks ? `${looseTasks} open ${looseTasks === 1 ? 'task' : 'tasks'}, no projects running.` : 'No projects running.'} Start one from Work, or ask {persona.name}.</p>
                            )}
                            {work.slice(0, 4).map((p) => (
                                <ListRow key={p.id} onClick={() => navigate(`/work?project=${p.id}`)} lead={<IconTile><IconWork size={16} /></IconTile>}
                                    title={p.name}
                                    sub={[`${p.open} open`, p.late ? `${p.late} late` : '', p.total ? `${p.done} done` : 'No tasks yet'].filter(Boolean).join(' · ')}
                                    trail={p.total ? <span className="mini" aria-hidden="true"><i style={{ width: `${Math.round((p.done / p.total) * 100)}%` }} /></span> : null} />
                            ))}
                            {work.length > 0 && looseTasks > 0 && <div className="pf"><IconClock size={13} /><span>{looseTasks} general {looseTasks === 1 ? 'task' : 'tasks'} outside projects</span></div>}
                        </Card>
                    )}

                    {seeMoney && (
                        <Card as="section" className="sb-panel" aria-labelledby="home-clients">
                            <div className="ph">
                                <h2 id="home-clients">Clients to watch</h2>
                                <Link to="/clients">Clients<IconChevronRight size={12} /></Link>
                            </div>
                            {clientItems.length === 0 && <p className="pe">No client owes you money right now.</p>}
                            {clientItems.slice(0, 4).map((c) => (
                                <ListRow key={c.key} onClick={() => navigate(c.customerId ? `/clients?client=${c.customerId}` : `/money/invoices?doc=${c.firstDoc}`)}
                                    lead={<Initials name={c.name} />} title={c.name}
                                    sub={`${c.count} ${c.count === 1 ? 'invoice' : 'invoices'} ${c.late ? 'overdue' : 'open'}`}
                                    amount={inr(c.owed)} className={c.late ? 'late' : undefined} />
                            ))}
                            {inTalks.length > 0 && (
                                <div className="pf">
                                    <span style={{ display: 'flex', marginRight: 2 }} aria-hidden="true">
                                        {inTalks.slice(0, 3).map((l, i) => <PixelAvatar key={l.id} spec={personAvatar(l.name)} round size={20} style={{ marginLeft: i ? -6 : 0, boxShadow: '0 0 0 2px #fff' }} />)}
                                    </span>
                                    <span>{inTalks.length} {inTalks.length === 1 ? 'lead' : 'leads'} in talks</span>
                                    <Link to="/clients">Pipeline</Link>
                                </div>
                            )}
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
}
