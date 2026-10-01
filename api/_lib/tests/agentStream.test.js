import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * POST /api/agent, chat mode: it starts streaming the moment the caller is
 * authenticated ("Thinking…"), so a slow session setup is not a blank wait —
 * and still refuses what it should: no token is a real 401, a missing message
 * a real 400, and a failure after the stream began arrives as an `error` event.
 */

const state = { user: { id: 'u-1', email: 'a@b.c' }, authError: null, sessionError: null, order: [] };
vi.mock('../auth.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    requireUser: async () => {
      state.order.push('auth');
      if (state.authError) throw state.authError;
      return state.user;
    },
  };
});
vi.mock('../agent/buddy.js', () => ({
  openSession: vi.fn(async () => {
    state.order.push('session');
    if (state.sessionError) throw state.sessionError;
    return { orgId: 'org-1', aiLimit: 100 };
  }),
  chat: vi.fn(async (_ctx, _turn, emit) => { state.order.push('chat'); emit('text', { text: 'hello' }); }),
  resume: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), undo: vi.fn(), retry: vi.fn(), status: vi.fn(), insights: vi.fn(), activity: vi.fn(),
}));
vi.mock('../aiUsage.js', () => ({ bumpAiUsage: async () => { state.order.push('usage'); return 1; }, logAiUsage: async () => null }));
vi.mock('../autonomy/worker.js', () => ({ runWorker: vi.fn(), recentJobs: vi.fn() }));
vi.mock('../autonomy/policy.js', () => ({ loadPolicy: vi.fn(), savePolicy: vi.fn(), catalogue: vi.fn() }));

const { default: handler } = await import('../../agent.js');
const { HttpError } = await import('../auth.js');

function call(body, { method = 'POST' } = {}) {
  const res = {
    headers: {}, writes: [], statusCode: null, ended: false, jsonBody: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; this.ended = true; return this; },
    write(s) { this.writes.push(s); state.order.push(`write:${s.split('\n')[0].replace('event: ', '')}`); return true; },
    end() { this.ended = true; return this; },
  };
  const req = { method, headers: { authorization: 'Bearer t' }, body };
  return handler(req, res).then(() => res);
}
const frames = (res) => res.writes.map((w) => ({ event: /^event: (.+)$/m.exec(w)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(w)?.[1] || 'null') }));

beforeEach(() => { state.authError = null; state.sessionError = null; state.order.length = 0; });

describe('chat streams as soon as the caller is known', () => {
  it('says "Thinking…" before the session is even opened', async () => {
    const res = await call({ mode: 'chat', org_id: 'org-1', message: 'hi' });
    expect(res.headers['Content-Type']).toMatch(/text\/event-stream/);
    expect(state.order.slice(0, 3)).toEqual(['auth', 'write:status', 'session']);
    expect(frames(res)[0]).toEqual({ event: 'status', data: { text: 'Thinking…' } });
    expect(frames(res).map((f) => f.event)).toEqual(['status', 'text', 'done']);
  });

  it('no or bad token is still a real 401, with nothing streamed', async () => {
    state.authError = new HttpError(401, 'Invalid or expired session');
    const res = await call({ mode: 'chat', org_id: 'org-1', message: 'hi' });
    expect(res.statusCode).toBe(401);
    expect(res.writes).toHaveLength(0);
    expect(state.order).toEqual(['auth']);
  });

  it('a missing message is still a real 400 — before anything streams or is counted', async () => {
    const res = await call({ mode: 'chat', org_id: 'org-1', message: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.writes).toHaveLength(0);
    expect(state.order).toEqual(['auth']);
  });

  it('someone who is not in the company gets an error event, and nothing is counted or run', async () => {
    state.sessionError = new HttpError(403, 'Not a member of this organization');
    const res = await call({ mode: 'chat', org_id: 'org-other', message: 'hi' });
    const f = frames(res);
    expect(f.map((x) => x.event)).toEqual(['status', 'error']);
    expect(f[1].data.message).toBe('Not a member of this organization');
    expect(state.order).not.toContain('usage');
    expect(state.order).not.toContain('chat');
    expect(res.ended).toBe(true);
  });

  it('other modes are untouched: plain JSON, no stream, real status codes', async () => {
    const bad = await call({ mode: 'nope', org_id: 'org-1' });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['Content-Type']).toBeUndefined();
    expect(bad.writes).toHaveLength(0);
    state.sessionError = new HttpError(403, 'Not a member of this organization');
    const denied = await call({ mode: 'activity', org_id: 'org-other' });
    expect(denied.statusCode).toBe(403);
    expect(denied.writes).toHaveLength(0);
  });
});
