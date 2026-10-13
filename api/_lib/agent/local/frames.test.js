import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeDb } from '../testing/fakeDb.js';
import { worldSeed, IDS, TODAY } from '../../../../scripts/eval-agent.world.js';

/**
 * Meaning frames: a sentence is understood from its parts — the action, the
 * kind of thing, which one, the details — not by matching a whole sentence.
 * So the same request said many ways reads the same, with no model.
 */

const store = new Map();
vi.mock('../actions.js', async (importOriginal) => {
  const real = await importOriginal();
  let n = 0;
  return {
    ...real,
    countPending: async (_ctx, chatId) => [...store.values()].filter((r) => r.chat_id === chatId && real.effectiveStatus(r) === 'proposed').length,
    insertProposal: async (ctx, { chatId, messageId, tool, args, targets, preview }) => {
      const id = `ffffffff-0000-4000-8000-${String(++n).padStart(12, '0')}`;
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
const { understand } = await import('./understand.js');
const { resolveName } = await import('./engine.js');

beforeEach(() => { store.clear(); });

const ITEM = '90000000-0000-4000-8000-000000000001';
const seed = () => ({
  ...worldSeed(),
  catalog_items: [{ id: ITEM, org_id: 'org-1', name: 'Support retainer', unit_price: 20000, unit: 'Month', hsn_sac: '998313', tax_rate: 18, archived_at: null, updated_at: '2026-09-01T09:00:00.000000+00:00' }],
  buddy_learned_phrasings: [],
});

function session() {
  const world = evalCtx({ db: fakeDb(seed()) });
  delete world.ctx.actionStore;
  world.model = countingModel();
  return world;
}

const of = (r, event) => r.events.filter((e) => e.event === event);
const asked = (r) => of(r, 'input')[0]?.input || null;
const cardOf = (r) => of(r, 'card')[0]?.card || null;
const textOf = (r) => of(r, 'text').map((e) => e.text).join('\n');

async function talk(world, opener, answers = []) {
  const turns = [await send(world.ctx, opener, { model: world.model })];
  for (const a of answers) {
    const q = asked(turns.at(-1));
    world.ctx.pending = q ? { tool: q.resume.tool, args: q.resume.args, param: q.param, question: q.question } : null;
    turns.push(await send(world.ctx, a, { model: world.model }));
    world.ctx.pending = null;
  }
  return turns;
}

const reader = (() => {
  const { ctx } = evalCtx({ db: fakeDb(seed()) });
  const env = {
    today: TODAY, pending: null, openCards: [], lastRoute: null, hasOpenInvoices: async () => false,
    resolve: (text, kinds, opts) => resolveName(ctx, text, kinds, { across: opts?.across ?? kinds.length > 3 }),
  };
  return (message) => understand(message, env);
})();

describe('the sentences that were reported', () => {
  it('"I want to fire an employee" asks who, instead of showing the team', async () => {
    const world = session();
    const [r] = await talk(world, 'I want to fire an employee');
    expect(world.model.calls).toBe(0);
    expect(of(r, 'view')).toEqual([]);
    expect(asked(r)).toMatchObject({ param: 'person' });
    expect(asked(r).question).toMatch(/who/i);
  });

  it('removing someone records that they left, on confirm, and deletes nothing', async () => {
    const world = session();
    const turns = await talk(world, 'fire Ravi', ['today']);
    expect(asked(turns[0])).toMatchObject({ param: 'last_day' });
    const card = cardOf(turns.at(-1));
    expect(card).toMatchObject({ tool: 'offboard_employee', risk: 'high', status: 'proposed' });
    expect(world.db.tables.employees.find((e) => e.id === IDS.ravi).exited_at).toBeNull();
    await confirm(world.ctx, card.action_id);
    const ravi = world.db.tables.employees.find((e) => e.id === IDS.ravi);
    expect(ravi.exited_at).toMatch(/^2026-09-26/);
    expect(world.db.tables.employees).toHaveLength(4);
  });

  it('"what is my task" names the task', async () => {
    const world = session();
    const [r] = await talk(world, 'what is my task');
    expect(world.model.calls).toBe(0);
    expect(textOf(r)).toMatch(/Landing page copy/);
  });

  it('"I want to remove an item name from my catalogue items" asks which item', async () => {
    const world = session();
    const [r] = await talk(world, 'I want to remove an item name from my catalogue items');
    expect(world.model.calls).toBe(0);
    expect(asked(r)).toMatchObject({ param: 'item' });
    expect(asked(r).options.map((o) => o.label)).toEqual(['Support retainer']);
  });

  it('removing a catalogue item archives it on confirm', async () => {
    const world = session();
    const [r] = await talk(world, 'delete Support retainer from the catalogue');
    const card = cardOf(r);
    expect(card).toMatchObject({ tool: 'archive_catalog_item', status: 'proposed' });
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.catalog_items[0].archived_at).toBeTruthy();
  });
});

describe('the same request, said many ways, reads the same', () => {
  const suites = [];
  const cross = (intent, prefixes, verbs, objects, check = null) => {
    for (const p of prefixes) for (const v of verbs) for (const o of objects) suites.push([`${p}${v} ${o}`.trim(), intent, check]);
  };
  const WISH = ['', 'i want to ', 'please ', 'can you ', 'i need to ', 'pls ', 'we have to ', 'i would like to ', 'kindly ', 'can u pls '];

  cross('OFFBOARD_EMPLOYEE', WISH, ['fire', 'remove', 'terminate', 'sack', 'offboard', 'get rid of', 'lay off', 'dismiss', 'let go of'],
    ['an employee', 'a team member', 'someone from the team', 'one of my staff', 'a guy from my team', 'an employee from the company', 'a person from my team']);
  cross('OFFBOARD_EMPLOYEE', WISH, ['fire', 'remove', 'terminate', 'sack', 'offboard', 'get rid of', 'dismiss'], ['Ravi', 'Ravi Kumar', 'Ravi from the team'], (d) => /ravi/i.test(d.parameters.person || ''));
  cross('OFFBOARD_EMPLOYEE', [''], ['Ravi'], ['has left', 'has left the company', 'resigned', 'quit', 'is leaving the company', 'has resigned', 'left us', 'no longer works here'], (d) => /ravi/i.test(d.parameters.person || ''));
  cross('CREATE_EMPLOYEE', WISH, ['add', 'hire', 'onboard', 'create', 'register', 'bring on'],
    ['a new employee', 'a team member', 'one more person to my team', 'a new joinee', 'an intern', 'someone to the team', 'a new hire', 'one more guy to my team', 'a new staff member']);
  cross('ARCHIVE_CATALOG_ITEM', WISH, ['remove', 'delete', 'archive', 'get rid of', 'take out', 'drop'],
    ['a product', 'an item from the catalogue', 'a catalogue item', 'an item from my price list', 'one of my products', 'an item name from my catalogue items']);
  cross('ARCHIVE_CATALOG_ITEM', WISH, ['remove', 'delete', 'archive', 'take'], ['Support retainer from the catalogue', 'Support retainer off the price list', 'the Support retainer product'], (d) => /support retainer/i.test(d.parameters.item || ''));
  cross('ARCHIVE_VENDOR', WISH, ['remove', 'delete', 'archive', 'drop', 'get rid of'], ['the Dell vendor', 'Dell India from vendors', 'vendor Dell India', 'the supplier Dell India'], (d) => /dell/i.test(d.parameters.vendor || ''));
  cross('CREATE_CATALOG_ITEM', WISH, ['add', 'create', 'register'], ['a product', 'a new item to the catalogue', 'a catalogue item', 'a new service', 'something to my price list']);
  cross('DELETE_TASK', WISH, ['delete', 'remove', 'get rid of', 'scrap'], ['the pricing task', 'the task about pricing', 'task pricing'], (d) => /pricing/i.test(d.parameters.task || ''));

  it('is a suite large enough to mean something', () => {
    expect(suites.length).toBeGreaterThan(1500);
  });

  it('at least 97% of the generated sentences read as the intended action', async () => {
    const misses = [];
    for (const [say, intent, check] of suites) {
      const d = await reader(say);
      const ok = d.executionRoute === 'local' && d.intent === intent && (!check || check(d));
      if (!ok) misses.push(`${say} → ${d.executionRoute} ${d.intent} ${JSON.stringify(d.parameters)}`);
    }
    const rate = 1 - misses.length / suites.length;
    expect(rate, `${misses.length} of ${suites.length} missed, e.g.\n${misses.slice(0, 25).join('\n')}`).toBeGreaterThanOrEqual(0.97);
  }, 120_000);
});

describe('loose wording that used to reach the model', () => {
  it.each([
    ['can u pls add one more guy to my team', 'CREATE_EMPLOYEE', {}],
    ['onboard a new joinee', 'CREATE_EMPLOYEE', {}],
    ['need to bill acme', 'CREATE_INVOICE', { client: /acme/i }],
    ['bump the pricing task to tomorrow', 'UPDATE_TASK', { deadline: /tomorrow/i }],
    ['get rid of the Dell vendor', 'ARCHIVE_VENDOR', { vendor: /dell/i }],
    ['take support retainer off the price list', 'ARCHIVE_CATALOG_ITEM', { item: /support retainer/i }],
    ['show me what neha is working on', 'LIST_TASKS', { assignee: IDS.neha }],
    ['kindly let me know the pending work of ravi', 'LIST_TASKS', { assignee: IDS.ravi }],
    ['who all are there in my company', 'LIST_TEAM', {}],
    ['let Ravi go', 'OFFBOARD_EMPLOYEE', { person: /ravi/i }],
  ])('%s', async (message, intent, params) => {
    const d = await reader(message);
    expect(d, `${d.executionRoute} ${d.intent}`).toMatchObject({ executionRoute: 'local', intent });
    for (const [k, v] of Object.entries(params)) expect(String(d.parameters[k] ?? '')).toMatch(v instanceof RegExp ? v : new RegExp(`^${v}$`));
  });
});

describe('what it understands but cannot do, it says without a model', () => {
  it.each([
    ['delete the Acme website project', /can't delete projects/i],
    ['update our bank account number', /bank details/i],
    ['make Ravi an admin', /roles and permissions/i],
    ['add a new department', /departments/i],
  ])('%s', async (message, expected) => {
    const world = session();
    const [r] = await talk(world, message);
    expect(world.model.calls, textOf(r)).toBe(0);
    expect(textOf(r)).toMatch(expected);
    expect(of(r, 'navigate')).toHaveLength(1);
    expect(world.db.writes.filter((w) => w.op !== 'rpc')).toEqual([]);
  });
});

describe('what needs thinking still reaches the model', () => {
  it.each([
    'how do I fire an employee?',
    'should I fire Ravi?',
    'maybe we should remove the Dell vendor',
    'why would I remove a product?',
    'fire up the presentation for Acme',
    'remove',
    'what happens if I delete the pricing task?',
  ])('%s', async (message) => {
    const d = await reader(message);
    expect(d.executionRoute === 'llm' || d.readOnly !== false, `${message} → ${d.executionRoute} ${d.intent}`).toBe(true);
    expect(['OFFBOARD_EMPLOYEE', 'ARCHIVE_VENDOR', 'ARCHIVE_CATALOG_ITEM', 'DELETE_TASK']).not.toContain(d.executionRoute === 'local' ? d.intent : null);
  });
});

describe('it learns a company\'s own way of saying things', () => {
  const unsure = 'show unpaid invoices sorted by amount';

  it('asks the first times, then stops asking once the reading has been confirmed twice', async () => {
    const world = session();
    for (let round = 0; round < 2; round++) {
      const turns = await talk(world, unsure, ['yes']);
      expect(asked(turns[0]), `round ${round}`).toMatchObject({ param: 'intent' });
      expect(of(turns[1], 'view')).toHaveLength(1);
    }
    const [third] = await talk(world, unsure);
    expect(asked(third)).toBeNull();
    expect(of(third, 'view')).toHaveLength(1);
    expect(world.model.calls).toBe(0);
    // What is kept is the shape of the sentence, never its names or figures.
    expect(world.db.tables.buddy_learned_phrasings).toEqual([expect.objectContaining({ org_id: 'org-1', intent: 'GET_OUTSTANDING_INVOICES', confirmations: 2 })]);
  });

  it('forgets a reading the person says was wrong', async () => {
    const world = session();
    await talk(world, unsure, ['yes']);
    await talk(world, unsure, ['no']);
    expect(world.db.tables.buddy_learned_phrasings).toEqual([]);
  });

  it('works without the table', async () => {
    const world = evalCtx({ db: fakeDb(worldSeed(), { deny: { buddy_learned_phrasings: ['insert', 'update', 'delete'] } }) });
    const r = await send(world.ctx, unsure, { model: countingModel() });
    expect(asked(r)).toMatchObject({ param: 'intent' });
  });
});
