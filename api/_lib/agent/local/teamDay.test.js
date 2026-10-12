import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeDb } from '../testing/fakeDb.js';
import { worldSeed, IDS } from '../../../../scripts/eval-agent.world.js';

/**
 * The day-to-day team actions, asked for in chat: leave, attendance,
 * announcements and time on a project. Each is a card, with no model call.
 * The person asking is Neha (evalCtx's employeeId).
 */

const store = new Map();
vi.mock('../actions.js', async (importOriginal) => {
  const real = await importOriginal();
  let n = 0;
  return {
    ...real,
    countPending: async (_ctx, chatId) => [...store.values()].filter((r) => r.chat_id === chatId && real.effectiveStatus(r) === 'proposed').length,
    insertProposal: async (ctx, { chatId, messageId, tool, args, targets, preview }) => {
      const id = `dddddddd-0000-4000-8000-${String(++n).padStart(12, '0')}`;
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

const SICK = '80000000-0000-4000-8000-000000000001';
const CASUAL = '80000000-0000-4000-8000-000000000002';
const REQ = '81000000-0000-4000-8000-000000000001';
const ts = '2026-09-20T09:00:00.000000+00:00';
const leaveTypes = [
  { id: SICK, org_id: 'org-1', name: 'Sick leave', code: 'SL', annual_quota: 12, is_paid: true, is_active: true, sort_order: 1 },
  { id: CASUAL, org_id: 'org-1', name: 'Casual leave', code: 'CL', annual_quota: 12, is_paid: true, is_active: true, sort_order: 2 },
];
const request = (over = {}) => ({
  id: REQ, org_id: 'org-1', employee_id: IDS.ravi, leave_type_id: SICK, start_date: '2026-10-05', end_date: '2026-10-07', days: 3,
  half_day: false, reason: 'Fever', status: 'pending', updated_at: ts, created_at: ts, ...over,
});

function session(seedOver = {}) {
  const db = fakeDb({ ...worldSeed(), leave_types: leaveTypes, leave_requests: [], attendance_days: [], announcements: [], timesheet_entries: [], departments: [], ...seedOver });
  const world = evalCtx({ db });
  delete world.ctx.actionStore;
  world.model = countingModel();
  return world;
}

const of = (r, event) => r.events.filter((e) => e.event === event);
const asked = (r) => of(r, 'input')[0]?.input || null;
const cardOf = (r) => of(r, 'card')[0]?.card || null;
const noticeOf = (r) => of(r, 'notice')[0]?.text || '';
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

describe('leave', () => {
  it('asks which kind of leave, with the company\'s own types as chips', async () => {
    const world = session();
    const turns = await talk(world, 'apply for leave tomorrow');
    expect(world.model.calls).toBe(0);
    expect(asked(turns[0])).toMatchObject({ param: 'leave_type' });
    expect(asked(turns[0]).options.map((o) => o.label)).toEqual(['Sick leave', 'Casual leave']);
  });

  it('files the request for the person asking, pending, only on confirm', async () => {
    const world = session();
    const turns = await talk(world, 'apply for leave tomorrow', ['sick']);
    const card = cardOf(turns.at(-1));
    expect(card).toMatchObject({ tool: 'apply_leave', status: 'proposed' });
    expect(store.get(card.action_id).args).toMatchObject({ employee: IDS.neha, leave_type: SICK, start_date: '2026-09-27', end_date: '2026-09-27', half_day: false });
    expect(businessWrites(world.db)).toEqual([]);
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.leave_requests).toEqual([
      expect.objectContaining({ org_id: 'org-1', employee_id: IDS.neha, leave_type_id: SICK, start_date: '2026-09-27', end_date: '2026-09-27', days: 1, half_day: false }),
    ]);
  });

  it('reads the kind and a range of dates from one sentence', async () => {
    const world = session();
    const [r] = await talk(world, 'apply for sick leave from 5th Oct to 7th Oct');
    const card = cardOf(r);
    expect(store.get(card.action_id).args).toMatchObject({ leave_type: SICK, start_date: '2026-10-05', end_date: '2026-10-07' });
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.leave_requests[0]).toMatchObject({ days: 3 });
  });

  it('asks for the dates when none were given', async () => {
    const world = session();
    const turns = await talk(world, 'apply for casual leave', ['Monday', 'Wednesday']);
    expect(turns.slice(0, 2).map((t) => asked(t)?.param)).toEqual(['start_date', 'end_date']);
    expect(store.get(cardOf(turns.at(-1)).action_id).args).toMatchObject({ leave_type: CASUAL, start_date: '2026-09-28', end_date: '2026-09-30' });
  });

  it('counts a half day as half', async () => {
    const world = session();
    const turns = await talk(world, 'apply for half day leave tomorrow', ['casual']);
    const card = cardOf(turns.at(-1));
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.leave_requests[0]).toMatchObject({ half_day: true, days: 0.5 });
  });

  it('refuses dates that overlap a request already filed', async () => {
    const world = session({ leave_requests: [request({ employee_id: IDS.neha })] });
    const [r] = await talk(world, 'apply for sick leave from 6th Oct to 8th Oct');
    expect(cardOf(r)).toBeNull();
    expect(noticeOf(r)).toMatch(/already/i);
  });

  it('says so when the company has no leave types yet', async () => {
    const world = session({ leave_types: [] });
    const [r] = await talk(world, 'apply for leave tomorrow');
    expect(noticeOf(r)).toMatch(/leave types/i);
  });

  it('approves a named person\'s pending request', async () => {
    const world = session({ leave_requests: [request()] });
    const [r] = await talk(world, "approve Ravi's leave");
    expect(world.model.calls).toBe(0);
    const card = cardOf(r);
    expect(card).toMatchObject({ tool: 'decide_leave', risk: 'high', status: 'proposed' });
    expect(world.db.tables.leave_requests[0].status).toBe('pending');
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.leave_requests[0]).toMatchObject({ status: 'approved' });
  });

  it('rejects with the reason given', async () => {
    const world = session({ leave_requests: [request()] });
    const [r] = await talk(world, "reject Ravi's leave: the launch is that week");
    await confirm(world.ctx, cardOf(r).action_id);
    expect(world.db.tables.leave_requests[0]).toMatchObject({ status: 'rejected', decision_comment: 'The launch is that week' });
  });

  it('asks which request when a person has several waiting', async () => {
    const second = request({ id: '81000000-0000-4000-8000-000000000002', start_date: '2026-11-02', end_date: '2026-11-02', days: 1 });
    const world = session({ leave_requests: [request(), second] });
    const [r] = await talk(world, "approve Ravi's leave");
    expect(asked(r)).toMatchObject({ param: 'request' });
    expect(asked(r).options).toHaveLength(2);
  });

  it('never lets someone decide their own request', async () => {
    const world = session({ leave_requests: [request({ employee_id: IDS.neha })] });
    const [r] = await talk(world, "approve Neha's leave");
    expect(cardOf(r)).toBeNull();
    expect(noticeOf(r)).toMatch(/your own/i);
  });

  it('withdraws the asker\'s own pending request', async () => {
    const world = session({ leave_requests: [request({ employee_id: IDS.neha })] });
    const [r] = await talk(world, 'cancel my leave');
    const card = cardOf(r);
    expect(card).toMatchObject({ tool: 'cancel_leave' });
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.leave_requests[0].status).toBe('cancelled');
  });
});

describe('attendance', () => {
  it('marks someone for today, as the manager\'s entry', async () => {
    const world = session();
    const [r] = await talk(world, 'mark Ravi absent today');
    expect(world.model.calls).toBe(0);
    const card = cardOf(r);
    expect(card).toMatchObject({ tool: 'mark_attendance', status: 'proposed' });
    expect(businessWrites(world.db)).toEqual([]);
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.attendance_days).toEqual([
      expect.objectContaining({ org_id: 'org-1', employee_id: IDS.ravi, work_date: '2026-09-26', status: 'absent', source: 'admin' }),
    ]);
  });

  it('corrects the day\'s row instead of adding a second', async () => {
    const world = session({ attendance_days: [{ id: '82000000-0000-4000-8000-000000000001', org_id: 'org-1', employee_id: IDS.ravi, work_date: '2026-09-26', status: 'present', source: 'self', updated_at: ts }] });
    const [r] = await talk(world, 'mark Ravi as working from home today');
    await confirm(world.ctx, cardOf(r).action_id);
    expect(world.db.tables.attendance_days).toHaveLength(1);
    expect(world.db.tables.attendance_days[0]).toMatchObject({ status: 'remote', source: 'admin' });
  });

  it('checks the asker in', async () => {
    const world = session();
    const [r] = await talk(world, 'check me in');
    const card = cardOf(r);
    expect(card).toMatchObject({ tool: 'mark_attendance' });
    await confirm(world.ctx, card.action_id);
    const [row] = world.db.tables.attendance_days;
    expect(row).toMatchObject({ employee_id: IDS.neha, work_date: '2026-09-26', status: 'present', source: 'self' });
    expect(row.check_in).toBeTruthy();
  });

  it('will not check out someone who never checked in', async () => {
    const world = session();
    const [r] = await talk(world, 'check me out');
    expect(cardOf(r)).toBeNull();
    expect(noticeOf(r)).toMatch(/not checked in/i);
  });

  it('asks who and what when told only to mark attendance', async () => {
    const world = session();
    const turns = await talk(world, 'mark attendance', ['Priya', 'half day']);
    expect(turns.slice(0, 2).map((t) => asked(t)?.param)).toEqual(['person', 'status']);
    expect(store.get(cardOf(turns.at(-1)).action_id).args).toMatchObject({ person: IDS.priya, status: 'half_day', date: '2026-09-26' });
  });

  it('refuses a day that has not come yet', async () => {
    const world = session();
    const [r] = await talk(world, 'mark Ravi absent tomorrow');
    expect(cardOf(r)).toBeNull();
    expect(noticeOf(r)).toMatch(/not come|future/i);
  });
});

describe('announcements', () => {
  it('asks for the title and what to say, then posts on confirm', async () => {
    const world = session();
    const turns = await talk(world, 'post an announcement', ['Office closed Monday', 'The office is closed on Monday for the festival. Work from home if you need to.']);
    expect(world.model.calls).toBe(0);
    expect(turns.slice(0, 2).map((t) => asked(t)?.param)).toEqual(['title', 'body']);
    const card = cardOf(turns.at(-1));
    expect(card).toMatchObject({ tool: 'post_announcement', status: 'proposed' });
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.announcements).toEqual([
      expect.objectContaining({ org_id: 'org-1', title: 'Office closed Monday', body: expect.stringContaining('festival'), department_id: null, is_pinned: false }),
    ]);
  });

  it('takes a one-line announcement whole', async () => {
    const world = session();
    const [r] = await talk(world, 'announce that the office is closed on Monday');
    expect(store.get(cardOf(r).action_id).args).toMatchObject({ title: 'The office is closed on Monday', body: 'The office is closed on Monday' });
  });

  it('asks who it is for when the company has departments', async () => {
    const world = session({ departments: [{ id: '83000000-0000-4000-8000-000000000001', org_id: 'org-1', name: 'Design' }] });
    const turns = await talk(world, 'announce that the design review moved to 4pm', ['Design']);
    expect(asked(turns[0])).toMatchObject({ param: 'audience' });
    expect(store.get(cardOf(turns.at(-1)).action_id).args).toMatchObject({ audience: '83000000-0000-4000-8000-000000000001' });
  });
});

describe('time on a project', () => {
  it('logs hours for the asker against the named project', async () => {
    const world = session();
    const [r] = await talk(world, 'log 3 hours on Acme website');
    expect(world.model.calls).toBe(0);
    const card = cardOf(r);
    expect(card).toMatchObject({ tool: 'log_time', status: 'proposed' });
    await confirm(world.ctx, card.action_id);
    expect(world.db.tables.timesheet_entries).toEqual([
      expect.objectContaining({ org_id: 'org-1', employee_id: IDS.neha, project_id: IDS.acmeWeb, work_date: '2026-09-26', minutes: 180, billable: true, status: 'draft' }),
    ]);
  });

  it('reads the day and a note', async () => {
    const world = session();
    const [r] = await talk(world, 'log 2.5 hours on Kite app yesterday: wireframes');
    expect(store.get(cardOf(r).action_id).args).toMatchObject({ project: IDS.kiteApp, minutes: 150, date: '2026-09-25', note: 'Wireframes' });
  });

  it('asks for the project and the time when told only to log time', async () => {
    const world = session();
    const turns = await talk(world, 'log time', ['Kite app', '90 minutes']);
    expect(turns.slice(0, 2).map((t) => asked(t)?.param)).toEqual(['project', 'hours']);
    expect(asked(turns[0]).options.map((o) => o.label)).toEqual(expect.arrayContaining(['Acme website', 'Kite app']));
    expect(store.get(cardOf(turns.at(-1)).action_id).args).toMatchObject({ project: IDS.kiteApp, minutes: 90 });
  });

  it('refuses more than a day in a day', async () => {
    const world = session();
    const [r] = await talk(world, 'log 30 hours on Acme website');
    expect(cardOf(r)).toBeNull();
  });
});
