import { KINDS, resolveEntity } from '../resolvers.js';

/**
 * Navigation. The agent can take the person to a screen or a record, and it
 * is also how it answers honestly when there is no tool for what was asked:
 * "I can't change salaries from chat — here's the employee page", with the
 * page opened rather than described.
 *
 * Opening a page reads nothing and writes nothing, so it needs no card. The
 * page itself still enforces the role, as it would from the sidebar.
 */

export const PAGES = {
  hub: { href: '/hub', label: 'Hub' },
  dashboard: { href: '/dashboard', label: 'Overview' },
  finance_dashboard: { href: '/dashboard/finance', label: 'Finance dashboard' },
  sales_dashboard: { href: '/dashboard/sales', label: 'Sales dashboard' },
  team_dashboard: { href: '/dashboard/team', label: 'Team dashboard' },
  usage: { href: '/dashboard/usage', label: 'Usage' },
  tasks: { href: '/tasks', label: 'Tasks' },
  projects: { href: '/projects', label: 'Projects' },
  new_project: { href: '/projects/new', label: 'New project' },
  timesheets: { href: '/timesheets', label: 'Timesheets' },
  crm: { href: '/crm', label: 'CRM board' },
  clients: { href: '/customers', label: 'Clients' },
  products: { href: '/products', label: 'Products' },
  invoices: { href: '/invoices', label: 'Invoices' },
  new_invoice: { href: '/new-invoice', label: 'New invoice' },
  quotations: { href: '/quotations', label: 'Quotations' },
  new_quotation: { href: '/new-quotation', label: 'New quotation' },
  proforma: { href: '/proforma', label: 'Proforma invoices' },
  recurring: { href: '/recurring', label: 'Recurring invoices' },
  cashbook: { href: '/cashbook', label: 'Cash book' },
  vendors: { href: '/vendors', label: 'Vendors' },
  purchases: { href: '/purchases', label: 'Purchase bills' },
  profit_loss: { href: '/profit-loss', label: 'Profit & loss' },
  tax_summary: { href: '/tax-summary', label: 'Tax summary' },
  employees: { href: '/employees', label: 'Employees' },
  new_employee: { href: '/employees/new', label: 'Add employee' },
  attendance: { href: '/attendance', label: 'Attendance' },
  leave: { href: '/leave', label: 'Leave requests' },
  announcements: { href: '/announcements', label: 'Announcements' },
  offers: { href: '/offers', label: 'Offer letters' },
  ndas: { href: '/ndas', label: 'NDAs' },
  mous: { href: '/mous', label: 'MoUs' },
  certificates: { href: '/certificates', label: 'Certificates' },
  library: { href: '/library', label: 'Document library' },
  edgebrain: { href: '/edgebrain', label: 'EdgeBrain' },
  settings: { href: '/profile', label: 'Company profile & settings' },
};

const open_page = {
  name: 'open_page',
  module: 'core',
  kind: 'navigate',
  permission: null,
  description: 'Open a screen of EdgeOS — only when the user asks to go somewhere, or when no tool can do what they want (then say so plainly). Never instead of a tool that can do the job, and never just to collect details.',
  params: {
    type: 'object',
    properties: { page: { type: 'string', enum: Object.keys(PAGES) } },
    required: ['page'],
  },
  async run(args) {
    const page = PAGES[args.page];
    if (!page) return { data: { error: `No page called ${args.page}.` } };
    return { data: { opened: page.label }, navigate: page };
  },
};

const open_record = {
  name: 'open_record',
  module: 'core',
  kind: 'navigate',
  permission: null,
  description: 'Open the screen for one record — a task, client, project, invoice, person or vendor — by name, code or "it".',
  params: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: Object.keys(KINDS) },
      ref: { type: 'string' },
    },
    required: ['type', 'ref'],
  },
  async run(args, ctx) {
    if (!KINDS[args.type]) return { data: { error: `Unknown record type ${args.type}` } };
    const r = await resolveEntity(args.type, args.ref, ctx);
    if (r.status === 'one') {
      return { data: { opened: r.entity.label }, navigate: { href: r.entity.href, label: r.entity.label }, entities: [r.entity] };
    }
    if (r.status === 'many') return { data: { ambiguous: true, candidates: r.candidates.map((c) => c.entity.label) } };
    return { data: { not_found: r.searched } };
  },
};

export default [open_page, open_record];
