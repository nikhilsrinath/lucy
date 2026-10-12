import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDS } from '../../../../scripts/eval-agent.world.js';

// ai_actions lives in memory here, as in engine.test.js; everything else is real.
const store = new Map();
vi.mock('../actions.js', async (importOriginal) => {
  const real = await importOriginal();
  let n = 0;
  return {
    ...real,
    countPending: async (_ctx, chatId) => [...store.values()].filter((r) => r.chat_id === chatId && real.effectiveStatus(r) === 'proposed').length,
    insertProposal: async (ctx, { chatId, messageId, tool, args, targets, preview }) => {
      const id = `bbbbbbbb-0000-4000-8000-${String(++n).padStart(12, '0')}`;
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

const { confirm } = await import('../pipeline.js');
const { evalCtx, send, countingModel } = await import('./evaluate.js');

beforeEach(() => { store.clear(); });

function session(over = {}) {
  const world = evalCtx(over);
  delete world.ctx.actionStore;
  world.model = countingModel();
  return world;
}

const of = (r, event) => r.events.filter((e) => e.event === event);
const businessWrites = (db) => db.writes.filter((w) => w.op !== 'rpc');
const asked = (r) => of(r, 'input')[0]?.input || null;

/** The next message, sent the way a client does: with Buddy's open question attached. */
async function reply(world, previous, message) {
  const q = asked(previous);
  world.ctx.pending = q ? { tool: q.resume.tool, args: q.resume.args, param: q.param, question: q.question } : null;
  const r = await send(world.ctx, message, { model: world.model });
  world.ctx.pending = null;
  return r;
}

/** A whole conversation: the opener, then one answer per question. Returns every turn. */
async function talk(world, opener, answers) {
  const turns = [await send(world.ctx, opener, { model: world.model })];
  for (const a of answers) turns.push(await reply(world, turns.at(-1), a));
  return turns;
}

describe('adding an employee is asked for, one thing at a time, with no model', () => {
  it('starts asking instead of opening the Team page', async () => {
    const world = session();
    const r = await send(world.ctx, 'i want to add a new employee', { model: world.model });
    expect(world.model.calls).toBe(0);
    expect(of(r, 'navigate')).toEqual([]);
    expect(asked(r)).toMatchObject({ param: 'full_name' });
  });

  it('asks name, role, type, start date and pay, then shows one card and writes nothing', async () => {
    const world = session();
    const turns = await talk(world, 'add a new employee', ['Kiran Rao', 'Senior Finance Manager', 'full time', '1st Oct', '40k']);
    expect(world.model.calls).toBe(0);
    expect(turns.slice(0, 5).map((t) => asked(t)?.param)).toEqual(['full_name', 'role', 'employment_type', 'start_date', 'pay']);
    const [card] = of(turns.at(-1), 'card').map((e) => e.card);
    expect(card).toMatchObject({ tool: 'create_employee', status: 'proposed', risk: 'high' });
    expect(store.get(card.action_id).args).toMatchObject({
      full_name: 'Kiran Rao', role: 'Senior Finance Manager', employment_type: 'fulltime', start_date: '2026-10-01', pay: 40000,
    });
    expect(businessWrites(world.db)).toEqual([]);
  });

  it('offers the employment types as chips', async () => {
    const world = session();
    const turns = await talk(world, 'add a new employee', ['Kiran Rao', 'Designer']);
    expect(asked(turns.at(-1)).options.map((o) => o.value)).toEqual(['fulltime', 'intern', 'contract', 'parttime']);
  });

  it('creates the person and their pay only when the card is confirmed', async () => {
    const world = session();
    const turns = await talk(world, 'add a new employee', ['Kiran Rao', 'Designer', 'intern', 'today', '15000']);
    const [card] = of(turns.at(-1), 'card').map((e) => e.card);
    const done = await confirm(world.ctx, card.action_id);
    expect(done.status).toBe('executed');
    const row = world.db.tables.employees.find((e) => e.full_name === 'Kiran Rao');
    expect(row).toMatchObject({ org_id: 'org-1', role: 'Designer', employment_type: 'intern', start_date: '2026-09-26' });
    expect(world.db.tables.employee_compensation).toEqual([
      expect.objectContaining({ employee_id: row.id, org_id: 'org-1', is_paid: true, amount: 15000, payment_frequency: 'Monthly' }),
    ]);
    expect(done.card.followUp).toMatch(/offer letter for Kiran/i);
  });

  it('takes what the first message already said and asks only for the rest', async () => {
    const world = session();
    const r = await send(world.ctx, 'add Kiran Rao as an intern', { model: world.model });
    expect(asked(r)).toMatchObject({ param: 'role' });
    expect(asked(r).resume.args).toMatchObject({ full_name: 'Kiran Rao', employment_type: 'intern' });
  });

  it('lets an optional question be skipped', async () => {
    const world = session();
    const turns = await talk(world, 'add a new employee', ['Kiran Rao', 'Designer', 'contract', 'skip', 'no']);
    const [card] = of(turns.at(-1), 'card').map((e) => e.card);
    const args = store.get(card.action_id).args;
    expect(args.start_date ?? null).toBeNull();
    expect(args.pay ?? null).toBeNull();
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.employee_compensation || []).toEqual([]);
  });

  it('does not mistake an answer for a lookup', async () => {
    const world = session();
    // "tasks" and "finance" are words the reader knows; here they are a job title.
    const turns = await talk(world, 'add a new employee', ['Kiran Rao', 'Head of finance and tasks']);
    expect(world.model.calls).toBe(0);
    expect(of(turns.at(-1), 'view')).toEqual([]);
    expect(asked(turns.at(-1))).toMatchObject({ param: 'employment_type' });
    expect(asked(turns.at(-1)).resume.args).toMatchObject({ role: 'Head of finance and tasks' });
  });

  it('asks again when an answer cannot be read', async () => {
    const world = session();
    const turns = await talk(world, 'add a new employee', ['Kiran Rao', 'Designer', 'sometimes']);
    expect(asked(turns.at(-1))).toMatchObject({ param: 'employment_type' });
  });

  it('stops when the person says cancel', async () => {
    const world = session();
    const turns = await talk(world, 'add a new employee', ['Kiran Rao', 'cancel']);
    expect(of(turns.at(-1), 'card')).toEqual([]);
    expect(asked(turns.at(-1))).toBeNull();
    expect(world.model.calls).toBe(0);
  });

  it('refuses someone who is already on the team', async () => {
    const world = session();
    const turns = await talk(world, 'add a new employee', ['Ravi Kumar', 'Sales', 'full time', 'skip', 'skip']);
    expect(of(turns.at(-1), 'card')).toEqual([]);
    expect(of(turns.at(-1), 'notice')[0].text).toMatch(/already on the team/i);
  });

  it('is refused for a role that cannot add people, without a model', async () => {
    const world = session();
    world.ctx.perms.employees = { view: true, create: false, edit: false, delete: false };
    const r = await send(world.ctx, 'add a new employee', { model: world.model });
    expect(world.model.calls).toBe(0);
    expect(of(r, 'notice')[0].text).toMatch(/Your role can't/);
  });
});

describe('changing a team member', () => {
  it('proposes the change as a diff card', async () => {
    const world = session();
    const r = await send(world.ctx, "change Ravi's role to Sales Lead", { model: world.model });
    expect(world.model.calls).toBe(0);
    const [card] = of(r, 'card').map((e) => e.card);
    expect(card).toMatchObject({ tool: 'update_employee', status: 'proposed' });
    expect(store.get(card.action_id).args).toMatchObject({ person: IDS.ravi, role: 'Sales Lead' });
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.employees.find((e) => e.id === IDS.ravi).role).toBe('Sales Lead');
  });

  it('says so when nothing would change', async () => {
    const world = session();
    const r = await send(world.ctx, "change Ravi's role to Sales", { model: world.model });
    expect(of(r, 'card')).toEqual([]);
    expect(of(r, 'notice')[0].text).toMatch(/already/i);
  });
});
