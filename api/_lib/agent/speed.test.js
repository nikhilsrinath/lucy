import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeDb, fakeCtx } from './testing/fakeDb.js';

/*
 * Reply speed: what happens before the first model call and how the model
 * is called. No ai_actions or network: the brain and the provider are spies.
 */

const brain = { calls: [], delay: 0, context: 'ACME OWES 10K' };
vi.mock('../brainRetrieval.js', () => ({
  buildContext: vi.fn(async (_org, _allowed, question) => {
    brain.calls.push(question);
    if (brain.delay) await new Promise((r) => setTimeout(r, brain.delay));
    return { context: brain.context };
  }),
  // The pieces the read tools import.
  getMetrics: async () => ({}), headlineSection: () => '', CONTEXT_RULES: '',
}));

const { runChat, wantsBrain, BRAIN_WAIT_MS } = await import('./loop.js');
const { callModel, providerRouting, resetRouting } = await import('./model.js');

const ALL = { view: true, create: true, edit: true, delete: true };
const ctxWith = (extra = {}) => {
  const c = fakeCtx({ db: fakeDb({}), perms: { tasks: ALL, edgebrain: ALL, employees: ALL } });
  Object.assign(c, { channel: 'chat', pending: null }, extra);
  return c;
};
const say = (text) => ({ message: { role: 'assistant', content: text } });

beforeEach(() => { brain.calls.length = 0; brain.delay = 0; resetRouting(); });
afterEach(() => vi.restoreAllMocks());

describe('the EdgeBrain pre-fetch is only done where it can help', () => {
  const c = ctxWith();
  it.each([
    ['How much does Acme owe us?', true],
    ['what changed in the pipeline this week', true],
    ['revenue this month?', true],
    ['can you tell me the cash balance', true],
    ['show overdue invoices', true],
    ['Why is the Kite deal stuck on legal review', true],
  ])('asks for company facts: %s', (m, want) => expect(wantsBrain(c, m)).toBe(want));
  it.each([
    'Ads', 'yes', 'thanks', 'ok', 'hi', 'Friday',
    'remind Swetha tomorrow at 10 to call the sponsor',
    'Make sure Swetha follows up with the sponsor tomorrow',
    'tell the group standup moved to 5',
    'mark the pricing task done',
    'please cancel that',
  ])('goes straight to the model: %s', (m) => expect(wantsBrain(c, m)).toBe(false));

  it('an answer to a question Buddy just asked never needs it', () => {
    expect(wantsBrain(ctxWith({ pending: { tool: 'create_cash_entry', param: 'category' } }), 'Advertising and marketing for the October campaign')).toBe(false);
  });

  it('a skipped lookup makes no query at all, and no wait', async () => {
    const events = [];
    const model = vi.fn(async () => say('Done.'));
    await runChat(ctxWith(), { message: 'Ads' }, (e, d) => events.push([e, d]), { callModelImpl: model });
    expect(brain.calls).toHaveLength(0);
    expect(events.some(([e, d]) => e === 'status' && /what I know/.test(d.text))).toBe(false);
  });

  it('a lookup that is made says so, and its facts reach the model as data', async () => {
    const events = [];
    const model = vi.fn(async () => say('Acme owes 10K.'));
    await runChat(ctxWith(), { message: 'How much does Acme owe us?' }, (e, d) => events.push([e, d]), { callModelImpl: model });
    expect(brain.calls).toEqual(['How much does Acme owe us?']);
    expect(events[0]).toEqual(['status', { text: 'Checking what I know…' }]);
    const sent = JSON.stringify(model.mock.calls[0][0].messages);
    expect(sent).toContain('<data source=\\"edgebrain\\">');
    expect(sent).toContain('ACME OWES 10K');
  });

  it('a slow lookup is abandoned after the cap — the answer goes ahead without it', async () => {
    vi.useFakeTimers();
    brain.delay = 60_000;
    const model = vi.fn(async () => say('Here you go.'));
    const run = runChat(ctxWith(), { message: 'How much does Acme owe us?' }, () => {}, { callModelImpl: model });
    await vi.advanceTimersByTimeAsync(BRAIN_WAIT_MS + 50);
    await run;
    expect(BRAIN_WAIT_MS).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(model.mock.calls[0][0].messages)).not.toContain('ACME OWES');
    vi.useRealTimers();
  });

  it('logs where the time went — numbers only, no message text', async () => {
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    await runChat(ctxWith(), { message: 'How much does Acme owe us? secret-text-123' }, () => {}, { callModelImpl: async () => say('x') });
    const line = logs.mock.calls.map((call) => String(call[0])).find((l) => l.startsWith('[agent] timing'));
    expect(line).toBeTruthy();
    const t = JSON.parse(line.slice('[agent] timing '.length));
    expect(t).toMatchObject({ channel: 'chat', steps: 1, brain: expect.any(Number) });
    expect(t.model_ms).toHaveLength(1);
    expect(line).not.toContain('secret-text-123');
    expect(line).not.toContain('ACME OWES');
  });
});

describe('OpenRouter provider routing', () => {
  const okJson = { choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: null };
  const reply = (status, body = okJson) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const withKey = () => { process.env.OPENROUTER_API_KEY = 'sk-or-v1-test'; };

  it('prefers the fastest provider that supports the request, by default', () => {
    expect(providerRouting(undefined)).toEqual({ sort: 'throughput', require_parameters: true });
    expect(providerRouting('latency')).toEqual({ sort: 'latency', require_parameters: true });
    expect(providerRouting('none')).toBeUndefined();
    expect(providerRouting('nonsense')).toBeUndefined();
  });

  it('sends the routing, and everything else it always sent', async () => {
    withKey();
    const fetchImpl = vi.fn(async () => reply(200));
    await callModel({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'x' } }], fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.provider).toEqual({ sort: 'throughput', require_parameters: true });
    expect(body).toMatchObject({ stream: false, tool_choice: 'auto', max_tokens: 4096 });
  });

  it('if OpenRouter cannot route that way, retries once with default routing — and stops asking', async () => {
    withKey();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(404, { error: { message: 'No endpoints found matching your data policy' } }))
      .mockResolvedValue(reply(200));
    const out = await callModel({ messages: [], fetchImpl });
    expect(out.message.content).toBe('hi');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).not.toHaveProperty('provider');
    await callModel({ messages: [], fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // the next call goes straight to default routing
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).not.toHaveProperty('provider');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('other failures are not retried', async () => {
    withKey();
    const fetchImpl = vi.fn(async () => reply(429, { error: 'rate limited' }));
    await expect(callModel({ messages: [], fetchImpl })).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
