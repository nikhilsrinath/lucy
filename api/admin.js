import nodemailer from 'nodemailer';
import { supabaseAdmin } from './_lib/supabaseAdmin.js';
import { requirePlatformAdmin, sendError, methodIs, readJsonBody, HttpError } from './_lib/auth.js';

/**
 * POST /api/admin — the platform console's only endpoint.
 *
 * Body: { action, ...args }
 *
 * The platform admin's RLS policies grant SELECT across tenants and nothing
 * else, so every read that needs a join across tenants and every write lands
 * here, behind the `platform_admin` claim in app_metadata — which only the
 * service role can set (scripts/setup-admin.js).
 *
 * PLATFORM_ADMIN_EMAIL narrows that further: when set, the claim alone is not
 * enough and the caller's address must match. Two locks on one door, because
 * this route reads every tenant's revenue and contact list.
 *
 * What this replaces: admin/index.html gated the entire panel on
 * `localStorage.admin_password || 'admin123'` and a `localStorage.admin_session`
 * flag, then signed in to Firebase anonymously and deleted organizations
 * directly from the browser.
 */
export default async function handler(req, res) {
  if (!methodIs(req, res, 'POST')) return;

  try {
    const admin = await requirePlatformAdmin(req);
    assertAllowedAddress(admin);

    const body = await readJsonBody(req);
    const { action } = body || {};

    const route = ACTIONS[action];
    if (!route) throw new HttpError(400, `Unknown action: ${action}`);

    const payload = await route(body, admin, req);
    return res.status(200).json({ success: true, ...payload });
  } catch (err) {
    return sendError(res, err, 'api/admin');
  }
}

/**
 * The console is for one operator. The claim is the authorization; this is the
 * identity check on top of it, so a second account that somehow acquires the
 * claim still cannot read the platform.
 */
function assertAllowedAddress(admin) {
  const allowed = (process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!allowed) return;
  if ((admin.email || '').toLowerCase() !== allowed) {
    throw new HttpError(403, 'This account is not the platform administrator');
  }
}

const ACTIONS = {
  overview: getOverview,
  list_orgs: listOrgs,
  org_detail: orgDetail,
  set_plan: setPlan,
  delete_org: deleteOrg,
  restore_org: restoreOrg,
  send_email: sendEmail,
};

/* ── reading ──────────────────────────────────────────────────────────────── */

const PAGE = 1000;

/**
 * Supabase caps a select at 1000 rows regardless of what you ask for, so a
 * platform-wide aggregate has to page. Bounded so a runaway table cannot turn
 * one request into an unbounded scan.
 */
async function fetchAll(table, columns, tune = (q) => q, maxPages = 40) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * PAGE;
    const { data, error } = await tune(
      supabaseAdmin().from(table).select(columns).range(from, from + PAGE - 1),
    );
    if (error) throw new HttpError(500, `${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/**
 * auth.users is not reachable through PostgREST, so identities come from the
 * admin API. Paged the same way, and returned as a Map keyed by user id.
 */
async function loadAuthUsers(maxPages = 40) {
  const byId = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const { data, error } = await supabaseAdmin().auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new HttpError(500, error.message);
    for (const u of data.users) {
      byId.set(u.id, {
        id: u.id,
        email: u.email || null,
        full_name: u.user_metadata?.full_name || u.user_metadata?.name || null,
        phone: u.phone || u.user_metadata?.phone || null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at || null,
        confirmed: !!(u.email_confirmed_at || u.confirmed_at),
        platform_admin: u.app_metadata?.platform_admin === true,
      });
    }
    if (data.users.length < 200) break;
  }
  return byId;
}

const num = (v) => Number(v) || 0;
const monthOf = (iso) => String(iso || '').slice(0, 7);

/** Money a tenant has billed, collected and is still owed, from its invoices. */
function rollUpRevenue(docs) {
  const acc = {
    billed: 0, collected: 0, outstanding: 0,
    invoices: 0, quotations: 0, proformas: 0, paidInvoices: 0, overdue: 0,
    lastInvoiceAt: null,
  };
  for (const d of docs) {
    if (d.type === 'quotation') { acc.quotations += 1; continue; }
    if (d.type === 'proforma') { acc.proformas += 1; continue; }
    if (d.status === 'draft' || d.status === 'void' || d.status === 'cancelled') continue;

    const total = num(d.grand_total);
    const paid = num(d.amount_paid);
    acc.invoices += 1;
    acc.billed += total;
    acc.collected += paid;
    acc.outstanding += Math.max(0, total - paid);
    if (paid >= total - 0.01) acc.paidInvoices += 1;
    if (d.status === 'overdue') acc.overdue += Math.max(0, total - paid);
    if (!acc.lastInvoiceAt || d.issue_date > acc.lastInvoiceAt) acc.lastInvoiceAt = d.issue_date;
  }
  return acc;
}

/** The last `months` calendar months, oldest first, as { month, billed, collected }. */
function monthlySeries(docs, months = 12) {
  const keys = [];
  const cursor = new Date();
  cursor.setUTCDate(1);
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - i, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  const index = new Map(keys.map((k) => [k, { month: k, billed: 0, collected: 0 }]));
  for (const d of docs) {
    if (d.type !== 'invoice') continue;
    if (d.status === 'draft' || d.status === 'void' || d.status === 'cancelled') continue;
    const bucket = index.get(monthOf(d.issue_date));
    if (!bucket) continue;
    bucket.billed += num(d.grand_total);
    bucket.collected += num(d.amount_paid);
  }
  return keys.map((k) => index.get(k));
}

/** Platform-wide counters, plan split and the twelve-month curve. */
async function getOverview() {
  const [orgs, subs, members, docs, users] = await Promise.all([
    fetchAll('organizations', 'id, company_name, created_at, deleted_at'),
    fetchAll('subscriptions', 'org_id, plan, status'),
    fetchAll('memberships', 'org_id, user_id'),
    fetchAll('financial_documents', 'org_id, type, status, grand_total, amount_paid, issue_date'),
    loadAuthUsers(),
  ]);

  const live = orgs.filter((o) => !o.deleted_at);
  const liveIds = new Set(live.map((o) => o.id));
  const liveDocs = docs.filter((d) => liveIds.has(d.org_id));
  const revenue = rollUpRevenue(liveDocs);

  const plans = { free: 0, pro: 0, max: 0 };
  const statuses = {};
  for (const s of subs) {
    if (!liveIds.has(s.org_id)) continue;
    if (plans[s.plan] !== undefined) plans[s.plan] += 1;
    statuses[s.status] = (statuses[s.status] || 0) + 1;
  }
  // An org provisioned before subscriptions had a row still counts as free.
  plans.free += live.length - subs.filter((s) => liveIds.has(s.org_id)).length;

  // Signups per month, on the same twelve-month axis as the revenue curve.
  const series = monthlySeries(liveDocs);
  const signups = new Map(series.map((p) => [p.month, 0]));
  for (const o of live) {
    const key = monthOf(o.created_at);
    if (signups.has(key)) signups.set(key, signups.get(key) + 1);
  }

  return {
    totals: {
      orgs: live.length,
      deletedOrgs: orgs.length - live.length,
      users: users.size,
      members: members.filter((m) => liveIds.has(m.org_id)).length,
      newOrgs30d: live.filter((o) => Date.now() - Date.parse(o.created_at) < 30 * 864e5).length,
      activeUsers30d: [...users.values()]
        .filter((u) => u.last_sign_in_at && Date.now() - Date.parse(u.last_sign_in_at) < 30 * 864e5).length,
      ...revenue,
    },
    plans,
    statuses,
    series: series.map((p) => ({ ...p, signups: signups.get(p.month) || 0 })),
  };
}

/** One row per tenant: who owns it, what it pays, what it has earned. */
async function listOrgs() {
  const [orgs, subs, members, docs, usage, users, employees, customers] = await Promise.all([
    fetchAll('organizations',
      'id, company_name, company_email, company_phone, company_website, owner_uid, owner_full_name, '
      + 'industry, country, city, company_size, created_at, deleted_at'),
    fetchAll('subscriptions', 'org_id, plan, status, current_period_end, updated_at'),
    fetchAll('memberships', 'org_id, user_id, role'),
    fetchAll('financial_documents', 'org_id, type, status, grand_total, amount_paid, issue_date'),
    fetchAll('usage_counters', '*'),
    loadAuthUsers(),
    fetchAll('employees', 'org_id, exited_at'),
    fetchAll('customers', 'org_id'),
  ]);

  const group = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.org_id)) m.set(r.org_id, []);
      m.get(r.org_id).push(r);
    }
    return m;
  };
  const docsBy = group(docs);
  const membersBy = group(members);
  const empBy = group(employees);
  const custBy = group(customers);
  const subBy = new Map(subs.map((s) => [s.org_id, s]));
  const usageBy = new Map(usage.map((u) => [u.org_id, u]));

  const rows = orgs.map((o) => {
    const owner = users.get(o.owner_uid) || null;
    const mine = membersBy.get(o.id) || [];
    const sub = subBy.get(o.id) || { plan: 'free', status: 'active', current_period_end: null };
    const lastSignIn = mine
      .map((m) => users.get(m.user_id)?.last_sign_in_at)
      .filter(Boolean)
      .sort()
      .pop() || null;

    return {
      id: o.id,
      name: o.company_name,
      email: o.company_email || owner?.email || null,
      phone: o.company_phone || null,
      website: o.company_website || null,
      industry: o.industry || null,
      location: [o.city, o.country].filter(Boolean).join(', ') || null,
      companySize: o.company_size || null,
      createdAt: o.created_at,
      deletedAt: o.deleted_at,
      owner: owner
        ? { id: owner.id, email: owner.email, name: o.owner_full_name || owner.full_name, lastSignInAt: owner.last_sign_in_at }
        : { id: o.owner_uid, email: null, name: o.owner_full_name, lastSignInAt: null },
      plan: sub.plan,
      status: sub.status,
      periodEnd: sub.current_period_end,
      seats: mine.length,
      employees: (empBy.get(o.id) || []).filter((e) => !e.exited_at).length,
      customers: (custBy.get(o.id) || []).length,
      lastSignInAt: lastSignIn,
      usage: usageBy.get(o.id) || null,
      revenue: rollUpRevenue(docsBy.get(o.id) || []),
    };
  });

  rows.sort((a, b) => b.revenue.billed - a.revenue.billed || String(a.name).localeCompare(String(b.name)));
  return { orgs: rows };
}

/** Everything the console shows when one tenant is opened. */
async function orgDetail({ org_id: orgId }) {
  if (!orgId) throw new HttpError(400, 'Missing org_id');

  const one = (table, columns, tune) => fetchAll(table, columns, (q) => tune(q.eq('org_id', orgId)), 10);

  const [[org], banking, [sub], [usage], members, docs, payments, expenses, customers, employees, auditRows] =
    await Promise.all([
      fetchAll('organizations', '*', (q) => q.eq('id', orgId), 1),
      fetchAll('org_banking', 'gstin, cin, upi_id, bank_name, bank_ifsc, bank_account_type', (q) => q.eq('org_id', orgId), 1),
      one('subscriptions', '*', (q) => q),
      one('usage_counters', '*', (q) => q),
      one('memberships', 'user_id, role, created_at', (q) => q),
      one('financial_documents', 'id, doc_number, type, status, bill_to_name, bill_to_email, grand_total, amount_paid, issue_date, due_date', (q) => q.order('issue_date', { ascending: false })),
      one('payments', 'amount, paid_on, method, reference', (q) => q.order('paid_on', { ascending: false })),
      one('expenses', 'amount, category, incurred_on', (q) => q),
      one('customers', 'id, name, email, phone, state, created_at', (q) => q.order('created_at', { ascending: false })),
      one('employees', 'id, full_name, email, phone, role, exited_at', (q) => q),
      one('audit_log', 'action, entity_type, created_at, diff', (q) => q.order('created_at', { ascending: false }).limit(40)),
    ]);

  if (!org) throw new HttpError(404, 'Organization not found');

  const users = await loadAuthUsers();
  const spend = expenses.reduce((a, e) => a + num(e.amount), 0);

  return {
    org: {
      ...org,
      banking: banking[0] || null,
      subscription: sub || { plan: 'free', status: 'active' },
      usage: usage || null,
    },
    members: members.map((m) => {
      const u = users.get(m.user_id);
      return {
        id: m.user_id,
        role: m.role,
        joinedAt: m.created_at,
        email: u?.email || null,
        name: u?.full_name || null,
        lastSignInAt: u?.last_sign_in_at || null,
        confirmed: u?.confirmed ?? null,
        isOwner: m.user_id === org.owner_uid,
      };
    }).sort((a, b) => Number(b.isOwner) - Number(a.isOwner)),
    revenue: {
      ...rollUpRevenue(docs),
      expenses: spend,
      series: monthlySeries(docs),
    },
    documents: docs.slice(0, 50),
    payments: payments.slice(0, 25),
    customers: customers.slice(0, 50),
    employees,
    audit: auditRows,
  };
}

/* ── writing ──────────────────────────────────────────────────────────────── */

const PLANS = new Set(['free', 'pro', 'max']);
const STATUSES = new Set(['active', 'past_due', 'cancelled', 'paused', 'trialing']);

async function setPlan({ org_id: orgId, plan, status, period_end: periodEnd }, admin) {
  if (!orgId) throw new HttpError(400, 'Missing org_id');
  if (!PLANS.has(plan)) throw new HttpError(400, 'plan must be free, pro or max');
  if (status !== undefined && status !== null && !STATUSES.has(status)) {
    throw new HttpError(400, `status must be one of ${[...STATUSES].join(', ')}`);
  }

  const patch = { org_id: orgId, plan, updated_at: new Date().toISOString() };
  if (status) patch.status = status;
  if (periodEnd !== undefined) patch.current_period_end = periodEnd || null;

  const { error } = await supabaseAdmin()
    .from('subscriptions')
    .upsert(patch, { onConflict: 'org_id' });
  if (error) throw new HttpError(500, error.message);

  await audit(orgId, admin.id, 'admin.set_plan', { plan, status: status || null, period_end: periodEnd ?? null });
  return { plan, status: status || null };
}

/**
 * Soft delete. The organizations RLS policy filters on `deleted_at is null`,
 * so the tenant disappears from every client query immediately while the rows
 * remain recoverable — the old panel called deleteDoc() and the data was gone.
 */
async function deleteOrg({ org_id: orgId }, admin, req) {
  if (!orgId) throw new HttpError(400, 'Missing org_id');
  const { error } = await supabaseAdmin()
    .from('organizations')
    .update({ deleted_at: new Date().toISOString(), deleted_by: admin.id })
    .eq('id', orgId)
    .is('deleted_at', null);
  if (error) throw new HttpError(500, error.message);

  await audit(orgId, admin.id, 'admin.delete_org', {}, req);
  return {};
}

async function restoreOrg({ org_id: orgId }, admin, req) {
  if (!orgId) throw new HttpError(400, 'Missing org_id');
  const { error } = await supabaseAdmin()
    .from('organizations')
    .update({ deleted_at: null, deleted_by: null })
    .eq('id', orgId);
  if (error) throw new HttpError(500, error.message);

  await audit(orgId, admin.id, 'admin.restore_org', {}, req);
  return {};
}

/* ── mail ─────────────────────────────────────────────────────────────────── */

const RECIPIENT_CAP = 200;
const ADDRESS_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/**
 * Platform mail. Deliberately NOT the tenant's Gmail credentials from
 * org_secrets — those belong to the customer and their quota. This sends from
 * the platform's own mailbox, configured server-side only.
 */
async function sendEmail({ to, subject, body, html }, admin) {
  const user = process.env.PLATFORM_SMTP_USER;
  const pass = process.env.PLATFORM_SMTP_PASSWORD;
  if (!user || !pass) {
    throw new HttpError(503, 'Platform mail is not configured (PLATFORM_SMTP_USER / PLATFORM_SMTP_PASSWORD)');
  }

  const recipients = [...new Set(
    (Array.isArray(to) ? to : String(to || '').split(/[,\s]+/))
      .map((a) => String(a || '').trim().toLowerCase())
      .filter(Boolean),
  )];
  if (!recipients.length) throw new HttpError(400, 'At least one recipient is required');
  if (recipients.length > RECIPIENT_CAP) throw new HttpError(400, `At most ${RECIPIENT_CAP} recipients per send`);

  const bad = recipients.find((a) => !ADDRESS_RE.test(a));
  if (bad) throw new HttpError(400, `Not a valid address: ${bad}`);

  // A newline in a header value is a header injection; the subject is the only
  // caller-supplied header here, so it is the only one that needs the check.
  const line = String(subject || '').trim();
  if (!line) throw new HttpError(400, 'Subject is required');
  if (/[\r\n]/.test(line)) throw new HttpError(400, 'Subject cannot contain line breaks');
  if (line.length > 300) throw new HttpError(400, 'Subject is too long');

  const text = String(body || '').trim();
  if (!text && !html) throw new HttpError(400, 'Message body is required');
  if (text.length > 100000) throw new HttpError(400, 'Message body is too long');

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass },
  });

  // Recipients go in BCC so a broadcast does not publish the customer list to
  // every customer on it.
  let info;
  try {
    info = await transporter.sendMail({
      from: `"${(process.env.PLATFORM_MAIL_FROM || 'StartupBuddy').replace(/["\r\n]/g, '')}" <${user}>`,
      to: user,
      bcc: recipients,
      subject: line,
      text: text || undefined,
      html: html || undefined,
    });
  } catch (err) {
    console.error('[api/admin] mail send failed:', err?.message);
    throw new HttpError(502, err?.responseCode === 535
      ? 'SMTP rejected the platform credentials'
      : 'Could not send the message');
  }

  await audit(null, admin.id, 'admin.send_email', { recipients: recipients.length, subject: line });
  return { sent: recipients.length, messageId: info.messageId };
}

/* ── audit ────────────────────────────────────────────────────────────────── */

async function audit(orgId, actorId, action, diff, req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const { error } = await supabaseAdmin().from('audit_log').insert({
    org_id: orgId,
    actor_id: actorId,
    action,
    entity_type: 'organization',
    entity_id: orgId,
    diff,
    ip: forwarded.replace(/^::ffff:/, '') || null,
  });
  // The action already happened; a missing audit row must not undo it, but it
  // is the kind of gap that should be visible in the logs.
  if (error) console.error('[api/admin] audit write failed:', error.message);
}
