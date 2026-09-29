import {
    cashPosition, profitAndLoss, taxSummary, issuedInvoices, isOverdue, todayIso, periodBounds,
} from '../services/financeAnalytics';
import { inr, taskBuckets } from './brief';
import { orgStore } from '../services/orgStore';

/* ══════════════════════════════════════════════════════════════════════════
   Instant Slash Commands System
   
   Commands start with '/' and execute instantly without calling the LLM
   for queries (Net cash, Revenue, Overdue invoices, Tax, Tasks, Help),
   saving tokens and returning 0ms response cards directly from orgStore.
   ══════════════════════════════════════════════════════════════════════════ */

export const SLASH_COMMANDS = [
    // ⚡ Instant Metric Commands (0ms, 0 tokens)
    {
        name: 'netcash',
        aliases: ['cash'],
        category: 'Finance',
        description: 'Instant net cash position & cash flow summary',
        instant: true,
        icon: 'cash',
        run: ({ data }) => {
            const { docs = [], income = [], expenses = [], purchases = [] } = data;
            const pos = cashPosition({ finDocs: docs, income, expenses, purchases });
            const month = periodBounds('month');
            const incThisMonth = (income || []).filter((e) => (e.date || e.received_on) >= month.from).reduce((s, e) => s + (Number(e.amount) || 0), 0);
            const expThisMonth = (expenses || []).filter((e) => (e.date || e.incurred_on) >= month.from).reduce((s, e) => s + (Number(e.amount) || 0), 0);
            
            return `### 💰 Net Cash Position (Instant)
**Current Net Cash:** **${inr(pos.net)}**

- **Recorded Money In (all-time):** ${inr(pos.in)}
- **Recorded Money Out (all-time):** ${inr(pos.out)}
- **This Month Inflow:** ${inr(incThisMonth)}
- **This Month Outflow:** ${inr(expThisMonth)}

*Computed locally from verified cashbook and bank transactions with 0ms delay.*`;
        },
    },
    {
        name: 'revenue',
        aliases: ['pnl', 'profit'],
        category: 'Finance',
        description: 'Current month revenue, expenses & net profit',
        instant: true,
        icon: 'chart',
        run: ({ data }) => {
            const { docs = [], income = [], expenses = [], purchases = [] } = data;
            const month = periodBounds('month');
            const pl = profitAndLoss({ docs, purchases, expenses, income }, month.from, month.to);
            const top = pl.byGroup?.[0];

            return `### 📊 Profit & Loss (This Month)
- **Earned Revenue (net of GST):** **${inr(pl.income)}**
- **Operating Expenses:** **${inr(pl.expenses)}**
- **Net Profit:** **${inr(pl.net)}** (${pl.margin != null ? `${Math.round(pl.margin)}% margin` : '—'})
${top ? `- **Top Spend Group:** ${top.name} (${inr(top.value)})` : ''}

*Calculated via financial treatments on live documents and expenses.*`;
        },
    },
    {
        name: 'overdue',
        aliases: ['unpaid', 'receivables'],
        category: 'Finance',
        description: 'List outstanding and overdue client invoices',
        instant: true,
        icon: 'alert',
        run: ({ data }) => {
            const { docs = [] } = data;
            const today = todayIso();
            const inv = issuedInvoices(docs);
            const late = inv.filter((d) => isOverdue(d, today));
            const totalLate = late.reduce((s, d) => s + (Number(d.grand_total || 0) - Number(d.amount_paid || 0)), 0);

            if (!late.length) {
                return `### ✅ Receivables Status
**No overdue invoices!** All client invoices are either settled or within their due dates.`;
            }

            const rows = late.slice(0, 8).map((d) => {
                const bal = Number(d.grand_total || 0) - Number(d.amount_paid || 0);
                const client = d.issued_to || d.client?.name || d.clientName || 'Client';
                return `- **${d.doc_number || 'INV'}** · ${client} — **${inr(bal)}** (due ${d.due_date || 'past'})`;
            }).join('\n');

            return `### ⚠️ Overdue Invoices (${late.length} total)
**Total Overdue Amount:** **${inr(totalLate)}**

${rows}
${late.length > 8 ? `\n*...and ${late.length - 8} more in [Invoices & Quotes](/money).*` : ''}`;
        },
    },
    {
        name: 'tax',
        aliases: ['gst'],
        category: 'Finance',
        description: 'Estimated GST payable for the current month',
        instant: true,
        icon: 'tax',
        run: ({ data }) => {
            const { docs = [], purchases = [], expenses = [], income = [], vendors = [] } = data;
            const month = periodBounds('month');
            const summary = taxSummary({ docs, purchases, expenses, income, vendors }, month.from, month.to);
            const payable = summary.netPayable;

            return `### 🏛️ GST & Tax Estimate (${new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })})
- **Output GST Collected:** ${inr(summary.output.gst)} (${summary.output.count} transactions)
- **Input GST Credit (ITC):** ${inr(summary.input.gst)} (${summary.input.count} bills/expenses)
- **Net GST Payable:** **${inr(Math.max(0, payable))}** ${payable < 0 ? `*(Credit of ${inr(Math.abs(payable))} carried forward)*` : ''}

*Preparation estimate based on GSTR rates. Review before filing.*`;
        },
    },
    {
        name: 'tasks',
        aliases: ['todo'],
        category: 'Work',
        description: 'Summary of tasks due this week and overdue',
        instant: true,
        icon: 'task',
        run: () => {
            const tasks = orgStore.list('tasks') || [];
            const tb = taskBuckets(tasks, new Date());
            
            if (!tb.open.length) {
                return `### ✨ Task Status
No open tasks. Everything is completed!`;
            }

            const lateLines = tb.overdue.slice(0, 5).map((t) => `- 🔴 **${t.title}** (due ${t.deadline})`).join('\n');
            const weekLines = tb.week.slice(0, 5).map((t) => `- 🟡 **${t.title}** (due ${t.deadline})`).join('\n');

            return `### 📋 Work & Tasks Status
- **Overdue Tasks:** ${tb.overdue.length}
- **Due This Week:** ${tb.week.length}
- **Total Open Tasks:** ${tb.open.length}

${tb.overdue.length ? `**Overdue:**\n${lateLines}\n` : ''}
${tb.week.length ? `**This Week:**\n${weekLines}` : ''}`;
        },
    },

    // ⚡ Direct Creation & Navigation Commands
    {
        name: 'invoice',
        aliases: ['new-invoice'],
        category: 'Actions',
        description: 'Create a new tax invoice or draft',
        icon: 'invoice',
        navigate: '/money/invoices/new',
    },
    {
        name: 'quote',
        aliases: ['quotation'],
        category: 'Actions',
        description: 'Create a new quotation for a client',
        icon: 'quote',
        navigate: '/money/quotations/new',
    },
    {
        name: 'expense',
        aliases: ['out', 'spend'],
        category: 'Actions',
        description: 'Log an expense (e.g. /expense 4500 office supplies)',
        icon: 'expense',
    },
    {
        name: 'income',
        aliases: ['in', 'receive'],
        category: 'Actions',
        description: 'Log money received (e.g. /income 25000 consulting advance)',
        icon: 'income',
    },
    {
        name: 'task',
        aliases: ['new-task'],
        category: 'Actions',
        description: 'Create a new task with deadline and assignee',
        icon: 'task',
    },
    {
        name: 'client',
        aliases: ['lead'],
        category: 'Actions',
        description: 'Add a new client or CRM lead',
        icon: 'client',
    },
    {
        name: 'offer',
        aliases: ['offer-letter'],
        category: 'Team',
        description: 'Generate an employee or intern offer letter',
        icon: 'letter',
        navigate: '/team/letters/offer/new',
    },
    {
        name: 'nda',
        category: 'Team',
        description: 'Draft a Non-Disclosure Agreement',
        icon: 'shield',
        navigate: '/team/letters/nda/new',
    },
    {
        name: 'call',
        aliases: ['voice'],
        category: 'Tools',
        description: 'Start a voice call with your co-founder',
        icon: 'call',
        action: ({ shell }) => shell.startCall(),
    },
    {
        name: 'brain',
        aliases: ['knowledge'],
        category: 'Tools',
        description: 'Ask EdgeBrain company memory or check status',
        icon: 'brain',
        instant: true,
        run: () => 'EdgeBrain slash lookup is disabled for deterministic command execution. Use the EdgeBrain panel for knowledge search.',
    },
    {
        name: 'clear',
        category: 'Tools',
        description: 'Clear the active chat history',
        icon: 'trash',
        action: ({ a }) => a.clearHistory(),
    },
    {
        name: 'help',
        aliases: ['commands'],
        category: 'Help',
        description: 'Show cheatsheet of all available slash commands',
        instant: true,
        icon: 'help',
        run: () => `### ⚡ Available Slash Commands

| Command | Action |
| :--- | :--- |
| \`/netcash\` | **Instant**: Net cash, inflows, outflows (0ms, $0) |
| \`/revenue\` | **Instant**: Monthly revenue, expenses & profit |
| \`/overdue\` | **Instant**: List of overdue invoices & amounts |
| \`/tax\` | **Instant**: GST payable and ITC summary |
| \`/tasks\` | **Instant**: Tasks due this week and overdue |
| \`/invoice [client]\` | Create a tax invoice draft |
| \`/quote [client]\` | Create a quotation draft |
| \`/expense [amount] [desc]\` | Log cash-out / expense entry |
| \`/income [amount] [desc]\` | Log cash-in entry |
| \`/task [title] [due]\` | Create a new task |
| \`/client [name]\` | Add a client or lead |
| \`/offer\` | Draft an offer letter |
| \`/nda\` | Draft an NDA agreement |
| \`/call\` | Start voice call with cofounder |
| \`/clear\` | Clear active conversation |

*Type \`/\` in the chat box anytime to open command search.*`,
    },
];

/**
 * Searches commands matching query
 */
export function matchSlashCommands(query = '') {
    const q = query.replace(/^\//, '').toLowerCase().trim();
    if (!q) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((c) => (
        c.name.toLowerCase().includes(q) ||
        c.aliases?.some((a) => a.toLowerCase().includes(q)) ||
        c.description.toLowerCase().includes(q)
    ));
}

// Structured slash wizards stay entirely in the browser. They intentionally
// return field values, not prose, so creation commands never enter the agent.
/* Each question carries a short `name` for the review list, a `placeholder`
   for the message box and optional `options` offered as one-tap chips. */
const GST_OPTIONS = ['0', '5', '12', '18', '28'].map((v) => ({ label: `${v}%`, value: v }));
const SKIP = { label: 'Skip', value: 'skip' };

export const SLASH_WIZARDS = {
    invoice: { kind: 'invoice', label: 'invoice', title: 'New invoice', questions: [
        { key: 'clientName', name: 'Client', label: 'Who is this invoice for?', placeholder: 'Client or company name' },
        { key: 'description', name: 'For', label: 'What are you billing for?', placeholder: 'e.g. Website design, March retainer' },
        { key: 'amount', name: 'Amount', label: 'What is the line amount?', placeholder: 'Amount in ₹, before GST' },
        { key: 'gstRate', name: 'GST', label: 'Which GST rate applies?', placeholder: 'Pick a rate or type 0, 5, 12, 18 or 28', options: GST_OPTIONS },
    ] },
    quote: { kind: 'quotation', label: 'quotation', title: 'New quote', questions: [
        { key: 'clientName', name: 'Client', label: 'Who is this quote for?', placeholder: 'Client or company name' },
        { key: 'description', name: 'For', label: 'What are you quoting for?', placeholder: 'e.g. Mobile app, phase one' },
        { key: 'amount', name: 'Amount', label: 'What is the line amount?', placeholder: 'Amount in ₹, before GST' },
        { key: 'gstRate', name: 'GST', label: 'Which GST rate applies?', placeholder: 'Pick a rate or type 0, 5, 12, 18 or 28', options: GST_OPTIONS },
    ] },
    offer: { kind: 'offer', label: 'offer letter', title: 'New offer letter', questions: [
        { key: 'studentName', name: 'Candidate', label: 'Who is the candidate?', placeholder: 'Full name' },
        { key: 'role', name: 'Role', label: 'What role are you offering?', placeholder: 'e.g. Design intern' },
        { key: 'department', name: 'Department', label: 'Which department?', placeholder: 'Department, or skip', options: [SKIP] },
        { key: 'startDate', name: 'Starts', label: 'When do they start?', placeholder: 'YYYY-MM-DD, or skip', options: [SKIP] },
        { key: 'stipend', name: 'Stipend', label: 'What is the monthly stipend?', placeholder: 'Amount in ₹, or 0 if unpaid', options: [{ label: 'Unpaid', value: '0' }] },
    ] },
    expense: { kind: 'expense', label: 'expense', title: 'Log an expense', questions: [
        { key: 'amount', name: 'Amount', label: 'How much was spent?', placeholder: 'Amount in ₹' },
        { key: 'description', name: 'For', label: 'What was it for?', placeholder: 'e.g. Figma subscription' },
    ] },
    income: { kind: 'income', label: 'income entry', title: 'Log income', questions: [
        { key: 'amount', name: 'Amount', label: 'How much was received?', placeholder: 'Amount in ₹' },
        { key: 'description', name: 'For', label: 'What was it for?', placeholder: 'e.g. Consulting fee' },
    ] },
    task: { kind: 'task', label: 'task', title: 'New task', questions: [
        { key: 'title', name: 'Task', label: 'What needs doing?', placeholder: 'Task title' },
        { key: 'deadline', name: 'Due', label: 'When is it due?', placeholder: 'YYYY-MM-DD, or skip', options: 'dates' },
    ] },
    client: { kind: 'client', label: 'client', title: 'New client', questions: [
        { key: 'clientName', name: 'Name', label: 'What is the client or company called?', placeholder: 'Client or company name' },
    ] },
};

export function slashWizardFor(name) {
    return SLASH_WIZARDS[name] || null;
}

export function parseSlashAnswer(key, answer) {
    const value = String(answer || '').trim();
    if (!value) return { error: 'Please enter a value.' };
    if (['amount', 'stipend'].includes(key)) {
        if (value.toLowerCase() === 'skip' && key === 'stipend') return { value: 0 };
        const number = Number(value.replace(/[,₹$€£]/g, ''));
        if (!Number.isFinite(number) || number < 0) return { error: 'Enter a valid non-negative amount.' };
        if (key === 'amount' && number <= 0) return { error: 'Enter an amount greater than zero.' };
        return { value: number };
    }
    if (key === 'gstRate') {
        const rate = Number(value.replace('%', ''));
        if (![0, 5, 12, 18, 28].includes(rate)) return { error: 'Use one of these GST rates: 0, 5, 12, 18 or 28.' };
        return { value: rate };
    }
    if (['department', 'startDate', 'deadline'].includes(key) && value.toLowerCase() === 'skip') return { value: '' };
    if (['startDate', 'deadline'].includes(key) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { error: 'Use the date format YYYY-MM-DD, or reply skip.' };
    return { value };
}

const isoIn = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** One-tap answers for a wizard question; date questions get relative picks. */
export function wizardOptions(question) {
    if (question?.options === 'dates') {
        return [
            { label: 'Today', value: isoIn(0) },
            { label: 'Tomorrow', value: isoIn(1) },
            { label: 'In a week', value: isoIn(7) },
            SKIP,
        ];
    }
    return question?.options || [];
}

/** How an accepted answer reads back in the wizard's review list. */
export function formatWizardValue(key, value) {
    if (value === '' || value == null) return '—';
    if (['amount', 'stipend'].includes(key)) return Number(value) ? `₹${Number(value).toLocaleString('en-IN')}` : 'Unpaid';
    if (key === 'gstRate') return `${value}%`;
    return String(value);
}
