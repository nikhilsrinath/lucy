import { describe, it, expect } from 'vitest';
import { understand } from './understand.js';
import { resolveName } from './engine.js';
import { evalCtx, send, countingModel } from './evaluate.js';
import { IDS, TODAY } from '../../../../scripts/eval-agent.world.js';

/**
 * Requests that used to cost a model call although a tool could carry them
 * out from the words alone: one changed detail, a task note, a vendor's bill,
 * a Telegram message in the words given, a reminder at a time.
 */

const { ctx } = evalCtx();
const env = {
  today: TODAY, pending: null, openCards: [], lastRoute: null, hasOpenInvoices: async () => false,
  resolve: (text, kinds, opts) => resolveName(ctx, text, kinds, { across: opts?.across ?? kinds.length > 3 }),
};
const read = (message) => understand(message, env);
const of = (r, event) => r.events.filter((e) => e.event === event);

describe('read from the words alone', () => {
  it.each([
    ["Acme's new email is ap@acme.com", 'UPDATE_CLIENT', { client: IDS.acme, email: 'ap@acme.com' }],
    ["update Kite's GSTIN to 29ABCDE1234F1Z5", 'UPDATE_CLIENT', { client: 'Kite', gstin: '29ABCDE1234F1Z5' }],
    ['set the Kite deal value to 3 lakh', 'UPDATE_CLIENT', { client: 'Kite', value: '3 lakh' }],
    ["set Neha's salary to 60k", 'UPDATE_EMPLOYEE', { person: 'Neha', pay: '60k' }],
    ["Ravi's email is ravi@new.test", 'UPDATE_EMPLOYEE', { person: IDS.ravi, email: 'ravi@new.test' }],
    ['Priya now reports to Arjun', 'UPDATE_EMPLOYEE', { person: 'Priya', reports_to: 'Arjun' }],
    ['add a note to the pricing task: client wants a call first', 'ADD_TASK_NOTE', { task: 'pricing', note: 'Client wants a call first' }],
    ['blocked on the landing page copy, waiting for the brand colours', 'ADD_TASK_NOTE', { task: 'landing page copy', blocker: true }],
    ['Dell India billed us 4,200 plus 12% GST', 'CREATE_PURCHASE_BILL', { vendor: 'Dell India', amount: '4,200', amount_is: 'subtotal', tax_rate: 12 }],
    ["got Dell's bill for 85k, bill no DL-9981", 'CREATE_PURCHASE_BILL', { vendor: 'Dell', amount: '85k', bill_number: 'DL-9981' }],
    ['delete the Globex quotation draft', 'DELETE_DOCUMENT_DRAFT', { document: 'Globex' }],
    ['message Ravi: standup is at 5 today', 'SEND_TELEGRAM_MESSAGE', { recipient: 'Ravi', message: 'Standup is at 5 today' }],
    ['tell Ravi that the deck is due Friday', 'SEND_TELEGRAM_MESSAGE', { recipient: 'Ravi', message: 'The deck is due Friday' }],
    ['ping Ravi', 'SEND_TELEGRAM_MESSAGE', { recipient: 'Ravi' }],
    ['tell the team: office is closed on Monday', 'SEND_TELEGRAM_GROUP_MESSAGE', { message: 'Office is closed on Monday' }],
    ['post in the group that the sponsor confirmed', 'SEND_TELEGRAM_GROUP_MESSAGE', { message: 'The sponsor confirmed' }],
    ['remind me at 5pm to call the sponsor', 'SCHEDULE_REMINDER', { person: 'me', message: 'Call the sponsor', time: '5pm' }],
    ['remind me tomorrow at 10 to call the sponsor', 'SCHEDULE_REMINDER', { person: 'me', message: 'Call the sponsor', date: 'tomorrow', time: '10' }],
    ['remind Priya tomorrow at 10 to send the deck', 'SCHEDULE_REMINDER', { person: 'Priya', message: 'Send the deck', date: 'tomorrow', time: '10' }],
    ['remind me to call the sponsor at 5pm tomorrow', 'SCHEDULE_REMINDER', { message: 'Call the sponsor', date: 'tomorrow', time: '5pm' }],
    ['on Friday check whether Ravi finished the deck and tell me', 'SCHEDULE_BUDDY_CHECK', { date: 'friday', instruction: 'Check whether Ravi finished the deck and tell me' }],
    ['make sure Priya sends the deck by Friday', 'START_FOLLOWUP', { person: 'Priya', task: 'Send the deck', deadline: 'Friday' }],
    ['stop chasing Ravi about the pitch deck', 'CANCEL_FOLLOWUP', { task: 'pitch deck' }],
  ])('%s', async (message, intent, params) => {
    const d = await read(message);
    expect(d).toMatchObject({ executionRoute: 'local', intent });
    expect(d.parameters).toMatchObject(params);
  });

  it.each([
    'draft a message to Ravi about the delay',
    'tell Ravi to send the deck',
    'remind Ravi to send the deck',
    'message Acme that we are late',
    'hire a developer',
    'we need to hire a developer',
    "what is Kite's email",
  ])('leaves "%s" to the model or a read, never a change', async (message) => {
    const d = await read(message);
    expect(d.readOnly !== false || d.executionRoute === 'llm').toBe(true);
  });

  it('a reminder with no clock time stays a task', async () => {
    expect(await read('remind me to call Kite on Monday')).toMatchObject({ intent: 'CREATE_TASK' });
  });
});

describe('a document asked for without its client, or for someone who is not one yet', () => {
  it.each([
    ['Draft an invoice of 3000 ruppees', 'CREATE_INVOICE'],
    ['draft an invoice for 3000 rupees', 'CREATE_INVOICE'],
    ['create an invoice worth rs 3,000 for website design', 'CREATE_INVOICE'],
    ['make a quotation of 50k', 'CREATE_QUOTATION'],
  ])('%s is a draft with an amount and no client yet', async (message, intent) => {
    const d = await read(message);
    expect(d).toMatchObject({ executionRoute: 'local', intent });
    expect(d.parameters.client).toBeUndefined();
    expect(String(d.parameters.items[0].rate)).toMatch(/^(?:rs )?(?:3,?000|50k)/i);
  });

  it.each(['draft an invoice', 'create an invoice', 'new quotation', 'make a proforma invoice'])('%s starts one', async (message) => {
    const d = await read(message);
    expect(d).toMatchObject({ executionRoute: 'local' });
    expect(d.intent).toMatch(/^CREATE_(?:INVOICE|QUOTATION|PROFORMA)$/);
    expect(d.parameters).toEqual({});
  });

  it('reads the client and an amount said with its currency', async () => {
    expect((await read('draft an invoice for Acme of 3000 rupees')).parameters).toMatchObject({ client: 'Acme', items: [{ rate: expect.stringMatching(/^3000/) }] });
  });

  it('still lists drafts when that is what was asked', async () => {
    expect(await read('draft invoices')).toMatchObject({ intent: 'LIST_INVOICES' });
    expect(await read('show draft invoices')).toMatchObject({ intent: 'LIST_INVOICES' });
  });

  it('asks who it is for and what it is for, keeping the amount, with no model', async () => {
    const world = evalCtx();
    const model = countingModel();
    const turn = async (message, previous) => {
      const q = previous ? of(previous, 'input')[0]?.input : null;
      world.ctx.pending = q ? { tool: q.resume.tool, args: q.resume.args, param: q.param, question: q.question } : null;
      const r = await send(world.ctx, message, { model });
      world.ctx.pending = null;
      return r;
    };
    const a = await turn('Draft an invoice of 3000 ruppees');
    expect(of(a, 'input')[0].input).toMatchObject({ param: 'client' });
    const b = await turn('Acme', a);
    expect(of(b, 'input')[0].input).toMatchObject({ param: 'item_description' });
    expect(of(b, 'input')[0].input.question).toMatch(/3,000/);
    const c = await turn('Website design and hosting for the invoice', b);
    expect(model.calls).toBe(0);
    expect(of(c, 'card')).toHaveLength(1);
    expect(world.proposals.at(-1)).toMatchObject({ tool: 'create_invoice_draft' });
    expect(world.proposals.at(-1).args.items[0]).toMatchObject({ description: 'Website design and hosting for the invoice', rate: 3000 });
  });

  it('for someone who is not a client yet, offers to add them instead of calling the model', async () => {
    const world = evalCtx();
    const model = countingModel();
    const r = await send(world.ctx, 'draft an invoice for Orbit Tech for 3000', { model });
    expect(model.calls).toBe(0);
    const [notice] = of(r, 'notice');
    expect(notice.text).toMatch(/no client called .Orbit Tech./);
    expect(notice.offer).toMatchObject({ tool: 'create_client', args: { name: 'Orbit Tech' } });
  });

  it('a name that only looked like a client still goes to the model', async () => {
    const world = evalCtx();
    const model = countingModel();
    const r = await send(world.ctx, 'we lost the keys', { model });
    expect(model.calls).toBe(1);
    expect(of(r, 'notice')).toEqual([]);
  });
});

describe('the newly local changes are still cards', () => {
  it.each([
    ["Acme's new email is ap@acme.com", 'update_client'],
    ["got Dell's bill for 85k, bill no DL-9981", 'create_purchase_bill'],
    ['add a note to the pricing task: client wants a call first', 'add_task_note'],
    ['delete quote QT-2026-0004', 'delete_financial_document'],
  ])('%s', async (message, tool) => {
    const world = evalCtx();
    const model = countingModel();
    const r = await send(world.ctx, message, { model });
    expect(model.calls).toBe(0);
    expect(world.proposals).toEqual([expect.objectContaining({ tool })]);
    expect(of(r, 'card')).toHaveLength(1);
    expect(world.db.writes.filter((w) => w.op !== 'rpc')).toEqual([]);
  });

  it('hands a tool the company has not switched on to the model, which explains', async () => {
    const world = evalCtx();
    const model = countingModel();
    const r = await send(world.ctx, 'remind me tomorrow at 10 to call the sponsor', { model });
    expect(model.calls).toBe(1);
    expect(of(r, 'card')).toEqual([]);
    expect(of(r, 'notice')).toEqual([]);
  });
});
