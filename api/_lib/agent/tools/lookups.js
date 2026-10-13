import { loadKind, entityOf } from '../resolvers.js';
import { money, formatDate, readDate } from '../helpers.js';

/**
 * Plain lookups: what is in the company's records, read back as it is.
 *
 * Vendors, the catalogue, departments, the company's own details, the notice
 * board, a person's logged hours, letters and leave. None of these needs a
 * model to answer — each reads through the caller's own client (RLS decides
 * what comes back) and returns counts over everything it matched plus the
 * rows it shows, like the other read tools.
 */

const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt; };
const s = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hm = (minutes) => { const h = Math.floor(minutes / 60); const m = minutes % 60; return [h ? `${h} h` : null, m ? `${m} min` : null].filter(Boolean).join(' ') || '0 min'; };

const list_vendors = {
  name: 'list_vendors',
  module: 'finance',
  kind: 'read',
  permission: { resource: 'vendors', action: 'view' },
  description: 'The vendors (suppliers) the company buys from: name, contact, credit days. For what is owed to them use list_bills.',
  params: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } },
  status: 'Checking vendors…',
  async run(args, ctx) {
    const rows = (await loadKind('vendor', ctx)).filter((v) => !v.archived_at).sort((a, b) => String(a.company_name).localeCompare(String(b.company_name)));
    const shown = rows.slice(0, clamp(args.limit, 1, 100, 30));
    return {
      data: { total: rows.length, showing: shown.length, vendors: shown.map((v) => ({ id: v.id, name: v.company_name, contact: v.contact_name || null, email: v.email || null })) },
      entities: shown.slice(0, 10).map((v) => entityOf('vendor', v)),
      view: { type: 'list', title: 'Vendors', total: rows.length, href: '/vendors', items: shown.map((v) => ({ title: v.company_name, sub: [v.contact_name, v.email].filter(Boolean).join(' · ') })) },
    };
  },
};

const list_catalog = {
  name: 'list_catalog',
  module: 'finance',
  kind: 'read',
  permission: { resource: 'catalog_items', action: 'view' },
  description: 'The catalogue: what the company sells, with each item\'s price, unit and GST rate. Use it for "what do we sell?", "what is the price of X?".',
  params: { type: 'object', properties: { text: { type: 'string', description: 'Part of an item\'s name.' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
  status: 'Checking the catalogue…',
  async run(args, ctx) {
    const { data, error } = await ctx.db.from('catalog_items').select('id, name, sku, unit_price, unit, tax_rate, hsn_sac, archived_at').eq('org_id', ctx.orgId).limit(1000);
    if (error) return { data: { error: 'Could not read the catalogue.' } };
    const said = String(args.text || '').trim().toLowerCase();
    const rows = (data || []).filter((i) => !i.archived_at && (!said || String(i.name).toLowerCase().includes(said))).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const shown = rows.slice(0, clamp(args.limit, 1, 100, 30));
    return {
      data: { total: rows.length, showing: shown.length, items: shown.map((i) => ({ id: i.id, name: i.name, price: money(i.unit_price), unit: i.unit || 'Nos', gst: `${Number(i.tax_rate ?? 18)}%` })) },
      view: { type: 'list', title: 'Catalogue', total: rows.length, href: '/products', items: shown.map((i) => ({ title: i.name, sub: [`per ${i.unit || 'Nos'}`, `GST ${Number(i.tax_rate ?? 18)}%`, i.hsn_sac].filter(Boolean).join(' · '), value: money(i.unit_price) })) },
    };
  },
};

const list_departments = {
  name: 'list_departments',
  module: 'people',
  kind: 'read',
  permission: { resource: 'employees', action: 'view' },
  description: 'The company\'s departments and how many people are in each.',
  params: { type: 'object', properties: {} },
  async run(_args, ctx) {
    const { data, error } = await ctx.db.from('departments').select('id, name').eq('org_id', ctx.orgId);
    if (error) return { data: { error: 'Could not read the departments.' } };
    const people = (await loadKind('employee', ctx)).filter((e) => !e.exited_at);
    const rows = (data || []).map((d) => ({ id: d.id, name: d.name, people: people.filter((e) => e.department_id === d.id).length })).sort((a, b) => a.name.localeCompare(b.name));
    return {
      data: { total: rows.length, departments: rows, unassigned_people: people.filter((e) => !e.department_id).length },
      view: { type: 'list', title: 'Departments', total: rows.length, href: '/employees', items: rows.map((d) => ({ title: d.name, value: s(d.people, 'person', 'people') })) },
    };
  },
};

const PROFILE = [
  ['name', 'company_name', 'Company name'], ['tagline', 'company_tagline', 'Tagline'], ['address', 'company_address', 'Address'],
  ['phone', 'company_phone', 'Phone'], ['email', 'company_email', 'Email'], ['website', 'company_website', 'Website'],
  ['signatory', 'owner_full_name', 'Signatory'], ['signatory_title', 'document_designation', 'Signatory title'],
];

const company_profile = {
  name: 'company_profile',
  module: 'core',
  kind: 'read',
  permission: null,
  description: 'The company\'s own details as printed on its documents: name, tagline, address, phone, email, website and who signs. '
    + 'Bank details, GSTIN and credentials are not readable here.',
  params: { type: 'object', properties: { field: { type: 'string', enum: PROFILE.map(([k]) => k), description: 'One detail, when only that was asked.' } } },
  async run(args, ctx) {
    const { data, error } = await ctx.db.from('organizations').select('*').eq('id', ctx.orgId).maybeSingle();
    if (error || !data) return { data: { error: 'Could not read the company profile.' } };
    const details = Object.fromEntries(PROFILE.map(([k, col]) => [k, data[col] || null]));
    return {
      data: { field: PROFILE.some(([k]) => k === args.field) ? args.field : null, details },
      view: { type: 'list', title: details.name || 'Company profile', total: PROFILE.filter(([k]) => details[k]).length, href: '/profile', items: PROFILE.filter(([k]) => details[k]).map(([k, , label]) => ({ title: label, value: details[k] })) },
    };
  },
};

const list_announcements = {
  name: 'list_announcements',
  module: 'people',
  kind: 'read',
  permission: { resource: ['announcements', 'employees'], action: 'view' },
  description: 'The notices on the team\'s announcement board that are live now: title, what it says, when it was posted.',
  params: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 30 } } },
  async run(args, ctx) {
    const { data, error } = await ctx.db.from('announcements').select('id, title, body, department_id, is_pinned, published_at, expires_at').eq('org_id', ctx.orgId).limit(500);
    if (error) return { data: { error: 'Could not read the announcements.' } };
    const now = Date.parse(ctx.now || `${ctx.today}T12:00:00Z`);
    const live = (data || []).filter((a) => (!a.published_at || Date.parse(a.published_at) <= now) && (!a.expires_at || Date.parse(a.expires_at) >= now))
      .sort((a, b) => Number(!!b.is_pinned) - Number(!!a.is_pinned) || String(b.published_at).localeCompare(String(a.published_at)));
    const shown = live.slice(0, clamp(args.limit, 1, 30, 10));
    return {
      data: { total: live.length, showing: shown.length, announcements: shown.map((a) => ({ id: a.id, title: a.title, says: String(a.body || '').slice(0, 300), posted: a.published_at ? formatDate(String(a.published_at).slice(0, 10)) : null, pinned: !!a.is_pinned })) },
      view: { type: 'list', title: 'Announcements', total: live.length, href: '/announcements', items: shown.map((a) => ({ title: a.title, sub: String(a.body || '').slice(0, 120), badge: a.is_pinned ? 'Pinned' : null })) },
    };
  },
};

const my_time = {
  name: 'my_time',
  module: 'projects',
  kind: 'read',
  permission: null,
  privateOnly: true,
  description: 'The time the user has logged on projects over a period (default this week): the total and the split by project. Their own entries only.',
  params: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
  status: 'Checking your timesheet…',
  async run(args, ctx) {
    if (!ctx.employeeId) return { data: { unavailable: 'You are not linked to a person in Team, so there is no timesheet of yours to read.' } };
    const today = ctx.today;
    const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const monday = new Date(Date.parse(`${today}T00:00:00Z`) - dow * 86400000).toISOString().slice(0, 10);
    const from = (args.from && readDate(args.from, today).value) || monday;
    const to = (args.to && readDate(args.to, today).value) || today;
    const { data, error } = await ctx.db.from('timesheet_entries').select('id, project_id, work_date, minutes, status, note').eq('employee_id', ctx.employeeId).gte('work_date', from).lte('work_date', to);
    if (error) return { data: { error: 'Could not read your timesheet.' } };
    const rows = data || [];
    const projects = ctx.can('projects', 'view') ? await loadKind('project', ctx) : [];
    const byProject = new Map();
    for (const r of rows) byProject.set(r.project_id, (byProject.get(r.project_id) || 0) + (Number(r.minutes) || 0));
    const split = [...byProject.entries()].map(([id, minutes]) => ({ project: projects.find((p) => p.id === id)?.name || 'A project', minutes, time: hm(minutes) })).sort((a, b) => b.minutes - a.minutes);
    const total = rows.reduce((sum, r) => sum + (Number(r.minutes) || 0), 0);
    return {
      data: { from, to, entries: rows.length, total_minutes: total, total: hm(total), not_submitted: rows.filter((r) => r.status === 'draft').length, by_project: split },
      view: { type: 'list', title: 'My time', total: split.length, href: '/timesheets', items: split.map((p) => ({ title: p.project, value: p.time })) },
    };
  },
};

const LETTER_KIND = { offer: 'Offer letter', nda: 'NDA', mou: 'MoU', certificate: 'Certificate' };
const LETTER_STATUS = { draft: 'Draft', pending: 'Not sent', sent: 'Sent', viewed: 'Viewed', accepted: 'Accepted', signed: 'Signed', declined: 'Declined', cancelled: 'Cancelled', expired: 'Expired' };

const list_letters = {
  name: 'list_letters',
  module: 'team',
  kind: 'read',
  permission: { resource: 'records', action: 'view' },
  privateOnly: true,
  description: 'Offer letters, NDAs, MoUs and certificates the company has made: who each is for, its number and whether it is a draft, not sent, sent or signed.',
  params: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: Object.keys(LETTER_KIND) },
      status: { type: 'string', enum: Object.keys(LETTER_STATUS) },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  status: 'Checking letters…',
  async run(args, ctx) {
    let q = ctx.db.from('records').select('id, type, status, doc_number, title, recipient_name, issue_date, created_at').eq('org_id', ctx.orgId).limit(1000);
    if (LETTER_KIND[args.type]) q = q.eq('type', args.type);
    if (LETTER_STATUS[args.status]) q = q.eq('status', args.status);
    const { data, error } = await q;
    if (error) return { data: { error: 'Could not read the letters.' } };
    const rows = (data || []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const shown = rows.slice(0, clamp(args.limit, 1, 50, 20));
    const row = (r) => ({ id: r.id, kind: LETTER_KIND[r.type] || r.type, for: r.recipient_name || r.title || 'Unaddressed', number: r.doc_number, status: LETTER_STATUS[r.status] || r.status, date: r.issue_date ? formatDate(r.issue_date) : null });
    return {
      data: { total_matching: rows.length, showing: shown.length, kind: LETTER_KIND[args.type] || null, letters: shown.map(row) },
      view: { type: 'list', title: args.type ? `${LETTER_KIND[args.type]}s` : 'Letters', total: rows.length, href: '/employees', items: shown.map((r) => ({ title: r.recipient_name || r.title || 'Unaddressed', sub: [args.type ? null : LETTER_KIND[r.type], r.doc_number].filter(Boolean).join(' · '), value: LETTER_STATUS[r.status] || r.status })) },
    };
  },
};

const leave_balance = {
  name: 'leave_balance',
  module: 'people',
  kind: 'read',
  permission: null,
  privateOnly: true,
  description: 'The company\'s leave types and, for the user, how many days of each are left this year. Use it for "what leave types do we have?", "how much leave do I have?".',
  params: { type: 'object', properties: { mine: { type: 'boolean', description: 'True when the user asks about their own balance.' } } },
  status: 'Checking leave…',
  async run(args, ctx) {
    const { data: types, error } = await ctx.db.from('leave_types').select('id, name, annual_quota, is_paid, is_active, sort_order').eq('org_id', ctx.orgId);
    if (error) return { data: { error: 'Could not read the leave types.' } };
    const live = (types || []).filter((t) => t.is_active !== false).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    let balances = [];
    if (ctx.employeeId) {
      const { data } = await ctx.db.from('leave_balances_v').select('leave_type_id, leave_type_name, quota, taken, remaining').eq('employee_id', ctx.employeeId);
      balances = data || [];
    }
    const rows = live.map((t) => {
      const b = balances.find((x) => x.leave_type_id === t.id);
      return { name: t.name, per_year: Number(t.annual_quota) || 0, paid: t.is_paid !== false, taken: b ? Number(b.taken) : null, left: b ? Number(b.remaining) : null };
    });
    return {
      data: { mine: args.mine === true, linked: !!ctx.employeeId, has_balances: balances.length > 0, types: rows },
      view: { type: 'list', title: args.mine ? 'My leave' : 'Leave types', total: rows.length, href: '/leave', items: rows.map((t) => ({ title: t.name, sub: `${t.per_year} a year${t.paid ? '' : ' · unpaid'}`, value: t.left === null ? null : `${t.left} left` })) },
    };
  },
};

export default [list_vendors, list_catalog, list_departments, company_profile, list_announcements, my_time, list_letters, leave_balance];
