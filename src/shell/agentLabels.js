import { resolveLegacyPath } from './redirects';

/* ══════════════════════════════════════════════════════════════════════════
   Words the agent sends that name screens or systems by their old names.

   The tool contracts (api/_lib/agent/tools/*) are not changing, so their
   labels still say "Timesheets", "Cash book" or "EdgeBrain". These map them,
   at display time only, to where the person actually lands and what things
   are called now. A record's own label ("Acme", "INV-0042") passes through.
   ══════════════════════════════════════════════════════════════════════════ */

const PAGE_LABEL = {
    Hub: 'Chat', Overview: 'Reports', 'Finance dashboard': 'Reports', 'Sales dashboard': 'Clients',
    'Team dashboard': 'Team', Usage: 'Plan and usage', Tasks: 'Work', Projects: 'Work', 'New project': 'a new project',
    Timesheets: 'Work', 'CRM board': 'Clients', Clients: 'Clients', Products: 'Items', Invoices: 'Invoices',
    'New invoice': 'a new invoice', Quotations: 'Quotes', 'New quotation': 'a new quote', 'Proforma invoices': 'Proformas',
    'Recurring invoices': 'Invoices', 'Cash book': 'Transactions', Vendors: 'Bills', 'Purchase bills': 'Bills',
    'Profit & loss': 'Reports', 'Tax summary': 'Reports', Employees: 'Team', 'Add employee': 'Team',
    Attendance: 'Team', 'Leave requests': 'Team', Announcements: 'Team', 'Offer letters': 'a new offer letter',
    NDAs: 'a new NDA', MoUs: 'Team', Certificates: 'Team', 'Document library': 'Files', EdgeBrain: 'Settings',
    'Company profile & settings': 'Settings',
};

/** "Opened …" for a navigate event: the new name of a page, or the record's own label. */
export function openedLabel(href, label) {
    if (label && PAGE_LABEL[label] && resolveLegacyPath(href)) return PAGE_LABEL[label];
    return label;
}

const STATUS = { 'Asking EdgeBrain…': 'Checking what I know…' };

/** A tool's status line, as shown under the typing dots. */
export const statusLabel = (text) => STATUS[text] || text;
