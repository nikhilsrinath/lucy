/**
 * An in-memory stand-in for the slice of the supabase-js query builder the
 * agent uses — enough to run tools, the executor and the loop in a unit test
 * without a database. Not a test file itself (no .test.js), so it is never
 * collected as one.
 *
 * `writes` records every insert/update/delete/rpc, which is how the tests
 * prove that nothing is written before a confirm.
 */

let clock = Date.parse('2026-09-26T06:00:00.000Z');
const tick = () => new Date(clock += 1000).toISOString().replace('Z', '+00:00');

export function fakeDb(seed = {}, { deny = {}, rpc = {} } = {}) {
  const tables = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const writes = [];
  let seq = 0;

  function builder(table) {
    const state = { op: 'select', filters: [], order: null, limit: null, single: false, payload: null, head: false, count: false, embeds: [] };
    const rows = () => (tables[table] = tables[table] || []);
    const match = (r) => state.filters.every((f) => f(r));

    const run = () => {
      const denied = deny[table]?.includes(state.op);
      if (state.op === 'select') {
        let out = rows().filter(match);
        if (state.order) {
          const { col, asc } = state.order;
          out = [...out].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')) * (asc ? 1 : -1));
        }
        if (state.limit) out = out.slice(0, state.limit);
        if (state.embeds.length) {
          out = out.map((r) => {
            const joined = { ...r };
            for (const e of state.embeds) joined[e] = (tables[e] || []).filter((c) => c.document_id === r.id).map((c) => ({ ...c }));
            return joined;
          });
        }
        if (state.head) return { data: null, count: out.length, error: null };
        return state.single ? { data: out[0] || null, error: null } : { data: out, error: null };
      }
      if (denied) {
        // RLS: an insert is refused loudly, an update/delete matches nothing.
        if (state.op === 'insert') return { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } };
        return { data: state.single ? null : [], error: null };
      }
      if (state.op === 'insert') {
        const many = Array.isArray(state.payload);
        const made = (many ? state.payload : [state.payload]).map((p) => {
          const row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, created_at: tick(), updated_at: tick(), ...p };
          rows().push(row);
          writes.push({ op: 'insert', table, row });
          return row;
        });
        return { data: state.single ? made[0] : made, error: null };
      }
      if (state.op === 'update') {
        const hit = rows().filter(match);
        for (const r of hit) Object.assign(r, state.payload, { updated_at: tick() });
        writes.push({ op: 'update', table, rows: hit.map((r) => r.id), patch: state.payload });
        return { data: state.single ? hit[0] || null : hit, error: null };
      }
      if (state.op === 'delete') {
        const hit = rows().filter(match);
        tables[table] = rows().filter((r) => !hit.includes(r));
        writes.push({ op: 'delete', table, rows: hit.map((r) => r.id) });
        return { data: state.single ? hit[0] || null : hit, error: null };
      }
      return { data: null, error: null };
    };

    const q = {
      select(cols, opts) {
        if (opts?.head) state.head = true;
        // "*, document_line_items(*), payments(*)": children joined on document_id.
        state.embeds = [...String(cols || '').matchAll(/([a-z_]+)\(\*\)/g)].map((m) => m[1]);
        return q;
      },
      insert(p) { state.op = 'insert'; state.payload = p; return q; },
      update(p) { state.op = 'update'; state.payload = p; return q; },
      delete() { state.op = 'delete'; return q; },
      eq(c, v) { state.filters.push((r) => r[c] === v); return q; },
      neq(c, v) { state.filters.push((r) => r[c] !== v); return q; },
      in(c, vs) { state.filters.push((r) => vs.includes(r[c])); return q; },
      gt(c, v) { state.filters.push((r) => r[c] > v); return q; },
      gte(c, v) { state.filters.push((r) => r[c] >= v); return q; },
      lte(c, v) { state.filters.push((r) => r[c] <= v); return q; },
      is(c, v) { state.filters.push((r) => (r[c] ?? null) === v); return q; },
      order(col, o) { state.order = { col, asc: o?.ascending !== false }; return q; },
      limit(n) { state.limit = n; return q; },
      maybeSingle() { state.single = true; return q; },
      single() { state.single = true; return q; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return q;
  }

  return {
    tables,
    writes,
    from: (t) => builder(t),
    rpc: async (fn, params) => {
      writes.push({ op: 'rpc', fn, params });
      return { data: rpc[fn] ? rpc[fn](params) : null, error: null };
    },
  };
}

const ALL = { view: true, create: true, edit: true, delete: true };

/** A context like buildAgentContext's, over a fake database. */
export function fakeCtx({ db = fakeDb(), perms = null, today = '2026-09-26', recentEntities = [], page = null, employeeId = null } = {}) {
  const p = perms || {
    tasks: ALL, clients: ALL, employees: ALL, projects: ALL, financial_documents: ALL, vendors: ALL,
    expenses: ALL, income_entries: ALL, project_allocations: ALL, edgebrain: ALL, leave_requests: ALL,
  };
  const ctx = {
    user: { id: 'u-1', email: 'owner@test', name: 'Nikhil' },
    orgId: 'org-1', orgName: 'Test Co', role: 'owner', perms: p, plan: 'max', tz: 'Asia/Kolkata',
    today, now: `${today}T06:00:00Z`, employeeId, db, dbFor: () => db,
    page, recentEntities, cache: new Map(),
  };
  ctx.can = (resource, action) => (Array.isArray(resource) ? resource : [resource]).some((k) => p[k]?.[action] === true);
  ctx.allowed = new Set(Object.keys(p).filter((k) => p[k].view));
  ctx.hasPlanFeature = () => true;
  ctx.aiLimit = Infinity;
  return ctx;
}

/**
 * The context buildAgentContext makes for a company person acting through a
 * linked Telegram account with no StartupBuddy login (0071): no user id, the
 * person as the actor, the admin role's operational rights and no delete.
 */
export function personCtx({ employeeId = 'e-swetha', name = 'Swetha NM', title = 'Business Development Lead', linkId = 'l-swetha', telegramUserId = 7001, perms = null, ...rest } = {}) {
  const ops = { view: true, create: true, edit: true, delete: false };
  const p = perms || Object.fromEntries(['tasks', 'clients', 'employees', 'projects', 'financial_documents', 'document_line_items',
    'payments', 'vendors', 'purchase_invoices', 'expenses', 'income_entries', 'project_allocations', 'edgebrain', 'records']
    .map((k) => [k, ops]));
  const ctx = fakeCtx({ ...rest, perms: p, employeeId });
  ctx.user = { id: null, email: null, name };
  ctx.role = 'teammate';
  ctx.actor = { kind: 'person', employeeId, linkId, title, via: 'telegram_link', channelActor: `telegram:${telegramUserId}` };
  ctx.canDelete = false;
  ctx.channel = 'telegram';
  return ctx;
}
