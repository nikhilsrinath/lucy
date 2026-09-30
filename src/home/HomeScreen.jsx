import React, { useMemo, useState } from 'react';
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
import { useAssistant } from '../components/assistant/assistantStore';
import { Button, Card, ListRow, IconTile, Initials, PixelAvatar } from '../design/ui';
import { personAvatar } from '../design/personas';
import {
    IconDoc, IconMail, IconTask, IconBolt, IconCheckCircle, IconChevronRight, IconClock, IconInvoice, IconTeam, IconWork,
    IconCall, IconChat, IconSparkle,
} from '../design/icons';
import '../design/hub.css';
import './home.css';

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
    const assistant = useAssistant();
    const ask = (text) => { navigate('/chat'); assistant.send(text); };
    const [day, setDay] = useState(null);

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

    /* The week rail: late items (if any), then today and the six days after.
       Tapping a day narrows the list below to it; tapping it again clears. */
    const week = Array.from({ length: 7 }, (_, i) => {
        const iso = addDays(today, i);
        const dt = new Date(`${iso}T00:00:00`);
        return { iso, dow: dt.toLocaleDateString('en-IN', { weekday: 'short' }), dom: dt.getDate(), count: deadlines.filter((d) => d.date === iso).length };
    });
    const lateCount = deadlines.filter((d) => d.date < today).length;
    const shown = day === 'late' ? deadlines.filter((d) => d.date < today) : day ? deadlines.filter((d) => d.date === day) : deadlines;
    const pick = (v) => setDay((cur) => (cur === v ? null : v));
    const emptyDay = day === null ? 'Nothing due in the next seven days.'
        : day === today ? 'Nothing due today.'
            : `Nothing due on ${whenLabel(day, today)}.`;

    const chips = [
        { label: 'Who owes me money?', prompt: 'Who owes me money?' },
        { label: 'What’s due this week?', prompt: 'What’s due this week?' },
        { label: 'Record an expense', prompt: 'Record an expense' },
        { label: 'Add a task', prompt: 'Add a task' },
        ...(shell.brainBuilt ? [{ label: 'How’s the month?', prompt: 'How did we do this month?' }] : []),
    ];

    return (
        <div className="sb-scroll hm">
            <div className="hm-page">
                <header className="hm-head">
                    <PixelAvatar spec={persona} className="hm-ava" />
                    <div className="hm-title">
                        <p className="hm-date">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                        <h1 className="hm-greet">{brief.greeting}</h1>
                    </div>
                    <div className="hm-acts">
                        {shell.canCall && <Button onClick={() => shell.startCall()} aria-label={`Call ${persona.name}`}><IconCall size={14} />Talk</Button>}
                        <Button variant="primary" onClick={() => navigate('/chat')}><IconChat size={14} />Open {persona.name}</Button>
                    </div>
                    <div className="hm-note">
                        <p className="hm-bubble"><b>{persona.name}</b>{brief.lede}</p>
                        <div className="hm-chips" role="group" aria-label={`Ask ${persona.name}`}>
                            {chips.map((c) => (
                                <button key={c.label} type="button" disabled={assistant.streaming} onClick={() => ask(c.prompt)}>
                                    <IconSparkle size={11} />{c.label}
                                </button>
                            ))}
                        </div>
                        <p className="hm-fine">Tell {persona.name} what happened. Nothing changes until you confirm it.</p>
                    </div>
                </header>

                {n > 0 && (
                    <section aria-labelledby="home-snap" className={`hm-vitals n${n}`}>
                        <h2 id="home-snap" className="sb-sr">Financial snapshot</h2>
                        {brief.kpis.map((k) => (
                            <button key={k.id} type="button" className="hm-vital" onClick={() => onKpi(k)}>
                                <span className="kl">{k.label}</span>
                                <span className="kv sb-num">{k.value}</span>
                                <span className="ks"><i className={`sb-dot ${k.tone}`} aria-hidden="true" />{k.sub}</span>
                            </button>
                        ))}
                    </section>
                )}

                <div className="hm-grid">
                    <div className="hm-col">
                        <Card as="section" className="hm-panel" aria-labelledby="home-today">
                            <div className="ph">
                                <h2 id="home-today">Suggested by {persona.name}</h2>
                                {brief.suggestions.length > 0 && <span className="c">{brief.suggestions.length}</span>}
                                <Link to="/chat">Ask more<IconChevronRight size={12} /></Link>
                            </div>
                            {brief.suggestions.length === 0 ? (
                                <div className="pe"><IconCheckCircle size={16} /><p>Nothing needs you today. Late invoices, signed offers and overdue tasks show up here first.</p></div>
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

                        {seeWork && (
                            <Card as="section" className="hm-panel" aria-labelledby="home-work">
                                <div className="ph">
                                    <h2 id="home-work">Active work</h2>
                                    {work.length > 0 && <span className="c">{work.length}</span>}
                                    <Link to="/work">Open Work<IconChevronRight size={12} /></Link>
                                </div>
                                {work.length === 0 && (
                                    <div className="pe"><IconWork size={16} /><p>{looseTasks ? `${looseTasks} open ${looseTasks === 1 ? 'task' : 'tasks'}, no projects running.` : 'No projects running.'} Start one from Work, or ask {persona.name}.</p></div>
                                )}
                                {work.slice(0, 4).map((p) => (
                                    <ListRow key={p.id} onClick={() => navigate(`/work?project=${p.id}`)} lead={<IconTile><IconWork size={16} /></IconTile>}
                                        title={p.name}
                                        sub={[`${p.open} open`, p.late ? `${p.late} late` : '', p.total ? `${p.done} done` : 'No tasks yet'].filter(Boolean).join(', ')}
                                        trail={p.total ? <span className="mini" aria-hidden="true"><i style={{ width: `${Math.round((p.done / p.total) * 100)}%` }} /></span> : null} />
                                ))}
                                {work.length > 0 && looseTasks > 0 && <div className="pf"><IconClock size={13} /><span>{looseTasks} general {looseTasks === 1 ? 'task' : 'tasks'} outside projects</span></div>}
                            </Card>
                        )}
                    </div>

                    <div className="hm-col">
                        <Card as="section" className="hm-panel" aria-labelledby="home-dl">
                            <div className="ph">
                                <h2 id="home-dl">Next seven days</h2>
                                {lateCount > 0 && <span className="late">{lateCount} late</span>}
                                {seeWork && <Link to="/work">Work<IconChevronRight size={12} /></Link>}
                            </div>
                            <div className={`hm-rail${lateCount > 0 ? ' has-late' : ''}`} role="group" aria-label="Show one day">
                                {lateCount > 0 && (
                                    <button type="button" className="d late" aria-pressed={day === 'late'} aria-label={`Late, ${lateCount} ${lateCount === 1 ? 'item' : 'items'}`} onClick={() => pick('late')}>
                                        <span className="w">Late</span><span className="n">{lateCount}</span><span className="dots" />
                                    </button>
                                )}
                                {week.map((w) => (
                                    <button key={w.iso} type="button" className={`d${w.iso === today ? ' now' : ''}`} aria-pressed={day === w.iso}
                                        aria-label={`${w.iso === today ? 'Today' : w.dow} ${w.dom}, ${w.count} ${w.count === 1 ? 'item' : 'items'}`} onClick={() => pick(w.iso)}>
                                        <span className="w">{w.iso === today ? 'Today' : w.dow}</span>
                                        <span className="n">{w.dom}</span>
                                        <span className="dots" aria-hidden="true">{Array.from({ length: Math.min(w.count, 3) }, (_, i) => <i key={i} />)}</span>
                                    </button>
                                ))}
                            </div>
                            {shown.length === 0 && <div className="pe"><IconClock size={16} /><p>{emptyDay}</p></div>}
                            {shown.slice(0, 6).map((d) => {
                                const Icon = d.icon;
                                const late = d.date < today;
                                return (
                                    <ListRow key={d.id} onClick={() => navigate(d.to)} lead={<IconTile tone={late ? 'r' : d.date === today ? 'a' : 'n'}><Icon /></IconTile>}
                                        title={d.title} sub={d.sub}
                                        trail={<span className={`sb-when${late ? ' r' : d.date === today ? ' a' : ''}`}>{whenLabel(d.date, today)}</span>} />
                                );
                            })}
                            {shown.length > 6 && <div className="pf"><span>{shown.length - 6} more</span><Link to="/work">See all</Link></div>}
                        </Card>

                        {seeMoney && (
                            <Card as="section" className="hm-panel" aria-labelledby="home-clients">
                                <div className="ph">
                                    <h2 id="home-clients">Clients to watch</h2>
                                    <Link to="/clients">Clients<IconChevronRight size={12} /></Link>
                                </div>
                                {clientItems.length === 0 && <div className="pe"><IconInvoice size={16} /><p>No client owes you money right now.</p></div>}
                                {clientItems.slice(0, 4).map((c) => (
                                    <ListRow key={c.key} onClick={() => navigate(c.customerId ? `/clients?client=${c.customerId}` : `/money/invoices?doc=${c.firstDoc}`)}
                                        lead={<Initials name={c.name} />} title={c.name}
                                        sub={`${c.count} ${c.count === 1 ? 'invoice' : 'invoices'} ${c.late ? 'overdue' : 'open'}`}
                                        amount={inr(c.owed)} className={c.late ? 'late' : undefined} />
                                ))}
                                {inTalks.length > 0 && (
                                    <div className="pf">
                                        <span className="stack" aria-hidden="true">
                                            {inTalks.slice(0, 3).map((l) => <PixelAvatar key={l.id} spec={personAvatar(l.name)} round size={20} />)}
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
        </div>
    );
}

