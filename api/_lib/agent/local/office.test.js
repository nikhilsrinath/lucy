import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeDb } from '../testing/fakeDb.js';
import { worldSeed, IDS } from '../../../../scripts/eval-agent.world.js';

/**
 * The rest of the office, asked for in chat: an NDA, the catalogue, a
 * document emailed to its client, and the company's own profile.
 */

const store = new Map();
vi.mock('../actions.js', async (importOriginal) => {
  const real = await importOriginal();
  let n = 0;
  return {
    ...real,
    countPending: async (_ctx, chatId) => [...store.values()].filter((r) => r.chat_id === chatId && real.effectiveStatus(r) === 'proposed').length,
    insertProposal: async (ctx, { chatId, messageId, tool, args, targets, preview }) => {
      const id = `eeeeeeee-0000-4000-8000-${String(++n).padStart(12, '0')}`;
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

const minted = [];
const mailed = [];
vi.mock('../../portalLink.js', () => ({
  canMintLinks: () => true,
  mintPortalLink: async (input) => { minted.push(input); return { url: `https://app.test/portal/${input.documentId}?t=tok`, expiresAt: '2026-10-26T00:00:00Z' }; },
}));
vi.mock('../../mailer.js', () => ({
  sendOrgMail: async (input) => { mailed.push(input); return { messageId: 'm-1', accepted: [input.to] }; },
  emailConfigured: async () => true,
  isEmailAddress: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()),
}));

const { confirm } = await import('../pipeline.js');
const { evalCtx, send, countingModel } = await import('./evaluate.js');

beforeEach(() => { store.clear(); minted.length = 0; mailed.length = 0; });

let serial = 0;
function session(seedOver = {}) {
  const db = fakeDb({ ...worldSeed(), records: [], ...seedOver }, {
    rpc: { next_document_number: ({ p_type }) => `${String(p_type).toUpperCase()}-2026-${String(++serial).padStart(4, '0')}` },
  });
  const world = evalCtx({ db, perms: undefined });
  world.ctx.perms.organizations = { view: true, create: false, edit: true, delete: false };
  delete world.ctx.actionStore;
  world.model = countingModel();
  return world;
}

const of = (r, event) => r.events.filter((e) => e.event === event);
const asked = (r) => of(r, 'input')[0]?.input || null;
const cardOf = (r) => of(r, 'card')[0]?.card || null;
const noticeOf = (r) => of(r, 'notice')[0] || null;
const businessWrites = (db) => db.writes.filter((w) => w.op !== 'rpc');

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

describe('an NDA', () => {
  it('asks who it is with, their address, what it covers and from when', async () => {
    const world = session();
    const turns = await talk(world, 'create an NDA', ['Orbit Tech Pvt Ltd', '14 Residency Road, Bengaluru 560025', 'Evaluating a joint product pilot', 'today']);
    expect(world.model.calls).toBe(0);
    expect(turns.slice(0, 4).map((t) => asked(t)?.param)).toEqual(['counterparty', 'address', 'purpose', 'effective_date']);
    const card = cardOf(turns.at(-1));
    expect(card).toMatchObject({ tool: 'create_nda', status: 'proposed', risk: 'high' });
    expect(businessWrites(world.db)).toEqual([]);
  });

  it('for a client, uses the client\'s own name and saves the letter the form\'s way', async () => {
    const world = session({ clients: worldSeed().clients.map((c) => (c.id === IDS.kite ? { ...c, address: '7 Lake View, Pune' } : c)) });
    const turns = await talk(world, 'create an NDA with Kite', ['skip', 'today']);
    // The address is on the client record, so it is not asked for.
    expect(turns.slice(0, 2).map((t) => asked(t)?.param)).toEqual(['purpose', 'effective_date']);
    const done = await confirm(world.ctx, cardOf(turns.at(-1)).action_id);
    expect(done.status).toBe('executed');
    const [row] = world.db.tables.records;
    expect(row).toMatchObject({ org_id: 'org-1', type: 'nda', title: 'Test Co & Kite Labs', recipient_name: 'Kite Labs', recipient_email: 'priya@kite.io' });
    expect(row.doc_number).toMatch(/^NDA-2026-/);
    expect(row.data).toMatchObject({
      effectiveDate: '2026-09-26', disclosingPartyName: 'Test Co', receivingPartyName: 'Kite Labs', receivingPartyAddress: '7 Lake View, Pune',
      receivingPartyIncorporation: 'India', obligationYears: '5', nonSolicitationYears: '1',
    });
  });

  it('is a draft until the places and the signatory are filled in', async () => {
    const world = session();
    const turns = await talk(world, 'create an NDA with Orbit Tech', ['14 Residency Road, Bengaluru', 'skip', 'today']);
    const card = cardOf(turns.at(-1));
    expect(card.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['city', 'state', 'signatory_name', 'signatory_title']));
    const done = await confirm(world.ctx, card.action_id);
    expect(world.db.tables.records[0].status).toBe('draft');
    expect(done.card.summary).toMatch(/draft/i);
  });

  it('is ready once the card has them', async () => {
    const world = session();
    const turns = await talk(world, 'create an NDA with Orbit Tech', ['14 Residency Road, Bengaluru', 'skip', 'today']);
    await confirm(world.ctx, cardOf(turns.at(-1)).action_id, { edits: { city: 'Bengaluru', state: 'Karnataka', signatory_name: 'Meera Iyer', signatory_title: 'Director' } });
    expect(world.db.tables.records[0]).toMatchObject({ status: 'pending' });
    expect(world.db.tables.records[0].data).toMatchObject({ executionCity: 'Bengaluru', arbitrationCity: 'Bengaluru', receivingSignatoryName: 'Meera Iyer' });
  });

  it('refuses at the plan limit', async () => {
    const world = session({ usage_counters: [{ org_id: 'org-1', nda: 1 }] });
    world.ctx.plan = 'free';
    const turns = await talk(world, 'create an NDA with Orbit Tech', ['14 Residency Road, Bengaluru', 'skip', 'today']);
    expect(cardOf(turns.at(-1))).toBeNull();
    expect(noticeOf(turns.at(-1)).text).toMatch(/plan/i);
  });
});

describe('the catalogue', () => {
  it('asks for the name, the price and the GST rate', async () => {
    const world = session();
    const turns = await talk(world, 'add a new product', ['Website audit', '45k', '18']);
    expect(world.model.calls).toBe(0);
    expect(turns.slice(0, 3).map((t) => asked(t)?.param)).toEqual(['name', 'price', 'tax_rate']);
    expect(asked(turns[2]).options.map((o) => o.value)).toEqual(['0', '5', '12', '18', '28']);
    const card = cardOf(turns.at(-1));
    expect(card).toMatchObject({ tool: 'create_catalog_item', status: 'proposed' });
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.catalog_items.find((i) => i.name === 'Website audit')).toMatchObject({ org_id: 'org-1', unit_price: 45000, tax_rate: 18, unit: 'Nos' });
  });

  it('reads the name and price from one sentence', async () => {
    const world = session();
    const [r] = await talk(world, 'add Logo design to the catalogue at 25k');
    expect(asked(r)).toMatchObject({ param: 'tax_rate' });
    expect(asked(r).resume.args).toMatchObject({ name: 'Logo design', price: '25k' });
  });

  it('will not add the same item twice', async () => {
    const world = session();
    const turns = await talk(world, 'add a new product', ['Support retainer', '20k', '18']);
    expect(cardOf(turns.at(-1))).toBeNull();
    expect(noticeOf(turns.at(-1)).text).toMatch(/already/i);
  });

  it('changes a price as a diff', async () => {
    const world = session({ catalog_items: [{ id: '90000000-0000-4000-8000-000000000001', org_id: 'org-1', name: 'Support retainer', unit_price: 20000, unit: 'Month', hsn_sac: '998313', tax_rate: 18, archived_at: null, updated_at: '2026-09-01T09:00:00.000000+00:00' }] });
    const [r] = await talk(world, 'change the price of Support retainer to 25k');
    const card = cardOf(r);
    expect(card).toMatchObject({ tool: 'update_catalog_item' });
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.catalog_items[0].unit_price).toBe(25000);
  });
});

describe('emailing a document to its client', () => {
  it('shows the email on a card and sends nothing until it is confirmed', async () => {
    const world = session();
    const [r] = await talk(world, 'email INV-2026-0012 to the client');
    expect(world.model.calls).toBe(0);
    const card = cardOf(r);
    expect(card).toMatchObject({ tool: 'send_document_email', risk: 'high', status: 'proposed' });
    expect(card.email).toMatchObject({ to: 'accounts@zephyr.in' });
    expect(mailed).toEqual([]);
    expect(minted).toEqual([]);
  });

  it('on confirm, mints the client\'s link and mails it from the company', async () => {
    const world = session({ financial_documents: worldSeed().financial_documents.map((d) => (d.id === IDS.zephyrInv ? { ...d, bill_to_email: 'accounts@zephyr.in' } : d)) });
    const [r] = await talk(world, 'email INV-2026-0012 to the client');
    const done = await confirm(world.ctx, cardOf(r).action_id);
    expect(done.status).toBe('executed');
    expect(minted).toEqual([expect.objectContaining({ orgId: 'org-1', documentId: IDS.zephyrInv })]);
    expect(mailed[0]).toMatchObject({ to: 'accounts@zephyr.in' });
    expect(mailed[0].text).toContain('https://app.test/portal/');
    expect(mailed[0].subject).toMatch(/INV-2026-0012/);
  });

  it('finds a quotation by its client', async () => {
    const world = session();
    const [r] = await talk(world, 'send the Kite quote to the client');
    expect(store.get(cardOf(r).action_id).args).toMatchObject({ document: IDS.kiteQuote, to: 'priya@kite.io' });
  });

  it('takes an address said in the message', async () => {
    const world = session();
    const [r] = await talk(world, 'email INV-2026-0012 to billing@zephyr.in');
    expect(store.get(cardOf(r).action_id).args).toMatchObject({ to: 'billing@zephyr.in' });
  });

  it('will not send a draft, and offers to issue it first', async () => {
    const world = session();
    const [r] = await talk(world, 'email INV-2026-0013 to the client');
    expect(cardOf(r)).toBeNull();
    expect(noticeOf(r).text).toMatch(/draft/i);
    expect(noticeOf(r).offer).toMatchObject({ tool: 'issue_document' });
  });
});

describe('the company profile', () => {
  it('changes one plain detail as a diff card', async () => {
    const world = session();
    const [r] = await talk(world, 'change our address to 12 MG Road, Bengaluru 560001');
    expect(world.model.calls).toBe(0);
    const card = cardOf(r);
    expect(card).toMatchObject({ tool: 'update_company_profile', risk: 'high', status: 'proposed' });
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.organizations[0]).toMatchObject({ company_address: '12 MG Road, Bengaluru 560001' });
  });

  it('asks which detail, then for the new value', async () => {
    const world = session();
    const turns = await talk(world, 'update the company profile', ['Website', 'https://edgelabs.test']);
    expect(turns.slice(0, 2).map((t) => asked(t)?.param)).toEqual(['field', 'value']);
    expect(store.get(cardOf(turns.at(-1)).action_id).args).toMatchObject({ field: 'company_website', value: 'https://edgelabs.test' });
  });

  it('never touches banking, tax ids or credentials', async () => {
    const world = session();
    for (const message of ['change our GSTIN to 29ABCDE1234F1Z5', 'update our bank account to 1234567890', 'set our gmail app password to hunter2']) {
      const [r] = await talk(world, message);
      expect(cardOf(r), message).toBeNull();
    }
    expect(businessWrites(world.db)).toEqual([]);
  });

  it('is refused for a role that cannot edit the company', async () => {
    const world = session();
    world.ctx.perms.organizations = { view: true, create: false, edit: false, delete: false };
    const [r] = await talk(world, 'change our address to 12 MG Road');
    expect(cardOf(r)).toBeNull();
    expect(noticeOf(r).text).toMatch(/Your role can't/);
  });
});
