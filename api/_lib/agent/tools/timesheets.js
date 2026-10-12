import { resolveEntity, loadKind, entityOf, KINDS } from '../resolvers.js';
import {
  askNext, change, choiceFrom, needsInput, notFound, formatDate, readDate,
} from '../helpers.js';

/**
 * Time on a project (0059 timesheet_entries).
 *
 * A person logs their own time; it is saved as a draft entry, exactly as the
 * Timesheets page saves it, and is submitted and approved there. Approved
 * and rejected are written only by decide_timesheets(), never from here.
 */

const DAY = 1440;

/** "3", "3h", "2.5 hours", "90 minutes", "2h 30m", "1:30" → minutes. */
export function readDuration(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return check(Math.round(raw * 60));
  const s = String(raw ?? '').trim().toLowerCase();
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return check(Number(m[1]) * 60 + Number(m[2]));
  m = s.match(/^(\d+(?:\.\d+)?)\s?(?:h|hr|hrs|hour|hours)(?:\s*(?:and\s+)?(\d{1,2})\s?(?:m|min|mins|minute|minutes))?$/);
  if (m) return check(Math.round(Number(m[1]) * 60) + (Number(m[2]) || 0));
  m = s.match(/^(\d+)\s?(?:m|min|mins|minute|minutes)$/);
  if (m) return check(Number(m[1]));
  m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return check(Math.round(Number(m[1]) * 60));
  if (/^half an hour$/.test(s)) return check(30);
  if (/^an? hour$/.test(s)) return check(60);
  return { error: 'I could not read that as an amount of time.' };
}
function check(minutes) {
  if (!(minutes > 0)) return { error: 'I need some time to log.' };
  if (minutes > DAY) return { error: 'That is more than a day.' };
  return { value: minutes };
}

export const durationWords = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : null, m ? `${m} min` : null].filter(Boolean).join(' ') || '0 min';
};

const HOURS_SLOT = { key: 'hours', question: 'How long?', options: [{ label: '1 hour', value: '1h' }, { label: '2 hours', value: '2h' }, { label: '4 hours', value: '4h' }, { label: '8 hours', value: '8h' }], read: readDuration };

const log_time = {
  name: 'log_time',
  module: 'projects',
  kind: 'write',
  risk: 'low',
  permission: { resource: ['timesheets', 'tasks'], action: 'create' },
  // Not in a team group, where everyone would read the card.
  privateOnly: true,
  description: 'Log the user\'s own time on a project: "log 3 hours on Acme website", "I spent 90 minutes on the Kite app yesterday". '
    + 'Pass the project, the time as said in `hours`, the day (default today) and a note. It is saved as a draft timesheet entry.',
  params: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The project as named, or its code.' },
      hours: { type: 'string', description: 'The time as said ("3h", "90 minutes", "2.5").' },
      minutes: { type: 'number', description: 'The time in minutes, if already worked out.' },
      date: { type: 'string', description: 'The day, as said; default today.' },
      note: { type: 'string' },
      billable: { type: 'boolean' },
    },
    required: [],
  },
  slots: [{ key: 'project' }, { key: 'hours' }, { key: 'note', free: true, optional: true }],
  undoable: true,

  async resolve(args, ctx) {
    if (!ctx.employeeId) return notFound('You are not linked to a person in Team, so there is nobody to log the time for.');
    const live = (await loadKind('project', ctx)).filter((p) => !KINDS.project.inactive(p));
    const ref = String(args.project ?? '').trim();
    if (!ref) {
      if (!live.length) return notFound('There are no active projects to log time on.');
      return needsInput('project', 'Which project?', live.slice(0, 6).map((p) => ({ label: p.name, value: p.id })));
    }
    const r = await resolveEntity('project', ref, ctx, { filter: (p) => !KINDS.project.inactive(p) });
    if (r.status === 'many') return choiceFrom('project', 'project', r, (p) => p.status);
    if (r.status !== 'one') return notFound(`I couldn't find an active project matching “${ref}”.`);
    const hours = args.hours ?? (Number(args.minutes) > 0 ? `${Math.round(Number(args.minutes))} minutes` : undefined);
    const asked = await askNext({ hours }, [HOURS_SLOT], ctx);
    if (asked.needs) return asked;
    const d = args.date ? readDate(args.date, ctx.today, { prefer: 'past' }) : { value: ctx.today };
    if (d.error) return needsInput('date', `${d.error} Which day?`, [{ label: 'Today', value: ctx.today }]);
    return {
      args: {
        project: r.row.id, minutes: asked.values.hours, date: d.value || ctx.today,
        note: String(args.note ?? '').trim().slice(0, 500) || null,
        billable: args.billable !== false && args.billable !== 'false',
      },
      entities: [entityOf('project', r.row)],
    };
  },

  async validate(args, ctx) {
    if (args.date > ctx.today) return ['That day has not come yet. Time is logged for today or a day gone by.'];
    const { data } = await ctx.db.from('timesheet_entries').select('minutes').eq('employee_id', ctx.employeeId).eq('work_date', args.date);
    const already = (data || []).reduce((sum, r) => sum + (Number(r.minutes) || 0), 0);
    return already + args.minutes > DAY ? [`That would make ${durationWords(already + args.minutes)} on ${formatDate(args.date)} — more than a day. You have ${durationWords(already)} logged already.`] : [];
  },

  async preview(args, ctx) {
    const project = (await loadKind('project', ctx)).find((p) => p.id === args.project);
    return {
      title: 'Log time',
      target: project ? entityOf('project', project) : null,
      diff: [
        change('project', 'Project', null, project?.name || 'Project'),
        change('minutes', 'Time', null, durationWords(args.minutes)),
        change('date', 'Day', null, formatDate(args.date)),
        ...(args.note ? [change('note', 'Note', null, args.note)] : []),
        ...(args.billable ? [] : [change('billable', 'Billable', null, 'No')]),
      ],
      fields: [
        { key: 'date', label: 'Day', type: 'date', value: args.date },
        { key: 'note', label: 'Note', type: 'text', value: args.note || '' },
      ],
      confirmLabel: `Log ${durationWords(args.minutes)}`,
    };
  },

  plan(args, ctx) {
    return [{
      op: 'insert', table: 'timesheet_entries',
      row: {
        org_id: ctx.orgId, employee_id: ctx.employeeId, project_id: args.project, work_date: args.date,
        minutes: args.minutes, note: args.note || null, billable: !!args.billable, status: 'draft',
      },
    }];
  },

  summary(outcome, args) {
    const r = outcome.results[0];
    return r?.ok === false ? `Not logged: ${r.error}` : `Logged ${durationWords(args.minutes)} for ${formatDate(args.date)}. It is a draft until you submit your timesheet.`;
  },
};

export default [log_time];
