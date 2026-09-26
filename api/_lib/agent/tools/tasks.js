import {
  resolveEntity, resolveMany, loadKind, byId, entityOf, forget, isBackReference,
} from '../resolvers.js';
import {
  change, choiceFrom, needsInput, notFound, readDate, formatDate, formatDateShort, q,
} from '../helpers.js';

/**
 * Tasks: create, change, complete, reopen, delete.
 *
 * One update tool covers every field, so "it's rescheduled to 2nd October",
 * "give it to Ravi" and "make it high priority" are all update_task with a
 * different argument, and a batch ("mark all the Acme tasks done") is the same
 * tool with several targets. The model names tasks the way the person did;
 * resolveEntity turns that into ids, and anything ambiguous comes back as a
 * choice instead of a guess.
 */

const STATUS_WORDS = [
  ['done', /^(?:done|complete[d]?|finish(?:ed)?|closed?|resolved)$/i],
  ['in_progress', /^(?:in[\s_-]?progress|started|doing|working|wip|ongoing|active)$/i],
  ['pending', /^(?:pending|to[\s-]?do|not started|open|reopen(?:ed)?|backlog|new)$/i],
];
const STATUS_LABEL = { pending: 'Pending', in_progress: 'In progress', done: 'Done', overdue: 'Overdue' };
const PRIORITIES = ['low', 'medium', 'high'];

export function readStatus(v) {
  const s = String(v ?? '').trim();
  for (const [key, re] of STATUS_WORDS) if (re.test(s)) return key;
  return null;
}

function readPriority(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (PRIORITIES.includes(s)) return s;
  if (/^(?:urgent|critical|top|asap|important)$/.test(s)) return 'high';
  if (/^(?:normal|default|med)$/.test(s)) return 'medium';
  if (/^(?:minor|whenever|someday)$/.test(s)) return 'low';
  return null;
}

const CLEAR_REF = /^(?:none|nobody|no one|unassign(?:ed)?|remove|clear|general|no project)$/i;

const isOverdue = (row, today) => row.status !== 'done' && !!row.deadline && row.deadline < today;

const taskSub = (row) => [
  row.deadline ? `due ${formatDateShort(row.deadline)}` : null,
  STATUS_LABEL[row.status] || row.status,
  row.assignee_label || null,
].filter(Boolean).join(' · ');

/* ── shared resolution ────────────────────────────────────────────────────── */

async function resolveTargets(args, ctx, { param = 'task' } = {}) {
  const refs = Array.isArray(args.tasks) && args.tasks.length ? args.tasks
    : args.task != null && args.task !== '' ? [args.task] : [];
  if (!refs.length) {
    // "it" with nothing said: the task in play in this chat, else ask.
    const r = await resolveEntity('task', 'it', ctx);
    if (r.status === 'one') return { rows: [r.row] };
    return needsInput(param, 'Which task?');
  }
  if (refs.length === 1) {
    const r = await resolveEntity('task', refs[0], ctx);
    if (r.status === 'one') return { rows: [r.row] };
    if (r.status === 'many') return choiceFrom(param, 'task', r, taskSub);
    // "it" / "the task" with nothing in this conversation to point at.
    if (isBackReference(refs[0])) return needsInput(param, 'Which task?');
    return notFound(`I looked for ${r.searched} and found none.`,
      String(refs[0]).length > 2 && !/^(it|that|this)/i.test(refs[0])
        ? { tool: 'create_task', args: { title: String(refs[0]) }, label: `Create task “${refs[0]}”` } : null);
  }
  if (refs.length > 25) return { error: 'I can change at most 25 tasks at once. Narrow it down and ask again.' };
  const { found, problems } = await resolveMany('task', refs, ctx);
  if (!found.length) return notFound('None of those tasks matched anything I can see.');
  return { rows: found.map((f) => f.row), skipped: problems.map((p) => String(p.ref)) };
}

async function readAssignee(raw, ctx) {
  if (raw === undefined) return { value: undefined };
  if (raw === null || CLEAR_REF.test(String(raw).trim())) return { value: null };
  if (/^(?:me|myself|i)$/i.test(String(raw).trim())) {
    if (ctx.employeeId) return { value: ctx.employeeId };
    return { error: 'You are not linked to an employee record, so I cannot assign it to you.' };
  }
  const r = await resolveEntity('employee', raw, ctx, { filter: (e) => !e.exited_at });
  if (r.status === 'one') return { value: r.row.id };
  if (r.status === 'many') return choiceFrom('assignee', 'person', r, (e) => e.role || e.email);
  return notFound(`I could not find anyone called “${raw}” on the team.`);
}

async function readProject(raw, ctx) {
  if (raw === undefined) return { value: undefined };
  if (raw === null || CLEAR_REF.test(String(raw).trim())) return { value: null };
  const r = await resolveEntity('project', raw, ctx);
  if (r.status === 'one') return { value: r.row.id };
  if (r.status === 'many') return choiceFrom('project', 'project', r, (p) => p.status);
  return notFound(`I could not find a project matching “${raw}”.`);
}

/** The changes an update asked for, read and resolved. */
async function readChanges(args, ctx) {
  const out = {};
  if (args.title !== undefined && String(args.title).trim()) out.title = String(args.title).trim().slice(0, 200);
  if (args.description !== undefined) out.description = String(args.description ?? '').trim() || null;
  if (args.deadline !== undefined) {
    const d = readDate(args.deadline, ctx.today, { prefer: 'future' });
    if (d.error) return needsInput('deadline', `${d.error} What should the deadline be?`,
      [{ label: 'Tomorrow', value: 'tomorrow' }, { label: 'Next Friday', value: 'next friday' }, { label: 'End of month', value: 'end of month' }]);
    if (d.value !== undefined) out.deadline = d.value;
  }
  if (args.status !== undefined) {
    const s = readStatus(args.status);
    if (!s) return needsInput('status', 'Which status?', [
      { label: 'Pending', value: 'pending' }, { label: 'In progress', value: 'in_progress' }, { label: 'Done', value: 'done' }]);
    out.status = s;
  }
  if (args.priority !== undefined) {
    const p = readPriority(args.priority);
    if (!p) return needsInput('priority', 'Which priority?', PRIORITIES.map((x) => ({ label: x[0].toUpperCase() + x.slice(1), value: x })));
    out.priority = p;
  }
  const a = await readAssignee(args.assignee, ctx);
  if (a.needs || a.error) return a;
  if (a.value !== undefined) out.assignee = a.value;
  const p = await readProject(args.project, ctx);
  if (p.needs || p.error) return p;
  if (p.value !== undefined) out.project = p.value;
  return { changes: out };
}

/* ── how a change reads ───────────────────────────────────────────────────── */

async function display(field, value, ctx) {
  if (value === null || value === undefined) return field === 'assignee' ? 'Unassigned' : field === 'project' ? 'General' : null;
  if (field === 'deadline') return formatDate(value);
  if (field === 'status') return STATUS_LABEL[value] || value;
  if (field === 'priority') return value[0].toUpperCase() + value.slice(1);
  if (field === 'assignee') return (await byId('employee', value, ctx))?.full_name || 'Someone';
  if (field === 'project') {
    const p = await byId('project', value, ctx);
    return p ? `${p.code} · ${p.name}` : 'A project';
  }
  return value;
}

const FIELD_LABEL = {
  title: 'Title', description: 'Description', deadline: 'Deadline', status: 'Status',
  priority: 'Priority', assignee: 'Assignee', project: 'Project',
};
const COLUMN = {
  title: 'title', description: 'description', deadline: 'deadline', status: 'status',
  priority: 'priority', assignee: 'assignee_id', project: 'project_id',
};

/** The part of `changes` that would actually change `row`. */
function effective(row, changes) {
  const out = {};
  for (const [field, value] of Object.entries(changes)) {
    if ((row[COLUMN[field]] ?? null) !== (value ?? null)) out[field] = value;
  }
  return out;
}

async function diffFor(row, changes, ctx) {
  const rows = [];
  for (const [field, value] of Object.entries(changes)) {
    const before = row[COLUMN[field]] ?? null;
    const from = field === 'deadline' && before ? formatDateShort(before, ctx.today) : await display(field, before, ctx);
    rows.push(change(field, FIELD_LABEL[field], from, await display(field, value, ctx)));
  }
  return rows;
}

async function patchFor(row, changes, ctx) {
  const patch = {};
  const before = {};
  for (const [field, value] of Object.entries(changes)) {
    const col = COLUMN[field];
    patch[col] = value;
    before[col] = row[col] ?? null;
    if (field === 'assignee') {
      patch.assignee_label = value ? (await byId('employee', value, ctx))?.full_name || null : null;
      before.assignee_label = row.assignee_label ?? null;
    }
    if (field === 'project' && (row.project_id ?? null) !== (value ?? null)) {
      // A milestone belongs to one project; moving the task empties it
      // rather than letting app.task_project_guard refuse the write.
      patch.milestone_id = null;
    }
  }
  return { patch, before };
}

function editableFields(changes, ctx) {
  const fields = [];
  for (const field of Object.keys(changes)) {
    if (field === 'deadline') fields.push({ key: 'deadline', label: 'Deadline', type: 'date', value: changes.deadline || '', min: null });
    if (field === 'status') fields.push({ key: 'status', label: 'Status', type: 'select', value: changes.status, options: Object.entries(STATUS_LABEL).filter(([k]) => k !== 'overdue').map(([value, label]) => ({ value, label })) });
    if (field === 'priority') fields.push({ key: 'priority', label: 'Priority', type: 'select', value: changes.priority, options: PRIORITIES.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) })) });
    if (field === 'title') fields.push({ key: 'title', label: 'Title', type: 'text', value: changes.title });
    if (field === 'description') fields.push({ key: 'description', label: 'Description', type: 'textarea', value: changes.description || '' });
  }
  void ctx;
  return fields;
}

/* ── update (and the status shortcuts) ────────────────────────────────────── */

const TARGET_PARAMS = {
  task: { type: 'string', description: 'The task, as the user referred to it: its title or part of it ("the pricing one"), "it"/"that task" for the one just discussed, or its id from an earlier result.' },
  tasks: { type: 'array', items: { type: 'string' }, description: 'Several tasks for one batch change (max 25) — ids from list_tasks, or titles.' },
};

function updateTool({ name, description, fixed = null, extraParams = {}, required = [] }) {
  return {
    name,
    module: 'tasks',
    kind: 'write',
    risk: 'low',
    permission: { resource: 'tasks', action: 'edit' },
    description,
    params: {
      type: 'object',
      properties: { ...TARGET_PARAMS, ...extraParams },
      required,
    },
    undoable: true,

    async resolve(args, ctx) {
      const target = await resolveTargets(args, ctx);
      if (target.needs || target.error) return target;
      const read = await readChanges(fixed ? { ...args, ...fixed } : args, ctx);
      if (read.needs || read.error) return read;
      if (!Object.keys(read.changes).length) {
        return { error: 'No change was named. Pass the field that should change (deadline, status, priority, assignee, title, project or description).' };
      }
      const rows = target.rows;
      const canonical = { tasks: rows.map((r) => r.id), ...toArgs(read.changes) };
      return {
        args: canonical,
        targets: rows.map((r) => ({ table: 'tasks', id: r.id, version: r.updated_at })),
        entities: rows.map((r) => entityOf('task', r)),
        notes: target.skipped?.length ? [`Not included (no single match): ${target.skipped.join(', ')}`] : [],
      };
    },

    async validate(args, ctx) {
      const rows = await rowsOf(args, ctx);
      const changes = await changesOf(args, ctx);
      const live = rows.filter((r) => Object.keys(effective(r, changes)).length);
      if (!live.length) {
        return [rows.length === 1
          ? `${q(rows[0].title)} is already set that way — there is nothing to change.`
          : 'Those tasks are already set that way — there is nothing to change.'];
      }
      if (changes.title !== undefined && !changes.title) return ['A task needs a title.'];
      return [];
    },

    async preview(args, ctx) {
      const rows = await rowsOf(args, ctx);
      const changes = await changesOf(args, ctx);
      const fields = Object.keys(changes);
      const title = name === 'complete_task' ? (rows.length > 1 ? `Mark ${rows.length} tasks done` : 'Mark task done')
        : name === 'reopen_task' ? (rows.length > 1 ? `Reopen ${rows.length} tasks` : 'Reopen task')
          : rows.length > 1 ? `Update ${rows.length} tasks`
            : fields.length === 1 ? `Update task ${FIELD_LABEL[fields[0]].toLowerCase()}` : 'Update task';
      if (rows.length === 1) {
        const row = rows[0];
        return {
          title,
          target: entityOf('task', row),
          diff: await diffFor(row, effective(row, changes), ctx),
          fields: editableFields(effective(row, changes), ctx),
        };
      }
      const items = [];
      for (const row of rows) {
        const eff = effective(row, changes);
        items.push({
          id: row.id, label: row.title, sub: taskSub(row),
          diff: await diffFor(row, eff, ctx), checked: Object.keys(eff).length > 0,
          disabled: Object.keys(eff).length === 0,
        });
      }
      return { title, items, fields: editableFields(changes, ctx) };
    },

    async plan(args, ctx) {
      const rows = await rowsOf(args, ctx);
      const changes = await changesOf(args, ctx);
      const ops = [];
      for (const row of rows) {
        const eff = effective(row, changes);
        if (!Object.keys(eff).length) continue;
        const { patch, before } = await patchFor(row, eff, ctx);
        ops.push({ op: 'update', table: 'tasks', id: row.id, version: row.updated_at, patch, before, label: row.title });
      }
      return ops;
    },

    summary(outcome, args) {
      const done = outcome.results.filter((r) => r.ok !== false);
      const failed = outcome.results.filter((r) => r.ok === false);
      const fieldNames = Object.keys(fromArgs(args));
      let line;
      if (done.length === 1) {
        const t = done[0].after?.title || 'the task';
        const only = fieldNames.length === 1 ? fieldNames[0] : null;
        if (only === 'deadline') {
          line = done[0].after?.deadline ? `Moved ${q(t)} to **${formatDate(done[0].after.deadline)}**.` : `Cleared the deadline on ${q(t)}.`;
        } else if (only === 'status') {
          line = done[0].after?.status === 'done' ? `Marked ${q(t)} done.` : `Set ${q(t)} to ${STATUS_LABEL[done[0].after?.status] || done[0].after?.status}.`;
        } else if (only === 'assignee') {
          line = done[0].after?.assignee_label ? `Assigned ${q(t)} to ${done[0].after.assignee_label}.` : `Unassigned ${q(t)}.`;
        } else {
          line = `Updated ${q(t)}.`;
        }
      } else if (done.length > 1) {
        line = name === 'complete_task' ? `Marked ${done.length} tasks done.` : `Updated ${done.length} tasks.`;
      } else {
        line = 'Nothing was changed.';
      }
      if (failed.length) line += ` ${failed.length} could not be changed: ${failed[0].error}`;
      return line;
    },

    async after(outcome, ctx) {
      const touchedDates = outcome.results.some((r) => r.ok !== false && r.before
        && ('deadline' in r.before || 'status' in r.before));
      if (!touchedDates) return null;
      forget(ctx, 'task');
      const all = await loadKind('task', ctx);
      const overdue = all.filter((r) => isOverdue(r, ctx.today)).length;
      return `Overdue tasks: ${overdue}.`;
    },
  };
}

// Canonical args carry changes flat, under the same names the model uses.
const toArgs = (changes) => ({ ...changes });
const fromArgs = (args) => {
  const { tasks: _t, task: _one, ...rest } = args;
  return rest;
};

async function rowsOf(args, ctx) {
  const all = await loadKind('task', ctx);
  return (args.tasks || []).map((id) => all.find((r) => r.id === id)).filter(Boolean);
}

async function changesOf(args, _ctx) {
  // Canonical args are already resolved: dates are ISO, people and projects ids.
  return fromArgs(args);
}

const update_task = updateTool({
  name: 'update_task',
  description: 'Change a task: its deadline, status, priority, assignee, project, title or description. '
    + 'Use it whenever the user states a fact that changes a task, not only when they say "update": '
    + '"it\'s rescheduled to 2nd October" → deadline; "Ravi is taking the pricing task" → assignee; '
    + '"that one is urgent" → priority high; "move the landing page task to the Acme project" → project. '
    + 'Dates may be passed as the user said them ("2nd October", "next Friday", "end of month"). '
    + 'For the same change on several tasks pass `tasks`.',
  extraParams: {
    title: { type: 'string', description: 'New title.' },
    description: { type: 'string', description: 'New description.' },
    deadline: { type: 'string', description: 'New deadline, as said ("2nd October", "tomorrow") or YYYY-MM-DD; "none" clears it.' },
    status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
    priority: { type: 'string', enum: ['low', 'medium', 'high'] },
    assignee: { type: 'string', description: 'Team member name, "me", or "none" to unassign.' },
    project: { type: 'string', description: 'Project name or code, or "none" for a general task.' },
  },
});

const complete_task = updateTool({
  name: 'complete_task',
  description: 'Mark one or more tasks done: "finished the pricing call", "mark all Acme tasks done" (list_tasks first, then pass their ids in `tasks`).',
  fixed: { status: 'done' },
});

const reopen_task = updateTool({
  name: 'reopen_task',
  description: 'Reopen one or more done tasks (back to pending): "the invoice task isn\'t actually finished".',
  fixed: { status: 'pending' },
});

/* ── create ───────────────────────────────────────────────────────────────── */

const create_task = {
  name: 'create_task',
  module: 'tasks',
  kind: 'write',
  risk: 'low',
  permission: { resource: 'tasks', action: 'create' },
  description: 'Create a task: "remind me to call Acme on Friday", "add a task for Ravi to send the deck by the 5th", '
    + '"we need to renew the domain next week". Dates as said; assignee by name.',
  params: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short imperative title, e.g. "Call Acme about renewal".' },
      description: { type: 'string' },
      deadline: { type: 'string', description: 'As said ("Friday", "5th Oct") or YYYY-MM-DD.' },
      priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      status: { type: 'string', enum: ['pending', 'in_progress'] },
      assignee: { type: 'string', description: 'Team member name, or "me".' },
      project: { type: 'string', description: 'Project name or code.' },
    },
    required: ['title'],
  },
  undoable: true,

  async resolve(args, ctx) {
    const title = String(args.title ?? '').trim();
    if (!title) return needsInput('title', 'What should the task be called?');
    const read = await readChanges({ ...args, title }, ctx);
    if (read.needs || read.error) return read;
    const c = read.changes;
    return {
      args: {
        title: c.title,
        description: c.description ?? null,
        deadline: c.deadline ?? null,
        priority: c.priority || 'medium',
        status: c.status && c.status !== 'done' ? c.status : 'pending',
        assignee: c.assignee ?? null,
        project: c.project ?? null,
      },
    };
  },

  validate(args) {
    const problems = [];
    if (!args.title) problems.push('A task needs a title.');
    return problems;
  },

  async preview(args, ctx) {
    const diff = [change('title', 'Title', null, args.title)];
    if (args.deadline) diff.push(change('deadline', 'Deadline', null, formatDate(args.deadline)));
    if (args.assignee) diff.push(change('assignee', 'Assignee', null, await display('assignee', args.assignee, ctx)));
    if (args.priority && args.priority !== 'medium') diff.push(change('priority', 'Priority', null, await display('priority', args.priority, ctx)));
    if (args.project) diff.push(change('project', 'Project', null, await display('project', args.project, ctx)));
    if (args.description) diff.push(change('description', 'Description', null, args.description));
    return {
      title: 'Create task',
      diff,
      fields: [
        { key: 'title', label: 'Title', type: 'text', value: args.title },
        { key: 'deadline', label: 'Deadline', type: 'date', value: args.deadline || '' },
        { key: 'priority', label: 'Priority', type: 'select', value: args.priority, options: PRIORITIES.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) })) },
      ],
    };
  },

  async plan(args, ctx) {
    const assignee = args.assignee ? await byId('employee', args.assignee, ctx) : null;
    return [{
      op: 'insert',
      table: 'tasks',
      row: {
        org_id: ctx.orgId,
        title: args.title,
        description: args.description || null,
        status: args.status || 'pending',
        priority: args.priority || 'medium',
        deadline: args.deadline || null,
        assignee_id: args.assignee || null,
        assignee_label: assignee?.full_name || null,
        project_id: args.project || null,
      },
    }];
  },

  summary(outcome) {
    const row = outcome.results[0]?.after;
    if (!row) return 'The task was not created.';
    return `Created ${q(row.title)}${row.deadline ? `, due **${formatDate(row.deadline)}**` : ''}${row.assignee_label ? ` for ${row.assignee_label}` : ''}.`;
  },

  entitiesOf(outcome) {
    const row = outcome.results[0]?.after;
    return row?.id ? [entityOf('task', row)] : [];
  },
};

/* ── delete ───────────────────────────────────────────────────────────────── */

const delete_task = {
  name: 'delete_task',
  module: 'tasks',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'tasks', action: 'delete' },
  description: 'Delete tasks permanently — only when the user explicitly says delete/remove. Completing a task is complete_task, not this.',
  params: { type: 'object', properties: { ...TARGET_PARAMS } },
  undoable: false,

  async resolve(args, ctx) {
    const target = await resolveTargets(args, ctx);
    if (target.needs || target.error) return target;
    return {
      args: { tasks: target.rows.map((r) => r.id) },
      targets: target.rows.map((r) => ({ table: 'tasks', id: r.id, version: r.updated_at })),
      entities: target.rows.map((r) => entityOf('task', r)),
    };
  },

  validate() { return []; },

  async preview(args, ctx) {
    const rows = await rowsOf(args, ctx);
    return {
      title: rows.length > 1 ? `Delete ${rows.length} tasks` : 'Delete task',
      target: rows.length === 1 ? entityOf('task', rows[0]) : null,
      items: rows.map((r) => ({ id: r.id, label: r.title, sub: taskSub(r), checked: true })),
      preview: {
        kind: 'delete',
        rows: rows.map((r) => [r.title, taskSub(r) || '—']),
        note: 'Nothing else depends on a task, so only the task itself is removed.',
      },
      confirmLabel: rows.length > 1 ? `Delete ${rows.length} tasks` : `Delete ${q(rows[0]?.title || 'task')}`,
      irreversible: 'A deleted task cannot be restored. Its history stays in the audit log.',
    };
  },

  async plan(args, ctx) {
    const rows = await rowsOf(args, ctx);
    return rows.map((r) => ({ op: 'delete', table: 'tasks', id: r.id, version: r.updated_at, before: r, label: r.title }));
  },

  summary(outcome) {
    const done = outcome.results.filter((r) => r.ok !== false);
    const failed = outcome.results.filter((r) => r.ok === false);
    let line = done.length === 1 ? `Deleted ${q(done[0].before?.title || 'the task')}.` : `Deleted ${done.length} tasks.`;
    if (failed.length) line += ` ${failed.length} could not be deleted: ${failed[0].error}`;
    return line;
  },
};

export default [create_task, update_task, complete_task, reopen_task, delete_task];
