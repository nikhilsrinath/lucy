import { resolveEntity, loadKind, entityOf, normalize, isUuid } from '../resolvers.js';
import {
  askNext, change, choiceFrom, needsInput, notFound, formatDate, readDate, q,
} from '../helpers.js';
import { countLeaveDays, rangesOverlap } from '../../../../src/shared/leave.js';
import { firstName } from './people.js';

/**
 * Leave: applying, deciding, withdrawing.
 *
 * The rules that matter are in the database (0029), and these tools only
 * say them early rather than let a confirm fail:
 *   · a request is always filed as pending, whoever files it;
 *   · nobody decides their own request (app.guard_leave_decision);
 *   · the applicant's only move afterwards is to withdraw a pending one.
 * Days are counted by the same function the leave form uses (src/shared/leave.js).
 *
 * Applying for your own leave is ordinary staff work, allowed by the table's
 * own "self" policy whatever the role's leave permission says — so the tool
 * is offered to anyone who can create tasks, and filing for someone else
 * asks for the leave permission itself.
 */

const active = (e) => !e.exited_at;

async function leaveTypes(ctx) {
  if (ctx.cache?.has('leave_types')) return ctx.cache.get('leave_types');
  const { data } = await ctx.db.from('leave_types').select('id, name, code, is_active, sort_order').eq('org_id', ctx.orgId);
  const rows = (data || []).filter((t) => t.is_active !== false).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  ctx.cache?.set('leave_types', rows);
  return rows;
}

/** "sick", "SL", "Sick leave" or an id → the company's leave type. */
function matchType(raw, types) {
  const s = String(raw ?? '').trim();
  const said = normalize(s.replace(/\bleaves?\b/gi, ' '));
  const hits = types.filter((t) => t.id === s || normalize(t.name) === normalize(s) || (t.code && t.code.toLowerCase() === s.toLowerCase())
    || (said && normalize(t.name).split(' ').includes(said)));
  return hits.length === 1 ? hits[0] : null;
}

async function namesById(ctx) {
  const people = await loadKind('employee', ctx);
  return (id) => people.find((e) => e.id === id)?.full_name || 'Someone';
}

const span = (r) => (r.start_date === r.end_date ? formatDate(r.start_date) : `${formatDate(r.start_date)} to ${formatDate(r.end_date)}`);
const dayWord = (n) => `${n} day${Number(n) === 1 ? '' : 's'}`;
const truthy = (v) => v === true || /^(?:true|yes|y|1)$/i.test(String(v ?? ''));

function dateSlots(types) {
  return [
    {
      key: 'leave_type', question: 'Which kind of leave?',
      options: types.slice(0, 8).map((t) => ({ label: t.name, value: t.id })),
      read: (raw) => { const t = matchType(raw, types); return t ? { value: t.id } : { error: 'I did not catch that.' }; },
    },
    {
      key: 'start_date', question: 'From which day?',
      options: (_v, ctx) => [{ label: 'Today', value: ctx.today }, { label: 'Tomorrow', value: 'tomorrow' }],
      read: (raw, ctx) => { const d = readDate(raw, ctx.today, { prefer: 'future' }); return d.error || !d.value ? { error: d.error || 'I could not read that date.' } : { value: d.value }; },
    },
    {
      key: 'end_date', optional: true, when: (v) => !v.half_day,
      question: 'Until which day?',
      options: [{ label: 'Just that day', value: 'skip' }],
      read: (raw, ctx, v) => {
        if (/^(?:same|same day|just that day|one day|only that day)$/i.test(String(raw).trim())) return { value: v.start_date };
        // "tomorrow" means tomorrow, not the day after the leave starts; a weekday
        // that would fall before the start is the one after it.
        let d = readDate(raw, ctx.today, { prefer: 'future' });
        if (!d.error && d.value && d.value < v.start_date) d = readDate(raw, v.start_date, { prefer: 'future' });
        if (d.error || !d.value) return { error: d.error || 'I could not read that date.' };
        return d.value < v.start_date ? { error: 'It cannot end before it starts.' } : { value: d.value };
      },
    },
  ];
}

/* ── apply ────────────────────────────────────────────────────────────────── */

const apply_leave = {
  name: 'apply_leave',
  module: 'people',
  kind: 'write',
  risk: 'low',
  permission: { resource: ['leave_requests', 'tasks'], action: 'create' },
  // Not in a team group, where everyone would read the card.
  privateOnly: true,
  description: 'File a leave request: "apply for leave tomorrow", "sick leave from 5th to 7th Oct", "half day on Friday". It is for the user unless they name someone else. '
    + 'Pass what was said; the kind of leave and the dates are asked for if missing. It is filed as pending for whoever approves leave.',
  params: {
    type: 'object',
    properties: {
      employee: { type: 'string', description: '"me" (default), or the person as named.' },
      leave_type: { type: 'string', description: 'The kind as said ("sick", "casual").' },
      start_date: { type: 'string' }, end_date: { type: 'string', description: 'Leave out for a single day.' },
      half_day: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: [],
  },
  slots: [{ key: 'leave_type' }, { key: 'start_date' }, { key: 'end_date', optional: true }, { key: 'reason', free: true, optional: true }],
  // Withdrawn with cancel_leave: the applicant's own policy has no delete.
  undoable: false,

  async resolve(args, ctx) {
    const ref = String(args.employee ?? 'me').trim() || 'me';
    let person;
    if (/^(?:me|myself|i|mine)$/i.test(ref) || ref === ctx.employeeId) {
      if (!ctx.employeeId) return notFound('You are not linked to a person in Team, so I cannot file leave for you.');
      person = { id: ctx.employeeId, full_name: ctx.user?.name || 'you', self: true };
    } else {
      if (!ctx.can('leave_requests', 'create')) return notFound('Your role can file your own leave, not someone else’s.');
      const r = await resolveEntity('employee', ref, ctx, { filter: active });
      if (r.status === 'many') return choiceFrom('employee', 'person', r, (e) => e.role || e.email);
      if (r.status !== 'one') return notFound(`I couldn't find anyone called “${ref}” in your team.`);
      person = r.row;
    }
    const types = await leaveTypes(ctx);
    if (!types.length) return notFound('No leave types are set up yet. Add them under Team → Leave, then ask me again.');

    const halfDay = truthy(args.half_day);
    const merged = { ...args, half_day: halfDay };
    if (!merged.leave_type && types.length === 1) merged.leave_type = types[0].id;
    const asked = await askNext(merged, [{ key: 'half_day', read: (v) => ({ value: truthy(v) }) }, ...dateSlots(types)], ctx);
    if (asked.needs) return asked;
    const v = asked.values;
    return {
      args: {
        employee: person.id, leave_type: v.leave_type,
        start_date: v.start_date, end_date: v.end_date || v.start_date,
        half_day: halfDay, reason: String(args.reason ?? '').trim().slice(0, 500) || null,
      },
      entities: person.self ? [] : [entityOf('employee', person)],
    };
  },

  async validate(args, ctx) {
    const days = countLeaveDays(args.start_date, args.end_date, { halfDay: args.half_day });
    if (!days) return ['Those dates do not make a leave: the end cannot be before the start.'];
    const { data } = await ctx.db.from('leave_requests').select('id, start_date, end_date, status').eq('employee_id', args.employee).in('status', ['pending', 'approved']);
    const clash = (data || []).find((r) => rangesOverlap(args.start_date, args.end_date, r.start_date, r.end_date));
    return clash ? [`There is already ${clash.status === 'approved' ? 'approved leave' : 'a leave request waiting'} for ${span(clash)}.`] : [];
  },

  async preview(args, ctx) {
    const type = (await leaveTypes(ctx)).find((t) => t.id === args.leave_type);
    const days = countLeaveDays(args.start_date, args.end_date, { halfDay: args.half_day });
    const self = args.employee === ctx.employeeId;
    const name = self ? null : (await namesById(ctx))(args.employee);
    return {
      title: self ? 'Apply for leave' : `Apply for leave for ${name}`,
      diff: [
        ...(self ? [] : [change('employee', 'For', null, name)]),
        change('leave_type', 'Kind', null, type?.name || 'Leave'),
        change('dates', 'Dates', null, span(args)),
        change('days', 'Days', null, args.half_day ? 'Half a day' : dayWord(days)),
        ...(args.reason ? [change('reason', 'Reason', null, args.reason)] : []),
      ],
      fields: [
        { key: 'start_date', label: 'From', type: 'date', value: args.start_date },
        { key: 'end_date', label: 'To', type: 'date', value: args.end_date },
        { key: 'reason', label: 'Reason', type: 'textarea', value: args.reason || '' },
      ],
      confirmLabel: 'Send for approval',
    };
  },

  plan(args, ctx) {
    return [{
      op: 'insert', table: 'leave_requests', key: 'leave',
      row: {
        org_id: ctx.orgId, employee_id: args.employee, leave_type_id: args.leave_type,
        start_date: args.start_date, end_date: args.end_date,
        days: countLeaveDays(args.start_date, args.end_date, { halfDay: args.half_day }),
        half_day: !!args.half_day, reason: args.reason || null,
      },
    }];
  },

  summary(outcome) {
    const row = outcome.results[0]?.after;
    return row ? `Filed ${row.half_day ? 'a half day' : dayWord(row.days)} of leave for ${span(row)}. It is waiting for approval.` : `Not filed: ${outcome.results[0]?.error || 'the request could not be saved.'}`;
  },
};

/* ── decide ───────────────────────────────────────────────────────────────── */

const DECISIONS = [{ label: 'Approve', value: 'approved' }, { label: 'Reject', value: 'rejected' }];
function readDecision(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^(?:approve|approved|accept|accepted|grant|granted|sanction|ok|okay|yes)$/.test(s)) return 'approved';
  if (/^(?:reject|rejected|decline|declined|deny|denied|refuse|refused|no)$/.test(s)) return 'rejected';
  return null;
}

async function requestById(id, ctx) {
  const { data } = await ctx.db.from('leave_requests').select('*').eq('id', id).maybeSingle();
  return data || null;
}

async function describe(row, ctx) {
  const type = (await leaveTypes(ctx)).find((t) => t.id === row.leave_type_id);
  return `${span(row)} · ${type?.name || 'Leave'} · ${row.half_day ? 'half day' : dayWord(row.days)}`;
}

const decide_leave = {
  name: 'decide_leave',
  module: 'people',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'leave_requests', action: 'edit' },
  // Not in a team group, where everyone would read the card.
  privateOnly: true,
  description: 'Approve or reject a pending leave request: "approve Ravi\'s leave", "reject Priya\'s leave, the launch is that week". '
    + 'Pass the person and the decision; a reason goes in `comment`. Nobody can decide their own request.',
  params: {
    type: 'object',
    properties: {
      employee: { type: 'string', description: 'Whose request, as named.' },
      request: { type: 'string', description: 'The request id, only if you have it from list_leave.' },
      decision: { type: 'string', enum: ['approved', 'rejected'] },
      comment: { type: 'string', description: 'A note to the applicant, optional.' },
    },
    required: [],
  },
  slots: [{ key: 'comment', free: true, optional: true }],
  undoable: false,

  async resolve(args, ctx) {
    let row = args.request && isUuid(args.request) ? await requestById(args.request, ctx) : null;
    if (!row) {
      let q0 = ctx.db.from('leave_requests').select('*').eq('org_id', ctx.orgId).eq('status', 'pending');
      let who = null;
      const ref = String(args.employee ?? '').trim();
      if (ref) {
        const r = await resolveEntity('employee', ref, ctx, { filter: active });
        if (r.status === 'many') return choiceFrom('employee', 'person', r, (e) => e.role || e.email);
        if (r.status !== 'one') return notFound(`I couldn't find anyone called “${ref}” in your team.`);
        who = r.row;
        q0 = q0.eq('employee_id', who.id);
      }
      const { data } = await q0;
      const waiting = (data || []).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
      if (!waiting.length) return notFound(who ? `${who.full_name} has no leave request waiting.` : 'No leave requests are waiting.');
      if (waiting.length > 1) {
        const name = await namesById(ctx);
        const options = [];
        for (const r of waiting.slice(0, 6)) options.push({ label: `${who ? '' : `${firstName(name(r.employee_id))} · `}${await describe(r, ctx)}`, value: r.id });
        return needsInput('request', 'Which request?', options);
      }
      row = waiting[0];
    }
    if (row.status !== 'pending') return notFound('That request has already been decided.');
    const decision = readDecision(args.decision);
    if (!decision) return needsInput('decision', `Approve or reject ${firstName((await namesById(ctx))(row.employee_id))}’s leave for ${span(row)}?`, DECISIONS);
    return {
      args: { request: row.id, decision, comment: String(args.comment ?? '').trim().slice(0, 500) || null },
      targets: [{ table: 'leave_requests', id: row.id, version: row.updated_at }],
    };
  },

  async validate(args, ctx) {
    const row = await requestById(args.request, ctx);
    if (!row) return ['That request is no longer visible to you.'];
    if (row.employee_id === ctx.employeeId) return ['You cannot decide your own leave request. Someone else who approves leave has to.'];
    return [];
  },

  async preview(args, ctx) {
    const row = await requestById(args.request, ctx);
    const name = (await namesById(ctx))(row.employee_id);
    const approve = args.decision === 'approved';
    return {
      title: `${approve ? 'Approve' : 'Reject'} leave for ${name}`,
      preview: {
        kind: 'record',
        rows: [['Who', name], ['Leave', await describe(row, ctx)], ['Reason given', row.reason || '—'], ['Your note', args.comment || '—']],
        note: `${firstName(name)} is told as soon as this is confirmed.`,
      },
      fields: [{ key: 'comment', label: 'Note to them', type: 'textarea', value: args.comment || '' }],
      confirmLabel: approve ? 'Approve leave' : 'Reject leave',
    };
  },

  async plan(args, ctx) {
    const row = await requestById(args.request, ctx);
    return [{
      op: 'update', table: 'leave_requests', id: row.id, version: row.updated_at,
      patch: { status: args.decision, decision_comment: args.comment || null },
      before: { status: row.status, decision_comment: row.decision_comment ?? null },
    }];
  },

  summary(outcome, args) {
    const r = outcome.results[0];
    return r?.ok === false ? `Not saved: ${r.error}` : `${args.decision === 'approved' ? 'Approved' : 'Rejected'} the leave for ${span(r.after)}.`;
  },
};

/* ── withdraw ─────────────────────────────────────────────────────────────── */

const cancel_leave = {
  name: 'cancel_leave',
  module: 'people',
  kind: 'write',
  risk: 'low',
  permission: { resource: ['leave_requests', 'tasks'], action: 'edit' },
  // Not in a team group, where everyone would read the card.
  privateOnly: true,
  description: 'Withdraw the user\'s own pending leave request: "cancel my leave", "withdraw my leave request". Only a request still waiting can be withdrawn.',
  params: { type: 'object', properties: { request: { type: 'string', description: 'The request id, if known.' } }, required: [] },
  undoable: false,

  async resolve(args, ctx) {
    if (!ctx.employeeId) return notFound('You are not linked to a person in Team, so there is no leave of yours to withdraw.');
    const { data } = await ctx.db.from('leave_requests').select('*').eq('employee_id', ctx.employeeId).eq('status', 'pending');
    const mine = (data || []).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
    const row = args.request ? mine.find((r) => r.id === args.request) : mine.length === 1 ? mine[0] : null;
    if (!mine.length) return notFound('You have no leave request waiting. Approved leave is changed by whoever approves it.');
    if (!row) {
      const options = [];
      for (const r of mine.slice(0, 6)) options.push({ label: await describe(r, ctx), value: r.id });
      return needsInput('request', 'Which request should I withdraw?', options);
    }
    return { args: { request: row.id }, targets: [{ table: 'leave_requests', id: row.id, version: row.updated_at }] };
  },

  validate() { return []; },

  async preview(args, ctx) {
    const row = await requestById(args.request, ctx);
    return {
      title: 'Withdraw leave request',
      diff: [change('leave', 'Leave', await describe(row, ctx), null), change('status', 'Status', 'Pending', 'Cancelled')],
      confirmLabel: 'Withdraw request',
    };
  },

  async plan(args, ctx) {
    const row = await requestById(args.request, ctx);
    return [{ op: 'update', table: 'leave_requests', id: row.id, version: row.updated_at, patch: { status: 'cancelled' }, before: { status: row.status } }];
  },

  summary(outcome) {
    const r = outcome.results[0];
    return r?.ok === false ? `Not withdrawn: ${r.error}` : `Withdrew your leave request for ${q(span(r.after))}.`;
  },
};

export default [apply_leave, decide_leave, cancel_leave];
