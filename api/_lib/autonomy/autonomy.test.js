import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeDb, fakeCtx, personCtx } from '../agent/testing/fakeDb.js';

/*
 * The Autonomous Buddy Engine, end to end over an in-memory database:
 * jobs → claim → handler → act() → the ONE pipeline (propose → policy →
 * confirm → executor) → Telegram (a spy) → ai_actions / buddy_jobs.
 *
 * Real: jobs.js, workflows.js, policy.js, act.js, handlers.js, observe.js,
 * worker.js, the Buddy tools, pipeline.js, actions.js, executor.js,
 * telegram/outbound.js and store.js. Faked: the database (service role and
 * each session's RLS-scoped view of it), the Telegram Bot API, the Daily
 * Pulse sender, the session factory (identity verification and tokens are
 * channelSession.js, tested elsewhere; the database side of the Buddy
 * principal is supabase/tests/16_buddy_autonomy_test.sql).
 */

const admin = { db: null };
vi.mock('../supabaseAdmin.js', () => ({ supabaseAdmin: () => admin.db }));

const sent = [];
const telegram = { fail: null };
vi.mock('../telegram/bot.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    isConfigured: () => true,
    sendMessage: vi.fn(async (chatId, html) => {
      if (telegram.fail) throw new real.TelegramError('sendMessage', telegram.fail.status, telegram.fail.description);
      sent.push({ chatId, html });
      return { message_id: 500 + sent.length, chat: { id: chatId, type: 'private' } };
    }),
  };
});

const pulse = { calls: [] };
vi.mock('../telegram/pulse.js', () => ({
  sendPulse: vi.fn(async ({ orgId }) => { pulse.calls.push(orgId); return { sent: 1, skipped: 0, failed: 0 }; }),
  runDailyPulse: vi.fn(async () => ({ orgs: 0, sent: 0 })),
}));

vi.mock('../aiUsage.js', () => ({ bumpAiUsage: async () => 1, logAiUsage: async () => null }));

// Sessions: what channelSession + buildAgentContext produce, over the fake.
const sessions = { make: null, calls: [] };
vi.mock('./session.js', () => ({
  sessionFor: vi.fn(async (job, { as = null, policy } = {}) => {
    const kind = as?.kind || job.actor_kind || 'buddy';
    sessions.calls.push(kind);
    return sessions.make(kind, job, policy);
  }),
}));
vi.mock('../agent/channelSession.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, openBuddySession: async ({ orgId }) => sessions.make('buddy', { org_id: orgId }, null) };
});

const jobs = await import('./jobs.js');
const { runWorker, kick, processJob } = await import('./worker.js');
const { observeOrg } = await import('./observe.js');
const { decide, effectivePolicy, classOf, cleanRules, catalogue } = await import('./policy.js');
const { act } = await import('./act.js');
const { quietUntil, atLocal, readTime } = await import('./time.js');
const { propose, confirm } = await import('../agent/pipeline.js');
const { getTool, registryProblems, ALL_TOOLS } = await import('../agent/registry.js');
const { runChat } = await import('../agent/loop.js');
const { formatMessage } = await import('../telegram/outbound.js');
const { todayIn } = await import('../../../src/shared/dates.js');

/* ── the world ────────────────────────────────────────────────────────────── */

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';      // Catalysis23
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';    // another company
const NIKHIL_USER = '99999999-0000-4000-8000-000000000001';
const SWETHA = 'e0000000-0000-4000-8000-000000000001';
const MADHES = 'e0000000-0000-4000-8000-000000000002';
const NIKHIL = 'e0000000-0000-4000-8000-000000000003';
const PRIYA = 'e0000000-0000-4000-8000-000000000006';
const ARJUN = 'e0000000-0000-4000-8000-000000000007';
const OUTSIDER = 'e0000000-0000-4000-8000-000000000009';
const T_DECK = '11111111-0000-4000-8000-000000000001';   // Swetha, due tomorrow
const T_VENUE = '11111111-0000-4000-8000-000000000002';  // Madheswaran, 4 days overdue
const T_PRIYA = '11111111-0000-4000-8000-000000000003';  // Priya (link revoked), due tomorrow
const T_B = '11111111-0000-4000-8000-000000000009';      // ANOTHER company's task

const TZ = 'Asia/Kolkata';
const START = '2026-09-26T06:00:00.000Z'; // 11:30 IST — outside quiet hours
const ALL = { view: true, create: true, edit: true, delete: true };
const OPS = { view: true, create: true, edit: true, delete: false };
const RESOURCES = ['tasks', 'clients', 'employees', 'projects', 'financial_documents', 'payments', 'expenses', 'income_entries', 'notifications'];
// What app.buddy_permission grants the Buddy principal (0072).
const BUDDY_PERMS = {
  tasks: { view: true, create: true, edit: true, delete: false },
  notifications: { view: true, create: true, edit: true, delete: false },
  employees: { view: true, create: false, edit: false, delete: false },
  projects: { view: true, create: false, edit: false, delete: false },
};

const person = (id, full_name, extra = {}) => ({
  id, org_id: ORG, full_name, role: 'Team', email: `${full_name.split(' ')[0].toLowerCase()}@c23.test`, user_id: null,
  is_owner: false, exited_at: null, access_revoked_at: null, updated_at: '2026-09-01', ...extra,
});
const link = (id, extra) => ({ id, org_id: ORG, user_id: null, employee_id: null, revoked_at: null, linked_via: 'person_invite', ...extra });
const task = (id, title, assignee, deadline, extra = {}) => ({
  id, org_id: ORG, title, status: 'pending', priority: 'medium', deadline, assignee_id: assignee,
  assignee_label: null, project_id: null, notes: null, updated_at: '2026-09-20T10:00:00+00:00', ...extra,
});

function claimRpc(p) {
  const now = Date.now();
  const all = admin.db.tables.buddy_jobs || [];
  const stale = (j) => j.status === 'processing' && j.lease_until && Date.parse(j.lease_until) < now;
  const mine = (j) => (!p.p_org || j.org_id === p.p_org) && (!p.p_ids || p.p_ids.includes(j.id));
  for (const j of all) if (mine(j) && stale(j) && j.attempts >= j.max_attempts) Object.assign(j, { status: 'failed', lease_until: null, last_error: 'lease expired after the last attempt' });
  const due = all.filter((j) => mine(j) && ((['pending', 'retry'].includes(j.status) && Date.parse(j.run_at) <= now) || stale(j)))
    .sort((a, b) => Date.parse(a.run_at) - Date.parse(b.run_at)).slice(0, p.p_limit || 10);
  for (const j of due) {
    Object.assign(j, { status: 'processing', attempts: j.attempts + 1, locked_by: p.p_worker, lease_until: new Date(now + (p.p_lease_seconds || 120) * 1000).toISOString(), started_at: new Date(now).toISOString() });
  }
  return due.map((j) => ({ ...j }));
}

function world({ policy = null } = {}) {
  const employees = [
    person(SWETHA, 'Swetha NM', { role: 'Business Development Lead' }),
    person(MADHES, 'Madheswaran', { role: 'Marketing Lead' }),
    person(NIKHIL, 'Nikhil', { role: 'Founder', user_id: NIKHIL_USER, is_owner: true }),
    person(PRIYA, 'Priya', { role: 'Designer' }),
    person(ARJUN, 'Arjun', { role: 'Intern' }),
    { ...person(OUTSIDER, 'Kiran Outsider'), org_id: ORG_B },
  ];
  const db = fakeDb({
    organizations: [{ id: ORG, company_name: 'Catalysis23', timezone: TZ }, { id: ORG_B, company_name: 'Other Co', timezone: TZ }],
    employees,
    tasks: [
      task(T_DECK, 'Send the sponsor deck', SWETHA, '2026-09-27', { assignee_label: 'Swetha NM' }),
      task(T_VENUE, 'Book the venue', MADHES, '2026-09-22', { assignee_label: 'Madheswaran' }),
      task(T_PRIYA, 'Update the banner', PRIYA, '2026-09-27', { assignee_label: 'Priya' }),
      { ...task(T_B, 'Other company secret task', OUTSIDER, '2026-09-27'), org_id: ORG_B },
    ],
    org_telegram: [
      { org_id: ORG, enabled: true, pulse_enabled: true, pulse_hour: 18 },
      { org_id: ORG_B, enabled: true, pulse_enabled: false, pulse_hour: 18 },
    ],
    telegram_links: [
      link('l-swetha', { employee_id: SWETHA, telegram_user_id: 7001, dm_chat_id: 7001 }),
      link('l-madhes', { employee_id: MADHES, telegram_user_id: 7002, dm_chat_id: 7002 }),
      link('l-nikhil', { user_id: NIKHIL_USER, telegram_user_id: 7003, dm_chat_id: 7003, linked_via: 'self' }),
      link('l-priya', { employee_id: PRIYA, telegram_user_id: 7006, dm_chat_id: 7006, revoked_at: '2026-09-25T10:00:00Z' }),
      { ...link('l-outsider', { employee_id: OUTSIDER, telegram_user_id: 7009, dm_chat_id: 7009 }), org_id: ORG_B },
    ],
    role_permissions: RESOURCES.map((resource) => ({ org_id: ORG, role: 'admin', resource, can_view: true })),
    memberships: [{ id: 'm-1', org_id: ORG, user_id: NIKHIL_USER, role: 'owner' }],
    buddy_autonomy_policies: policy ? [{ org_id: ORG, enabled: true, rules: {}, settings: {}, version: 1, ...policy }] : [],
    ai_actions: [],
    buddy_jobs: [],
    buddy_workflows: [],
  }, {
    rpc: {
      buddy_claim_jobs: (p) => claimRpc(p),
      user_permissions: () => RESOURCES.map((resource) => ({ resource, can_view: true })),
    },
    unique: { ai_actions: [['org_id', 'idempotency_key']], buddy_jobs: [['org_id', 'dedupe_key']] },
    defaults: {
      buddy_jobs: { status: 'pending', attempts: 0, max_attempts: 5, action_ids: [], result: null, lease_until: null, locked_by: null, last_error: null },
      buddy_workflows: { status: 'active', state: {} },
      ai_actions: { autonomous: false, actor_kind: 'user', events: [] },
    },
  });
  admin.db = db;
  return db;
}

/** A session's view of the database: its own company only (what RLS does). */
const TENANT = new Set(['tasks', 'employees', 'projects', 'notifications', 'clients', 'financial_documents', 'expenses', 'income_entries', 'payments', 'vendors']);
function scoped(db, orgId) {
  return {
    tables: db.tables,
    writes: db.writes,
    from: (t) => (TENANT.has(t) ? db.from(t).eq('org_id', orgId) : db.from(t)),
    rpc: db.rpc,
  };
}

function finishCtx(ctx, orgId) {
  ctx.orgId = orgId;
  ctx.orgName = 'Catalysis23';
  ctx.tz = TZ;
  ctx.today = todayIn(TZ);
  ctx.cache = new Map();
  return ctx;
}

sessions.make = (kind, job, policy) => {
  const orgId = job.org_id || ORG;
  const db = scoped(admin.db, orgId);
  let ctx;
  if (kind === 'buddy') {
    ctx = fakeCtx({ db, perms: BUDDY_PERMS, employeeId: null });
    ctx.user = { id: null, email: null, name: 'Buddy' };
    ctx.actor = { kind: 'buddy', channelActor: 'buddy:system' };
    ctx.role = 'buddy';
    ctx.canDelete = false;
  } else if (kind === 'user') {
    ctx = nikhilCtx(db);
  } else {
    ctx = personCtx({ db, employeeId: job.actor_employee_id || SWETHA });
  }
  ctx.channel = 'autonomous';
  finishCtx(ctx, orgId);
  ctx.autonomy = { trigger: 'job', policy: policy || { ...effectivePolicy(null), orgId }, job, ready: true };
  return ctx;
};

function nikhilCtx(db = scoped(admin.db, ORG)) {
  const ctx = fakeCtx({ db, perms: Object.fromEntries(RESOURCES.map((k) => [k, ALL])), employeeId: NIKHIL });
  ctx.user = { id: NIKHIL_USER, email: 'nikhil@c23.test', name: 'Nikhil' };
  ctx.actor = { kind: 'user', userId: NIKHIL_USER, channelActor: null };
  ctx.role = 'owner';
  ctx.canDelete = true;
  ctx.channel = 'chat';
  return finishCtx(ctx, ORG);
}

/** A chat session with the company's policy loaded, as buddy.openSession builds it. */
function interactive(ctx, policy = effectivePolicy(null)) {
  ctx.autonomy = { trigger: 'interactive', policy: { ...policy, orgId: ORG }, job: null, ready: true };
  return ctx;
}

const rows = (t) => admin.db.tables[t] || [];
const jobsOf = (kind) => rows('buddy_jobs').filter((j) => !kind || j.kind === kind);
const actionsOf = (tool) => rows('ai_actions').filter((a) => !tool || a.tool === tool);
const at = (iso) => vi.setSystemTime(new Date(iso));
const enqueueJob = (extra) => jobs.enqueue({ orgId: ORG, source: 'test', ...extra });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(START);
  sent.length = 0;
  pulse.calls.length = 0;
  sessions.calls.length = 0;
  telegram.fail = null;
  world();
});
afterEach(() => vi.useRealTimers());

/* ── the queue ────────────────────────────────────────────────────────────── */

describe('jobs: creation, duplicates, claiming', () => {
  it('creates a pending job with company, actor, payload and run time', async () => {
    const r = await enqueueJob({ kind: 'task_due_soon', dedupeKey: `task_due_soon:${T_DECK}:2026-09-27`, payload: { task_id: T_DECK, deadline: '2026-09-27' } });
    expect(r.created).toBe(true);
    const [j] = jobsOf();
    expect(j).toMatchObject({ org_id: ORG, kind: 'task_due_soon', status: 'pending', attempts: 0, actor_kind: 'buddy', actor_user_id: null, payload: { task_id: T_DECK } });
    expect(Date.parse(j.run_at)).toBe(Date.parse(START));
  });

  it('the same event enqueued twice is one job', async () => {
    const key = `task_due_soon:${T_DECK}:2026-09-27`;
    const a = await enqueueJob({ kind: 'task_due_soon', dedupeKey: key, payload: {} });
    const b = await enqueueJob({ kind: 'task_due_soon', dedupeKey: key, payload: {} });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(jobsOf()).toHaveLength(1);
  });

  it('refuses malformed jobs before they reach the database', async () => {
    await expect(jobs.enqueue({ orgId: 'not-a-uuid', kind: 'task_due_soon', dedupeKey: 'k:1' })).rejects.toThrow(/org/);
    await expect(enqueueJob({ kind: 'DROP TABLE', dedupeKey: 'k:1' })).rejects.toThrow(/kind/);
    await expect(enqueueJob({ kind: 'reminder_due', dedupeKey: 'k:1', payload: { x: 'y'.repeat(9000) } })).rejects.toThrow(/too large/);
    await expect(enqueueJob({ kind: 'reminder_due', dedupeKey: 'k:1', actor: { kind: 'user' } })).rejects.toThrow(/user id/);
    await expect(enqueueJob({ kind: 'reminder_due', dedupeKey: 'k:1', actor: { kind: 'root' } })).rejects.toThrow(/actor/);
    expect(jobsOf()).toHaveLength(0);
  });

  it('claims only due jobs, once, with a lease and a counted attempt', async () => {
    await enqueueJob({ kind: 'reminder_due', dedupeKey: 'due:1', payload: {} });
    await enqueueJob({ kind: 'reminder_due', dedupeKey: 'later:1', payload: {}, runAt: '2026-09-26T09:00:00Z' });
    const first = await jobs.claim({ worker: 'w-a' });
    expect(first.map((j) => j.dedupe_key)).toEqual(['due:1']);
    expect(first[0]).toMatchObject({ status: 'processing', attempts: 1, locked_by: 'w-a' });
    expect(Date.parse(first[0].lease_until)).toBeGreaterThan(Date.now());
    expect(await jobs.claim({ worker: 'w-b' })).toEqual([]);
  });

  it('two workers woken together run a job exactly once', async () => {
    await enqueueJob({ kind: 'task_due_soon', dedupeKey: `task_due_soon:${T_DECK}:2026-09-27`, payload: { task_id: T_DECK, deadline: '2026-09-27' } });
    const [a, b] = await Promise.all([runWorker({ observe: false }), runWorker({ observe: false })]);
    expect(a.processed + b.processed).toBe(1);
    expect(sent).toHaveLength(1);
    expect(actionsOf('send_telegram_message')).toHaveLength(1);
  });

  it('a worker whose lease was overtaken cannot overwrite the newer attempt', async () => {
    await enqueueJob({ kind: 'reminder_due', dedupeKey: 'lease:1', payload: {} });
    const [mine] = await jobs.claim({ worker: 'w-old', leaseSeconds: 10 });
    at('2026-09-26T06:05:00Z');
    const [theirs] = await jobs.claim({ worker: 'w-new' });
    expect(theirs.attempts).toBe(2);
    expect(await jobs.finish(mine, 'w-old', { status: 'completed' })).toBeNull();
    expect(await jobs.finish(theirs, 'w-new', { status: 'completed', result: { ok: 1 } })).toMatchObject({ status: 'completed' });
  });

  it('cancelled jobs are never claimed', async () => {
    const { id } = await enqueueJob({ kind: 'reminder_due', dedupeKey: 'c:1', payload: {} });
    expect(await jobs.cancel({ orgId: ORG, ids: [id] })).toEqual([id]);
    expect(await jobs.claim({ worker: 'w-a' })).toEqual([]);
    expect(jobsOf()[0].status).toBe('cancelled');
  });

  it('backs off 1 min, 4 min, 16 min… capped at 6 hours', () => {
    expect([1, 2, 3, 4, 5, 9].map(jobs.backoffMs)).toEqual([60_000, 240_000, 960_000, 3_840_000, 15_360_000, 21_600_000]);
  });
});

/* ── the policy ───────────────────────────────────────────────────────────── */

describe('autonomy policy: deterministic, server-side', () => {
  const buddy = () => sessions.make('buddy', { org_id: ORG }, null);
  const pol = (extra = {}) => ({ ...effectivePolicy(null), ...extra });

  it('classifies the real registry by side effect', () => {
    const cls = Object.fromEntries(ALL_TOOLS.filter((t) => t.kind === 'write').map((t) => [t.name, classOf(t)]));
    for (const t of ['create_task', 'update_task', 'complete_task', 'reopen_task', 'add_task_note', 'send_telegram_message',
      'start_followup', 'cancel_followup', 'schedule_reminder', 'schedule_buddy_check']) expect(cls[t]).toBe('autonomous');
    for (const t of ['create_cash_entry', 'record_payment', 'mark_invoice_paid', 'issue_document', 'create_vendor', 'create_purchase_bill',
      'cancel_financial_document', 'send_payment_reminder', 'create_invoice_draft', 'create_client', 'create_project']) expect(cls[t]).toBe('approval');
    for (const t of ['delete_task', 'delete_client', 'delete_financial_document']) expect(cls[t]).toBe('forbidden');
  });

  it('routine internal work is autonomous in a job; money, email and high risk need approval', () => {
    const ctx = nikhilCtx();
    expect(decide({ tool: getTool('create_task'), args: {}, ctx, policy: pol() })).toMatchObject({ decision: 'autonomous', rule: 'tool_default_autonomous' });
    expect(decide({ tool: getTool('create_cash_entry'), args: {}, ctx, policy: pol() })).toMatchObject({ decision: 'approval', rule: 'high_risk_requires_approval' });
    expect(decide({ tool: getTool('create_invoice_draft'), args: {}, ctx, policy: pol() })).toMatchObject({ decision: 'approval' });
    expect(decide({ tool: getTool('send_payment_reminder'), args: {}, ctx, policy: pol() }).decision).toBe('approval');
  });

  it('a routine Telegram message is autonomous; money, pay or secrets in it need approval', () => {
    const ctx = buddy();
    const tool = getTool('send_telegram_message');
    expect(decide({ tool, args: { message: 'Reminder: the deck is due tomorrow.' }, ctx, policy: pol() }).decision).toBe('autonomous');
    expect(decide({ tool, args: { message: 'Please collect ₹50,000 from Acme' }, ctx, policy: pol() })).toMatchObject({ decision: 'approval', rule: 'condition:sensitive_topic' });
    expect(decide({ tool, args: { message: 'x'.repeat(700) }, ctx, policy: pol() })).toMatchObject({ decision: 'approval', rule: 'condition:long_message' });
  });

  it('deletes are forbidden whatever the role, the rules or the metadata', () => {
    const ctx = nikhilCtx();
    const p = pol({ rules: cleanRules({ delete_task: 'autonomous' }) });
    expect(p.rules).toEqual({}); // not even stored: only autonomous|approval on real write tools
    expect(decide({ tool: getTool('delete_task'), args: {}, ctx, policy: pol() })).toMatchObject({ decision: 'forbidden', rule: 'deletion_restricted' });
    const bad = { ...getTool('delete_task'), autonomy: { class: 'autonomous' } };
    expect(registryProblems([bad])).toContain('delete_task: a delete can never be autonomous');
  });

  it('never beyond the actor\'s permissions', () => {
    expect(decide({ tool: getTool('create_client'), args: {}, ctx: buddy(), policy: pol() })).toMatchObject({ decision: 'forbidden', rule: 'permission' });
  });

  it('the company can switch it off, send a tool to approval, or widen only safe low-risk tools', () => {
    const ctx = nikhilCtx();
    expect(decide({ tool: getTool('create_task'), args: {}, ctx, policy: pol({ enabled: false }) })).toMatchObject({ decision: 'approval', rule: 'autonomy_disabled' });
    expect(decide({ tool: getTool('create_task'), args: {}, ctx, policy: pol({ rules: { create_task: 'approval' } }) })).toMatchObject({ decision: 'approval', rule: 'company_rule_approval' });
    expect(decide({ tool: getTool('create_client'), args: {}, ctx, policy: pol({ rules: { create_client: 'autonomous' } }) })).toMatchObject({ decision: 'autonomous', rule: 'company_rule_autonomous' });
    // Money and high risk can never be widened.
    expect(decide({ tool: getTool('create_invoice_draft'), args: {}, ctx, policy: pol({ rules: { create_invoice_draft: 'autonomous' } }) }).decision).toBe('approval');
    expect(decide({ tool: getTool('create_cash_entry'), args: {}, ctx, policy: pol({ rules: { create_cash_entry: 'autonomous' } }) }).decision).toBe('approval');
    const cat = catalogue(pol());
    expect(cat.find((t) => t.tool === 'create_client').widenable).toBe(true);
    expect(cat.find((t) => t.tool === 'create_invoice_draft').widenable).toBe(false);
  });

  it('in a conversation only the follow-through tools skip the card', () => {
    const ctx = nikhilCtx();
    for (const name of ['create_task', 'update_task', 'send_telegram_message', 'create_cash_entry']) {
      expect(decide({ tool: getTool(name), args: { message: 'hi' }, ctx, policy: pol(), trigger: 'interactive' })).toMatchObject({ decision: 'approval', rule: 'interactive_review' });
    }
    expect(decide({ tool: getTool('start_followup'), args: {}, ctx: interactive(nikhilCtx()), policy: pol(), trigger: 'interactive' }).decision).toBe('autonomous');
  });

  it('is the same answer for the same inputs', () => {
    const ctx = buddy();
    const a = decide({ tool: getTool('create_task'), args: {}, ctx, policy: pol() });
    const b = decide({ tool: getTool('create_task'), args: {}, ctx, policy: pol() });
    expect(a).toEqual(b);
  });

  it('the registry\'s invariants still hold with autonomy metadata', () => {
    expect(registryProblems()).toEqual([]);
  });
});

/* ── acting on its own ────────────────────────────────────────────────────── */

describe('act(): autonomous actions through the one pipeline', () => {
  it('creates a task on its own, recorded as an autonomous Buddy action', async () => {
    const ctx = sessions.make('buddy', { org_id: ORG, id: null }, null);
    const res = await act(ctx, 'create_task', { title: 'Prepare the demo checklist', assignee: 'Swetha', deadline: 'tomorrow' }, { key: 'test:create:1' });
    expect(res.status).toBe('executed');
    const made = rows('tasks').find((t) => t.title === 'Prepare the demo checklist');
    expect(made).toMatchObject({ org_id: ORG, assignee_id: SWETHA, deadline: '2026-09-27' });
    const a = actionsOf('create_task')[0];
    expect(a).toMatchObject({ status: 'executed', autonomous: true, approval_required: false, actor_kind: 'buddy', user_id: null, channel: 'autonomous', idempotency_key: 'test:create:1' });
    expect(a.policy_decision).toMatchObject({ decision: 'autonomous', rule: 'tool_default_autonomous', trigger: 'job' });
    expect(a.events.map((e) => e.status)).toEqual(['proposed', 'auto_approved', 'executing', 'completed']);
  });

  it('is idempotent: the same key never does it twice', async () => {
    const ctx = sessions.make('buddy', { org_id: ORG }, null);
    await act(ctx, 'create_task', { title: 'Once only' }, { key: 'test:once' });
    const again = await act(sessions.make('buddy', { org_id: ORG }, null), 'create_task', { title: 'Once only' }, { key: 'test:once' });
    expect(again).toMatchObject({ status: 'executed', reused: true });
    expect(rows('tasks').filter((t) => t.title === 'Once only')).toHaveLength(1);
  });

  it('refuses a delete, and records the refusal', async () => {
    const ctx = sessions.make('buddy', { org_id: ORG }, null);
    const res = await act(ctx, 'delete_task', { task: 'Send the sponsor deck' }, { key: 'test:del' });
    expect(res).toMatchObject({ status: 'refused', decision: { rule: 'deletion_restricted' } });
    expect(rows('tasks').find((t) => t.id === T_DECK)).toBeTruthy();
    expect(actionsOf('delete_task')[0]).toMatchObject({ status: 'failed', autonomous: false, policy_decision: { decision: 'forbidden' } });
  });

  it('refuses what Buddy\'s permissions do not include (clients, money)', async () => {
    const ctx = sessions.make('buddy', { org_id: ORG }, null);
    expect((await act(ctx, 'create_client', { name: 'Acme' }, { key: 'test:cl' })).status).toBe('refused');
    expect((await act(ctx, 'create_cash_entry', { amount: '5000' }, { key: 'test:cash' })).status).toBe('refused');
    expect(rows('clients')).toHaveLength(0);
  });
});

/* ── Scenario 1 ───────────────────────────────────────────────────────────── */

describe('Scenario 1: "Make sure Swetha follows up with the sponsor tomorrow."', () => {
  async function ask() {
    const ctx = interactive(nikhilCtx());
    const out = await propose(getTool('start_followup'), { person: 'Swetha', task: 'Follow up with the sponsor', deadline: 'tomorrow' }, ctx, { chatId: 'c1', messageId: 'm1' });
    return { ctx, out };
  }

  it('creates the task and the workflow, schedules the checks, and tells Swetha — no approval card', async () => {
    const { out } = await ask();
    expect(out.kind).toBe('card');
    expect(out.auto).toBe(true);
    expect(out.card.status).toBe('executed');
    const t = rows('tasks').find((x) => x.title === 'Follow up with the sponsor');
    expect(t).toMatchObject({ org_id: ORG, assignee_id: SWETHA, deadline: '2026-09-27', status: 'pending' });
    const [wf] = rows('buddy_workflows');
    expect(wf).toMatchObject({ org_id: ORG, task_id: t.id, assignee_employee_id: SWETHA, initiator_kind: 'user', initiator_user_id: NIKHIL_USER, initiator_employee_id: NIKHIL, status: 'active' });
    // The kickoff ran at once; the due-day reminder is scheduled for tomorrow 09:00 IST.
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(7001);
    expect(sent[0].html).toContain('🤖 <b>Buddy</b>');
    expect(sent[0].html).toContain('Nikhil asked me to make sure');
    const next = jobsOf('workflow_check_due').find((j) => j.payload.phase === 'due');
    expect(next).toMatchObject({ status: 'pending', workflow_id: wf.id });
    expect(next.run_at).toBe(atLocal('2026-09-27', 9, 0, TZ));
    // The founder's action is autonomous and attributed to him; Buddy's message is Buddy's.
    expect(actionsOf('start_followup')[0]).toMatchObject({ autonomous: true, user_id: NIKHIL_USER, actor_kind: 'user', status: 'executed' });
    expect(actionsOf('send_telegram_message')[0]).toMatchObject({ autonomous: true, actor_kind: 'buddy', status: 'executed', workflow_id: wf.id });
  });

  it('follows through over the days: reminds, follows up, escalates to Nikhil, then notices it is done', async () => {
    await ask();
    const wf = rows('buddy_workflows')[0];
    const taskRow = rows('tasks').find((x) => x.id === wf.task_id);

    at('2026-09-27T03:31:00Z'); // 09:01 IST on the due day
    await runWorker({ observe: false });
    expect(sent.at(-1).chatId).toBe(7001);
    expect(sent.at(-1).html).toContain('is due today');

    at('2026-09-28T03:31:00Z'); // the day after: still open → follow-up
    await runWorker({ observe: false });
    expect(sent.at(-1).chatId).toBe(7001);
    expect(sent.at(-1).html).toContain('isn’t marked done yet');

    at('2026-09-29T03:31:00Z'); // 2 days overdue → Nikhil hears about it
    await runWorker({ observe: false });
    expect(sent.at(-1).chatId).toBe(7003);
    expect(sent.at(-1).html).toContain('2 days overdue');
    expect(rows('buddy_workflows')[0].status).toBe('escalated');

    // The same day again: nothing new is said (no spam).
    const before = sent.length;
    await runWorker({ observe: false });
    expect(sent.length).toBe(before);

    // Swetha finishes; the next daily check notices and tells Nikhil once.
    taskRow.status = 'done';
    at('2026-09-30T03:31:00Z');
    await runWorker({ observe: false });
    expect(sent.at(-1).chatId).toBe(7003);
    expect(sent.at(-1).html).toContain('marked “Follow up with the sponsor” done');
    expect(rows('buddy_workflows')[0].status).toBe('completed');
    at('2026-10-01T03:31:00Z');
    const n = sent.length;
    await runWorker({ observe: false });
    expect(sent.length).toBe(n);
  });

  it('a follow-through about money is a card, not autonomous', async () => {
    const ctx = interactive(nikhilCtx());
    const out = await propose(getTool('start_followup'), { person: 'Swetha', task: 'Collect ₹2 lakh from Acme', deadline: 'tomorrow' }, ctx, { chatId: 'c1' });
    expect(out.card).toMatchObject({ status: 'proposed' });
    expect(rows('buddy_workflows')).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('after escalating, a deadline moved to the future resumes the follow-through', async () => {
    const ctx = interactive(nikhilCtx());
    await propose(getTool('start_followup'), { person: 'Swetha', task: 'Follow up with the sponsor', deadline: 'tomorrow' }, ctx, { chatId: 'c1' });
    for (const day of ['2026-09-27', '2026-09-28', '2026-09-29']) {
      at(`${day}T03:31:00Z`);
      await runWorker({ observe: false });
    }
    const wf = rows('buddy_workflows')[0];
    expect(wf.status).toBe('escalated');
    rows('tasks').find((x) => x.id === wf.task_id).deadline = '2026-10-03';
    at('2026-09-30T03:31:00Z');
    await runWorker({ observe: false });
    expect(rows('buddy_workflows')[0].status).toBe('active');
    at('2026-10-03T03:31:00Z');
    await runWorker({ observe: false });
    expect(sent.at(-1).html).toContain('is due today');
  });

  it('stale slippage is not chased: tasks overdue beyond the window are left alone', async () => {
    rows('tasks').find((t) => t.id === T_VENUE).deadline = '2026-08-01';
    await observeOrg({ org_id: ORG, pulse_enabled: false });
    expect(jobsOf().some((j) => j.payload.task_id === T_VENUE)).toBe(false);
    expect(jobsOf('founder_digest')).toHaveLength(0);
  });

  it('a moved deadline moves the plan; asking again restarts rather than duplicates', async () => {
    await ask();
    const wf = rows('buddy_workflows')[0];
    rows('tasks').find((x) => x.id === wf.task_id).deadline = '2026-10-01';
    at('2026-09-27T03:31:00Z');
    await runWorker({ observe: false });
    expect(sent).toHaveLength(1); // no "due today" on the old date
    expect(jobsOf('workflow_check_due').some((j) => j.status === 'pending' && j.payload.phase === 'due' && j.run_at === atLocal('2026-10-01', 9, 0, TZ))).toBe(true);
    await ask();
    expect(rows('buddy_workflows')).toHaveLength(1);
  });

  it('Swetha (a linked person, no login) can hand Buddy a follow-through too', async () => {
    const swetha = interactive(personCtx({ db: scoped(admin.db, ORG), employeeId: SWETHA }));
    finishCtx(swetha, ORG);
    const out = await propose(getTool('start_followup'), { person: 'Madheswaran', task: 'Print the banners', deadline: 'friday' }, swetha, { chatId: 'tg:7001' });
    expect(out.card.status).toBe('executed');
    expect(rows('buddy_workflows')[0]).toMatchObject({ initiator_kind: 'person', initiator_employee_id: SWETHA, assignee_employee_id: MADHES });
    expect(sent.at(-1).chatId).toBe(7002);
    expect(actionsOf('start_followup')[0]).toMatchObject({ actor_kind: 'person', employee_id: SWETHA, user_id: null, autonomous: true });
  });

  it('stopping it cancels the workflow and its pending checks', async () => {
    await ask();
    const ctx = interactive(nikhilCtx());
    const out = await propose(getTool('cancel_followup'), { task: 'Follow up with the sponsor' }, ctx, { chatId: 'c1' });
    expect(out.card.status).toBe('executed');
    expect(rows('buddy_workflows')[0].status).toBe('cancelled');
    expect(jobsOf('workflow_check_due').filter((j) => j.status === 'pending')).toHaveLength(0);
    at('2026-09-27T03:31:00Z');
    await runWorker({ observe: false });
    expect(sent).toHaveLength(1);
  });
});

/* ── Scenario 2 ───────────────────────────────────────────────────────────── */

describe('Scenario 2: a routine reminder becomes due', () => {
  it('cron wakes the worker, it claims the job, sends, completes, audits — and a second run sends nothing', async () => {
    // Observation (deterministic): Swetha's deck is due tomorrow.
    const obs = await observeOrg({ org_id: ORG, pulse_enabled: false });
    expect(obs.kinds).toContain('task_due_soon');
    const job = jobsOf('task_due_soon')[0];
    expect(job.dedupe_key).toBe(`task_due_soon:${T_DECK}:2026-09-27`);

    const run = await runWorker({ observe: false });
    expect(run.byStatus.completed).toBeGreaterThanOrEqual(1);
    expect(sent.find((m) => m.chatId === 7001).html).toContain('“Send the sponsor deck” is due tomorrow');
    const done = jobsOf('task_due_soon')[0];
    expect(done).toMatchObject({ status: 'completed', attempts: 1, locked_by: null, result: { sent: true } });
    const a = actionsOf('send_telegram_message').find((x) => x.id === done.action_ids[0]);
    expect(a).toMatchObject({
      autonomous: true, actor_kind: 'buddy', job_id: job.id, status: 'executed', channel: 'autonomous',
      idempotency_key: `ev:task_due_soon:${T_DECK}:2026-09-27`, policy_decision: { rule: 'tool_default_autonomous' },
    });
    expect(a.after_state[0]).toMatchObject({ recipient_person_id: SWETHA, telegram_message_id: expect.any(Number), from: 'buddy' });
    expect(JSON.stringify(a.after_state)).not.toContain('sponsor deck'); // no message body in the delivery record

    // Cron fires again (and observation runs again): no duplicate.
    const n = sent.length;
    await observeOrg({ org_id: ORG, pulse_enabled: false });
    await runWorker({ observe: false });
    expect(sent.length).toBe(n);
    expect(jobsOf('task_due_soon')).toHaveLength(1);
  });

  it('a transient Telegram failure retries with backoff, then succeeds without a duplicate', async () => {
    await enqueueJob({ kind: 'task_due_soon', dedupeKey: `task_due_soon:${T_DECK}:2026-09-27`, payload: { task_id: T_DECK, deadline: '2026-09-27' } });
    telegram.fail = { status: 502, description: 'Bad Gateway' };
    await runWorker({ observe: false });
    const j = jobsOf()[0];
    expect(j.status).toBe('retry');
    expect(Date.parse(j.run_at)).toBe(Date.parse(START) + 60_000);
    expect(actionsOf('send_telegram_message')[0]).toMatchObject({ status: 'failed', result: { transient: true } });

    telegram.fail = null;
    at('2026-09-26T06:02:00Z');
    await runWorker({ observe: false });
    expect(jobsOf()[0]).toMatchObject({ status: 'completed', attempts: 2 });
    expect(sent).toHaveLength(1);
    expect(actionsOf('send_telegram_message').map((a) => a.idempotency_key)).toEqual([
      `ev:task_due_soon:${T_DECK}:2026-09-27`, `ev:task_due_soon:${T_DECK}:2026-09-27#1`]);
  });

  it('a permanent failure (bot blocked) fails the job without retrying', async () => {
    await enqueueJob({ kind: 'task_due_soon', dedupeKey: `task_due_soon:${T_DECK}:2026-09-27`, payload: { task_id: T_DECK, deadline: '2026-09-27' } });
    telegram.fail = { status: 403, description: 'Forbidden: bot was blocked by the user' };
    await runWorker({ observe: false });
    expect(jobsOf()[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(jobsOf()[0].last_error).toMatch(/blocked/);
    at('2026-09-26T08:00:00Z');
    telegram.fail = null;
    await runWorker({ observe: false });
    expect(sent).toHaveLength(0);
  });

  it('gives up after max attempts', async () => {
    await jobs.enqueue({ orgId: ORG, kind: 'task_due_soon', dedupeKey: 'x:1', payload: { task_id: T_DECK, deadline: '2026-09-27' }, maxAttempts: 2 });
    telegram.fail = { status: 500, description: 'Internal' };
    await runWorker({ observe: false });
    at('2026-09-26T06:10:00Z');
    await runWorker({ observe: false });
    expect(jobsOf()[0]).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('a worker that died mid-send: the job is reclaimed after its lease, and the message is NOT sent twice', async () => {
    await enqueueJob({ kind: 'task_due_soon', dedupeKey: `task_due_soon:${T_DECK}:2026-09-27`, payload: { task_id: T_DECK, deadline: '2026-09-27' } });
    // First worker claims it and "crashes" after the action was claimed for execution.
    const [claimed] = await jobs.claim({ worker: 'w-dead' });
    const ctx = sessions.make('buddy', claimed, null);
    const out = await propose(getTool('send_telegram_message'), { recipient_person_id: SWETHA, message: 'Reminder: the deck is due tomorrow.' }, ctx,
      { autonomy: { trigger: 'job', decision: { decision: 'approval', rule: 'test' }, jobId: claimed.id, idempotencyKey: `ev:${claimed.dedupe_key}` } });
    const row = rows('ai_actions').find((a) => a.id === out.card.action_id);
    Object.assign(row, { status: 'confirmed' }); // in flight when the process died
    at('2026-09-26T06:05:00Z'); // lease (120 s) expired
    await runWorker({ observe: false });
    const j = jobsOf()[0];
    expect(j).toMatchObject({ status: 'failed', attempts: 2 });
    expect(j.last_error).toMatch(/interrupted/);
    expect(sent).toHaveLength(0);
  });

  it('a crash before anything happened simply runs again after the lease', async () => {
    await enqueueJob({ kind: 'task_due_soon', dedupeKey: `task_due_soon:${T_DECK}:2026-09-27`, payload: { task_id: T_DECK, deadline: '2026-09-27' } });
    await jobs.claim({ worker: 'w-dead' });
    await runWorker({ observe: false });
    expect(sent).toHaveLength(0); // still leased
    at('2026-09-26T06:03:00Z');
    await runWorker({ observe: false });
    expect(jobsOf()[0]).toMatchObject({ status: 'completed', attempts: 2 });
    expect(sent).toHaveLength(1);
  });

  it('quiet hours: the reminder waits for the morning, without spending an attempt', async () => {
    at('2026-09-26T17:00:00Z'); // 22:30 IST
    await enqueueJob({ kind: 'task_due_soon', dedupeKey: `task_due_soon:${T_DECK}:2026-09-27`, payload: { task_id: T_DECK, deadline: '2026-09-27' } });
    await runWorker({ observe: false });
    const j = jobsOf()[0];
    expect(j).toMatchObject({ status: 'pending', attempts: 0 });
    expect(j.run_at).toBe(atLocal('2026-09-27', 8, 0, TZ));
    expect(sent).toHaveLength(0);
  });

  it('nothing to do is recorded, not retried: done, rescheduled, unassigned', async () => {
    rows('tasks').find((t) => t.id === T_DECK).deadline = '2026-09-30';
    await enqueueJob({ kind: 'task_due_soon', dedupeKey: 'moved', payload: { task_id: T_DECK, deadline: '2026-09-27' } });
    await runWorker({ observe: false });
    expect(jobsOf()[0]).toMatchObject({ status: 'completed', result: { skipped: 'deadline_changed' } });
    expect(sent).toHaveLength(0);
  });
});

/* ── Scenario 3 ───────────────────────────────────────────────────────────── */

describe('Scenario 3: a high-risk action is approval-required', () => {
  it('a job acting for Nikhil does not execute money on its own: it raises an approval request and tells him', async () => {
    const { id } = await jobs.enqueue({ orgId: ORG, kind: 'buddy_review', dedupeKey: 'check:money', actor: { kind: 'user', userId: NIKHIL_USER }, payload: { instruction: 'chase Acme', report_to: NIKHIL } });
    const [job] = await jobs.claim({ worker: 'w-1', ids: [id] });
    const ctx = sessions.make('user', job, null);
    const notices = [];
    const res = await act(ctx, 'send_telegram_message', { recipient_person_id: SWETHA, message: 'Please collect the ₹50,000 Acme owes us this week' }, {
      key: 'test:approval',
      notify: async ({ actionId }) => { notices.push(actionId); },
    });
    expect(res.status).toBe('awaiting_approval');
    const a = rows('ai_actions').find((x) => x.id === res.actionId);
    expect(a).toMatchObject({ status: 'proposed', autonomous: false, approval_required: true, user_id: NIKHIL_USER, job_id: id, policy_decision: { decision: 'approval', rule: 'condition:sensitive_topic' } });
    expect(Date.parse(a.expires_at) - Date.now()).toBe(48 * 3600_000);
    expect(sent).toHaveLength(0); // nothing reached Swetha
    expect(notices).toEqual([res.actionId]); // Nikhil was told where to approve it

    // Running the job again does not raise a second request.
    const again = await act(sessions.make('user', job, null), 'send_telegram_message', { recipient_person_id: SWETHA, message: 'Please collect the ₹50,000 Acme owes us this week' }, { key: 'test:approval' });
    expect(again).toMatchObject({ status: 'awaiting_approval', reused: true, actionId: res.actionId });

    // Nikhil approves it in the app: only now does it run, as a human-confirmed action.
    const out = await confirm(nikhilCtx(), res.actionId);
    expect(out.status).toBe('executed');
    expect(sent).toHaveLength(1);
    const row = rows('ai_actions').find((x) => x.id === res.actionId);
    expect(row.events.map((e) => e.status)).toEqual(['proposed', 'approved', 'executing', 'completed']);
    expect(row.autonomous).toBe(false);
  });

  it('an approval never bypasses validation: pay may not go to someone who cannot see it', async () => {
    const job = await jobs.enqueue({ orgId: ORG, kind: 'buddy_review', dedupeKey: 'check:pay', actor: { kind: 'user', userId: NIKHIL_USER }, payload: {} });
    const [claimed] = await jobs.claim({ worker: 'w-1', ids: [job.id] });
    const res = await act(sessions.make('user', claimed, null), 'send_telegram_message', { recipient_person_id: SWETHA, message: 'Salary revisions go out Friday' }, { key: 'test:pay' });
    expect(res.status).toBe('not_actionable');
    expect(res.message).toMatch(/can't see salaries and pay/);
    expect(sent).toHaveLength(0);
  });

  it('an approval request Buddy raised on its own runs only after an owner approves it', async () => {
    const policy = { ...effectivePolicy({ org_id: ORG, rules: { send_telegram_message: 'approval' } }), orgId: ORG };
    const ctx = sessions.make('buddy', { org_id: ORG, id: null }, policy);
    const res = await act(ctx, 'send_telegram_message', { recipient_person_id: SWETHA, message: 'Reminder: the deck is due tomorrow.' }, { key: 'test:buddy-approval' });
    expect(res.status).toBe('awaiting_approval');
    const a = rows('ai_actions').find((x) => x.id === res.actionId);
    expect(a).toMatchObject({ actor_kind: 'buddy', status: 'proposed', policy_decision: { rule: 'company_rule_approval' } });
    expect(sent).toHaveLength(0);

    // A person without admin rights cannot adopt it.
    const swetha = personCtx({ db: scoped(admin.db, ORG), employeeId: SWETHA });
    finishCtx(swetha, ORG);
    expect((await confirm(swetha, res.actionId)).status).toBe('not_found');
    // A forged auto-confirm cannot skip the approval either.
    expect((await confirm(ctx, res.actionId, { auto: { decision: 'autonomous', rule: 'forged' } })).status).toBe('invalid');
    expect(sent).toHaveLength(0);

    const out = await confirm(nikhilCtx(), res.actionId);
    expect(out.status).toBe('executed');
    expect(sent).toHaveLength(1);
    expect(rows('ai_actions').find((x) => x.id === res.actionId)).toMatchObject({ user_id: NIKHIL_USER, actor_kind: 'user', approved_by: NIKHIL_USER, autonomous: false, status: 'executed' });
    // Approved and sent by Nikhil: it says so.
    expect(sent[0].html).toContain('<b>Nikhil</b>');
  });

  it('financial confirmation is unchanged: money stays a card in chat, and approval in a job', async () => {
    const chat = interactive(nikhilCtx());
    chat.db.tables.finance_categories = [{ key: 'office', label: 'Office supplies', direction: 'out', group_label: 'Operations', treatment: 'opex', active: true, sort_order: 1 }];
    const tool = getTool('create_cash_entry');
    expect(decide({ tool, args: {}, ctx: chat, policy: chat.autonomy.policy, trigger: 'interactive' }).decision).toBe('approval');
    expect(decide({ tool, args: {}, ctx: sessions.make('user', { org_id: ORG }, null), policy: effectivePolicy(null) })).toMatchObject({ decision: 'approval', rule: 'high_risk_requires_approval' });
  });
});

/* ── Scenario 4 ───────────────────────────────────────────────────────────── */

describe('Scenario 4: an employee asks Buddy to delete something', () => {
  it('stays blocked: not offered, refused by propose, refused by the executor, refused autonomously', async () => {
    const swetha = interactive(personCtx({ db: scoped(admin.db, ORG), employeeId: SWETHA }));
    finishCtx(swetha, ORG);
    const { toolsFor } = await import('../agent/registry.js');
    expect(toolsFor(swetha).map((t) => t.name)).not.toContain('delete_task');
    const out = await propose(getTool('delete_task'), { task: 'Send the sponsor deck' }, swetha, { chatId: 'tg:7001' });
    expect(out.kind).toBe('none');
    expect(out.message).toMatch(/requires admin access/);
    const { applyPlan } = await import('../agent/executor.js');
    const res = await applyPlan(swetha.db, [{ op: 'delete', table: 'tasks', id: T_DECK }], { allowDelete: swetha.canDelete !== false });
    expect(res.results[0]).toMatchObject({ ok: false, code: 'denied' });
    // …and a job acting for her cannot either.
    const job = await jobs.enqueue({ orgId: ORG, kind: 'buddy_review', dedupeKey: 'p:del', actor: { kind: 'person', employeeId: SWETHA }, payload: {} });
    const ctx = sessions.make('person', { id: job.id, org_id: ORG, actor_kind: 'person', actor_employee_id: SWETHA }, null);
    expect((await act(ctx, 'delete_task', { task: 'Send the sponsor deck' }, { key: 'p:del:1' })).status).toBe('refused');
    expect(rows('tasks').find((t) => t.id === T_DECK)).toBeTruthy();
  });
});

/* ── Scenario 5 ───────────────────────────────────────────────────────────── */

describe('Scenario 5: a Catalysis23 job names another company\'s record', () => {
  it('is refused, leaks nothing, and the job records the safe failure', async () => {
    await enqueueJob({ kind: 'task_due_soon', dedupeKey: `task_due_soon:${T_B}:2026-09-27`, payload: { task_id: T_B, deadline: '2026-09-27' } });
    await enqueueJob({ kind: 'reminder_due', dedupeKey: 'r:outsider', payload: { recipient_person_id: OUTSIDER, text: 'hello', initiator: { kind: 'buddy' } } });
    const logs = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runWorker({ observe: false });
    const [a, b] = jobsOf();
    expect(a).toMatchObject({ status: 'failed', result: { code: 'cross_company' } });
    expect(b).toMatchObject({ status: 'failed', result: { code: 'cross_company' } });
    expect(sent).toHaveLength(0);
    expect(JSON.stringify(jobsOf())).not.toContain('Other company secret task');
    const lines = logs.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('job.cross_company_denied'))).toBe(true);
    expect(lines.join('\n')).not.toContain('Other company secret task');
    logs.mockRestore();
  });

  it('a session only sees its own company, and never messages another company\'s person', async () => {
    const ctx = sessions.make('buddy', { org_id: ORG }, null);
    const res = await act(ctx, 'send_telegram_message', { recipient_person_id: OUTSIDER, message: 'hi' }, { key: 'x:out' });
    expect(res.status).toBe('not_actionable');
    expect(sent).toHaveLength(0);
    const obs = await observeOrg({ org_id: ORG, pulse_enabled: false });
    expect(jobsOf().some((j) => j.payload.task_id === T_B)).toBe(false);
    expect(obs.orgId).toBe(ORG);
  });
});

/* ── Telegram identity, spam, escalation, pulse ───────────────────────────── */

describe('who can be messaged, and how often', () => {
  it('a revoked Telegram identity gets nothing: not enqueued, and not sent if a job exists', async () => {
    await observeOrg({ org_id: ORG, pulse_enabled: false });
    expect(jobsOf().some((j) => j.payload.task_id === T_PRIYA)).toBe(false);
    await enqueueJob({ kind: 'task_due_soon', dedupeKey: `task_due_soon:${T_PRIYA}:2026-09-27`, payload: { task_id: T_PRIYA, deadline: '2026-09-27' } });
    await runWorker({ observe: false });
    const j = jobsOf().find((x) => x.payload.task_id === T_PRIYA);
    expect(j).toMatchObject({ status: 'completed', result: { skipped: 'not_deliverable' } });
    expect(j.result.note).toMatch(/disconnected/);
    expect(sent.some((m) => m.chatId === 7006)).toBe(false);
  });

  it('caps Buddy\'s own messages per person per day', async () => {
    const policy = { ...effectivePolicy({ org_id: ORG, settings: { max_messages_per_person_per_day: 1 } }), orgId: ORG };
    admin.db.tables.buddy_autonomy_policies = [{ org_id: ORG, enabled: true, rules: {}, settings: { max_messages_per_person_per_day: 1 }, version: 2 }];
    void policy;
    await enqueueJob({ kind: 'reminder_due', dedupeKey: 'r:1', payload: { recipient_person_id: SWETHA, text: 'one', initiator: { kind: 'buddy' } } });
    await enqueueJob({ kind: 'task_due_soon', dedupeKey: `task_due_soon:${T_DECK}:2026-09-27`, payload: { task_id: T_DECK, deadline: '2026-09-27' } });
    await runWorker({ observe: false });
    expect(sent.filter((m) => m.chatId === 7001)).toHaveLength(1);
    expect(jobsOf().find((j) => j.kind === 'task_due_soon').result).toMatchObject({ skipped: 'daily_message_cap' });
  });

  it('tells the founder about long-overdue work once, and not again while nothing changed', async () => {
    await observeOrg({ org_id: ORG, pulse_enabled: false });
    expect(jobsOf('founder_digest')).toHaveLength(1);
    await runWorker({ observe: false });
    const toNikhil = sent.filter((m) => m.chatId === 7003);
    expect(toNikhil).toHaveLength(1);
    expect(toNikhil[0].html).toContain('“Book the venue” — Madheswaran');
    // Madheswaran also got his one overdue follow-up.
    expect(sent.filter((m) => m.chatId === 7002)).toHaveLength(1);

    at('2026-09-27T06:00:00Z'); // next day, same problem
    await observeOrg({ org_id: ORG, pulse_enabled: false });
    await runWorker({ observe: false });
    expect(jobsOf('founder_digest')[1]).toMatchObject({ status: 'completed', result: { skipped: 'unchanged_since_last_digest' } });
    expect(sent.filter((m) => m.chatId === 7003)).toHaveLength(1);
    expect(sent.filter((m) => m.chatId === 7002)).toHaveLength(1); // one follow-up per missed deadline
  });

  it('the kill switch stops everything Buddy does on its own', async () => {
    admin.db.tables.buddy_autonomy_policies = [{ org_id: ORG, enabled: false, rules: {}, settings: {} }];
    const obs = await observeOrg({ org_id: ORG, pulse_enabled: false });
    expect(obs.skipped).toBe('autonomy_off');
    await enqueueJob({ kind: 'task_due_soon', dedupeKey: `task_due_soon:${T_DECK}:2026-09-27`, payload: { task_id: T_DECK, deadline: '2026-09-27' } });
    await runWorker({ observe: false });
    expect(jobsOf()[0]).toMatchObject({ status: 'completed', result: { skipped: 'autonomy_off' } });
    expect(sent).toHaveLength(0);
  });

  it('Daily Pulse is a job now: one per company per day, at its hour', async () => {
    await observeOrg({ org_id: ORG, pulse_enabled: true, pulse_hour: 18 });
    const [p] = jobsOf('pulse_due');
    expect(p.run_at).toBe(atLocal('2026-09-26', 18, 0, TZ));
    await runWorker({ observe: false });
    expect(pulse.calls).toHaveLength(0); // not yet 18:00
    at('2026-09-26T12:31:00Z');
    await observeOrg({ org_id: ORG, pulse_enabled: true, pulse_hour: 18 });
    await runWorker({ observe: false });
    await runWorker({ observe: false });
    expect(pulse.calls).toEqual([ORG]);
    expect(jobsOf('pulse_due')).toHaveLength(1);
  });
});

describe('reminders people schedule', () => {
  it('"remind Swetha tomorrow at 10 to call the sponsor" → a job, sent at 10:00 by Buddy', async () => {
    const ctx = interactive(nikhilCtx());
    const out = await propose(getTool('schedule_reminder'), { person: 'Swetha', message: 'call the sponsor about the demo day', date: 'tomorrow', time: '10am' }, ctx, { chatId: 'c1' });
    expect(out.card.status).toBe('executed');
    const [j] = jobsOf('reminder_due');
    expect(j.run_at).toBe(atLocal('2026-09-27', 10, 0, TZ));
    at('2026-09-27T04:29:00Z');
    await runWorker({ observe: false });
    expect(sent).toHaveLength(0);
    at('2026-09-27T04:31:00Z');
    await runWorker({ observe: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatId: 7001 });
    expect(sent[0].html).toContain('Reminder from Nikhil: call the sponsor about the demo day');
  });

  it('a reminder to someone else about money is a card, not autonomous; one to yourself is yours', async () => {
    const ctx = interactive(nikhilCtx());
    const out = await propose(getTool('schedule_reminder'), { person: 'Swetha', message: 'invoice Acme ₹2 lakh', date: 'tomorrow', time: '10am' }, ctx, { chatId: 'c1' });
    expect(out.card.status).toBe('proposed');
    expect(jobsOf('reminder_due')).toHaveLength(0);
    const mine = await propose(getTool('schedule_reminder'), { person: 'me', message: 'check the ₹2 lakh invoice', date: 'tomorrow', time: '9' }, interactive(nikhilCtx()), { chatId: 'c2' });
    expect(mine.card.status).toBe('executed');
  });

  it('can be undone before it goes out', async () => {
    const { undo } = await import('../agent/pipeline.js');
    const ctx = interactive(nikhilCtx());
    const out = await propose(getTool('schedule_reminder'), { person: 'me', message: 'stretch', date: 'tomorrow', time: '9' }, ctx, { chatId: 'c1' });
    expect((await undo(nikhilCtx(), out.card.action_id)).status).toBe('undone');
    expect(jobsOf('reminder_due')[0].status).toBe('cancelled');
  });

  it('a linked person (no login) cannot schedule a Buddy check (it runs as a login)', async () => {
    const swetha = interactive(personCtx({ db: scoped(admin.db, ORG), employeeId: SWETHA }));
    finishCtx(swetha, ORG);
    const { toolsFor } = await import('../agent/registry.js');
    const names = toolsFor(swetha).map((t) => t.name);
    expect(names).toContain('start_followup');
    expect(names).toContain('schedule_reminder');
    expect(names).not.toContain('schedule_buddy_check');
  });
});

describe('reasoning only when it is needed', () => {
  it('a deadline reminder calls no model', async () => {
    const callModel = vi.fn();
    await enqueueJob({ kind: 'task_due_soon', dedupeKey: `task_due_soon:${T_DECK}:2026-09-27`, payload: { task_id: T_DECK, deadline: '2026-09-27' } });
    await runWorker({ observe: false, callModel });
    expect(callModel).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it('a scheduled check runs the same Buddy loop, bounded, as the asker, and reports back', async () => {
    const ctx = interactive(nikhilCtx());
    const out = await propose(getTool('schedule_buddy_check'), { instruction: 'check whether Swetha sent the sponsor deck and tell me', date: 'tomorrow', time: '6pm' }, ctx, { chatId: 'c1' });
    // Delegating a future turn takes one tap.
    expect(out.card.status).toBe('proposed');
    expect((await confirm(interactive(nikhilCtx()), out.card.action_id)).status).toBe('executed');
    const [j] = jobsOf('buddy_review');
    expect(j).toMatchObject({ actor_kind: 'user', actor_user_id: NIKHIL_USER, payload: { report_to: NIKHIL } });
    const callModel = vi.fn()
      .mockResolvedValueOnce({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'list_tasks', arguments: '{"assignee":"Swetha"}' } }] } })
      .mockResolvedValueOnce({ message: { role: 'assistant', content: 'Swetha has not sent the sponsor deck yet — it is due today.' } });
    at('2026-09-27T12:31:00Z');
    await runWorker({ observe: false, callModel });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(sessions.calls).toContain('user');
    expect(jobsOf('buddy_review')[0].status).toBe('completed');
    expect(sent.at(-1).chatId).toBe(7003);
    expect(sent.at(-1).html).toContain('has not sent the sponsor deck yet');
  });

  it('what the model proposes in a job goes through the policy: routine runs, money waits', async () => {
    const job = await jobs.enqueue({ orgId: ORG, kind: 'buddy_review', dedupeKey: 'check:loop', actor: { kind: 'user', userId: NIKHIL_USER }, payload: {} });
    const [claimed] = await jobs.claim({ worker: 'w', ids: [job.id] });
    const ctx = sessions.make('user', claimed, null);
    const events = [];
    const model = vi.fn()
      .mockResolvedValueOnce({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'create_task', arguments: '{"title":"Chase the sponsor","assignee":"Swetha","deadline":"tomorrow"}' } }] } })
      .mockResolvedValueOnce({ message: { role: 'assistant', content: 'Created the chase task.' } });
    await runChat(ctx, { message: 'x', history: [], chatId: `job:${job.id}` }, (e, d) => events.push([e, d]), { callModelImpl: model });
    const card = events.find(([e]) => e === 'card')[1].card;
    expect(card).toMatchObject({ status: 'executed', autonomous: true, policy_rule: 'tool_default_autonomous' });
    expect(rows('tasks').some((t) => t.title === 'Chase the sponsor')).toBe(true);
  });
});

/* ── nothing else changed ─────────────────────────────────────────────────── */

describe('existing behaviour is unchanged', () => {
  it('a manual create_task in chat is still a card awaiting a tap, written as before', async () => {
    const ctx = interactive(nikhilCtx());
    const out = await propose(getTool('create_task'), { title: 'Draft the pitch' }, ctx, { chatId: 'c1' });
    expect(out.card.status).toBe('proposed');
    expect(out.auto).toBeUndefined();
    const a = actionsOf('create_task')[0];
    expect(a).toMatchObject({ status: 'proposed', approval_required: true });
    expect(a).not.toHaveProperty('policy_decision');
    expect(a).not.toHaveProperty('idempotency_key');
    expect(rows('tasks').some((t) => t.title === 'Draft the pitch')).toBe(false);
    const done = await confirm(nikhilCtx(), a.id);
    expect(done.status).toBe('executed');
    expect(rows('ai_actions')[0].events.map((e) => e.status)).toEqual(['proposed', 'approved', 'executing', 'completed']);
  });

  it('a manual Telegram message in chat is still a high-risk card with Send', async () => {
    const ctx = interactive(nikhilCtx());
    const out = await propose(getTool('send_telegram_message'), { recipient: 'Swetha', message: 'See you at 4' }, ctx, { chatId: 'c1' });
    expect(out.card).toMatchObject({ status: 'proposed', risk: 'high', confirmLabel: 'Send to Swetha' });
    expect(sent).toHaveLength(0);
    await confirm(nikhilCtx(), out.card.action_id);
    expect(sent[0].html).toBe(formatMessage('See you at 4', { senderName: 'Nikhil', orgName: 'Catalysis23' }));
  });

  it('a session without the engine (no autonomy context, e.g. before 0072) is offered none of it', async () => {
    const ctx = nikhilCtx();
    const out = await propose(getTool('start_followup'), { person: 'Swetha', task: 'x', deadline: 'tomorrow' }, ctx, { chatId: 'c1' });
    expect(out.kind).toBe('none');
    expect(rows('buddy_workflows')).toHaveLength(0);
    const create = await propose(getTool('create_task'), { title: 'Plain' }, ctx, { chatId: 'c1' });
    expect(create.card.status).toBe('proposed');
  });
});

describe('time', () => {
  it('knows the company\'s clock', () => {
    expect(atLocal('2026-09-27', 9, 0, TZ)).toBe('2026-09-27T03:30:00.000Z');
    expect(quietUntil({ quiet_start: 21, quiet_end: 8 }, TZ, new Date('2026-09-26T17:00:00Z'))).toBe('2026-09-27T02:30:00.000Z');
    expect(quietUntil({ quiet_start: 21, quiet_end: 8 }, TZ, new Date('2026-09-26T06:00:00Z'))).toBeNull();
    expect(['10', '10am', '10:30 pm', '5 pm', 'noon', '25:00', 'soon'].map(readTime)).toEqual(['10:00', '10:00', '22:30', '17:00', '12:00', null, null]);
  });

  it('processJob of an unknown kind fails permanently', async () => {
    const { id } = await enqueueJob({ kind: 'mystery_event', dedupeKey: 'm:1', payload: {} });
    const [j] = await jobs.claim({ worker: 'w-x', ids: [id] });
    const out = await processJob(j, 'w-x');
    expect(out).toMatchObject({ status: 'failed' });
  });

  it('kick never throws', async () => {
    expect(await kick(ORG, [])).toEqual({ processed: 0, jobs: [] });
  });
});
