import { cashPosition, taxSummary, paymentPosition, issuedInvoices, isOverdue, daysOverdue, balanceOf } from '../services/financeAnalytics';

/* ══════════════════════════════════════════════════════════════════════════
   The daily brief — built here, in the browser, from rows already loaded.
   No model call and nothing metered (plan §5.3).

   Every figure is one the app already computes elsewhere, by the same rule:
     net cash      financeAnalytics.cashPosition — the hub's net-cash tile
     owed to you   paymentPosition — the finance status cards
     GST payable   taxSummary().netPayable for this month — the tax summary
   A figure is shown only when the person can read every table behind it; a
   partial sum would be a wrong number, not a smaller one.
   ══════════════════════════════════════════════════════════════════════════ */

const INSIGHT_ICON = {
    overdue_invoices: 'doc', stale_quotes: 'doc', bills_due: 'doc', spend_spike: 'bolt',
    due_soon: 'task', overdue_tasks: 'task', slipping_task: 'task', project_risk: 'task', inactive_leads: 'mail',
};

const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const inr = (v) => inr0.format(Math.round(Number(v) || 0));

const pad = (n) => String(n).padStart(2, '0');
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Sunday of the week `d` is in (weeks run Monday–Sunday). */
export function endOfWeek(d) {
    const e = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    e.setDate(e.getDate() + ((7 - e.getDay()) % 7));
    return isoDay(e);
}

/** Open tasks bucketed the way Work shows them. */
export function taskBuckets(tasks, now = new Date()) {
    const today = isoDay(now);
    const eow = endOfWeek(now);
    const open = (tasks || []).filter((t) => t.status !== 'done');
    const overdue = open.filter((t) => t.deadline && t.deadline < today);
    const week = open.filter((t) => t.deadline && t.deadline >= today && t.deadline <= eow);
    return { open, overdue, week, dueByWeekEnd: overdue.length + week.length };
}

export function greetingWord(now = new Date()) {
    const h = now.getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/* One or two sentences in each persona's voice, from facts only. Every branch
   says something true for the numbers given — including "nothing". */
const LEDES = {
    mira: (f) => (f.owed > 0
        ? `You're owed ${inr(f.owed)}${f.overdueCount ? `, and ${f.overdueCount} ${f.overdueCount === 1 ? 'invoice is' : 'invoices are'} past due` : ''}.${f.netCash !== null ? ` Net cash stands at ${inr(f.netCash)}.` : ''}`
        : `No one owes you money right now.${f.netCash !== null ? ` Net cash stands at ${inr(f.netCash)}.` : ''}`),
    arjun: (f) => (f.overdueCount
        ? `${f.overdueCount} late. ${inr(f.overdueAmount)}. Chase it.`
        : f.tasksOverdue ? `${f.tasksOverdue} ${f.tasksOverdue === 1 ? 'task' : 'tasks'} overdue. Clear ${f.tasksOverdue === 1 ? 'it' : 'them'}.` : 'Nothing urgent.'),
    tara: (f) => (f.owed > 0
        ? `${inr(f.owed)} is on its way to you. Let's bring it home!`
        : `Clean slate: nobody owes you a rupee. ${f.tasksDue ? `${f.tasksDue} ${f.tasksDue === 1 ? 'task' : 'tasks'} to knock out this week.` : 'Enjoy it.'}`),
    neel: (f) => `${f.owed > 0 ? `Receivables: ${inr(f.owed)} across ${f.owedCount} ${f.owedCount === 1 ? 'invoice' : 'invoices'}` : 'Receivables: nil'}${f.gst !== null ? `. GST payable this month: ${inr(Math.max(0, f.gst))}` : ''}.`,
    sam: (f) => (f.overdueCount || f.tasksOverdue
        ? `${[f.overdueCount && `${f.overdueCount} late ${f.overdueCount === 1 ? 'invoice' : 'invoices'}`, f.tasksOverdue && `${f.tasksOverdue} overdue ${f.tasksOverdue === 1 ? 'task' : 'tasks'}`].filter(Boolean).join(' and ')}. No stress, let's sort them.`
        : 'Nothing is stuck. Easy day to get ahead.'),
    dia: (f) => (f.owed > 0
        ? `${inr(f.owed)} is owed to you. Worth checking your terms on the ${f.overdueCount ? 'late ones' : 'next quote'}.`
        : 'Nothing outstanding. A good moment to send the next quote.'),
};

/**
 * @param {object} p
 *   docs, income, expenses, purchases, vendors, tasks — orgStore lists
 *   can(resource, 'view') — permission check
 *   persona, name, now
 *   gmail   { configured } | null (null: unknown or not an admin)
 *   brain   { built, canBuild } | null
 *   notifications — unread portal notifications
 *   insights — "Buddy noticed" from the server (useInsights), or null while
 *              unknown; when present they replace the local invoice and task
 *              suggestions, which cover the same ground with fewer rules
 */
export function buildBrief(p) {
    const now = p.now || new Date();
    const today = isoDay(now);
    const can = p.can || (() => true);
    const seeDocs = can('financial_documents', 'view');
    const seeCash = seeDocs && can('income_entries', 'view') && can('expenses', 'view') && can('purchase_invoices', 'view');
    const seeTasks = can('tasks', 'view');

    const pos = seeDocs ? paymentPosition(p.docs || [], today) : null;
    const netCash = seeCash ? cashPosition({ finDocs: p.docs, income: p.income, expenses: p.expenses, purchases: p.purchases }).net : null;
    const month = { from: `${today.slice(0, 7)}-01`, to: today };
    const gst = seeCash ? taxSummary({ docs: p.docs || [], purchases: p.purchases || [], expenses: p.expenses || [], income: p.income || [], vendors: p.vendors || [] }, month.from, month.to).netPayable : null;
    const tb = seeTasks ? taskBuckets(p.tasks, now) : null;

    const facts = {
        owed: pos?.outstanding || 0, owedCount: pos?.outstandingCount || 0,
        overdueCount: pos?.overdueCount || 0, overdueAmount: pos?.overdue || 0,
        tasksDue: tb?.dueByWeekEnd || 0, tasksOverdue: tb?.overdue.length || 0,
        netCash, gst,
    };

    const kpis = [];
    if (netCash !== null) kpis.push({ id: 'cash', label: 'Net cash', value: inr(netCash), sub: 'Recorded money in, less out', tone: netCash >= 0 ? 'g' : 'r', to: '/business' });
    if (pos) kpis.push({ id: 'owed', label: 'Owed to you', value: inr(pos.outstanding), sub: pos.overdueCount ? `${pos.overdueCount} overdue` : 'None overdue', tone: pos.overdueCount ? 'r' : 'g', ask: 'Who owes me money?' });
    if (tb) kpis.push({ id: 'week', label: 'This week', value: `${tb.dueByWeekEnd} ${tb.dueByWeekEnd === 1 ? 'task' : 'tasks'}`, sub: tb.overdue.length ? `${tb.overdue.length} overdue` : 'None overdue', tone: tb.overdue.length ? 'a' : 'g', to: '/work' });
    if (gst !== null) kpis.push({ id: 'gst', label: 'GST payable', value: inr(Math.max(0, gst)), sub: gst < 0 ? `${inr(-gst)} input credit` : now.toLocaleDateString('en-IN', { month: 'long' }), tone: 'n', to: '/money/reports' });

    /* Suggested for today: from real signals, most pressing first. */
    const sug = [];
    const noticed = Array.isArray(p.insights) ? p.insights : null;
    for (const i of (noticed || []).slice(0, 4)) {
        const primary = i.actions?.[0] || null;
        sug.push({
            id: `ins-${i.id}`, tone: i.tone || 'n', icon: INSIGHT_ICON[i.kind] || 'bolt',
            title: i.title, sub: i.reason, action: primary?.label || 'Review',
            insight: i, noticed: true,
        });
    }
    if (!noticed && seeDocs) {
        const late = issuedInvoices(p.docs || [])
            .filter((d) => isOverdue(d, today))
            .sort((a, b) => daysOverdue(b, today) - daysOverdue(a, today));
        for (const d of late.slice(0, 2)) {
            const days = daysOverdue(d, today);
            sug.push({
                id: `inv-${d.id}`, tone: 'r', icon: 'doc',
                title: `Chase ${d.issued_to || d.client_name || d.client?.name || 'the client'} for ${inr(balanceOf(d))}`,
                sub: `${d.doc_number || 'Invoice'} · ${days} ${days === 1 ? 'day' : 'days'} overdue`,
                action: 'Send reminder', doc: d.id,
            });
        }
    }
    for (const n of (p.notifications || []).filter((x) => !x.read).slice(0, 2)) {
        sug.push({ id: `note-${n.id}`, tone: 'b', icon: 'bell', title: n.title, sub: n.message, action: 'Open', notification: n });
    }
    if (!noticed && tb?.overdue.length) {
        sug.push({ id: 'tasks', tone: 'a', icon: 'task', title: `${tb.overdue.length} overdue ${tb.overdue.length === 1 ? 'task' : 'tasks'}`,
            sub: tb.overdue.slice(0, 2).map((t) => t.title).join(', '), action: 'Open Work', to: '/work' });
    }
    if (p.gmail && !p.gmail.configured) {
        sug.push({ id: 'gmail', tone: 'b', icon: 'mail', title: 'Connect Gmail', sub: 'So invoices, reminders and letters go out from your address', action: 'Set up', to: '/settings#email' });
    }
    if (p.brain && !p.brain.built && p.brain.canBuild) {
        sug.push({ id: 'brain', tone: 'n', icon: 'bolt', title: `Let ${p.persona?.name || 'your cofounder'} learn your company`, sub: 'Builds the knowledge your answers come from', action: 'Build', build: true });
    }

    const lede = (LEDES[p.persona?.id] || LEDES.mira)(facts);
    return {
        greeting: `${greetingWord(now)}, ${p.name || 'there'}.`,
        lede,
        kpis,
        suggestions: sug.slice(0, noticed ? 5 : 3),
        noticed: !!noticed,
        facts,
    };
}
