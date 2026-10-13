import { describe, it, expect } from 'vitest';
import { fakeDb } from '../testing/fakeDb.js';
import { evalCtx, send, countingModel } from './evaluate.js';
import { worldSeed, IDS } from '../../../../scripts/eval-agent.world.js';

/**
 * Plain questions about what is in the company's records are answered from
 * the records, with no model: who is on the team, what we sell, who we buy
 * from, our own details, the notice board, hours logged, letters, leave.
 */

const DESIGN = '83000000-0000-4000-8000-000000000001';
const SICK = '80000000-0000-4000-8000-000000000001';
const seed = () => ({
  ...worldSeed(),
  employees: worldSeed().employees.map((e) => (e.id === IDS.priya ? { ...e, department_id: DESIGN } : e)),
  departments: [{ id: DESIGN, org_id: 'org-1', name: 'Design' }, { id: '83000000-0000-4000-8000-000000000002', org_id: 'org-1', name: 'Sales' }],
  organizations: [{ id: 'org-1', company_name: 'Edge Labs', company_address: '12 MG Road, Bengaluru', company_phone: '080 4000 1234', company_email: 'hello@edgelabs.test', company_website: 'edgelabs.test', owner_full_name: 'Nikhil S', document_designation: 'Founder', country_code: 'IN' }],
  announcements: [
    { id: 'an-1', org_id: 'org-1', title: 'Office closed Monday', body: 'For the festival.', department_id: null, is_pinned: true, published_at: '2026-09-25T09:00:00Z', expires_at: null },
    { id: 'an-2', org_id: 'org-1', title: 'Old notice', body: 'Gone.', department_id: null, is_pinned: false, published_at: '2026-08-01T09:00:00Z', expires_at: '2026-08-10T00:00:00Z' },
  ],
  timesheet_entries: [
    { id: 'ts-1', org_id: 'org-1', employee_id: IDS.neha, project_id: IDS.acmeWeb, work_date: '2026-09-22', minutes: 180, status: 'draft', billable: true },
    { id: 'ts-2', org_id: 'org-1', employee_id: IDS.neha, project_id: IDS.kiteApp, work_date: '2026-09-24', minutes: 120, status: 'submitted', billable: true },
    { id: 'ts-3', org_id: 'org-1', employee_id: IDS.ravi, project_id: IDS.kiteApp, work_date: '2026-09-24', minutes: 600, status: 'draft', billable: true },
  ],
  records: [
    { id: 'rec-1', org_id: 'org-1', type: 'offer', status: 'pending', doc_number: 'OL-2026-0001', title: 'Ravi Kumar', recipient_name: 'Ravi Kumar', issue_date: '2026-09-20', created_at: '2026-09-20T09:00:00Z' },
    { id: 'rec-2', org_id: 'org-1', type: 'nda', status: 'draft', doc_number: 'NDA-2026-0001', title: 'Edge Labs & Kite Labs', recipient_name: 'Kite Labs', issue_date: '2026-09-21', created_at: '2026-09-21T09:00:00Z' },
  ],
  leave_balances_v: [
    { org_id: 'org-1', employee_id: IDS.neha, leave_type_id: SICK, leave_type_name: 'Sick leave', year: 2026, quota: 12, taken: 3, adjusted: 0, remaining: 9 },
    { org_id: 'org-1', employee_id: IDS.neha, leave_type_id: '80000000-0000-4000-8000-000000000002', leave_type_name: 'Casual leave', year: 2026, quota: 12, taken: 0, adjusted: 0, remaining: 12 },
  ],
});

async function ask(message) {
  const world = evalCtx({ db: fakeDb(seed()) });
  const model = countingModel();
  const r = await send(world.ctx, message, { model });
  return {
    model,
    route: r.out?.route,
    intent: r.out?.intent,
    text: r.events.filter((e) => e.event === 'text').map((e) => e.text).join('\n'),
    views: r.events.filter((e) => e.event === 'view').map((e) => e.view),
    navigated: r.events.some((e) => e.event === 'navigate'),
    writes: world.db.writes.filter((w) => w.op !== 'rpc'),
  };
}

describe('questions about the records are answered from the records', () => {
  it.each([
    ['name the team members', /Ravi Kumar.*Priya Sharma|Priya Sharma.*Ravi Kumar/s],
    ['who is in my team', /Ravi Kumar/],
    ['who works here', /Arjun Mehta/],
    ['who all work here', /Neha Gupta/],
    ['how many people work here', /4 people/],
    ['list vendors', /Dell India/],
    ['name our vendors', /1 vendor/],
    ['who do we buy from', /Dell India/],
    ['what products do we sell', /Support retainer.*₹20,000/s],
    ['list catalogue items', /Support retainer/],
    ['show the price list', /Support retainer/],
    ['what departments do we have', /Design.*Sales|Sales.*Design/s],
    ['list departments', /2 departments/],
    ['what is our company address', /12 MG Road, Bengaluru/],
    ['what is our company phone number', /080 4000 1234/],
    ['who signs our documents', /Nikhil S.*Founder/s],
    ['show the company profile', /Edge Labs.*12 MG Road/s],
    ['any announcements', /Office closed Monday/],
    ['what is on the notice board', /1 announcement/],
    ['how many hours did I log this week', /5 h/],
    ['show my timesheet', /Acme website|Kite app/],
    ['list offer letters', /Ravi Kumar.*OL-2026-0001/s],
    ['show ndas', /Kite Labs/],
    ['what leave types do we have', /Sick leave.*Casual leave/s],
    ['how much leave do I have', /9.*Sick leave|Sick leave.*9/s],
    ['my leave balance', /Casual leave.*12|12.*Casual leave/s],
    ['who is Ravi', /Ravi Kumar/],
  ])('%s', async (message, expected) => {
    const r = await ask(message);
    expect(r.model.calls, `${message} → ${r.route} ${r.intent}`).toBe(0);
    expect(r.route).toBe('local');
    expect(r.text).toMatch(expected);
    expect(r.writes).toEqual([]);
  });

  it('lists vendors in chat instead of opening the page', async () => {
    const r = await ask('list vendors');
    expect(r.navigated).toBe(false);
    expect(r.views[0]).toMatchObject({ type: 'list', total: 1 });
  });

  it('shows only announcements that are still live', async () => {
    expect((await ask('any announcements')).text).not.toMatch(/Old notice/);
  });

  it('counts only the asker\'s own hours', async () => {
    const r = await ask('how many hours did I log this week');
    expect(r.text).not.toMatch(/15 h|10 h/);
  });

  it('says plainly when there is nothing', async () => {
    const world = evalCtx({ db: fakeDb({ ...worldSeed(), vendors: [], catalog_items: [] }) });
    const model = countingModel();
    const a = await send(world.ctx, 'list vendors', { model });
    const b = await send(world.ctx, 'what products do we sell', { model });
    expect(model.calls).toBe(0);
    expect(a.events.find((e) => e.event === 'text').text).toMatch(/no vendors/i);
    expect(b.events.find((e) => e.event === 'text').text).toMatch(/nothing in the catalogue/i);
  });

  it('still leaves reasoning to the model', async () => {
    for (const message of ['which vendor should we drop?', 'why is our catalogue so small?', 'should we hire for the design department?']) {
      const r = await ask(message);
      expect(r.model.calls, message).toBe(1);
    }
  });
});
