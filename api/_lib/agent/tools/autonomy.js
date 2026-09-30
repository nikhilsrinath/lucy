import { randomUUID } from 'node:crypto';
import { resolveEntity, entityOf, byId, forget } from '../resolvers.js';
import { change, choiceFrom, needsInput, notFound, readDate, formatDate, q } from '../helpers.js';
import { recipientChannel, recipientAccess, withheldFor, routineIssue, ROUTINE_MAX } from '../../telegram/outbound.js';
import { atLocal, readTime } from '../../autonomy/time.js';
import { liveWorkflows } from '../../autonomy/workflows.js';

/**
 * Follow-through, reminders and scheduled checks: the tools that hand work
 * to Buddy's durable engine (api/_lib/autonomy, 0072). Ordinary write tools —
 * same resolve → validate → preview → plan, same ai_actions row, same audit.
 *
 * What they write is the business record the person asked for (a task, as
 * that person, through RLS) and Buddy's own schedule (a workflow and its
 * jobs, service role, in the verified company). What happens later — the
 * reminder, the follow-up, the escalation — is done by the engine as its own
 * actions, each one decided by the company policy and audited.
 *
 * In a conversation these run as soon as the person asks (autonomy
 * interactive 'auto') when the policy allows: asking "make sure Swetha
 * follows up tomorrow" IS the decision; a card would only repeat it. A
 * reminder to someone else whose text is not routine goes back to a card.
 */

const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'them';
const active = (e) => !e.exited_at && !e.access_revoked_at;
const ready = (ctx) => ctx.autonomy?.ready === true;
const AUTO = Object.freeze({ class: 'autonomous', interactive: 'auto', widen: false });

async function readPerson(raw, ctx, param) {
  const ref = String(raw ?? '').trim();
  if (!ref) return needsInput(param, 'Who is it for?');
  if (/^(?:me|myself|i)$/i.test(ref)) {
    if (ctx.employeeId) return { row: { id: ctx.employeeId, full_name: ctx.user?.name || 'you' }, self: true };
    return notFound('You are not linked to a person in Team, so I cannot do that for you.');
  }
  if (!ctx.can('employees', 'view')) return notFound('Your role can\'t see the team, so I can\'t do that for someone else.');
  const r = await resolveEntity('employee', ref, ctx, { filter: active });
  if (r.status === 'one') return { row: r.row, self: r.row.id === ctx.employeeId };
  if (r.status === 'many') return choiceFrom(param, 'person', r, (e) => e.role || e.email);
  return notFound(`I couldn't find anyone called “${ref}” in your team.`);
}

function whenOf(args, ctx, { defaultTime = '09:00' } = {}) {
  const d = args.date ? readDate(args.date, ctx.today, { prefer: 'future' }) : { value: args.time ? ctx.today : undefined };
  if (d.error) return { needs: needsInput('date', `${d.error} When should it happen?`, [{ label: 'Tomorrow', value: 'tomorrow' }, { label: 'Friday', value: 'friday' }]).needs };
  if (!d.value) return { needs: needsInput('date', 'When?', [{ label: 'Tomorrow morning', value: 'tomorrow' }, { label: 'Friday', value: 'friday' }]).needs };
  const time = args.time ? readTime(args.time) : defaultTime;
  if (!time) return { needs: needsInput('time', `I couldn't read “${args.time}” as a time. What time?`, [{ label: '9 am', value: '9am' }, { label: '5 pm', value: '5pm' }]).needs };
  const [h, m] = time.split(':').map(Number);
  const runAt = atLocal(d.value, h, m, ctx.tz);
  if (Date.parse(runAt) <= Date.now()) return { needs: needsInput('time', 'That time has already passed. When should it be?', [{ label: 'In the evening', value: '6pm' }, { label: 'Tomorrow 9 am', value: '9am' }]).needs };
  return { date: d.value, time, runAt };
}

const initiatorOf = (ctx) => ({
  kind: ctx.actor?.kind === 'person' ? 'person' : 'user',
  userId: ctx.actor?.kind === 'person' ? null : ctx.user?.id || null,
  employeeId: ctx.employeeId || null,
  name: ctx.user?.name && ctx.user.name !== 'you' ? ctx.user.name : null,
});

/* ── start_followup ───────────────────────────────────────────────────────── */

const start_followup = {
  name: 'start_followup',
  module: 'tasks',
  kind: 'write',
  risk: 'low',
  permission: { resource: 'tasks', action: 'create' },
  privateOnly: true,
  autonomy: {
    ...AUTO,
    // What Buddy will tell the assignee comes from the title: routine only,
    // or it is a card the user confirms.
    when: (args) => {
      const text = `${args.title || ''} ${args.goal || ''}`.trim();
      return text ? routineIssue(text) : null;
    },
  },
  available: (ctx) => ready(ctx) && ctx.can('employees', 'view') && ctx.can('tasks', 'edit'),
  description: 'Make sure someone gets something done and FOLLOW THROUGH on it over the coming days: '
    + '"make sure Swetha follows up with the sponsor tomorrow", "ensure Ravi sends the deck by Friday", "keep after Madheswaran about the banner", '
    + '"chase Priya until the invoice list is done". Buddy creates the task (or uses the open task you name), tells the person on Telegram, reminds them on the day, '
    + 'follows up if it slips and tells the user if it stays overdue. Use create_task instead when the user only wants a task written down.',
  params: {
    type: 'object',
    properties: {
      person: { type: 'string', description: 'Who must do it, as the user named them ("Swetha").' },
      person_id: { type: 'string', description: 'Their id, only if you have it from list_team or the conversation.' },
      task: { type: 'string', description: 'What they must do, as a short imperative task title ("Follow up with the sponsor"), or the name of an existing open task.' },
      deadline: { type: 'string', description: 'By when, as said ("tomorrow", "Friday", "5th Oct").' },
      goal: { type: 'string', description: 'Optional one line of context ("sponsor for the demo day").' },
    },
    required: ['person', 'task'],
  },
  undoable: false,

  async resolve(args, ctx) {
    const who = await readPerson(args.person_id || args.person, ctx, 'person_id');
    if (who.needs || who.error) return who;
    // `title` / `task_id` are the canonical form a confirm re-resolves from.
    const title = String(args.task ?? args.title ?? '').trim();
    if (!title && !args.task_id) return needsInput('task', `What should ${first(who.row.full_name)} do?`);
    // An open task by that name is used; anything else is a new task. Never a guess.
    let existing = null;
    if (args.task_id) {
      existing = await byId('task', args.task_id, ctx);
      if (!existing || existing.status === 'done') return notFound('That task is no longer open.');
    } else {
      const t = await resolveEntity('task', title, ctx, { filter: (r) => r.status !== 'done' });
      if (t.status === 'one' && (!t.row.assignee_id || t.row.assignee_id === who.row.id)) existing = t.row;
    }
    const d = readDate(args.deadline ?? existing?.deadline ?? '', ctx.today, { prefer: 'future' });
    if (d.error || !d.value) {
      return needsInput('deadline', `${d.error ? `${d.error} ` : ''}By when should ${first(who.row.full_name)} have it done?`,
        [{ label: 'Today', value: 'today' }, { label: 'Tomorrow', value: 'tomorrow' }, { label: 'Friday', value: 'friday' }]);
    }
    return {
      args: {
        person_id: who.row.id,
        task_id: existing?.id || null,
        title: existing?.title || title.slice(0, 200),
        deadline: d.value,
        goal: args.goal ? String(args.goal).trim().slice(0, 300) : null,
      },
      targets: existing ? [{ table: 'tasks', id: existing.id, version: existing.updated_at }] : [],
      entities: [entityOf('employee', who.row), ...(existing ? [entityOf('task', existing)] : [])],
    };
  },

  async validate(args, ctx) {
    const problems = [];
    if (!args.title) problems.push('What should they do?');
    if (!args.deadline) problems.push('It needs a date to follow through against.');
    else if (args.deadline < ctx.today) problems.push('That date has already passed — pick today or later.');
    const person = await byId('employee', args.person_id, ctx);
    if (!person || person.exited_at) problems.push('I can only follow through with someone active in the team.');
    return problems;
  },

  async preview(args, ctx) {
    const person = await byId('employee', args.person_id, ctx);
    const name = person?.full_name || 'them';
    const s = ctx.autonomy?.policy?.settings || {};
    const channel = await recipientChannel(ctx.orgId, args.person_id);
    const plan = [
      channel.ok ? `tell ${first(name)} now on Telegram` : null,
      `remind ${first(name)} on ${formatDate(args.deadline)}`,
      'follow up if it slips',
      s.escalate === false ? null : `tell you if it's still open ${s.escalate_after_days || 2} days after`,
    ].filter(Boolean);
    return {
      title: `Follow through: ${args.title}`,
      diff: [
        change('task', args.task_id ? 'Task' : 'New task', null, args.title),
        change('assignee', 'Who', null, name),
        change('deadline', 'By', null, formatDate(args.deadline)),
      ],
      preview: { kind: 'followup', rows: [['How', plan.join(', ')]] },
      notes: channel.ok ? [] : [`${first(name)} isn't reachable on Telegram (${channel.message}) — I'll still track it and tell you if it slips.`],
    };
  },

  async plan(args, ctx) {
    const settings = ctx.autonomy?.policy?.settings || {};
    const person = await byId('employee', args.person_id, ctx);
    const workflow = (taskId) => ({
      op: 'workflow', orgId: ctx.orgId, taskId, assigneeId: args.person_id, initiator: initiatorOf(ctx), goal: args.goal || args.title,
      settings: { reminder_hour: settings.reminder_hour, escalate: settings.escalate, escalate_after_days: settings.escalate_after_days },
      key: 'workflow',
    });
    if (args.task_id) {
      const row = await byId('task', args.task_id, ctx);
      const patch = {};
      const before = {};
      if ((row.assignee_id ?? null) !== args.person_id) {
        Object.assign(patch, { assignee_id: args.person_id, assignee_label: person?.full_name || null });
        Object.assign(before, { assignee_id: row.assignee_id ?? null, assignee_label: row.assignee_label ?? null });
      }
      if ((row.deadline ?? null) !== args.deadline) { patch.deadline = args.deadline; before.deadline = row.deadline ?? null; }
      if (!Object.keys(patch).length) return [workflow(row.id)];
      return [{ op: 'update', table: 'tasks', id: row.id, version: row.updated_at, patch, before, label: row.title, then: () => [workflow(row.id)] }];
    }
    return [{
      op: 'insert', table: 'tasks',
      row: {
        org_id: ctx.orgId, title: args.title, description: args.goal || null, status: 'pending', priority: 'medium',
        deadline: args.deadline, assignee_id: args.person_id, assignee_label: person?.full_name || null,
      },
      then: (row) => [workflow(row.id)],
    }];
  },

  summary(outcome, args, ctx) {
    const wf = outcome.results.find((r) => r.op === 'workflow' && r.ok !== false);
    const task = outcome.results.find((r) => r.table === 'tasks' && r.ok !== false)?.after;
    const name = task?.assignee_label || 'them';
    if (!wf) {
      const why = outcome.warnings?.[0] || outcome.results.find((r) => r.ok === false)?.error || 'it could not be scheduled';
      return task ? `Saved ${q(task.title)}, but I couldn't set up the follow-through: ${why}` : `I couldn't set that up: ${why}`;
    }
    const s = ctx.autonomy?.policy?.settings || {};
    return `On it: I'll make sure ${first(name)} gets ${q(args.title)} done by **${formatDate(args.deadline)}** — a reminder on the day, `
      + `a follow-up if it slips${s.escalate === false ? '' : `, and I'll tell you if it's still open ${s.escalate_after_days || 2} days after`}.`;
  },

  async after(outcome, ctx) {
    forget(ctx, 'task');
    const wf = outcome.results.find((r) => r.op === 'workflow' && r.ok !== false);
    if (!wf?.after?.job_ids?.length) return null;
    // The kickoff message now, rather than at the next scheduled run.
    const { kick } = await import('../../autonomy/worker.js');
    const run = await kick(ctx.orgId, wf.after.job_ids);
    const job = run.jobs?.[0];
    if (!job) return null;
    if (job.status === 'deferred') return 'It’s quiet hours, so I’ll message them in the morning.';
    if (job.status === 'completed') return 'I’ve let them know on Telegram.';
    return null;
  },

  entitiesOf(outcome) {
    const row = outcome.results.find((r) => r.table === 'tasks')?.after;
    return row?.id ? [entityOf('task', row)] : [];
  },
  href: () => '/tasks',
};

/* ── stop following through ───────────────────────────────────────────────── */

const cancel_followup = {
  name: 'cancel_followup',
  module: 'tasks',
  kind: 'write',
  risk: 'low',
  permission: { resource: 'tasks', action: 'edit' },
  privateOnly: true,
  autonomy: AUTO,
  available: (ctx) => ready(ctx),
  description: 'Stop following through on a task (no more reminders, follow-ups or escalation): "stop chasing Swetha about the sponsor", "you can drop the deck follow-up".',
  params: { type: 'object', properties: { task: { type: 'string', description: 'The task being followed through, as the user named it.' } }, required: ['task'] },
  undoable: false,

  async resolve(args, ctx) {
    const ref = String(args.task ?? '').trim();
    if (!ref) return needsInput('task', 'Which one should I stop following through?');
    const t = await resolveEntity('task', ref, ctx);
    if (t.status === 'many') return choiceFrom('task', 'task', t, (r) => r.assignee_label || r.status);
    if (t.status !== 'one') return notFound(`I couldn't find a task matching “${ref}”.`);
    // The task was found through the person's own access; its workflow is looked up in this company only.
    const [wf] = await liveWorkflows(ctx.orgId, { taskId: t.row.id });
    if (!wf) return notFound(`I'm not following ${q(t.row.title)} through.`);
    return { args: { task: t.row.id, workflow_id: wf.id }, targets: [], entities: [entityOf('task', t.row)] };
  },
  validate() { return []; },
  async preview(args, ctx) {
    const row = await byId('task', args.task, ctx);
    return { title: 'Stop following through', target: row ? entityOf('task', row) : null, diff: [change('followup', 'Follow-through', 'On', 'Off')] };
  },
  async plan(args, ctx) {
    return [{ op: 'workflow_cancel', orgId: ctx.orgId, workflowId: args.workflow_id }];
  },
  summary(outcome) {
    const r = outcome.results[0];
    return r?.ok === false ? r.error : 'Stopped: no more reminders or follow-ups on it.';
  },
};

/* ── schedule_reminder ────────────────────────────────────────────────────── */

const schedule_reminder = {
  name: 'schedule_reminder',
  module: 'team',
  kind: 'write',
  risk: 'low',
  permission: { resource: ['notifications', 'tasks'], action: 'create' },
  privateOnly: true,
  autonomy: {
    ...AUTO,
    // A reminder to yourself is yours; to someone else it must be routine,
    // or it is a card like any message (it is a message, sent later).
    when: (args, ctx) => (args.recipient_person_id === ctx.employeeId ? null : routineIssue(args.message)),
  },
  available: (ctx) => ready(ctx),
  description: 'Remind someone (or the user) at a specific date and time, by a private Telegram message from Buddy: '
    + '"remind me tomorrow at 10 to call the sponsor", "remind Swetha at 5pm to send the deck", "ping Ravi on Friday morning about the banner". '
    + 'For work that needs following through until done, use start_followup; for a to-do without a time, create_task.',
  params: {
    type: 'object',
    properties: {
      person: { type: 'string', description: '"me", or the person as the user named them.' },
      person_id: { type: 'string', description: 'Their id, only if you have it.' },
      message: { type: 'string', description: 'What to remind them of, short, in the user\'s words ("call the sponsor about the demo day").' },
      date: { type: 'string', description: 'The day, as said ("tomorrow", "Friday"); default today.' },
      time: { type: 'string', description: 'The time, as said ("10", "10:30am", "5 pm"); default 9 am.' },
    },
    required: ['person', 'message'],
  },
  // Undo cancels it, if it has not gone out yet.
  undoable: true,

  async resolve(args, ctx) {
    const who = await readPerson(args.recipient_person_id || args.person_id || args.person, ctx, 'person_id');
    if (who.needs || who.error) return who;
    const message = String(args.message ?? '').trim();
    if (!message) return needsInput('message', 'What should the reminder say?');
    const when = whenOf(args, ctx);
    if (when.needs) return { needs: when.needs };
    return {
      args: { recipient_person_id: who.row.id, message: message.slice(0, ROUTINE_MAX + 1), date: when.date, time: when.time },
      targets: [],
      entities: who.self ? [] : [entityOf('employee', who.row)],
    };
  },

  async validate(args, ctx) {
    const problems = [];
    if (!args.message) problems.push('The reminder is empty.');
    if (String(args.message || '').length > ROUTINE_MAX) problems.push(`Keep a reminder under ${ROUTINE_MAX} characters.`);
    const channel = await recipientChannel(ctx.orgId, args.recipient_person_id);
    if (!channel.ok) {
      problems.push(channel.message);
      return problems;
    }
    const withheld = withheldFor(args.message, await recipientAccess(ctx.orgId, channel.person), first(channel.person.full_name));
    if (withheld) problems.push(withheld);
    return problems;
  },

  async preview(args, ctx) {
    const self = args.recipient_person_id === ctx.employeeId;
    const { person } = await recipientChannel(ctx.orgId, args.recipient_person_id);
    return {
      title: self ? 'Reminder for you' : `Reminder for ${person?.full_name || 'them'}`,
      diff: [
        change('when', 'When', null, `${formatDate(args.date)} at ${args.time}`),
        change('message', 'Reminder', null, args.message),
      ],
      preview: { kind: 'reminder', rows: [['Via', 'Telegram · private chat with Buddy']], note: 'Sent at Buddy’s first scheduled run after this time.' },
      fields: [{ key: 'message', label: 'Reminder', type: 'textarea', value: args.message }],
    };
  },

  async plan(args, ctx) {
    const [h, m] = String(args.time).split(':').map(Number);
    return [{
      op: 'job', orgId: ctx.orgId, kind: 'reminder_due', dedupeKey: `reminder:${randomUUID()}`,
      runAt: atLocal(args.date, h, m, ctx.tz), actor: { kind: 'buddy' },
      payload: { recipient_person_id: args.recipient_person_id, text: args.message, initiator: initiatorOf(ctx) },
    }];
  },

  summary(outcome, args, ctx) {
    const r = outcome.results[0];
    if (!r || r.ok === false) return `The reminder was not scheduled: ${r?.error || 'something went wrong.'}`;
    const who = args.recipient_person_id === ctx.employeeId ? 'you' : 'them';
    return `I'll remind ${who} on **${formatDate(args.date)} at ${args.time}** on Telegram.`;
  },
};

/* ── schedule_buddy_check ─────────────────────────────────────────────────── */

const schedule_buddy_check = {
  name: 'schedule_buddy_check',
  module: 'core',
  kind: 'write',
  risk: 'low',
  permission: { resource: ['notifications', 'tasks'], action: 'create' },
  privateOnly: true,
  // It hands Buddy a future turn with the user's own access, so scheduling it
  // takes one tap (its later actions still go through the policy).
  autonomy: { class: 'autonomous', interactive: 'review', widen: false },
  // Runs later in the asker's own session; a person without a login has no
  // app to review what it might prepare, so it is for users.
  available: (ctx) => ready(ctx) && ctx.actor?.kind === 'user' && !!ctx.employeeId,
  description: 'Have Buddy check something LATER on its own and report back on Telegram: "on Friday check whether Swetha finished the deck and tell me", '
    + '"tomorrow evening see if the sponsor task is done". Buddy looks it up then (with the user\'s own access), does only what the company allows it to do on its own, and sends a short report.',
  params: {
    type: 'object',
    properties: {
      instruction: { type: 'string', description: 'What to check and do, in the user\'s words.' },
      date: { type: 'string', description: 'When, as said ("Friday", "tomorrow").' },
      time: { type: 'string', description: 'Optional time ("6pm"); default 9 am.' },
    },
    required: ['instruction', 'date'],
  },
  undoable: true,

  async resolve(args, ctx) {
    const instruction = String(args.instruction ?? '').trim();
    if (!instruction) return needsInput('instruction', 'What should I check?');
    const when = whenOf(args, ctx);
    if (when.needs) return { needs: when.needs };
    return { args: { instruction: instruction.slice(0, 500), date: when.date, time: when.time }, targets: [] };
  },
  validate(args) { return args.instruction ? [] : ['What should I check?']; },
  async preview(args) {
    return {
      title: 'Scheduled check',
      diff: [change('when', 'When', null, `${formatDate(args.date)} at ${args.time}`), change('instruction', 'Check', null, args.instruction)],
      preview: { kind: 'check', rows: [['Report', 'To you on Telegram']] },
    };
  },
  async plan(args, ctx) {
    const [h, m] = String(args.time).split(':').map(Number);
    return [{
      op: 'job', orgId: ctx.orgId, kind: 'buddy_review', dedupeKey: `check:${randomUUID()}`,
      runAt: atLocal(args.date, h, m, ctx.tz), actor: { kind: 'user', userId: ctx.user.id },
      payload: { instruction: args.instruction, report_to: ctx.employeeId, asked_on: ctx.today },
    }];
  },
  summary(outcome, args) {
    const r = outcome.results[0];
    if (!r || r.ok === false) return `The check was not scheduled: ${r?.error || 'something went wrong.'}`;
    return `I'll check on **${formatDate(args.date)} at ${args.time}** and send you what I find on Telegram.`;
  },
};

export default [start_followup, cancel_followup, schedule_reminder, schedule_buddy_check];
