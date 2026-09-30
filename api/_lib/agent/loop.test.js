import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeDb, fakeCtx } from './testing/fakeDb.js';

// ai_actions lives in memory here; everything else is the real code.
const store = new Map();
vi.mock('./actions.js', async (importOriginal) => {
  const real = await importOriginal();
  let n = 0;
  return {
    ...real,
    countPending: async (_ctx, chatId) => [...store.values()].filter((r) => r.chat_id === chatId && real.effectiveStatus(r) === 'proposed').length,
    insertProposal: async (ctx, { chatId, messageId, tool, args, targets, preview }) => {
      const id = `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      const row = {
        id, org_id: ctx.orgId, user_id: ctx.user.id, chat_id: chatId, message_id: messageId,
        tool: tool.name, module: tool.module, risk: tool.risk, args, target_ref: targets?.length ? { items: targets } : null,
        preview, status: 'proposed', proposed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + real.PROPOSAL_TTL_MS).toISOString(),
      };
      store.set(id, row);
      return { ...row };
    },
    loadAction: async (id, userId) => { const r = store.get(id); return r && r.user_id === userId ? { ...r } : null; },
    transition: async (id, from, patch) => {
      const r = store.get(id);
      if (!r || r.status !== from) return null;
      Object.assign(r, patch);
      return { ...r };
    },
    patchAction: async (id, patch) => { Object.assign(store.get(id), patch); return { ...store.get(id) }; },
  };
});

const { runChat, runResume } = await import('./loop.js');
const { confirm, cancel, undo } = await import('./pipeline.js');

const T1 = '11111111-1111-4111-8111-111111111111';
const ALL = { view: true, create: true, edit: true, delete: true };
const PERMS = {
  tasks: ALL, clients: ALL, employees: ALL, projects: ALL, expenses: ALL, income_entries: ALL, vendors: ALL,
  financial_documents: ALL, payments: ALL, purchase_invoices: ALL, usage_counters: ALL, catalog_items: ALL,
};

function world() {
  const db = fakeDb({
    tasks: [{ id: T1, org_id: 'org-1', title: 'Connect with client on pricing', status: 'pending', priority: 'medium', deadline: '2026-09-25', updated_at: '2026-09-20T10:00:00+00:00' }],
    expenses: [],
    finance_categories: [{ key: 'furniture', label: 'Furniture', direction: 'out', group_label: 'Assets', treatment: 'capex', active: true, sort_order: 1 }],
  });
  const ctx = fakeCtx({ db, perms: structuredClone(PERMS), today: '2026-09-26', recentEntities: [{ type: 'task', id: T1, label: 'Connect with client on pricing', turn: 'm1' }] });
  return { db, ctx };
}

/** A model that plays back scripted replies and records what it was sent. */
function scripted(...replies) {
  const seen = [];
  const fn = async ({ messages, tools }) => {
    seen.push({ messages: messages.map((m) => ({ ...m })), tools });
    // Out of script: a model that has nothing more to do says so.
    const next = replies.length ? replies.shift() : { role: 'assistant', content: 'ok' };
    return { message: typeof next === 'function' ? next(messages) : next };
  };
  fn.seen = seen;
  return fn;
}

const call = (name, args, id = 'call_1') => ({
  role: 'assistant', content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, extra_content: { google: { thought_signature: 'sig' } } }],
});

function collect() {
  const events = [];
  const emit = (event, data) => events.push({ event, ...data });
  return { events, emit };
}

const businessWrites = (db) => db.writes.filter((w) => w.table !== 'ai_actions');

beforeEach(() => store.clear());

describe('nothing is written without a confirm', () => {
  it('the implied reschedule becomes a card and only a card', async () => {
    const { db, ctx } = world();
    const { events, emit } = collect();
    const model = scripted(call('update_task', { task: 'it', deadline: '2nd October' }));
    await runChat(ctx, { message: 'it is rescheduled to 2nd October', history: [], chatId: 'c1', messageId: 'm2' }, emit, { callModelImpl: model });

    const card = events.find((e) => e.event === 'card')?.card;
    expect(card).toMatchObject({ status: 'proposed', risk: 'low', title: 'Update task deadline' });
    expect(card.diff[0]).toMatchObject({ from: '25 Sep', to: '2 Oct 2026' });
    expect(businessWrites(db)).toEqual([]);
    expect(db.tables.tasks[0].deadline).toBe('2026-09-25');
    // The turn ends at the proposal: one model call, not a second one that might claim success.
    expect(model.seen).toHaveLength(1);
  });

  it('holds for every write tool the model could call', async () => {
    const { ALL_TOOLS } = await import('./registry.js');
    const argsFor = {
      create_task: { title: 'X' }, update_task: { task: 'pricing', priority: 'high' }, complete_task: { task: 'pricing' },
      reopen_task: { task: 'pricing' }, add_task_note: { task: 'pricing', note: 'waiting on API access', blocker: true }, delete_task: { task: 'pricing' }, create_client: { name: 'New Co' },
      update_client: { client: 'x', email: 'a@b.co' }, move_client_stage: { client: 'x', stage: 'lost' },
      add_client_note: { client: 'x', note: 'n' }, delete_client: { client: 'x' },
      create_cash_entry: { direction: 'out', amount: '500', description: 'Tea', category: 'furniture', source_text: 'paid 500 for tea' },
      create_invoice_draft: { client: 'x', items: 'design 50k' }, create_quotation_draft: { client: 'x', items: 'design 50k' },
      create_proforma_draft: { client: 'x', items: 'design 50k' }, convert_quotation: { source: 'x' },
      issue_document: { document: 'x' }, record_payment: { document: 'x', amount: '500' }, mark_invoice_paid: { document: 'x' },
      create_vendor: { company_name: 'New Vendor' }, create_purchase_bill: { vendor: 'x', amount: '500', bill_number: 'B1' },
      cancel_financial_document: { document: 'x' }, delete_financial_document: { document: 'x' },
    };
    for (const tool of ALL_TOOLS.filter((t) => t.kind === 'write')) {
      const { db, ctx } = world();
      const { emit } = collect();
      await runChat(ctx, { message: 'do it', chatId: 'c1', messageId: 'm' }, emit, { callModelImpl: scripted(call(tool.name, argsFor[tool.name] || {})) });
      expect(businessWrites(db), tool.name).toEqual([]);
    }
  });

  it('a read tool runs, its result goes back as data, and the answer follows', async () => {
    const { ctx } = world();
    const { events, emit } = collect();
    const model = scripted(
      call('list_tasks', { status: 'overdue' }),
      { role: 'assistant', content: 'One overdue task: *Connect with client on pricing*, due 25 Sep.' },
    );
    await runChat(ctx, { message: 'what is overdue?', chatId: 'c1', messageId: 'm1' }, emit, { callModelImpl: model });
    expect(events.find((e) => e.event === 'entities').entities[0]).toMatchObject({ type: 'task', id: T1 });
    expect(events.at(-1)).toMatchObject({ event: 'text', text: expect.stringMatching(/One overdue task/) });
    const toolMsg = model.seen[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg.content).toMatch(/^<data tool="list_tasks">/);
    expect(toolMsg.content).toMatch(/"total_matching":1/);
    // The thought signature goes back untouched.
    expect(model.seen[1].messages.find((m) => m.tool_calls)?.tool_calls[0].extra_content.google.thought_signature).toBe('sig');
  });

  it('refuses a tool the user is not allowed, whatever the model asks for', async () => {
    const { db, ctx } = world();
    ctx.perms.tasks = { view: true, create: false, edit: false, delete: false };
    const { events, emit } = collect();
    const model = scripted(call('update_task', { task: 'it', deadline: 'friday' }), { role: 'assistant', content: 'I can\'t change tasks with your role.' });
    await runChat(ctx, { message: 'move it to friday', chatId: 'c1', messageId: 'm' }, emit, { callModelImpl: model });
    expect(events.some((e) => e.event === 'card')).toBe(false);
    expect(model.seen[0].tools.map((t) => t.function.name)).not.toContain('update_task');
    expect(businessWrites(db)).toEqual([]);
  });
});

describe('confirm', () => {
  async function proposed() {
    const w = world();
    const { events, emit } = collect();
    await runChat(w.ctx, { message: 'rescheduled to 2nd October', chatId: 'c1', messageId: 'm2' }, emit,
      { callModelImpl: scripted(call('update_task', { task: 'it', deadline: '2nd October' })) });
    return { ...w, card: events.find((e) => e.event === 'card').card };
  }

  it('executes once, and a double tap returns the same result', async () => {
    const { db, ctx, card } = await proposed();
    const first = await confirm(ctx, card.action_id);
    expect(first.status).toBe('executed');
    expect(first.card.summary).toBe('Moved “Connect with client on pricing” to **2 Oct 2026**.');
    expect(first.card.followUp).toBe('Overdue tasks: 0.');
    expect(first.card.undo_until).toBeTruthy();
    const second = await confirm(ctx, card.action_id);
    expect(second.status).toBe('executed');
    expect(businessWrites(db).filter((w) => w.op === 'update')).toHaveLength(1);
  });

  it('re-previews instead of overwriting a record changed since the card was drawn', async () => {
    const { db, ctx, card } = await proposed();
    db.tables.tasks[0].updated_at = '2026-09-26T08:00:00+00:00';
    db.tables.tasks[0].priority = 'high';
    ctx.cache = new Map();
    const res = await confirm(ctx, card.action_id);
    expect(res.status).toBe('repreviewed');
    expect(res.card.action_id).not.toBe(card.action_id);
    expect(businessWrites(db)).toEqual([]);
    expect(store.get(card.action_id).status).toBe('expired');
  });

  it('refuses after 30 minutes', async () => {
    const { db, ctx, card } = await proposed();
    store.get(card.action_id).expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await confirm(ctx, card.action_id)).status).toBe('expired');
    expect(businessWrites(db)).toEqual([]);
  });

  it('re-checks permission at confirm time', async () => {
    const { db, ctx, card } = await proposed();
    ctx.perms.tasks = { view: true };
    expect((await confirm(ctx, card.action_id)).status).toBe('failed');
    expect(businessWrites(db)).toEqual([]);
  });

  it('is scoped to the proposer', async () => {
    const { ctx, card } = await proposed();
    const other = { ...ctx, user: { id: 'someone-else' } };
    expect((await confirm(other, card.action_id)).status).toBe('not_found');
  });

  it('applies an inline edit, validated like the original', async () => {
    const { db, ctx, card } = await proposed();
    const res = await confirm(ctx, card.action_id, { edits: { deadline: '2026-10-09', title: 'ignored: not an editable field here' } });
    expect(res.status).toBe('executed');
    expect(db.tables.tasks[0]).toMatchObject({ deadline: '2026-10-09', title: 'Connect with client on pricing' });
  });

  it('cancel and undo', async () => {
    const a = await proposed();
    expect((await cancel(a.ctx, a.card.action_id)).status).toBe('cancelled');
    expect((await confirm(a.ctx, a.card.action_id)).status).toBe('cancelled');

    const b = await proposed();
    await confirm(b.ctx, b.card.action_id);
    b.ctx.cache = new Map();
    const u = await undo(b.ctx, b.card.action_id);
    expect(u.status).toBe('undone');
    expect(b.db.tables.tasks[0].deadline).toBe('2026-09-25');
  });
});

describe('chips and typed answers', () => {
  it('a tapped choice goes straight back into the tool, no model', async () => {
    const { ctx } = world();
    const { events, emit } = collect();
    await runResume(ctx, { tool: 'update_task', args: { deadline: 'friday' }, param: 'task', value: T1 }, emit, { chatId: 'c1' });
    expect(events[0]).toMatchObject({ event: 'card' });
  });

  it('a typed reply to an open question goes to the model with the question and the arguments so far', async () => {
    const { ctx } = world();
    ctx.pending = { tool: 'create_cash_entry', param: 'amount', question: 'How much went out?', args: { direction: 'out', description: 'Chairs', source_text: 'log an expense for chairs' } };
    const { events, emit } = collect();
    const model = scripted(call('create_cash_entry', { direction: 'out', description: 'Chairs', category: 'furniture', payment_method: 'upi', amount: '4500', source_text: 'log an expense for chairs' }));
    await runChat(ctx, { message: 'it was about four and a half thousand', chatId: 'c1', messageId: 'm' }, emit, { callModelImpl: model });
    const turn = model.seen[0].messages.at(-2).content;
    expect(turn).toMatch(/YOUR OPEN QUESTION: you asked "How much went out\?"/);
    expect(turn).toMatch(/"description":"Chairs"/);
    expect(model.seen[0].messages[0].content).not.toMatch(/How much went out/);
    expect(events.find((e) => e.event === 'card').card.confirmLabel).toBe('Record ₹4,500.00 expense');
  });

  it('caps pending proposals per chat', async () => {
    const { ctx } = world();
    for (let i = 0; i < 5; i++) {
      await runResume(ctx, { tool: 'create_task', args: { title: `Task ${i}` } }, () => {}, { chatId: 'c9' });
    }
    const { events, emit } = collect();
    await runResume(ctx, { tool: 'create_task', args: { title: 'One too many' } }, emit, { chatId: 'c9' });
    expect(events[0]).toMatchObject({ event: 'notice', text: expect.stringMatching(/5 changes waiting/) });
  });
});

describe('prompt caching and token accounting', () => {
  const history = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }];

  it('the system prompt does not change with the per-message state, which goes just before the message', async () => {
    const a = world();
    const b = world();
    b.ctx.today = '2026-10-14';
    b.ctx.page = { route: '/invoices', recordType: 'invoice', recordId: 'inv-9' };
    b.ctx.recentEntities = [{ type: 'client', id: 'c-7', label: 'Kite', turn: 'm4' }];
    b.ctx.pending = { tool: 'create_task', param: 'title', question: 'What should it be called?', args: {} };
    b.ctx.openCards = [{ action_id: 'act-1', title: 'Update task deadline', risk: 'low' }];

    const ma = scripted({ role: 'assistant', content: 'ok' });
    const mb = scripted({ role: 'assistant', content: 'ok' });
    await runChat(a.ctx, { message: 'first', history, chatId: 'c1', messageId: 'm1' }, () => {}, { callModelImpl: ma });
    await runChat(b.ctx, { message: 'second', history, chatId: 'c1', messageId: 'm2' }, () => {}, { callModelImpl: mb });

    const [sa, sb] = [ma.seen[0].messages, mb.seen[0].messages];
    expect(sb[0]).toEqual(sa[0]);
    expect(sb.slice(1, 3)).toEqual(history);
    expect(sb.at(-1)).toEqual({ role: 'user', content: 'second' });
    const turn = sb.at(-2).content;
    expect(turn).toMatch(/^<data source="turn">/);
    expect(turn).toMatch(/2026-10-14/);
    expect(turn).toMatch(/\/invoices — open invoice inv-9/);
    expect(turn).toMatch(/client "Kite" \(id c-7\)/);
    expect(turn).toMatch(/act-1: Update task deadline/);
  });

  it('adds up tokens over every step, counting thinking as output', async () => {
    const { ctx } = world();
    const { newUsage, describeUsage } = await import('./model.js');
    const replies = [
      { message: call('list_tasks', { status: 'overdue' }), usage: { prompt_tokens: 7000, completion_tokens: 20, total_tokens: 7120 } },
      { message: { role: 'assistant', content: 'One overdue task.' }, usage: { prompt_tokens: 7300, completion_tokens: 15, total_tokens: 7315, cost: 0.0012, prompt_tokens_details: { cached_tokens: 6000 } } },
    ];
    const usage = newUsage();
    await runChat(ctx, { message: 'what is overdue?', chatId: 'c1', messageId: 'm1' }, () => {}, { callModelImpl: async () => replies.shift(), usage });
    expect(usage).toMatchObject({ calls: 2, prompt: 14300, output: 135, cached: 6000, cost: 0.0012, perCall: [7000, 7300] });
    expect(describeUsage(usage)).toBe('in 14,300 (cached 6,000) · out 135 · $0.00120 · 2 calls [7,000, 7,300]');
  });
});

describe('acting on open cards: understood by the model, guarded by the server', () => {
  async function withCard({ voice = false } = {}) {
    const w = world();
    const { events, emit } = collect();
    await runChat(w.ctx, { message: 'rescheduled to 2nd October', chatId: 'c1', messageId: 'm2' }, emit,
      { callModelImpl: scripted(call('update_task', { task: 'it', deadline: '2nd October' })) });
    const card = events.find((e) => e.event === 'card').card;
    w.ctx.openCards = [{ action_id: card.action_id, title: card.title, risk: card.risk }];
    w.ctx.voice = voice;
    return { ...w, card };
  }

  it('"scrap that" → the model withdraws the card; nothing was written', async () => {
    const { db, ctx, card } = await withCard();
    const { events, emit } = collect();
    const model = scripted(call('cancel_proposal', { action_id: card.action_id }));
    await runChat(ctx, { message: 'actually scrap that', chatId: 'c1', messageId: 'm3' }, emit, { callModelImpl: model });
    expect(model.seen[0].tools.map((t) => t.function.name)).toContain('cancel_proposal');
    expect(events.find((e) => e.event === 'card_update').card.status).toBe('cancelled');
    expect(businessWrites(db)).toEqual([]);
  });

  it('typed chat never offers confirm_proposal: only a tap confirms', async () => {
    const { ctx } = await withCard({ voice: false });
    const model = scripted({ role: 'assistant', content: 'Tap Confirm on the card to apply it.' });
    await runChat(ctx, { message: 'yes do it', chatId: 'c1', messageId: 'm3' }, () => {}, { callModelImpl: model });
    expect(model.seen[0].tools.map((t) => t.function.name)).not.toContain('confirm_proposal');
  });

  it('on a call, agreeing out loud confirms a low-risk card through the real confirm path', async () => {
    const { db, ctx, card } = await withCard({ voice: true });
    const { events, emit } = collect();
    await runChat(ctx, { message: 'yeah go ahead with that', chatId: 'c1', messageId: 'm3' }, emit,
      { callModelImpl: scripted(call('confirm_proposal', { action_id: card.action_id })) });
    expect(events.find((e) => e.event === 'card_update').card.status).toBe('executed');
    expect(db.tables.tasks[0].deadline).toBe('2026-10-02');
  });

  it('even on a call, a high-risk card is refused by the server whatever the model does', async () => {
    const { db, ctx, card } = await withCard({ voice: true });
    ctx.openCards = [{ ...ctx.openCards[0], risk: 'high' }];
    const model = scripted(call('confirm_proposal', { action_id: card.action_id }));
    await runChat(ctx, { message: 'yes', chatId: 'c1', messageId: 'm3' }, () => {}, { callModelImpl: model });
    expect(model.seen[0].tools.map((t) => t.function.name)).not.toContain('confirm_proposal');
    expect(businessWrites(db)).toEqual([]);
  });
});
