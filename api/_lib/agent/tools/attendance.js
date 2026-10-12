import { resolveEntity, loadKind, entityOf } from '../resolvers.js';
import {
  askNext, change, choiceFrom, needsInput, notFound, formatDate, readDate,
} from '../helpers.js';
import { firstName } from './people.js';

/**
 * Attendance: one row per person per day (0029 attendance_days).
 *
 * Two writers, told apart by `source`, as on the Team page:
 *   'self'   someone marking or checking in their own day;
 *   'admin'  a manager's entry — once written, the person can no longer
 *            overwrite it (the table's own policy).
 * A day that already has a row is corrected, never duplicated.
 */

export const ATTENDANCE = { present: 'Present', remote: 'Remote', half_day: 'Half day', leave: 'On leave', absent: 'Absent', holiday: 'Holiday' };
const STATUS_OPTIONS = Object.entries(ATTENDANCE).map(([value, label]) => ({ value, label }));
const active = (e) => !e.exited_at;

export function readAttendance(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (ATTENDANCE[s.replace(/ /g, '_')]) return { value: s.replace(/ /g, '_') };
  if (/^(?:present|in|in office|at work|here)$/.test(s)) return { value: 'present' };
  if (/^(?:remote|wfh|working from home|work from home|working remotely|from home)$/.test(s)) return { value: 'remote' };
  if (/^(?:on )?half ?day$/.test(s)) return { value: 'half_day' };
  if (/^(?:on leave|leave|off|day off)$/.test(s)) return { value: 'leave' };
  if (/^(?:absent|away|not in|missing|no show)$/.test(s)) return { value: 'absent' };
  if (/^(?:on )?holiday$/.test(s)) return { value: 'holiday' };
  return { error: 'I did not catch that.' };
}

const STATUS_SLOT = { key: 'status', question: (v) => `How should I mark ${v.self ? 'you' : firstName(v.name)}?`, options: STATUS_OPTIONS, read: readAttendance };

async function dayRow(employeeId, date, ctx) {
  const { data } = await ctx.db.from('attendance_days').select('*').eq('org_id', ctx.orgId).eq('employee_id', employeeId).eq('work_date', date).maybeSingle();
  return data || null;
}

const clock = (iso, tz) => {
  try { return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'Asia/Kolkata' }); } catch { return String(iso).slice(11, 16); }
};

const mark_attendance = {
  name: 'mark_attendance',
  module: 'people',
  kind: 'write',
  risk: 'low',
  permission: { resource: ['attendance_days', 'tasks'], action: 'create' },
  // Not in a team group, where everyone would read the card.
  privateOnly: true,
  description: 'Mark attendance for a day, or check the user in or out: "mark Ravi absent today", "I\'m working from home today", "check me in", "check me out". '
    + 'Pass `check` ("in" or "out") for a check-in or check-out; otherwise the person, the status and the day (default today).',
  params: {
    type: 'object',
    properties: {
      person: { type: 'string', description: '"me", or the person as named.' },
      status: { type: 'string', enum: Object.keys(ATTENDANCE) },
      date: { type: 'string', description: 'The day, as said; default today.' },
      check: { type: 'string', enum: ['in', 'out'] },
      note: { type: 'string' },
    },
    required: [],
  },
  slots: [{ key: 'person' }, { key: 'status' }],
  undoable: (args, ctx) => !args.check && ctx.can('attendance_days', 'delete'),

  async resolve(args, ctx) {
    const check = /^(?:in|out)$/i.test(String(args.check ?? '')) ? String(args.check).toLowerCase() : null;
    const ref = String(args.person ?? (check ? 'me' : '')).trim();
    if (!ref) return needsInput('person', 'Whose attendance?', ctx.employeeId ? [{ label: 'Mine', value: 'me' }] : []);
    let person;
    if (/^(?:me|myself|i|mine)$/i.test(ref) || ref === ctx.employeeId) {
      if (!ctx.employeeId) return notFound('You are not linked to a person in Team, so I cannot mark your attendance.');
      person = { id: ctx.employeeId, full_name: ctx.user?.name || 'you' };
    } else {
      if (check) return notFound('I can only check you in or out yourself. To record someone else’s day, tell me how to mark them.');
      if (!ctx.can('attendance_days', 'create')) return notFound('Your role can mark your own attendance, not someone else’s.');
      const r = await resolveEntity('employee', ref, ctx, { filter: active });
      if (r.status === 'many') return choiceFrom('person', 'person', r, (e) => e.role || e.email);
      if (r.status !== 'one') return notFound(`I couldn't find anyone called “${ref}” in your team.`);
      person = r.row;
    }
    const self = person.id === ctx.employeeId;
    const d = args.date && !check ? readDate(args.date, ctx.today, { prefer: 'past' }) : { value: ctx.today };
    if (d.error) return needsInput('date', `${d.error} Which day?`, [{ label: 'Today', value: ctx.today }]);
    let status = null;
    if (!check) {
      const asked = await askNext({ ...args, name: person.full_name, self }, [{ key: 'name' }, { key: 'self', read: (v) => ({ value: v === true }) }, STATUS_SLOT], ctx);
      if (asked.needs) return asked;
      status = asked.values.status;
    }
    return {
      args: { person: person.id, status, date: d.value || ctx.today, check, note: String(args.note ?? '').trim().slice(0, 300) || null },
      entities: self ? [] : [entityOf('employee', person)],
    };
  },

  async validate(args, ctx) {
    if (args.date > ctx.today) return ['That day has not come yet. Attendance is marked for today or a day gone by; for a day ahead, file leave.'];
    const row = await dayRow(args.person, args.date, ctx);
    if (args.check === 'in' && row?.check_in) return [`You already checked in at ${clock(row.check_in, ctx.tz)}.`];
    if (args.check === 'out' && !row?.check_in) return ['You have not checked in today, so there is nothing to check out of.'];
    if (args.check === 'out' && row?.check_out) return [`You already checked out at ${clock(row.check_out, ctx.tz)}.`];
    if (!args.check && row && row.status === args.status && !args.note) return [`That day is already marked ${ATTENDANCE[row.status].toLowerCase()}.`];
    return [];
  },

  async preview(args, ctx) {
    const self = args.person === ctx.employeeId;
    const name = self ? 'you' : (await loadKind('employee', ctx)).find((e) => e.id === args.person)?.full_name || 'them';
    const row = await dayRow(args.person, args.date, ctx);
    if (args.check) {
      return {
        title: args.check === 'in' ? 'Check in' : 'Check out',
        diff: [change('when', args.check === 'in' ? 'Check-in' : 'Check-out', null, `Now, ${formatDate(args.date)}`)],
        confirmLabel: args.check === 'in' ? 'Check me in' : 'Check me out',
      };
    }
    return {
      title: self ? 'Mark my attendance' : `Mark attendance for ${name}`,
      diff: [
        change('date', 'Day', null, formatDate(args.date)),
        change('status', 'Marked as', row ? ATTENDANCE[row.status] : null, ATTENDANCE[args.status]),
        ...(args.note ? [change('note', 'Note', row?.note || null, args.note)] : []),
      ],
      fields: [
        { key: 'status', label: 'Marked as', type: 'select', value: args.status, options: STATUS_OPTIONS },
        { key: 'note', label: 'Note', type: 'text', value: args.note || '' },
      ],
      confirmLabel: `Mark ${ATTENDANCE[args.status].toLowerCase()}`,
    };
  },

  async plan(args, ctx) {
    const row = await dayRow(args.person, args.date, ctx);
    const source = args.person === ctx.employeeId ? 'self' : 'admin';
    const now = new Date().toISOString();
    const patch = args.check === 'in' ? { check_in: now, source }
      : args.check === 'out' ? { check_out: now }
        : { status: args.status, source, ...(args.note ? { note: args.note } : {}) };
    if (row) {
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, row[k] ?? null]));
      return [{ op: 'update', table: 'attendance_days', id: row.id, version: row.updated_at || null, patch, before }];
    }
    return [{
      op: 'insert', table: 'attendance_days',
      row: { org_id: ctx.orgId, employee_id: args.person, work_date: args.date, status: args.status || 'present', ...patch },
    }];
  },

  summary(outcome, args) {
    const r = outcome.results[0];
    if (r?.ok === false) return `Not saved: ${r.error}`;
    if (args.check) return args.check === 'in' ? 'You are checked in.' : 'You are checked out.';
    return `Marked ${ATTENDANCE[args.status].toLowerCase()} for ${formatDate(args.date)}.`;
  },
};

export default [mark_attendance];
