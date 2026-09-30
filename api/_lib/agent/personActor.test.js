import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeDb, fakeCtx, personCtx } from './testing/fakeDb.js';

/*
 * A company person with no StartupBuddy login, acting through their linked
 * Telegram account (0071), in the SAME Buddy as the founder on the web:
 * the same tools, proposals, confirm, executor and undo. Their identity
 * (ctx.actor) is resolved before Buddy runs; the model never decides it.
 *
 * ai_actions lives in memory here with the real ownership rule; everything
 * else is the real code. The database's side — RLS for the person
 * principal — is supabase/tests/15_telegram_person_test.sql.
 */

const actions = new Map();
vi.mock('./actions.js', async (importOriginal) => {
  const real = await importOriginal();
  let n = 0;
  return {
    ...real,
    countPending: async () => 0,
    insertProposal: async (ctx, { chatId, messageId, tool, args, targets, preview }) => {
      const id = `bbbbbbbb-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      const row = {
        id, org_id: ctx.orgId,
        // What actions.insertProposal writes for each kind of actor.
        user_id: ctx.actor?.kind === 'person' ? null : ctx.user.id,
        employee_id: ctx.actor?.kind === 'person' ? ctx.actor.employeeId : null,
        channel_actor: ctx.actor?.channelActor || null,
        channel: ctx.channel || 'chat',
        chat_id: chatId, message_id: messageId, tool: tool.name, module: tool.module, risk: tool.risk, args,
        target_ref: targets?.length ? { items: targets } : null, preview, status: 'proposed',
        proposed_at: new Date().toISOString(), expires_at: new Date(Date.now() + real.PROPOSAL_TTL_MS).toISOString(),
      };
      actions.set(id, row);
      return { ...row };
    },
    loadAction: async (id, ctx) => { const r = actions.get(id); return real.isOwner(r, ctx) ? { ...r } : null; },
    transition: async (id, from, patch) => {
      const r = actions.get(id);
      if (!r || r.status !== from) return null;
      Object.assign(r, patch);
      return { ...r };
    },
    patchAction: async (id, patch) => { Object.assign(actions.get(id), patch); return { ...actions.get(id) }; },
  };
});

const { propose, confirm, undo, deleteRefusal } = await import('./pipeline.js');
const { getTool, toolsFor, allowed } = await import('./registry.js');
const { applyPlan, DELETE_REFUSED } = await import('./executor.js');
const { buildSystemPrompt } = await import('./prompt.js');

const SWETHA = 'e0000000-0000-4000-8000-000000000001';
const MADHES = 'e0000000-0000-4000-8000-000000000002';
const NIKHIL = 'e0000000-0000-4000-8000-000000000003';
const T1 = '11111111-1111-4111-8111-111111111111';
const ACME = 'c0000000-0000-4000-8000-000000000001';
const ALL = { view: true, create: true, edit: true, delete: true };
const RESOURCES = ['tasks', 'clients', 'employees', 'projects', 'financial_documents', 'document_line_items', 'payments',
  'vendors', 'purchase_invoices', 'expenses', 'income_entries', 'project_allocations', 'edgebrain', 'records'];

function world() {
  const db = fakeDb({
    organizations: [{ id: 'org-1', company_name: 'Catalysis23', company_address: 'Chennai', country_code: 'IN', signature_path: null }],
    usage_counters: [{ org_id: 'org-1', invoices: 0, quotations: 0 }],
    employees: [
      { id: SWETHA, org_id: 'org-1', full_name: 'Swetha NM', role: 'Business Development Lead', email: 'swetha@c23.test', user_id: null, exited_at: null, updated_at: '2026-09-01' },
      { id: MADHES, org_id: 'org-1', full_name: 'Madheswaran', role: 'Marketing Lead', email: 'madhes@c23.test', user_id: null, exited_at: null, updated_at: '2026-09-01' },
      { id: NIKHIL, org_id: 'org-1', full_name: 'Nikhil', role: 'Founder', email: 'nikhil@c23.test', user_id: 'u-1', exited_at: null, updated_at: '2026-09-01' },
    ],
    tasks: [{ id: T1, org_id: 'org-1', title: 'Follow up with the sponsor', status: 'pending', priority: 'medium', deadline: null, assignee_id: null, assignee_label: null, project_id: null, notes: null, updated_at: '2026-09-20T10:00:00+00:00' }],
    clients: [{ id: ACME, org_id: 'org-1', name: 'Client X', email: 'ap@clientx.test', state: 'Tamil Nadu', status: 'active', notes: null, updated_at: '2026-09-01' }],
    finance_categories: [
      { key: 'office', label: 'Office supplies', direction: 'out', group_label: 'Operations', treatment: 'opex', active: true, sort_order: 1 },
      { key: 'sponsorship', label: 'Sponsorship', direction: 'in', group_label: 'Income', treatment: 'revenue', active: true, sort_order: 2 },
    ],
  }, { rpc: { next_document_number: ({ p_type }) => ({ invoice: 'INV-2026-0001', quotation: 'QT-2026-0001' })[p_type] } });
  const swetha = personCtx({ db, employeeId: SWETHA });
  const nikhil = fakeCtx({ db, perms: Object.fromEntries(RESOURCES.map((k) => [k, ALL])), employeeId: NIKHIL });
  nikhil.actor = { kind: 'user', userId: 'u-1', channelActor: null };
  nikhil.canDelete = true;
  return { db, swetha, nikhil };
}

const say = async (name, args, ctx) => propose(getTool(name), args, ctx, { chatId: 'tg:7001', messageId: 'tg1' });
const businessWrites = (db) => db.writes.filter((w) => w.op !== 'rpc');

beforeEach(() => actions.clear());

describe('one Buddy, two verified identities', () => {
  it('S: the person is offered the owner\'s catalogue minus deleting, emailing clients and the admin-only team pulse', () => {
    const { swetha, nikhil } = world();
    const theirs = new Set(toolsFor(swetha).map((t) => t.name));
    const missing = toolsFor(nikhil).map((t) => t.name).filter((n) => !theirs.has(n)).sort();
    expect(missing).toEqual(['delete_client', 'delete_financial_document', 'delete_task', 'send_payment_reminder', 'team_pulse']);
    for (const t of ['create_task', 'update_task', 'complete_task', 'create_client', 'update_client', 'add_client_note', 'create_cash_entry',
      'create_invoice_draft', 'create_quotation_draft', 'record_payment', 'issue_document', 'cancel_financial_document', 'create_project']) {
      expect(theirs.has(t), t).toBe(true);
    }
  });

  it('the verified identity reaches the prompt as a fact; deleting is ruled out there too', () => {
    const { swetha, nikhil } = world();
    const p = buildSystemPrompt(swetha, toolsFor(swetha));
    expect(p).toMatch(/on behalf of Swetha NM \(Business Development Lead\), a team member verified through their linked Telegram account/);
    expect(p).toMatch(/DELETING: this person cannot delete anything/);
    expect(p).toMatch(/requires admin access\. I can help you edit it or prepare the change for an admin/);
    expect(buildSystemPrompt(nikhil, toolsFor(nikhil))).not.toMatch(/DELETING:/);
  });
});

describe('F–M, T: operational work goes through propose → confirm', () => {
  it('F: creates a task for herself — proposed, recorded as hers, written only on confirm', async () => {
    const { db, swetha } = world();
    const out = await say('create_task', { title: 'Call the sponsor', assignee: 'me', deadline: '2026-09-27' }, swetha);
    expect(out.kind).toBe('card');
    expect(businessWrites(db)).toEqual([]);
    const row = actions.get(out.card.action_id);
    expect(row).toMatchObject({ user_id: null, employee_id: SWETHA, channel_actor: 'telegram:7001', channel: 'telegram', tool: 'create_task' });

    const res = await confirm(swetha, out.card.action_id);
    expect(res.status).toBe('executed');
    const made = db.tables.tasks.find((t) => t.title === 'Call the sponsor');
    expect(made).toMatchObject({ org_id: 'org-1', assignee_id: SWETHA });
    // Undoing a creation would delete it: not offered to someone who cannot delete.
    expect(res.card.undo_until).toBeNull();
  });

  it('G: assigns a task to a teammate, and can undo that edit', async () => {
    const { db, swetha } = world();
    const out = await say('update_task', { task: 'sponsor', assignee: 'Madheswaran' }, swetha);
    expect(out.kind).toBe('card');
    const res = await confirm(swetha, out.card.action_id);
    expect(res.status).toBe('executed');
    expect(db.tables.tasks[0].assignee_id).toBe(MADHES);
    expect(res.card.undo_until).toBeTruthy();
    const back = await undo(swetha, out.card.action_id);
    expect(back.status).toBe('undone');
    expect(db.tables.tasks[0].assignee_id).toBeNull();
  });

  it('completes a task', async () => {
    const { db, swetha } = world();
    const out = await say('complete_task', { task: 'sponsor' }, swetha);
    expect((await confirm(swetha, out.card.action_id)).status).toBe('executed');
    expect(db.tables.tasks[0].status).toBe('done');
  });

  it('M: creates and updates clients', async () => {
    const { db, swetha } = world();
    const made = await say('create_client', { name: 'Sponsor Co', email: 'hi@sponsor.test' }, swetha);
    expect((await confirm(swetha, made.card.action_id)).status).toBe('executed');
    expect(db.tables.clients.some((c) => c.name === 'Sponsor Co')).toBe(true);
    const note = await say('add_client_note', { client: 'Client X', note: 'Budget frozen till March' }, swetha);
    expect((await confirm(swetha, note.card.action_id)).status).toBe('executed');
    expect(db.tables.clients.find((c) => c.id === ACME).notes).toMatch(/Budget frozen till March/);
  });

  it('H: creates an invoice draft', async () => {
    const { db, swetha } = world();
    const out = await say('create_invoice_draft', { client: 'Client X', items: 'event sponsorship 25k' }, swetha);
    expect(out.kind).toBe('card');
    expect(out.card.risk).toBe('low');
    const res = await confirm(swetha, out.card.action_id);
    expect(res.status).toBe('executed');
    expect(db.tables.financial_documents).toEqual([expect.objectContaining({ type: 'invoice', status: 'draft', doc_number: 'INV-2026-0001' })]);
  });

  it('K: creates an offer (quotation draft)', async () => {
    const { db, swetha } = world();
    const out = await say('create_quotation_draft', { client: 'Client X', items: 'event package 1 lakh' }, swetha);
    expect((await confirm(swetha, out.card.action_id)).status).toBe('executed');
    expect(db.tables.financial_documents).toEqual([expect.objectContaining({ type: 'quotation', doc_number: 'QT-2026-0001' })]);
  });

  it('I, J, T: cash in and cash out are high-risk proposals — nothing moves until confirmed', async () => {
    const { db, swetha } = world();
    const cashIn = await say('create_cash_entry', { direction: 'in', amount: '25000', description: 'Sponsor advance', category: 'sponsorship', payment_method: 'upi', source_text: 'got 25k sponsor advance' }, swetha);
    const cashOut = await say('create_cash_entry', { direction: 'out', amount: '5000', description: 'Office supplies', category: 'office', payment_method: 'upi', source_text: 'cash out 5000 for office supplies' }, swetha);
    expect(cashIn.kind).toBe('card');
    expect(cashOut.kind).toBe('card');
    expect(cashIn.card.risk).toBe('high');
    expect(cashOut.card.risk).toBe('high');
    expect(businessWrites(db)).toEqual([]);

    expect((await confirm(swetha, cashIn.card.action_id)).status).toBe('executed');
    expect((await confirm(swetha, cashOut.card.action_id)).status).toBe('executed');
    expect(db.tables.income_entries).toHaveLength(1);
    expect(db.tables.expenses).toHaveLength(1);
    expect(db.tables.expenses[0]).toMatchObject({ org_id: 'org-1', original_amount: 5000 });
  });
});

describe('N: a linked person never deletes', () => {
  it('is not offered a delete tool, and is told so plainly if one is asked for', async () => {
    const { db, swetha } = world();
    for (const name of ['delete_task', 'delete_client', 'delete_financial_document']) expect(allowed(getTool(name), swetha)).toBe(false);
    const task = await say('delete_task', { task: 'sponsor' }, swetha);
    expect(task).toMatchObject({ kind: 'none', message: 'Deleting tasks requires admin access. I can help you edit it or prepare the change for an admin.' });
    const inv = await say('delete_financial_document', { document: 'INV-2026-0001' }, swetha);
    expect(inv.message).toBe(deleteRefusal(getTool('delete_financial_document')));
    expect(inv.message).toMatch(/^Deleting invoices and quotations requires admin access\./);
    expect(db.writes).toEqual([]);
    expect(db.tables.tasks).toHaveLength(1);
  });

  it('holds even if the permission map wrongly said delete: the registry refuses on its own', async () => {
    const { db } = world();
    const wrong = personCtx({ db, employeeId: SWETHA, perms: Object.fromEntries(RESOURCES.map((k) => [k, ALL])) });
    expect(toolsFor(wrong).map((t) => t.name).filter((n) => n.startsWith('delete_'))).toEqual([]);
    expect((await say('delete_client', { client: 'Client X' }, wrong)).message).toMatch(/^Deleting clients requires admin access/);
    expect(db.writes).toEqual([]);
  });

  it('even a delete op that reached the executor is refused, follow-ups included', async () => {
    const { db } = world();
    const direct = await applyPlan(db, [{ op: 'delete', table: 'tasks', id: T1 }], { allowDelete: false });
    expect(direct.results[0]).toMatchObject({ ok: false, error: DELETE_REFUSED });
    const viaFollowUp = await applyPlan(db, [{
      op: 'update', table: 'tasks', id: T1, patch: { notes: 'x' }, then: () => [{ op: 'delete', table: 'clients', id: ACME }],
    }], { allowDelete: false });
    expect(viaFollowUp.warnings).toEqual([DELETE_REFUSED]);
    expect(db.tables.tasks).toHaveLength(1);
    expect(db.tables.clients).toHaveLength(1);
  });

  it('a founder still deletes through the same pipeline', async () => {
    const { db, nikhil } = world();
    const out = await say('delete_task', { task: 'sponsor' }, nikhil);
    expect(out.kind).toBe('card');
    expect((await confirm(nikhil, out.card.action_id)).status).toBe('executed');
    expect(db.tables.tasks).toHaveLength(0);
  });
});

describe('an action answers only to the identity that asked', () => {
  it('nobody else can confirm Swetha\'s card — not the founder, not a teammate', async () => {
    const { swetha, nikhil, db } = world();
    const out = await say('create_task', { title: 'Hers', assignee: 'me' }, swetha);
    const madhes = personCtx({ db, employeeId: MADHES, name: 'Madheswaran', linkId: 'l-madhes', telegramUserId: 7002 });
    expect((await confirm(nikhil, out.card.action_id)).status).toBe('not_found');
    expect((await confirm(madhes, out.card.action_id)).status).toBe('not_found');
    expect(businessWrites(db)).toEqual([]);
    expect((await confirm(swetha, out.card.action_id)).status).toBe('executed');
  });

  it('and she cannot confirm the founder\'s', async () => {
    const { swetha, nikhil } = world();
    const out = await say('create_task', { title: 'His' }, nikhil);
    expect((await confirm(swetha, out.card.action_id)).status).toBe('not_found');
  });
});

describe('S: the same request from Telegram and from the web is one pipeline', () => {
  it('produces the same card and the same write, differing only in who asked', async () => {
    const { db, swetha, nikhil } = world();
    nikhil.channel = 'chat';
    const a = await say('update_task', { task: 'sponsor', deadline: '2026-10-02' }, swetha);
    const b = await say('update_task', { task: 'sponsor', deadline: '2026-10-02' }, nikhil);
    const strip = (c) => ({ title: c.title, tool: c.tool, risk: c.risk, diff: c.diff, status: c.status });
    expect(strip(a.card)).toEqual(strip(b.card));
    expect(actions.get(a.card.action_id)).toMatchObject({ employee_id: SWETHA, user_id: null, channel: 'telegram' });
    expect(actions.get(b.card.action_id)).toMatchObject({ employee_id: null, user_id: 'u-1', channel: 'chat' });
    expect((await confirm(swetha, a.card.action_id)).status).toBe('executed');
    expect(db.tables.tasks[0].deadline).toBe('2026-10-02');
  });
});
