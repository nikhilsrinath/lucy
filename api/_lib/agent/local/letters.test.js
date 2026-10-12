import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeDb } from '../testing/fakeDb.js';
import { worldSeed, IDS } from '../../../../scripts/eval-agent.world.js';

// ai_actions lives in memory here, as in engine.test.js; everything else is real.
const store = new Map();
vi.mock('../actions.js', async (importOriginal) => {
  const real = await importOriginal();
  let n = 0;
  return {
    ...real,
    countPending: async (_ctx, chatId) => [...store.values()].filter((r) => r.chat_id === chatId && real.effectiveStatus(r) === 'proposed').length,
    insertProposal: async (ctx, { chatId, messageId, tool, args, targets, preview }) => {
      const id = `cccccccc-0000-4000-8000-${String(++n).padStart(12, '0')}`;
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

// Sending a letter mints a signing link and emails it: both leave the building.
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
  const db = fakeDb({ ...worldSeed(), records: [], employee_compensation: [], departments: [], ...seedOver }, {
    rpc: { next_document_number: ({ p_type }) => `${p_type === 'offer' ? 'OL' : 'DOC'}-2026-${String(++serial).padStart(4, '0')}` },
  });
  const world = evalCtx({ db });
  delete world.ctx.actionStore;
  world.model = countingModel();
  return world;
}

const of = (r, event) => r.events.filter((e) => e.event === event);
const asked = (r) => of(r, 'input')[0]?.input || null;
const businessWrites = (db) => db.writes.filter((w) => w.op !== 'rpc');

async function talk(world, opener, answers) {
  const turns = [await send(world.ctx, opener, { model: world.model })];
  for (const a of answers) {
    const q = asked(turns.at(-1));
    world.ctx.pending = q ? { tool: q.resume.tool, args: q.resume.args, param: q.param, question: q.question } : null;
    turns.push(await send(world.ctx, a, { model: world.model }));
    world.ctx.pending = null;
  }
  return turns;
}

describe('an offer letter is asked for in chat, not searched for in the library', () => {
  it('asks who it is for when nobody was named', async () => {
    const world = session();
    const r = await send(world.ctx, 'create an offer letter', { model: world.model });
    expect(world.model.calls).toBe(0);
    expect(of(r, 'view')).toEqual([]);
    expect(asked(r)).toMatchObject({ param: 'candidate' });
  });

  it('for someone on the team, uses what Team already knows and asks only for the rest', async () => {
    const world = session();
    const turns = await talk(world, 'create an offer letter for Ravi', ['full time', '50k', '1st Oct', 'skip']);
    expect(world.model.calls).toBe(0);
    // Ravi's job title is on his record, so it is not asked again.
    expect(turns.slice(0, 4).map((t) => asked(t)?.param)).toEqual(['offer_type', 'pay', 'start_date', 'reply_by']);
    const [card] = of(turns.at(-1), 'card').map((e) => e.card);
    expect(card).toMatchObject({ tool: 'create_offer_letter', status: 'proposed', risk: 'high' });
    expect(store.get(card.action_id).args).toMatchObject({ candidate: IDS.ravi, offer_type: 'fulltime', role: 'Sales', pay: 50000, start_date: '2026-10-01' });
    expect(businessWrites(world.db)).toEqual([]);
  });

  it('saves the letter in the shape the Team page and the PDF read', async () => {
    const world = session();
    const turns = await talk(world, 'create an offer letter for Ravi', ['full time', '50k', '1st Oct', 'in 7 days']);
    const [card] = of(turns.at(-1), 'card').map((e) => e.card);
    const done = await confirm(world.ctx, card.action_id);
    expect(done.status).toBe('executed');
    const [row] = world.db.tables.records;
    expect(row).toMatchObject({
      org_id: 'org-1', type: 'offer', title: 'Ravi Kumar', employee_id: IDS.ravi,
      recipient_name: 'Ravi Kumar', recipient_email: 'ravi@edge.test', issue_date: '2026-09-26',
    });
    expect(row.doc_number).toMatch(/^OL-2026-\d{4}$/);
    expect(row.data).toMatchObject({
      offerType: 'fulltime', studentName: 'Ravi Kumar', email: 'ravi@edge.test', role: 'Sales',
      startDate: '2026-10-01', acceptanceDeadline: '2026-10-03', isPaid: true, stipend: 50000, currency: 'INR', paymentFrequency: 'Monthly',
      companyName: 'Test Co',
    });
  });

  it('is a draft, and says what is missing, until the letter is complete', async () => {
    const world = session();
    const turns = await talk(world, 'create an offer letter for Ravi', ['full time', '50k', '1st Oct', 'skip']);
    const [card] = of(turns.at(-1), 'card').map((e) => e.card);
    const done = await confirm(world.ctx, card.action_id);
    expect(world.db.tables.records[0].status).toBe('draft');
    expect(done.card.summary).toMatch(/draft/i);
    expect(done.card.summary).toMatch(/address/i);
  });

  it('is ready to send once the card has the rest', async () => {
    const world = session();
    const turns = await talk(world, 'create an offer letter for Ravi', ['full time', '50k', '1st Oct', 'in 7 days']);
    const [card] = of(turns.at(-1), 'card').map((e) => e.card);
    expect(card.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['address', 'department', 'reports_to', 'responsibilities']));
    await confirm(world.ctx, card.action_id, { edits: { address: '12 MG Road, Bengaluru', department: 'Sales', reports_to: 'Arjun Mehta', responsibilities: 'Own the enterprise pipeline.' } });
    expect(world.db.tables.records[0]).toMatchObject({ status: 'pending' });
    expect(world.db.tables.records[0].data).toMatchObject({ studentAddress: '12 MG Road, Bengaluru', department: 'Sales', supervisorName: 'Arjun Mehta' });
  });

  it('for someone new, asks their job title too, and an internship its end date', async () => {
    const world = session();
    const turns = await talk(world, 'create an offer letter for Kiran Rao', ['internship', 'Design intern', '15000', '1st Oct', '31st Dec', 'skip']);
    expect(turns.slice(0, 6).map((t) => asked(t)?.param)).toEqual(['offer_type', 'role', 'pay', 'start_date', 'end_date', 'reply_by']);
    const [card] = of(turns.at(-1), 'card').map((e) => e.card);
    expect(store.get(card.action_id).args).toMatchObject({ candidate: 'Kiran Rao', offer_type: 'internship', role: 'Design intern', end_date: '2026-12-31' });
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.records[0]).toMatchObject({ employee_id: null, recipient_name: 'Kiran Rao' });
  });

  it('refuses at the plan limit', async () => {
    const world = session({ usage_counters: [{ org_id: 'org-1', offer_letters: 5 }] });
    world.ctx.plan = 'free';
    const turns = await talk(world, 'create an offer letter for Ravi', ['full time', '50k', '1st Oct', 'skip']);
    expect(of(turns.at(-1), 'card')).toEqual([]);
    expect(of(turns.at(-1), 'notice')[0].text).toMatch(/plan/i);
  });
});

describe('sending an offer letter', () => {
  const letter = (over = {}) => ({
    id: '70000000-0000-4000-8000-000000000001', org_id: 'org-1', doc_number: 'OL-2026-0007', type: 'offer', status: 'pending',
    title: 'Ravi Kumar', employee_id: IDS.ravi, recipient_name: 'Ravi Kumar', recipient_email: 'ravi@edge.test', issue_date: '2026-09-26',
    data: { studentName: 'Ravi Kumar', role: 'Sales', acceptanceDeadline: '2026-10-03' }, updated_at: '2026-09-26T09:00:00.000000+00:00', ...over,
  });

  it('shows the email on a card and sends nothing until it is confirmed', async () => {
    const world = session({ records: [letter()] });
    const r = await send(world.ctx, 'send the offer letter to Ravi', { model: world.model });
    expect(world.model.calls).toBe(0);
    const [card] = of(r, 'card').map((e) => e.card);
    expect(card).toMatchObject({ tool: 'send_offer_letter', risk: 'high', status: 'proposed' });
    expect(mailed).toEqual([]);
    expect(minted).toEqual([]);
  });

  it('on confirm, mints the signing link, emails it and marks the letter sent', async () => {
    const world = session({ records: [letter()] });
    const r = await send(world.ctx, 'send the offer letter to Ravi', { model: world.model });
    const done = await confirm(world.ctx, of(r, 'card')[0].card.action_id);
    expect(done.status).toBe('executed');
    expect(minted).toEqual([expect.objectContaining({ orgId: 'org-1', documentId: letter().id, scope: 'sign' })]);
    expect(mailed).toHaveLength(1);
    expect(mailed[0]).toMatchObject({ to: 'ravi@edge.test', orgId: 'org-1' });
    expect(mailed[0].text).toContain('https://app.test/portal/');
    expect(world.db.tables.records[0].status).toBe('sent');
    expect(done.card.undo_until ?? null).toBeNull();
  });

  it('will not send a draft', async () => {
    const world = session({ records: [letter({ status: 'draft' })] });
    const r = await send(world.ctx, 'send the offer letter to Ravi', { model: world.model });
    expect(of(r, 'card')).toEqual([]);
    expect(of(r, 'notice')[0].text).toMatch(/draft/i);
  });

  it('asks for an email address when the letter has none', async () => {
    const world = session({ records: [letter({ recipient_email: null })] });
    const r = await send(world.ctx, 'send the offer letter to Ravi', { model: world.model });
    expect(asked(r)).toMatchObject({ param: 'to' });
  });
});
