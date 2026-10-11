import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeDb } from '../testing/fakeDb.js';
import { worldSeed, OWNER_PERMS, IDS } from '../../../../scripts/eval-agent.world.js';

// ai_actions lives in memory here, as in loop.test.js; everything else is real.
const store = new Map();
vi.mock('../actions.js', async (importOriginal) => {
  const real = await importOriginal();
  let n = 0;
  return {
    ...real,
    countPending: async (_ctx, chatId) => [...store.values()].filter((r) => r.chat_id === chatId && real.effectiveStatus(r) === 'proposed').length,
    insertProposal: async (ctx, { chatId, messageId, tool, args, targets, preview }) => {
      const id = `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      const row = {
        id, org_id: ctx.orgId, user_id: ctx.user.id, employee_id: null, channel_actor: null, chat_id: chatId, message_id: messageId,
        tool: tool.name, module: tool.module, risk: tool.risk, args, target_ref: targets?.length ? { items: targets } : null,
        preview, status: 'proposed', proposed_at: new Date().toISOString(), expires_at: new Date(Date.now() + real.PROPOSAL_TTL_MS).toISOString(),
      };
      store.set(id, row);
      return { ...row };
    },
    loadAction: async (id, ctx) => { const r = store.get(id); return real.isOwner(r, ctx) ? { ...r } : null; },
    transition: async (id, from, patch) => { const r = store.get(id); if (!r || r.status !== from) return null; Object.assign(r, patch); return { ...r }; },
    patchAction: async (id, patch) => { Object.assign(store.get(id), patch); return { ...store.get(id) }; },
  };
});

// The service role must never be what answers a question: reads go through
// the caller's own client. Anything that reaches for it here fails loudly.
const adminCalls = [];
vi.mock('../../supabaseAdmin.js', () => ({
  supabaseAdmin: () => { adminCalls.push(new Error('service role used').stack); throw new Error('service role is not available in this test'); },
}));

const { runChat, runResume } = await import('../loop.js');
const { confirm } = await import('../pipeline.js');
const { callModel } = await import('../model.js');
const { evalCtx, send, countingModel } = await import('./evaluate.js');
const { routerMode } = await import('./engine.js');

beforeEach(() => { store.clear(); adminCalls.length = 0; });

/** A session over the fixture company that proposes into the mocked ai_actions. */
function session(over = {}) {
  const world = evalCtx(over);
  delete world.ctx.actionStore;
  const logged = [];
  world.ctx.routeLog = (row) => logged.push(row);
  return { ...world, logged };
}

const texts = (r) => r.events.filter((e) => e.event === 'text').map((e) => e.text).join('\n');
const of = (r, event) => r.events.filter((e) => e.event === event);
const businessWrites = (db) => db.writes.filter((w) => w.op !== 'rpc');

describe('deterministic requests make no model call', () => {
  it.each([
    ['Who owes us money?', /1 unpaid invoice.*₹1,00,000\.00 to collect/],
    ["Which clients haven't paid?", /1 unpaid invoice/],
    ['Can you check our pending collections?', /1 unpaid invoice/],
    ['overdue tasks', /2 overdue tasks/],
    ['who is working on the pitch deck?', /Ravi Kumar.*Send Acme the pitch deck/],
    ["what is Kite's email", /priya@kite\.io/],
    ['18% gst on 50k', /₹9,000\.00.*₹59,000\.00/],
    ['hi', /What do you need\?/],
  ])('%s', async (message, expected) => {
    const { ctx, db } = session();
    const model = countingModel();
    const r = await send(ctx, message, { model });
    expect(model.calls).toBe(0);
    expect(r.out).toMatchObject({ local: true, route: 'local' });
    expect(texts(r)).toMatch(expected);
    expect(businessWrites(db)).toEqual([]);
    expect(adminCalls).toEqual([]);
  });

  it('shows the tool\'s own view, with the tool\'s own figures', async () => {
    const { ctx } = session();
    const r = await send(ctx, 'unpaid invoices');
    const [view] = of(r, 'view').map((e) => e.view);
    expect(view).toMatchObject({ type: 'list', title: 'Unpaid invoices', total: 1 });
    expect(view.items[0]).toMatchObject({ title: 'Zephyr Retail', value: '₹1,00,000.00' });
    // The sentence quotes the figure the tool computed, not one of its own.
    expect(texts(r)).toContain('₹1,00,000.00');
  });

  it('ends every local turn with a mood, like a model turn', async () => {
    const { ctx } = session();
    const r = await send(ctx, 'who owes us money?');
    expect(r.events.at(-1).event).toBe('mood');
  });
});

describe('equivalent wordings run the same operation', () => {
  it('five ways of asking who owes money produce one tool call with the same arguments', async () => {
    const seen = [];
    for (const message of ['Who owes us money?', "Which clients haven't paid?", 'Show outstanding customer payments.', 'Can you check our pending collections?', 'List the invoices that are still unpaid.']) {
      const { ctx } = session();
      const r = await send(ctx, message);
      seen.push({ intent: r.out.intent, params: r.out.decision.parameters, view: of(r, 'view')[0]?.view.title, text: texts(r) });
    }
    expect(new Set(seen.map((x) => JSON.stringify([x.intent, x.params, x.view, x.text]))).size).toBe(1);
    expect(seen[0]).toMatchObject({ intent: 'GET_OUTSTANDING_INVOICES', params: {}, view: 'Unpaid invoices' });
  });
});

describe('changes stay proposals', () => {
  it('a recognised change becomes a card through the same propose(), and writes nothing', async () => {
    const { ctx, db } = session();
    const model = countingModel();
    const r = await send(ctx, 'remind me to call Kite on Monday', { model });
    expect(model.calls).toBe(0);
    const [card] = of(r, 'card').map((e) => e.card);
    expect(card).toMatchObject({ tool: 'create_task', status: 'proposed', risk: 'low' });
    expect(store.get(card.action_id).args).toMatchObject({ title: 'Call Kite', deadline: '2026-09-28' });
    expect(businessWrites(db)).toEqual([]);
  });

  it('is written only when the person confirms it, through the usual confirm()', async () => {
    const { ctx, db } = session();
    const r = await send(ctx, 'mark the pricing task as done');
    const [card] = of(r, 'card').map((e) => e.card);
    expect(db.tables.tasks.find((t) => t.id === IDS.pricing).status).toBe('pending');
    const done = await confirm(ctx, card.action_id);
    expect(done.status).toBe('executed');
    expect(db.tables.tasks.find((t) => t.id === IDS.pricing).status).toBe('done');
  });

  it('a high-risk change is a high-risk card, however well it was understood', async () => {
    const { ctx, db } = session();
    const r = await send(ctx, 'INV-2026-0012 is settled');
    expect(of(r, 'card')[0].card).toMatchObject({ tool: 'mark_invoice_paid', risk: 'high', status: 'proposed' });
    expect(businessWrites(db)).toEqual([]);
  });

  it('lets the tool ask for what is missing, and for which record was meant', async () => {
    const { ctx } = session();
    expect(of(await send(ctx, 'record an expense'), 'input')[0].input.param).toBe('amount');
    const choice = of(await send(ctx, 'change the deadline of the report to the 10th'), 'choice')[0].choice;
    expect(choice.options.map((o) => o.label).sort()).toEqual(['Board meeting report', 'Q3 investor report']);
  });

  it('hands a change it cannot place to the model rather than reporting "not found"', async () => {
    const { ctx } = session();
    const model = countingModel();
    const r = await send(ctx, 'we lost the keys', { model });
    expect(model.calls).toBe(1);
    expect(r.out.route).toBe('llm');
    expect(of(r, 'notice')).toEqual([]);
  });
});

describe('permissions are enforced, not inferred from understanding', () => {
  it('refuses a read the role cannot make, without a model and without the data', async () => {
    const perms = structuredClone(OWNER_PERMS);
    delete perms.financial_documents;
    const { ctx, db } = session({ perms });
    const model = countingModel();
    const r = await send(ctx, 'who owes us money?', { model });
    expect(model.calls).toBe(0);
    expect(texts(r)).toMatch(/does not have access/);
    expect(of(r, 'view')).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('refuses a change the role cannot make, in the pipeline\'s own words', async () => {
    const perms = structuredClone(OWNER_PERMS);
    perms.tasks = { view: true, create: false, edit: false, delete: false };
    const { ctx, db } = session({ perms });
    const r = await send(ctx, 'mark the pricing task as done');
    expect(of(r, 'card')).toEqual([]);
    expect(of(r, 'notice')[0].text).toMatch(/Your role can't/);
    expect(businessWrites(db)).toEqual([]);
  });

  it('keeps money out of a shared space', async () => {
    const perms = { tasks: OWNER_PERMS.tasks, projects: OWNER_PERMS.projects, employees: OWNER_PERMS.employees };
    const { ctx } = session({ perms, session: { audience: 'shared', channel: 'telegram' } });
    const model = countingModel();
    const r = await send(ctx, 'show unpaid invoices', { model });
    expect(model.calls).toBe(0);
    expect(texts(r)).toMatch(/private chat/);
    expect(of(r, 'view')).toEqual([]);
    // Work is fine there.
    expect(texts(await send(ctx, 'overdue tasks'))).toMatch(/2 overdue tasks/);
  });

  it('answers only from what the caller\'s own client returns', async () => {
    // Another company's rows are simply not in this person's view (RLS).
    const seed = worldSeed();
    const other = { ...seed.financial_documents[0], id: '99999999-0000-4000-8000-000000000001', org_id: 'org-2', bill_to_name: 'Other Co', grand_total: 999999, amount_paid: 0, status: 'sent', due_date: '2026-01-01' };
    const visible = fakeDb(seed);
    const { ctx } = session({ db: visible });
    const r = await send(ctx, 'who owes us money?');
    expect(texts(r)).not.toMatch(/Other Co|9,99,999/);
    expect(JSON.stringify(of(r, 'view'))).not.toContain(other.id);
    // …and nothing was read with the service role.
    expect(adminCalls).toEqual([]);
  });

  it('re-validates arguments a client sends back with a chip', async () => {
    const { ctx, db } = session();
    const events = [];
    await runResume(ctx, {
      tool: 'local:GET_OUTSTANDING_INVOICES', param: 'intent', value: 'DELETE_TASK',
      args: { _options: [{ value: 'DELETE_TASK', label: 'x', args: { task: IDS.pricing, unpaid: false, anything: 'else' } }] },
    }, (event, data) => events.push({ event, ...data }), { chatId: 'c', messageId: 'm' });
    // A chip may choose an intent, but a delete is still only a high-risk card.
    expect(db.tables.tasks.some((t) => t.id === IDS.pricing)).toBe(true);
    expect(businessWrites(db)).toEqual([]);
    const card = events.find((e) => e.event === 'card')?.card;
    expect(card).toMatchObject({ tool: 'delete_task', risk: 'high', status: 'proposed' });
  });

  it('ignores a chip for an option that was never offered', async () => {
    const { ctx } = session();
    const events = [];
    await runResume(ctx, { tool: 'local:GET_OUTSTANDING_INVOICES', param: 'intent', value: 'CREATE_TASK', args: { _options: [] } }, (event, data) => events.push({ event, ...data }), {});
    expect(events.find((e) => e.event === 'notice').text).toMatch(/no longer available/);
  });
});

describe('empty results and failures', () => {
  it('says plainly when there is nothing', async () => {
    const seed = worldSeed();
    seed.financial_documents = [];
    seed.tasks = [];
    const { ctx } = session({ db: fakeDb(seed) });
    expect(texts(await send(ctx, 'who owes us money?'))).toMatch(/No unpaid invoices\. Nobody owes you anything right now\./);
    expect(texts(await send(ctx, 'overdue tasks'))).toMatch(/No overdue tasks/);
    expect(texts(await send(ctx, 'show my tasks'))).toMatch(/No open tasks on your plate/);
  });

  it('uses the singular and the plural correctly', async () => {
    const { ctx } = session();
    expect(texts(await send(ctx, 'unpaid invoices'))).toMatch(/\*\*1 unpaid invoice\*\*/);
    expect(texts(await send(ctx, 'overdue tasks'))).toMatch(/\*\*2 overdue tasks\*\*/);
  });

  it('reports a query that failed as a failure, never as an empty result', async () => {
    const db = fakeDb(worldSeed());
    const from = db.from;
    const failing = () => { const q = new Proxy({}, { get: (_t, k) => (k === 'then' ? (res) => res({ data: null, error: { message: 'connection reset' } }) : () => q) }); return q; };
    db.from = (table) => (table === 'financial_documents' ? failing() : from(table));
    const { ctx, logged } = session({ db });
    const model = countingModel();
    const r = await send(ctx, 'show draft invoices', { model });
    expect(model.calls).toBe(0);
    expect(texts(r)).toMatch(/Could not read documents just now/);
    expect(texts(r)).not.toMatch(/No draft/);
    expect(logged.at(-1)).toMatchObject({ ok: false, error_kind: 'tool_failed' });
  });
});

describe('when the model is needed', () => {
  it('passes the message through untouched', async () => {
    const { ctx } = session();
    const seen = [];
    const model = async ({ messages }) => { seen.push(messages.at(-1).content); return { message: { role: 'assistant', content: 'Because rent doubled.' } }; };
    const r = await runChatCollect(ctx, 'why are expenses up this month?', model);
    expect(seen).toEqual(['why are expenses up this month?']);
    expect(r.out).toMatchObject({ route: 'llm', intent: 'ADVICE' });
    expect(texts(r)).toBe('Because rent doubled.');
  });

  it('meters only a message that reaches the model', async () => {
    const { ctx } = session();
    const gate = vi.fn(async () => null);
    await send(ctx, 'who owes us money?', { gate });
    expect(gate).not.toHaveBeenCalled();
    await send(ctx, 'should we hire a developer?', { gate });
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('at the plan limit, the model is refused and local answers still work', async () => {
    const { ctx } = session();
    const model = countingModel();
    const gate = async () => ({ blocked: true, message: 'Your plan\'s AI message limit (10) has been reached.' });
    const blocked = await send(ctx, 'should we hire a developer?', { model, gate });
    expect(model.calls).toBe(0);
    expect(of(blocked, 'notice')[0].text).toMatch(/limit \(10\)/);
    expect(texts(await send(ctx, 'who owes us money?', { model, gate }))).toMatch(/1 unpaid invoice/);
  });

  it('says so when the model cannot be reached, and invents nothing', async () => {
    const { ctx, logged } = session();
    const down = async () => { const e = new Error('AI provider error 503'); e.status = 503; throw e; };
    const r = await send(ctx, 'should we hire a developer?', { model: Object.assign(down, { calls: 0 }) });
    expect(r.error).toMatchObject({ status: 503, explained: true });
    expect(texts(r)).toMatch(/could not reach the AI service.*not guessed/s);
    expect(texts(r)).toMatch(/who owes us money/);
    expect(logged.at(-1)).toMatchObject({ route: 'llm', ok: false, error_kind: 'model_failed' });
  });

  it('a model that never answers is abandoned at the timeout', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const hang = (_url, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
    await expect(callModel({ messages: [{ role: 'user', content: 'x' }], fetchImpl: hang, timeoutMs: 30 })).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('a malformed reply is a failure, not an empty answer', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const html = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    const noChoices = async () => ({ ok: true, status: 200, json: async () => ({ error: { message: 'upstream overloaded' } }) });
    await expect(callModel({ messages: [], fetchImpl: html })).rejects.toThrow(/malformed/);
    await expect(callModel({ messages: [], fetchImpl: noChoices })).rejects.toMatchObject({ status: 502, detail: 'upstream overloaded' });
  });

  it('a timed-out turn tells the person and is logged as a timeout', async () => {
    const { ctx, logged } = session();
    const slow = async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); };
    const r = await send(ctx, 'what do you think about our pricing?', { model: Object.assign(slow, { calls: 0 }) });
    expect(texts(r)).toMatch(/could not reach the AI service/);
    expect(logged.at(-1).error_kind).toBe('model_timeout');
  });
});

async function runChatCollect(ctx, message, model) {
  const events = [];
  const out = await runChat(ctx, { message, chatId: 'c', messageId: 'm' }, (event, data) => events.push({ event, ...data }), { callModelImpl: model, router: 'on' });
  return { out, events };
}

describe('clarifying instead of guessing', () => {
  it('confirms a reading it is not sure of, and runs it on yes', async () => {
    const { ctx } = session();
    const model = countingModel();
    const asked = await send(ctx, 'show unpaid invoices sorted by amount', { model });
    const { input } = of(asked, 'input')[0];
    expect(input.question).toMatch(/I read that as \*\*unpaid invoices\*\*/);
    expect(input.options.map((o) => o.label)).toEqual(['Yes, unpaid invoices', 'No, something else']);
    expect(model.calls).toBe(0);

    // The typed answer comes back with the open question, as the clients send it.
    ctx.pending = { ...input.resume, param: input.param, question: input.question };
    const yes = await send(ctx, 'yes', { model });
    expect(model.calls).toBe(0);
    expect(texts(yes)).toMatch(/1 unpaid invoice/);
  });

  it('on "no", hands the ORIGINAL request to the model', async () => {
    const { ctx } = session();
    const asked = await send(ctx, 'show unpaid invoices sorted by amount');
    const { input } = of(asked, 'input')[0];
    ctx.pending = { ...input.resume, param: input.param, question: input.question };
    const seen = [];
    const model = async ({ messages }) => { seen.push(messages.at(-1).content); return { message: { role: 'assistant', content: 'Sorted.' } }; };
    await runChatCollect(ctx, 'no', model);
    expect(seen).toEqual(['show unpaid invoices sorted by amount']);
  });

  it('a tapped chip finishes the question with no model', async () => {
    const { ctx } = session();
    const asked = await send(ctx, 'tell me about Acme');
    const { input } = of(asked, 'input')[0];
    const client = input.options.find((o) => o.label === 'Acme Corp (client)');
    const events = [];
    await runResume(ctx, { ...input.resume, param: input.param, value: client.value }, (event, data) => events.push({ event, ...data }), {});
    expect(events.find((e) => e.event === 'text').text).toMatch(/\*\*Acme Corp\*\* — deal stage, contact John Mathew, john@acme\.com/);
  });

  it('an answer to a tool\'s own question goes back into that tool', async () => {
    const { ctx, db } = session();
    const asked = await send(ctx, 'record an expense');
    const { input } = of(asked, 'input')[0];
    ctx.pending = { ...input.resume, param: input.param, question: input.question };
    const model = countingModel();
    const next = await send(ctx, '4,500', { model });
    expect(model.calls).toBe(0);
    // The next thing the cash book needs, or the card — never a write.
    expect(next.events.some((e) => ['input', 'choice', 'card'].includes(e.event))).toBe(true);
    expect(businessWrites(db)).toEqual([]);
  });

  it('a new request in the middle of a question is read as itself', async () => {
    const { ctx } = session();
    const asked = await send(ctx, 'record an expense');
    const { input } = of(asked, 'input')[0];
    ctx.pending = { ...input.resume, param: input.param, question: input.question };
    expect(texts(await send(ctx, 'show unpaid invoices'))).toMatch(/1 unpaid invoice/);
  });

  it('"never mind" drops the question, with nothing changed', async () => {
    const { ctx, db } = session();
    const asked = await send(ctx, 'record an expense');
    const { input } = of(asked, 'input')[0];
    ctx.pending = { ...input.resume, param: input.param, question: input.question };
    const model = countingModel();
    expect(texts(await send(ctx, 'never mind', { model }))).toMatch(/Nothing was changed/);
    expect(model.calls).toBe(0);
    expect(businessWrites(db)).toEqual([]);
  });
});

describe('follow-ups across turns', () => {
  it('"what about last month?" is read against the memo the last answer left', async () => {
    const { ctx } = session();
    const first = await send(ctx, 'how much did we spend this month?');
    const memo = of(first, 'route')[0].memo;
    expect(memo).toMatchObject({ intent: 'GET_EXPENSE_SUMMARY', period: { from: '2026-09-01', to: '2026-09-30' } });
    // The memo carries no words of the message.
    expect(JSON.stringify(memo)).not.toMatch(/spend|how much/);
    ctx.lastRoute = memo;
    const model = countingModel();
    const next = await send(ctx, 'what about last month?', { model });
    expect(model.calls).toBe(0);
    expect(next.out.decision.parameters).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
    expect(texts(next)).toMatch(/last month/);
  });
});

describe('the cofounder changes the wording and nothing else', () => {
  it('same intent, arguments, figures and view for Steve, Elon and Mark', async () => {
    const runs = [];
    for (const persona of ['steve', 'elon', 'mark']) {
      const { ctx } = session({ session: { persona } });
      const r = await send(ctx, 'overdue tasks');
      runs.push({ intent: r.out.intent, params: r.out.decision.parameters, view: of(r, 'view')[0].view, text: texts(r) });
    }
    expect(new Set(runs.map((r) => JSON.stringify([r.intent, r.params, r.view]))).size).toBe(1);
    for (const r of runs) expect(r.text).toMatch(/^\*\*2 overdue tasks\*\*\./);
    expect(new Set(runs.map((r) => r.text)).size).toBe(3);
  });

  it('each greets as themselves', async () => {
    const hello = async (persona) => texts(await send(session({ session: { persona } }).ctx, 'hi'));
    expect(await hello('steve')).toMatch(/^Steve here/);
    expect(await hello('elon')).toMatch(/Elon/);
    expect(await hello('mark')).toMatch(/Mark/);
    expect(await hello('steve')).not.toMatch(/Elon|Mark/);
  });
});

describe('channels', () => {
  it('a spoken answer has no list and no markdown', async () => {
    const { ctx } = session({ session: { voice: true, channel: 'voice' } });
    const r = await send(ctx, 'who owes us money\n\nAnswer in two short spoken sentences.');
    expect(of(r, 'view')).toEqual([]);
    expect(texts(r)).toBe('1 unpaid invoice, ₹1,00,000.00 to collect. None overdue yet.');
  });

  it('a typed yes with a card open is told to tap; a card is withdrawn on "scrap that"', async () => {
    const { ctx } = session();
    const proposed = await send(ctx, 'remind me to call Kite on Monday');
    const card = of(proposed, 'card')[0].card;
    ctx.openCards = [{ action_id: card.action_id, title: card.title, risk: card.risk }];
    const model = countingModel();
    expect(texts(await send(ctx, 'yes', { model }))).toMatch(/Tap the button on the card/);
    const dropped = await send(ctx, 'scrap that', { model });
    expect(of(dropped, 'card_update')[0].card.status).toBe('cancelled');
    expect(model.calls).toBe(0);
  });

  it('Buddy\'s own scheduled work and Daily Pulse replies are never read locally', async () => {
    const job = session({ session: { autonomy: { trigger: 'job', policy: {} } } });
    const model = countingModel();
    await send(job.ctx, 'who owes us money?', { model });
    expect(model.calls).toBe(1);
    const pulse = session({ session: { source: 'pulse:abc' } });
    await send(pulse.ctx, 'overdue tasks', { model });
    expect(model.calls).toBe(2);
  });
});

describe('the switch', () => {
  it('off: every message goes to the model, as before', async () => {
    const { ctx } = session();
    const model = countingModel();
    const r = await send(ctx, 'who owes us money?', { model, router: 'off' });
    expect(model.calls).toBe(1);
    expect(r.out.route).toBe('llm');
  });

  it('shadow: decides and logs, but the model still answers', async () => {
    const { ctx, logged } = session();
    const model = countingModel();
    await send(ctx, 'who owes us money?', { model, router: 'shadow' });
    expect(model.calls).toBe(1);
    expect(logged[0]).toMatchObject({ route: 'shadow', intent: 'GET_OUTSTANDING_INVOICES', reason_code: 'local' });
  });

  it('reads its mode from the environment, defaulting to on', () => {
    expect([routerMode(null), routerMode('off'), routerMode('shadow'), routerMode('ON'), routerMode('false')]).toEqual(['on', 'off', 'shadow', 'on', 'off']);
  });

  it('a fault inside the router falls back to the model instead of failing the turn', async () => {
    const { ctx } = session();
    // Something only the router reads breaks.
    Object.defineProperty(ctx, 'lastRoute', { get() { throw new Error('boom'); } });
    const model = countingModel();
    const r = await send(ctx, 'who owes us money?', { model });
    expect(r.error).toBe(null);
    expect(model.calls).toBe(1);
  });
});

describe('what is logged', () => {
  it('records the decision and never the message', async () => {
    const { ctx, logged } = session();
    await send(ctx, 'show me the unpiad invioces for Zephyr Retail worth 1 lakh');
    await send(ctx, 'why is Zephyr Retail late on INV-2026-0012?');
    expect(logged).toHaveLength(2);
    const dump = JSON.stringify(logged);
    expect(dump).not.toMatch(/zephyr|retail|lakh|INV-2026|unpiad|invioces|why/i);
    expect(Object.keys(logged[0]).sort()).toEqual(['channel', 'clarified', 'confidence', 'corrected_to', 'error_kind', 'intent', 'latency_ms', 'llm_used', 'ok', 'org_id', 'reason_code', 'route', 'signature', 'tokens', 'user_id']);
    expect(logged[1]).toMatchObject({ route: 'llm', llm_used: true });
  });

  it('records the intent a person chose when asked, as the correction', async () => {
    const { ctx, logged } = session();
    const asked = await send(ctx, 'pending');
    const { input } = of(asked, 'input')[0];
    await runResume(ctx, { ...input.resume, param: input.param, value: 'GET_OUTSTANDING_INVOICES' }, () => {}, {});
    expect(logged.at(-1)).toMatchObject({ route: 'local', intent: 'GET_OUTSTANDING_INVOICES', corrected_to: 'GET_OUTSTANDING_INVOICES', reason_code: 'chip' });
  });
});
