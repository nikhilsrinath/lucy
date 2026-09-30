import { loadKind, resolveEntity, entityOf, byId } from '../resolvers.js';
import { readDate, formatDate, formatDateShort, money } from '../helpers.js';
import { computeInsights } from '../insights.js';
import { recentFor, effectiveStatus } from '../actions.js';
import { shiftDays } from '../../../../src/shared/dates.js';

/**
 * Company-wide reads for Buddy as an operator: the pipeline, projects, the
 * team's load, the document library, what happened recently, what Buddy
 * itself did, and what Buddy has noticed.
 *
 * Same contract as read.js: run at once, through the user's own client,
 * counts over the whole filtered set ("total_matching"), a page of rows
 * beside them. Each also returns a `view` — a block built here from the same
 * rows — which the model may show with [[show:<view_id>]] (views.js).
 */

const clamp = (n, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : d));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function filterEntity(kind, ref, ctx) {
  if (ref === undefined || ref === null || ref === '') return { id: undefined };
  const r = await resolveEntity(kind, ref, ctx);
  if (r.status === 'one') return { id: r.row.id, entity: r.entity };
  if (r.status === 'many') return { reply: { ambiguous: true, kind, said: ref, candidates: r.candidates.map((c) => c.entity.label) } };
  return { reply: { not_found: true, kind, said: ref, searched: r.searched } };
}

/* ── clients & pipeline ───────────────────────────────────────────────────── */

const STAGE_OF = { lead: 'Lead', contacted: 'Contacted', active: 'Deal', lost: 'Lost', archived: 'Archived' };
const STAGE_FILTER = { lead: ['lead'], contacted: ['contacted'], deal: ['active'], lost: ['lost'], pipeline: ['lead', 'contacted'], active: ['lead', 'contacted', 'active'] };

const list_clients = {
  name: 'list_clients',
  module: 'clients',
  kind: 'read',
  permission: { resource: 'clients', action: 'view' },
  description: 'Clients and the sales pipeline: counts and value by stage (lead, contacted, deal, lost), and leads that have gone quiet. '
    + 'Filters: stage ("pipeline" = lead + contacted), inactive_days (not touched for at least N days), text.',
  params: {
    type: 'object',
    properties: {
      stage: { type: 'string', enum: ['pipeline', 'active', 'lead', 'contacted', 'deal', 'lost', 'all'] },
      inactive_days: { type: 'integer', minimum: 1, maximum: 365 },
      text: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  status: 'Checking clients…',
  async run(args, ctx) {
    const all = (await loadKind('client', ctx)).filter((c) => !c.archived_at && c.status !== 'archived');
    const byStage = {};
    for (const c of all) {
      const s = STAGE_OF[c.status] || c.status;
      byStage[s] = byStage[s] || { count: 0, value: 0 };
      byStage[s].count += 1;
      byStage[s].value += Number(c.value) || 0;
    }
    let rows = all;
    const stage = args.stage || 'active';
    if (stage !== 'all') rows = rows.filter((c) => (STAGE_FILTER[stage] || [stage]).includes(c.status));
    if (args.inactive_days) {
      const cutoff = new Date(Date.now() - Number(args.inactive_days) * 86400000).toISOString();
      rows = rows.filter((c) => c.updated_at && c.updated_at < cutoff);
    }
    if (args.text) {
      const t = String(args.text).toLowerCase();
      rows = rows.filter((c) => `${c.name} ${c.person_name || ''} ${c.notes || ''}`.toLowerCase().includes(t));
    }
    rows = [...rows].sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
    const limit = clamp(args.limit, 1, 50, 15);
    const shown = rows.slice(0, limit);
    const out = shown.map((c) => ({
      id: c.id, name: c.name, contact: c.person_name || null, stage: STAGE_OF[c.status] || c.status,
      value: Number(c.value) ? money(c.value) : null,
      last_touched: c.updated_at ? formatDate(c.updated_at.slice(0, 10)) : null,
    }));
    const pipelineValue = all.filter((c) => ['lead', 'contacted'].includes(c.status)).reduce((s, c) => s + (Number(c.value) || 0), 0);
    return {
      data: {
        total_matching: rows.length, showing: out.length,
        by_stage: Object.fromEntries(Object.entries(byStage).map(([k, v]) => [k, { count: v.count, value: money(v.value) }])),
        open_pipeline_value: money(pipelineValue),
        clients: out,
      },
      entities: shown.slice(0, 10).map((c) => entityOf('client', c)),
      view: {
        type: 'list',
        title: args.inactive_days ? `Quiet for ${args.inactive_days}+ days` : stage === 'pipeline' ? 'Open pipeline' : 'Clients',
        total: rows.length,
        href: '/clients',
        items: shown.map((c) => ({
          title: c.name,
          sub: [c.person_name, c.updated_at && `touched ${formatDateShort(c.updated_at.slice(0, 10), ctx.today)}`].filter(Boolean).join(' · '),
          value: Number(c.value) ? money(c.value) : null,
          badge: STAGE_OF[c.status] || c.status,
          tone: c.status === 'active' ? 'g' : c.status === 'lost' ? 'n' : 'b',
        })),
      },
    };
  },
};

/* ── projects ─────────────────────────────────────────────────────────────── */

const HEALTH = { on_track: ['On track', 'g'], at_risk: ['At risk', 'a'], off_track: ['Off track', 'r'] };

const list_projects = {
  name: 'list_projects',
  module: 'projects',
  kind: 'read',
  permission: { resource: 'projects', action: 'view' },
  description: 'Projects with status, health (on track / at risk / off track and why), client, target end date and open or overdue tasks. Filters: status, client, health.',
  params: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['open', 'planned', 'active', 'on_hold', 'completed', 'cancelled', 'all'] },
      client: { type: 'string' },
      health: { type: 'string', enum: ['at_risk', 'off_track', 'unhealthy'] },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  status: 'Checking projects…',
  async run(args, ctx) {
    const [{ data: projects, error }, portfolio, tasks] = await Promise.all([
      ctx.db.from('projects').select('id, code, name, status, client_id, start_date, target_end_date, archived_at, updated_at').limit(1000),
      ctx.db.rpc('project_portfolio', { p_org: ctx.orgId }).then((r) => r.data || []).catch(() => []),
      ctx.can('tasks', 'view') ? loadKind('task', ctx) : [],
    ]);
    if (error) return { data: { error: 'Could not read projects.' } };
    const health = new Map((portfolio || []).map((p) => [p.project_id, p]));
    let rows = (projects || []).filter((p) => !p.archived_at);
    const status = args.status || 'open';
    if (status === 'open') rows = rows.filter((p) => !['completed', 'cancelled'].includes(p.status));
    else if (status !== 'all') rows = rows.filter((p) => p.status === status);
    if (args.client) {
      const f = await filterEntity('client', args.client, ctx);
      if (f.reply) return { data: f.reply };
      rows = rows.filter((p) => p.client_id === f.id);
    }
    if (args.health) {
      rows = rows.filter((p) => {
        const h = health.get(p.id)?.health;
        return args.health === 'unhealthy' ? ['at_risk', 'off_track'].includes(h) : h === args.health;
      });
    }
    const open = (id) => tasks.filter((t) => t.project_id === id && t.status !== 'done');
    rows.sort((a, b) => (a.target_end_date || '9999').localeCompare(b.target_end_date || '9999'));
    const limit = clamp(args.limit, 1, 50, 15);
    const shown = rows.slice(0, limit);
    const out = [];
    for (const p of shown) {
      const h = health.get(p.id);
      const ot = open(p.id);
      out.push({
        id: p.id, code: p.code, name: p.name, status: p.status,
        client: p.client_id ? (await byId('client', p.client_id, ctx))?.name || null : null,
        target_end: p.target_end_date ? formatDate(p.target_end_date) : null,
        health: h?.health || null, health_reasons: h?.health_reasons || [],
        open_tasks: ot.length, overdue_tasks: ot.filter((t) => t.deadline && t.deadline < ctx.today).length,
      });
    }
    return {
      data: { total_matching: rows.length, showing: out.length, projects: out },
      entities: shown.slice(0, 10).map((p) => entityOf('project', p)),
      view: {
        type: 'list', title: args.health ? 'Projects needing attention' : 'Projects', total: rows.length, href: '/projects',
        items: out.map((p) => ({
          title: `${p.code} · ${p.name}`,
          sub: [p.client, p.target_end && `ends ${p.target_end}`, p.open_tasks && `${p.open_tasks} open${p.overdue_tasks ? `, ${p.overdue_tasks} overdue` : ''}`].filter(Boolean).join(' · '),
          badge: HEALTH[p.health]?.[0] || p.status.replace('_', ' '),
          tone: HEALTH[p.health]?.[1] || 'n',
          href: `/projects/${p.id}`,
        })),
      },
    };
  },
};

/* ── the team ─────────────────────────────────────────────────────────────── */

const list_team = {
  name: 'list_team',
  module: 'people',
  kind: 'read',
  permission: { resource: 'employees', action: 'view' },
  description: 'The team: who is on it, their role, and their current load — open, overdue and due-this-week tasks per person. Use it to pick an owner for work or to see who is overloaded.',
  params: {
    type: 'object',
    properties: {
      person: { type: 'string', description: 'One person, by name.' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  status: 'Checking the team…',
  async run(args, ctx) {
    let people = (await loadKind('employee', ctx)).filter((e) => !e.exited_at);
    if (args.person) {
      const f = await filterEntity('employee', args.person, ctx);
      if (f.reply) return { data: f.reply };
      people = people.filter((e) => e.id === f.id);
    }
    const tasks = ctx.can('tasks', 'view') ? (await loadKind('task', ctx)).filter((t) => t.status !== 'done') : [];
    const weekEnd = shiftDays(ctx.today, 7);
    const load = (id) => {
      const mine = tasks.filter((t) => t.assignee_id === id);
      return {
        open: mine.length,
        overdue: mine.filter((t) => t.deadline && t.deadline < ctx.today).length,
        due_this_week: mine.filter((t) => t.deadline && t.deadline >= ctx.today && t.deadline <= weekEnd).length,
        top: mine.sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999')).slice(0, 3).map((t) => t.title),
      };
    };
    const rows = people.map((e) => ({ e, l: load(e.id) })).sort((a, b) => b.l.open - a.l.open);
    const limit = clamp(args.limit, 1, 100, 30);
    const shown = rows.slice(0, limit);
    const unassigned = tasks.filter((t) => !t.assignee_id).length;
    return {
      data: {
        total_people: rows.length, showing: shown.length, unassigned_open_tasks: ctx.can('tasks', 'view') ? unassigned : null,
        people: shown.map(({ e, l }) => ({ id: e.id, name: e.full_name, role: e.role || null, open_tasks: l.open, overdue: l.overdue, due_this_week: l.due_this_week, next_up: l.top })),
      },
      entities: shown.slice(0, 10).map(({ e }) => entityOf('employee', e)),
      view: {
        type: 'list', title: 'Team load', total: rows.length, href: '/team',
        items: shown.map(({ e, l }) => ({
          title: e.full_name,
          sub: [e.role, l.top[0] && `next: ${l.top[0]}`].filter(Boolean).join(' · '),
          value: plural(l.open, 'open task'),
          badge: l.overdue ? `${l.overdue} overdue` : null,
          tone: l.overdue ? 'r' : l.open > 8 ? 'a' : 'g',
        })),
      },
    };
  },
};

/* ── documents ────────────────────────────────────────────────────────────── */

const list_documents = {
  name: 'list_documents',
  module: 'library',
  kind: 'read',
  permission: { resource: 'library_documents', action: 'view' },
  description: 'Documents in the company library (contracts, decks, policies, uploads): title, category, summary, date. Filter by text or category. For invoices and quotes use list_invoices.',
  params: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      category: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  status: 'Checking documents…',
  async run(args, ctx) {
    let q = ctx.db.from('library_documents').select('id, title, category, summary, file_name, extraction_status, created_at, updated_at')
      .order('updated_at', { ascending: false }).limit(500);
    if (args.category) q = q.eq('category', String(args.category).toLowerCase());
    const { data, error } = await q;
    if (error) return { data: { error: 'Could not read the document library.' } };
    let rows = data || [];
    if (args.text) {
      const t = String(args.text).toLowerCase();
      rows = rows.filter((d) => `${d.title} ${d.summary || ''} ${d.file_name}`.toLowerCase().includes(t));
    }
    const limit = clamp(args.limit, 1, 50, 15);
    const shown = rows.slice(0, limit);
    return {
      data: {
        total_matching: rows.length, showing: shown.length,
        documents: shown.map((d) => ({ id: d.id, title: d.title, category: d.category, summary: d.summary ? d.summary.slice(0, 300) : null, updated: formatDate(d.updated_at.slice(0, 10)) })),
      },
      view: {
        type: 'list', title: 'Documents', total: rows.length, href: '/chat?files=1',
        items: shown.map((d) => ({ title: d.title, sub: [d.category, formatDateShort(d.updated_at.slice(0, 10), ctx.today)].filter(Boolean).join(' · '), tone: 'n' })),
      },
    };
  },
};

/* ── what happened ────────────────────────────────────────────────────────── */

const ACTIVITY = {
  'tasks.insert': ['task', 'created', 'Tasks created'],
  'clients.insert': ['client', 'added', 'Clients added'],
  'financial_documents.insert': ['document', 'created', 'Documents created'],
  'payments.insert': ['payment', 'recorded', 'Payments recorded'],
  'expenses.insert': ['expense', 'recorded', 'Expenses recorded'],
  'income_entries.insert': ['income', 'recorded', 'Money in recorded'],
  'projects.insert': ['project', 'created', 'Projects created'],
  'purchase_invoices.insert': ['bill', 'recorded', 'Vendor bills recorded'],
};

const recent_activity = {
  name: 'recent_activity',
  module: 'core',
  kind: 'read',
  permission: null,
  description: 'What happened in the company over a period (default the last 7 days): tasks created and completed, clients added and moved, documents, payments, expenses — from the audit trail, with counts and the notable items. Use it for "what happened this week?".',
  params: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Start, as said ("Monday", "1st Oct") or YYYY-MM-DD. Default: 7 days ago.' },
      to: { type: 'string', description: 'End (inclusive). Default: today.' },
    },
  },
  status: 'Looking at recent activity…',
  async run(args, ctx) {
    const from = (args.from && readDate(args.from, ctx.today, { prefer: 'past' }).value) || shiftDays(ctx.today, -7);
    const to = (args.to && readDate(args.to, ctx.today, { prefer: 'past' }).value) || ctx.today;
    const { data, error } = await ctx.db.from('audit_log')
      .select('action, entity_type, entity_id, diff, created_at, actor_id, via')
      .eq('org_id', ctx.orgId).gte('created_at', `${from}T00:00:00Z`).lte('created_at', `${shiftDays(to, 1)}T00:00:00Z`)
      .order('created_at', { ascending: false }).limit(2000);
    if (error) return { data: { unavailable: 'The activity log could not be read for your role.' } };
    const rows = data || [];
    const counts = {};
    const notable = [];
    let completed = 0;
    let stageMoves = 0;
    let byBuddy = 0;
    const name = (d) => d?.title || d?.name || d?.full_name || d?.doc_number || null;
    for (const r of rows) {
      if (r.via === 'edgeai') byBuddy += 1;
      const known = ACTIVITY[r.action];
      if (known) {
        counts[known[2]] = (counts[known[2]] || 0) + 1;
        if (notable.length < 14) notable.push({ at: r.created_at, what: `${known[0]} ${known[1]}`, name: name(r.diff), amount: r.diff?.amount ? money(r.diff.amount) : null });
      }
      if (r.action === 'tasks.update' && r.diff?.status?.to === 'done') {
        completed += 1;
        if (notable.length < 14) notable.push({ at: r.created_at, what: 'task completed', name: null, id: r.entity_id });
      }
      if (r.action === 'clients.update' && r.diff?.status) {
        stageMoves += 1;
        if (notable.length < 14) notable.push({ at: r.created_at, what: `client moved to ${STAGE_OF[r.diff.status.to] || r.diff.status.to}`, id: r.entity_id });
      }
    }
    if (completed) counts['Tasks completed'] = completed;
    if (stageMoves) counts['Client stage changes'] = stageMoves;
    // Names for rows whose diff carries none (updates only record the change).
    for (const n of notable) {
      if (n.name || !n.id) continue;
      if (n.what.startsWith('task')) n.name = (await byId('task', n.id, ctx))?.title || null;
      else if (n.what.startsWith('client')) n.name = (await byId('client', n.id, ctx))?.name || null;
      delete n.id;
    }
    return {
      data: {
        from: formatDate(from), to: formatDate(to), total_changes: rows.length, changes_made_through_buddy: byBuddy,
        counts, notable: notable.map((n) => ({ ...n, at: formatDate(n.at.slice(0, 10)) })),
        note: rows.length >= 2000 ? 'Only the latest 2,000 changes were read.' : undefined,
      },
      view: {
        type: 'metrics', title: `${formatDateShort(from, ctx.today)} – ${formatDateShort(to, ctx.today)}`,
        items: Object.entries(counts).slice(0, 6).map(([label, value]) => ({ label, value: String(value), tone: 'n' })),
      },
    };
  },
};

/* ── what Buddy did ───────────────────────────────────────────────────────── */

const STATUS_WORD = { proposed: 'waiting for you', confirmed: 'running', executed: 'done', failed: 'failed', cancelled: 'cancelled', expired: 'expired', undone: 'undone' };

const buddy_activity = {
  name: 'buddy_activity',
  module: 'core',
  kind: 'read',
  permission: null,
  description: 'What you (Buddy) proposed and did for this user recently — each action or plan, its status (done, failed, cancelled, undone, waiting) and result. Use it for "what did you do today?", "did that invoice go through?", "what failed?".',
  params: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 30 } } },
  status: 'Checking what I did…',
  async run(args, ctx) {
    const since = new Date(Date.now() - clamp(args.days, 1, 30, 1) * 86400000).toISOString();
    const rows = await recentFor(ctx, { limit: 30, since });
    const items = rows.map((r) => {
      const status = effectiveStatus(r);
      return {
        what: r.preview?.title || r.tool, kind: r.kind || 'action', status: STATUS_WORD[status] || status,
        result: r.result?.summary || null, error: r.error || null, when: r.proposed_at, channel: r.channel || 'chat',
      };
    });
    return {
      data: { total: items.length, actions: items.map((i) => ({ ...i, when: formatDate(i.when.slice(0, 10)) })) },
      view: {
        type: 'timeline', title: 'What I did', total: items.length,
        items: items.map((i) => ({ at: i.when, title: i.what, sub: i.error || i.result || i.status, tone: i.status === 'done' ? 'g' : i.status === 'failed' ? 'r' : 'n' })),
      },
    };
  },
};

/* ── what Buddy noticed ───────────────────────────────────────────────────── */

const get_insights = {
  name: 'get_insights',
  module: 'core',
  kind: 'read',
  permission: null,
  description: 'What needs attention right now, found in the company data: overdue invoices, deadlines, slipping tasks, at-risk projects, quiet leads, waiting quotes, spending spikes, bills due. Each with its reason. Use it for "what should I focus on?", "anything I should know?", "how are we doing?".',
  params: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } } },
  status: 'Looking for what needs you…',
  async run(args, ctx) {
    const items = await computeInsights(ctx, { limit: clamp(args.limit, 1, 10, 6) });
    return {
      data: {
        total: items.length,
        insights: items.map((i) => ({ severity: i.severity, title: i.title, reason: i.reason, next_steps: i.actions.filter((a) => a.kind === 'ask').map((a) => a.prompt) })),
        note: items.length ? undefined : 'Nothing stands out: no overdue invoices, slipping work or risks found.',
      },
      entities: items.flatMap((i) => i.entities || []).filter((e) => e.type !== 'project' || e.id).slice(0, 10),
      view: { type: 'insights', title: 'Buddy noticed', total: items.length, items },
    };
  },
};

export default [list_clients, list_projects, list_team, list_documents, recent_activity, buddy_activity, get_insights];
