import { describe, it, expect } from 'vitest';
import { fakeDb, fakeCtx } from './testing/fakeDb.js';
import { getTool } from './registry.js';
import { applyPlan, undoPlan } from './executor.js';

// Saturday 26 Sep 2026, Asia/Kolkata.
const TODAY = '2026-09-26';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';
const EMP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const C1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function seed() {
  return fakeDb({
    tasks: [
      { id: T1, org_id: 'org-1', title: 'Connect with client on pricing', status: 'pending', priority: 'medium', deadline: '2026-09-25', assignee_id: null, assignee_label: null, project_id: null, updated_at: '2026-09-20T10:00:00.000001+00:00' },
      { id: T2, org_id: 'org-1', title: 'Send Acme the deck', status: 'in_progress', priority: 'high', deadline: '2026-10-10', assignee_id: EMP, assignee_label: 'Ravi Kumar', project_id: null, updated_at: '2026-09-21T10:00:00+00:00' },
      { id: T3, org_id: 'org-1', title: 'Acme renewal call', status: 'pending', priority: 'medium', deadline: null, assignee_id: null, assignee_label: null, project_id: null, updated_at: '2026-09-22T10:00:00+00:00' },
    ],
    employees: [{ id: EMP, org_id: 'org-1', full_name: 'Ravi Kumar', email: 'ravi@test', user_id: null, exited_at: null, updated_at: '2026-01-01' }],
    clients: [{ id: C1, org_id: 'org-1', name: 'Kite Labs', person_name: 'Priya', email: 'priya@kite.io', status: 'contacted', notes: null, archived_at: null, updated_at: '2026-09-01T00:00:00+00:00' }],
    expenses: [{ id: 'x-old', payment_method: 'upi', created_at: '2026-09-01' }],
    finance_categories: [
      { key: 'furniture', label: 'Furniture & fixtures', direction: 'out', group_label: 'Assets', treatment: 'capex', active: true, sort_order: 1 },
      { key: 'rent', label: 'Rent & lease', direction: 'out', group_label: 'Premises', treatment: 'operating', active: true, sort_order: 2 },
      { key: 'other_expense', label: 'Other expense', direction: 'out', group_label: 'Other', treatment: 'operating', active: true, sort_order: 3 },
      { key: 'product_sales', label: 'Product sales', direction: 'in', group_label: 'Sales', treatment: 'revenue', active: true, sort_order: 4 },
    ],
  });
}

/** propose → confirm, the way the pipeline drives a tool, without the log. */
async function run(toolName, args, ctx) {
  const tool = getTool(toolName);
  const r = await tool.resolve(args, ctx);
  if (!r.args) return { stopped: r };
  const problems = await tool.validate(r.args, ctx);
  if (problems.length) return { problems };
  const preview = await tool.preview(r.args, ctx);
  const writesBefore = ctx.db.writes.length;
  const plan = await tool.plan(r.args, ctx);
  const planned = ctx.db.writes.length;
  const outcome = await applyPlan(ctx.db, plan);
  ctx.cache = new Map();
  const summary = tool.summary(outcome, r.args, ctx);
  const after = tool.after ? await tool.after(outcome, ctx) : null;
  return { r, preview, plan, outcome, summary, after, wroteWhilePlanning: planned !== writesBefore };
}

describe('the screenshot scenario — "it is rescheduled to 2nd October"', () => {
  it('turns an implied reschedule of the task under discussion into a deadline change', async () => {
    const db = seed();
    const ctx = fakeCtx({ db, today: TODAY, recentEntities: [{ type: 'task', id: T1, label: 'Connect with client on pricing', turn: 'm1' }] });
    const res = await run('update_task', { task: 'it', deadline: '2nd October' }, ctx);

    expect(res.r.args).toMatchObject({ tasks: [T1], deadline: '2026-10-02' });
    expect(res.preview.title).toBe('Update task deadline');
    expect(res.preview.diff).toEqual([{ key: 'deadline', label: 'Deadline', from: '25 Sep', to: '2 Oct 2026' }]);
    expect(res.wroteWhilePlanning).toBe(false);
    expect(db.tables.tasks.find((t) => t.id === T1).deadline).toBe('2026-10-02');
    expect(res.summary).toBe('Moved “Connect with client on pricing” to **2 Oct 2026**.');
    expect(res.after).toBe('Overdue tasks: 0.');
  });

  it('asks which task when the last turn mentioned several', async () => {
    const ctx = fakeCtx({
      db: seed(), today: TODAY,
      recentEntities: [
        { type: 'task', id: T1, label: 'Connect with client on pricing', turn: 'm2' },
        { type: 'task', id: T3, label: 'Acme renewal call', turn: 'm2' },
      ],
    });
    const { stopped } = await run('update_task', { task: 'that task', deadline: '2 Oct' }, ctx);
    expect(stopped.needs.kind).toBe('choice');
    expect(stopped.needs.options.map((o) => o.value)).toEqual([T1, T3]);
  });

  it('finds a task by a fragment of its title', async () => {
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const res = await run('update_task', { task: 'the pricing one', priority: 'urgent' }, ctx);
    expect(res.r.args).toMatchObject({ tasks: [T1], priority: 'high' });
  });

  it('never guesses between two equally good matches', async () => {
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const { stopped } = await run('update_task', { task: 'acme', status: 'done' }, ctx);
    expect(stopped.needs.kind).toBe('choice');
    expect(stopped.needs.options).toHaveLength(2);
  });

  it('says what it searched when nothing matches, and offers to create it', async () => {
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const { stopped } = await run('update_task', { task: 'quarterly tax filing', deadline: 'friday' }, ctx);
    expect(stopped.needs.kind).toBe('none');
    expect(stopped.needs.message).toMatch(/quarterly tax filing/);
    expect(stopped.needs.offer.tool).toBe('create_task');
  });

  it('refuses a change that changes nothing', async () => {
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const res = await run('update_task', { task: T2, priority: 'high' }, ctx);
    expect(res.problems[0]).toMatch(/already/);
  });

  it('undo restores the deadline, but not over a later edit', async () => {
    const db = seed();
    const ctx = fakeCtx({ db, today: TODAY });
    const res = await run('update_task', { task: T1, deadline: '2026-10-02' }, ctx);
    const back = undoPlan(res.outcome.results);
    expect(back[0]).toMatchObject({ op: 'update', patch: { deadline: '2026-09-25' } });
    // Someone edits the task after the agent did.
    db.tables.tasks.find((t) => t.id === T1).updated_at = '2026-09-26T09:00:00+00:00';
    const undone = await applyPlan(db, back);
    expect(undone.ok).toBe(false);
    expect(undone.results[0].code).toBe('stale');
    expect(db.tables.tasks.find((t) => t.id === T1).deadline).toBe('2026-10-02');
  });
});

describe('tasks', () => {
  it('batch-completes, skipping ones already done', async () => {
    const db = seed();
    db.tables.tasks[2].status = 'done';
    const ctx = fakeCtx({ db, today: TODAY });
    const res = await run('complete_task', { tasks: [T1, T2, T3] }, ctx);
    expect(res.preview.items.map((i) => i.checked)).toEqual([true, true, false]);
    expect(res.plan).toHaveLength(2);
    expect(res.summary).toBe('Marked 2 tasks done.');
  });

  it('assigns by first name and resolves "me" only for a linked employee', async () => {
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const res = await run('update_task', { task: 'pricing', assignee: 'Ravi' }, ctx);
    expect(res.plan[0].patch).toMatchObject({ assignee_id: EMP, assignee_label: 'Ravi Kumar' });
    const me = await run('update_task', { task: 'pricing', assignee: 'me' }, fakeCtx({ db: seed(), today: TODAY }));
    expect(me.stopped.error).toMatch(/not linked/);
  });

  it('creates a task with a forward-looking deadline', async () => {
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const res = await run('create_task', { title: 'Renew the domain', deadline: 'next friday', assignee: 'ravi' }, ctx);
    expect(res.plan[0].row).toMatchObject({ org_id: 'org-1', title: 'Renew the domain', deadline: '2026-10-02', assignee_id: EMP });
    expect(res.summary).toBe('Created “Renew the domain”, due **2 Oct 2026** for Ravi Kumar.');
  });

  it('a delete is high risk and says it cannot be undone', async () => {
    const tool = getTool('delete_task');
    expect(tool.risk).toBe('high');
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const r = await tool.resolve({ task: 'pricing' }, ctx);
    const preview = await tool.preview(r.args, ctx);
    expect(preview.irreversible).toBeTruthy();
    expect(preview.confirmLabel).toMatch(/Delete/);
  });
});

describe('clients & CRM', () => {
  it('"we lost the Kite deal" moves the stage to lost', async () => {
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const res = await run('move_client_stage', { client: 'Kite', stage: 'lost' }, ctx);
    expect(res.preview.diff).toEqual([{ key: 'status', label: 'Stage', from: 'Contacted', to: 'Lost' }]);
    expect(res.plan[0].patch).toEqual({ status: 'lost' });
    expect(res.summary).toBe('Moved “Kite Labs” to **Lost**.');
  });

  it('"won" means the Deal column (status active)', async () => {
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const res = await run('move_client_stage', { client: 'priya', stage: 'won' }, ctx);
    expect(res.plan[0].patch).toEqual({ status: 'active' });
  });

  it('appends a dated note without replacing earlier ones', async () => {
    const db = seed();
    db.tables.clients[0].notes = 'Met at SaaSBoomi.';
    const ctx = fakeCtx({ db, today: TODAY });
    await run('add_client_note', { client: 'Kite Labs', note: 'Budget frozen till March' }, ctx);
    expect(db.tables.clients[0].notes).toBe('Met at SaaSBoomi.\n26 Sep 2026 — Budget frozen till March');
  });

  it('will not add a second client with the same name', async () => {
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const res = await run('create_client', { name: 'kite labs' }, ctx);
    expect(res.problems[0]).toMatch(/already a client/);
  });

  it('reads a deal value in lakh', async () => {
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const res = await run('create_client', { name: 'Globex', value: '2.5 lakh', stage: 'lead' }, ctx);
    expect(res.plan[0].row).toMatchObject({ name: 'Globex', value: 250000, status: 'lead' });
  });
});

describe('create_cash_entry', () => {
  it('records "spent 4.5k on office chairs yesterday" as the full row the card showed', async () => {
    const db = seed();
    const ctx = fakeCtx({ db, today: TODAY });
    const res = await run('create_cash_entry', {
      direction: 'out', amount: '4.5k', source_text: 'spent 4.5k on office chairs yesterday',
    }, ctx);
    expect(res.r.args).toMatchObject({ amount: '4500', category: 'furniture', date: '2026-09-25', payment_method: 'upi' });
    expect(res.preview.confirmLabel).toBe('Record ₹4,500.00 expense');
    expect(res.preview.preview.rows).toContainEqual(['Paid by', 'UPI']);
    const row = db.tables.expenses.find((e) => e.description);
    expect(row).toMatchObject({ org_id: 'org-1', original_amount: 4500, currency: 'INR', incurred_on: '2026-09-25', category: 'furniture', payment_method: 'upi', status: 'paid' });
    expect(row).not.toHaveProperty('amount');
  });

  it('asks how much when no figure was said', async () => {
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const { stopped } = await run('create_cash_entry', { direction: 'out', source_text: 'log an expense for chairs' }, ctx);
    expect(stopped.needs).toMatchObject({ kind: 'input', param: 'amount' });
  });

  it('asks for the rate on a foreign-currency entry instead of booking it at 1', async () => {
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const { stopped } = await run('create_cash_entry', { direction: 'out', amount: '$300', description: 'Figma', category: 'other_expense', source_text: 'paid $300 for figma' }, ctx);
    expect(stopped.needs).toMatchObject({ kind: 'input', param: 'fx_rate' });
  });

  it('is refused up front to a role that cannot record that side', async () => {
    const perms = { expenses: { view: true, create: false }, income_entries: { view: true, create: true } };
    const ctx = fakeCtx({ db: seed(), today: TODAY, perms });
    const { stopped } = await run('create_cash_entry', { direction: 'out', amount: '500', source_text: 'paid 500 for tea' }, ctx);
    expect(stopped.error).toMatch(/cannot record expenses/);
  });
});

describe('the model chooses the category, from the org\'s real list', () => {
  it('its choice stands; the sentence parser only fills in when it chose none', async () => {
    const ctx = fakeCtx({ db: seed(), today: TODAY });
    const tool = getTool('create_cash_entry');
    await tool.prepare(ctx);
    const schema = tool.modelParams(ctx);
    expect(schema.properties.category.description).toMatch(/furniture = Furniture & fixtures/);
    const chosen = await tool.resolve({ direction: 'out', amount: '4500', category: 'other_expense', source_text: 'spent 4,500 on office chairs yesterday' }, ctx);
    expect(chosen.args.category).toBe('other_expense');
    const none = await tool.resolve({ direction: 'out', amount: '4500', source_text: 'spent 4,500 on office chairs yesterday' }, ctx);
    expect(none.args.category).toBe('furniture');
  });
});
