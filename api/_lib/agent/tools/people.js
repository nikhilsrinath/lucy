import { resolveEntity, loadKind, entityOf, normalize, isUuid } from '../resolvers.js';
import {
  askNext, change, choiceFrom, needsInput, notFound, money, formatDate, readDate, q,
} from '../helpers.js';
import { parseAmount } from '../../../../src/shared/cashIntent.js';

/**
 * The team: adding someone and changing their details.
 *
 * A person is one `employees` row; what they are paid is a separate
 * `employee_compensation` row (0001), readable only by roles that hold that
 * resource. So pay is asked for, shown and written only when the caller may
 * write it — the same split the Team page makes.
 *
 * Adding someone is a guided flow (helpers.askNext): name, job title, kind of
 * employment, start date, pay. The rest is on the card to fill in or leave.
 */

export const EMPLOYMENT = { fulltime: 'Full-time', intern: 'Intern', contract: 'Contract', parttime: 'Part-time' };
const TYPE_OPTIONS = Object.entries(EMPLOYMENT).map(([value, label]) => ({ value, label }));
const FREQUENCIES = ['Monthly', 'Weekly', 'Hourly', 'One-time'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const firstName = (name) => String(name || 'them').trim().split(/\s+/)[0] || 'them';
const active = (e) => !e.exited_at;

export function readEmployment(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (EMPLOYMENT[s]) return { value: s };
  if (/^(?:fulltime|fulltimer|ft|permanent|regular|employee|staff)$/.test(s)) return { value: 'fulltime' };
  if (/^(?:intern|internship|trainee|apprentice)$/.test(s)) return { value: 'intern' };
  if (/^(?:contract|contractor|freelance|freelancer|consultant)$/.test(s)) return { value: 'contract' };
  if (/^(?:parttime|parttimer|pt)$/.test(s)) return { value: 'parttime' };
  return { error: 'I did not catch that.' };
}

/** Pay as said: a figure ("40k", "15000"), or "unpaid". Returns { value: number }. */
export function readPay(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw >= 0 ? { value: raw } : { error: 'Pay cannot be negative.' };
  const s = String(raw ?? '').trim();
  if (/^(?:unpaid|no pay|nil|zero|0|free|voluntary|volunteer)$/i.test(s)) return { value: 0 };
  if (Number.isFinite(Number(s.replace(/,/g, ''))) && s !== '') return { value: Number(s.replace(/,/g, '')) };
  const a = parseAmount(s);
  if (!a || !(a.amount >= 0)) return { error: `I could not read “${s}” as an amount.` };
  return { value: a.amount };
}

function readName(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 120 || !/\p{L}/u.test(s)) return { error: 'I need a name.' };
  return { value: s };
}

const nextMonthStart = (today) => {
  const [y, m] = String(today).split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

const mayPay = (ctx, action = 'create') => ctx.can('employee_compensation', action) || ctx.can('employee_compensation', 'edit');

const SLOTS = [
  { key: 'full_name', question: 'What is their full name?', read: readName },
  { key: 'role', question: (v) => `What is ${firstName(v.full_name)}’s job title?`, read: (raw) => ({ value: String(raw).trim().slice(0, 120) }) },
  { key: 'employment_type', question: (v) => `How is ${firstName(v.full_name)} joining?`, options: TYPE_OPTIONS, read: readEmployment },
  {
    key: 'start_date', optional: true,
    question: (v) => `When does ${firstName(v.full_name)} start?`,
    options: (_v, ctx) => [{ label: 'Today', value: ctx.today }, { label: formatDate(nextMonthStart(ctx.today)), value: nextMonthStart(ctx.today) }],
    read: (raw, ctx) => { const d = readDate(raw, ctx.today, { prefer: 'future' }); return d.error || !d.value ? { error: d.error || 'I could not read that date.' } : { value: d.value }; },
  },
  {
    key: 'pay', optional: true, when: (_v, ctx) => mayPay(ctx),
    question: (v) => `What is ${firstName(v.full_name)}’s monthly pay?`,
    options: [{ label: 'Unpaid', value: 'unpaid' }],
    read: readPay,
  },
];

async function departments(ctx) {
  if (ctx.cache?.has('departments')) return ctx.cache.get('departments');
  const { data } = await ctx.db.from('departments').select('id, name').eq('org_id', ctx.orgId);
  const rows = data || [];
  ctx.cache?.set('departments', rows);
  return rows;
}

/** A department by id or name → { id, name } | { error } | { value: null }. */
async function readDepartment(raw, ctx) {
  if (raw === null) return { value: null };
  const s = String(raw ?? '').trim();
  if (!s) return { value: undefined };
  const all = await departments(ctx);
  const hit = all.find((d) => d.id === s) || all.find((d) => normalize(d.name) === normalize(s.replace(/\s+(?:department|dept|team)$/i, '')));
  if (hit) return { value: hit.id, name: hit.name };
  return { error: all.length ? `There is no department called “${s}”. The departments are ${all.map((d) => d.name).join(', ')}.` : `There is no department called “${s}” — add it on the Team page first.` };
}

async function readManager(raw, ctx, selfId = null) {
  if (raw === null) return { value: null };
  const s = String(raw ?? '').trim();
  if (!s) return { value: undefined };
  const r = await resolveEntity('employee', s, ctx, { filter: active });
  if (r.status === 'many') return choiceFrom('reports_to', 'person', r, (e) => e.role || e.email);
  if (r.status !== 'one') return { error: `I couldn't find anyone called “${s}” in your team.` };
  if (selfId && r.row.id === selfId) return { error: 'Someone cannot report to themselves.' };
  return { value: r.row.id, name: r.row.full_name };
}

const cleanEmail = (v) => (v === undefined ? undefined : String(v ?? '').trim().toLowerCase() || null);
const cleanText = (v, n = 200) => (v === undefined ? undefined : String(v ?? '').trim().slice(0, n) || null);
const readFrequency = (v) => FREQUENCIES.find((f) => f.toLowerCase() === String(v ?? '').trim().toLowerCase()) || 'Monthly';

const PERSON_PARAM = { type: 'string', description: 'The team member as the user named them ("Ravi", "Priya Sharma"), or their id.' };

/* ── create ───────────────────────────────────────────────────────────────── */

const create_employee = {
  name: 'create_employee',
  module: 'team',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'employees', action: 'create' },
  // Not in a team group, where everyone would read the card.
  privateOnly: true,
  description: 'Add a person to the team: "add a new employee", "hire Kiran Rao as a designer", "add Meera as an intern starting 1st Oct at 15k". '
    + 'Pass whatever the user said and leave the rest out — they are asked for the name, job title, kind of employment, start date and pay in turn. '
    + 'For their offer letter use create_offer_letter afterwards.',
  params: {
    type: 'object',
    properties: {
      full_name: { type: 'string' },
      role: { type: 'string', description: 'Job title.' },
      employment_type: { type: 'string', enum: Object.keys(EMPLOYMENT) },
      start_date: { type: 'string', description: 'As said ("1st Oct", "Monday").' },
      pay: { type: 'string', description: 'Pay per period as said ("40k", "unpaid").' },
      payment_frequency: { type: 'string', enum: FREQUENCIES },
      email: { type: 'string' }, phone: { type: 'string' },
      department: { type: 'string' },
      reports_to: { type: 'string', description: 'Their manager, as named.' },
    },
    required: [],
  },
  slots: SLOTS,
  undoable: (_args, ctx) => ctx.can('employees', 'delete'),

  async resolve(args, ctx) {
    const asked = await askNext(args, SLOTS, ctx);
    if (asked.needs) return asked;
    const v = asked.values;
    const dept = await readDepartment(args.department, ctx);
    if (dept.error) return needsInput('department', `${dept.error} Which department?`, (await departments(ctx)).slice(0, 6).map((d) => ({ label: d.name, value: d.id })));
    const boss = await readManager(args.reports_to, ctx);
    if (boss.needs) return boss;
    if (boss.error) return needsInput('reports_to', `${boss.error} Who do they report to?`);
    return {
      args: {
        full_name: v.full_name, role: v.role, employment_type: v.employment_type,
        start_date: v.start_date ?? null,
        pay: v.pay ?? null,
        payment_frequency: readFrequency(args.payment_frequency),
        email: cleanEmail(args.email) ?? null, phone: cleanText(args.phone, 40) ?? null,
        department: dept.value ?? null, reports_to: boss.value ?? null,
      },
    };
  },

  async validate(args, ctx) {
    const problems = [];
    if (args.email && !EMAIL.test(args.email)) problems.push(`“${args.email}” is not an email address.`);
    const all = await loadKind('employee', ctx);
    const dupe = all.find((e) => active(e) && (normalize(e.full_name) === normalize(args.full_name)
      || (args.email && e.email && String(e.email).toLowerCase() === args.email)));
    if (dupe) problems.push(`${q(dupe.full_name)} is already on the team — change their details instead of adding them again.`);
    return problems;
  },

  async preview(args, ctx) {
    const depts = await departments(ctx);
    const dept = depts.find((d) => d.id === args.department)?.name || null;
    const boss = args.reports_to ? (await loadKind('employee', ctx)).find((e) => e.id === args.reports_to)?.full_name : null;
    const pay = args.pay === null || args.pay === undefined ? null : args.pay === 0 ? 'Unpaid' : `${money(args.pay)} · ${args.payment_frequency}`;
    return {
      title: 'Add team member',
      preview: {
        kind: 'record',
        rows: [
          ['Name', args.full_name], ['Job title', args.role], ['Joining as', EMPLOYMENT[args.employment_type]],
          ['Starts', args.start_date ? formatDate(args.start_date) : '—'],
          ...(mayPay(ctx) ? [['Pay', pay || '—']] : []),
          ['Email', args.email || '—'], ['Phone', args.phone || '—'],
          ['Department', dept || '—'], ['Reports to', boss || '—'],
        ],
        note: 'This adds them to Team. It does not create a login or send them anything.',
      },
      confirmLabel: `Add ${firstName(args.full_name)}`,
      fields: [
        { key: 'full_name', label: 'Name', type: 'text', value: args.full_name },
        { key: 'role', label: 'Job title', type: 'text', value: args.role },
        { key: 'employment_type', label: 'Joining as', type: 'select', value: args.employment_type, options: TYPE_OPTIONS },
        { key: 'start_date', label: 'Starts', type: 'date', value: args.start_date || '' },
        { key: 'email', label: 'Email', type: 'text', value: args.email || '' },
        { key: 'phone', label: 'Phone', type: 'text', value: args.phone || '' },
        ...(depts.length ? [{ key: 'department', label: 'Department', type: 'select', value: args.department || '', options: [{ value: '', label: '—' }, ...depts.map((d) => ({ value: d.id, label: d.name }))] }] : []),
      ],
    };
  },

  plan(args, ctx) {
    const row = {
      org_id: ctx.orgId, full_name: args.full_name, role: args.role, employment_type: args.employment_type,
      ...(args.start_date ? { start_date: args.start_date } : {}),
      ...(args.email ? { email: args.email } : {}), ...(args.phone ? { phone: args.phone } : {}),
      ...(args.department ? { department_id: args.department } : {}), ...(args.reports_to ? { reports_to: args.reports_to } : {}),
    };
    const paid = args.pay !== null && args.pay !== undefined && mayPay(ctx);
    return [{
      op: 'insert', table: 'employees', key: 'employee', row,
      then: paid ? (made) => [{
        op: 'insert', table: 'employee_compensation', key: 'pay',
        row: { employee_id: made.id, org_id: ctx.orgId, is_paid: args.pay > 0, amount: args.pay, currency: 'INR', payment_frequency: args.payment_frequency },
      }] : undefined,
    }];
  },

  summary(outcome) {
    const row = outcome.results.find((r) => r.key === 'employee')?.after;
    if (!row) return `Not added: ${outcome.results[0]?.error || 'the change could not be saved.'}`;
    const warn = outcome.warnings?.length ? ` Their pay was not saved: ${outcome.warnings[0]}` : '';
    return `Added ${q(row.full_name)} to the team as ${row.role}.${warn}`;
  },

  async after(outcome, ctx) {
    const row = outcome.results.find((r) => r.key === 'employee')?.after;
    if (!row || !ctx.can('records', 'create')) return null;
    return `Want an offer letter for ${firstName(row.full_name)}? Say “create an offer letter for ${row.full_name}”.`;
  },

  entitiesOf(outcome) {
    const row = outcome.results.find((r) => r.key === 'employee')?.after;
    return row?.id ? [entityOf('employee', row)] : [];
  },
};

/* ── update ───────────────────────────────────────────────────────────────── */

const LABEL = {
  full_name: 'Name', role: 'Job title', employment_type: 'Joining as', start_date: 'Starts', email: 'Email', phone: 'Phone',
  department_id: 'Department', reports_to: 'Reports to',
};

async function loadPay(id, ctx) {
  if (!ctx.can('employee_compensation', 'view')) return null;
  const { data } = await ctx.db.from('employee_compensation').select('*').eq('employee_id', id).maybeSingle();
  return data || null;
}

async function fullRow(id, ctx) {
  const { data } = await ctx.db.from('employees').select('*').eq('id', id).maybeSingle();
  return data || null;
}

const update_employee = {
  name: 'update_employee',
  module: 'team',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'employees', action: 'edit' },
  // Not in a team group, where everyone would read the card.
  privateOnly: true,
  description: 'Change a team member\'s details: job title, email, phone, department, manager, start date, kind of employment or pay. '
    + '"change Ravi\'s role to Sales Lead", "Priya now reports to Arjun", "set Neha\'s salary to 60k". Pass only what changes.',
  params: {
    type: 'object',
    properties: {
      person: PERSON_PARAM,
      full_name: { type: 'string' }, role: { type: 'string' },
      employment_type: { type: 'string', enum: Object.keys(EMPLOYMENT) },
      start_date: { type: 'string' },
      email: { type: 'string' }, phone: { type: 'string' },
      department: { type: 'string' }, reports_to: { type: 'string' },
      pay: { type: 'string', description: 'New pay per period as said ("60k", "unpaid").' },
    },
    required: ['person'],
  },
  // A change of pay is put right by saying the new figure, not by an Undo.
  undoable: (args) => args.pay === undefined,

  async resolve(args, ctx) {
    const ref = String(args.person ?? '').trim();
    if (!ref) return needsInput('person', 'Whose details should I change?');
    const who = await resolveEntity('employee', ref, ctx, { filter: active });
    if (who.status === 'many') return choiceFrom('person', 'person', who, (e) => e.role || e.email);
    if (who.status !== 'one') return notFound(`I couldn't find anyone called “${ref}” in your team.`, isUuid(ref) ? null : { tool: 'create_employee', args: { full_name: ref }, label: `Add “${ref}” to the team` });
    const row = who.row;

    const patch = {};
    if (args.full_name !== undefined) { const n = readName(args.full_name); if (n.error) return { error: n.error }; patch.full_name = n.value; }
    if (args.role !== undefined && String(args.role).trim()) patch.role = String(args.role).trim().slice(0, 120);
    if (args.employment_type !== undefined) {
      const t = readEmployment(args.employment_type);
      if (t.error) return needsInput('employment_type', 'Which kind of employment?', TYPE_OPTIONS);
      patch.employment_type = t.value;
    }
    if (args.start_date !== undefined) {
      const d = readDate(args.start_date, ctx.today, { prefer: 'future' });
      if (d.error) return needsInput('start_date', `${d.error} What is the start date?`);
      if (d.value !== undefined) patch.start_date = d.value;
    }
    if (args.email !== undefined) patch.email = cleanEmail(args.email);
    if (args.phone !== undefined) patch.phone = cleanText(args.phone, 40);
    const dept = await readDepartment(args.department, ctx);
    if (dept.error) return needsInput('department', `${dept.error} Which department?`, (await departments(ctx)).slice(0, 6).map((d) => ({ label: d.name, value: d.id })));
    if (dept.value !== undefined) patch.department_id = dept.value;
    const boss = await readManager(args.reports_to, ctx, row.id);
    if (boss.needs) return boss;
    if (boss.error) return needsInput('reports_to', `${boss.error} Who do they report to?`);
    if (boss.value !== undefined) patch.reports_to = boss.value;

    let pay;
    if (args.pay !== undefined && args.pay !== null && String(args.pay).trim() !== '') {
      if (!ctx.can('employee_compensation', 'edit')) return notFound('Your role can\'t change pay, so I can\'t do that for you.');
      const p = readPay(args.pay);
      if (p.error) return needsInput('pay', `${p.error} What should their pay be?`);
      pay = p.value;
    }
    if (!Object.keys(patch).length && pay === undefined) return needsInput('role', `What should change for ${firstName(row.full_name)}? Tell me the new job title, or say it in full (“${firstName(row.full_name)}’s email is …”).`);

    // Canonical arguments: ids and ISO dates, so a confirm re-resolves to the same change.
    const canon = { person: row.id };
    for (const [k, v] of Object.entries(patch)) canon[k === 'department_id' ? 'department' : k] = v;
    if (pay !== undefined) canon.pay = pay;
    return { args: canon, targets: [{ table: 'employees', id: row.id, version: row.updated_at }], entities: [entityOf('employee', row)] };
  },

  async validate(args, ctx) {
    const problems = [];
    const row = await fullRow(args.person, ctx);
    if (!row) return ['That person is no longer on the team.'];
    if (args.email && !EMAIL.test(args.email)) problems.push(`“${args.email}” is not an email address.`);
    const patch = toPatch(args);
    const pay = args.pay === undefined ? null : await loadPay(row.id, ctx);
    const samePay = args.pay === undefined || (pay && Number(pay.amount) === Number(args.pay));
    if (Object.entries(patch).every(([k, v]) => (row[k] ?? null) === (v ?? null)) && samePay) {
      problems.push(`${q(row.full_name)} already has those details.`);
    }
    return problems;
  },

  async preview(args, ctx) {
    const row = await fullRow(args.person, ctx);
    const patch = toPatch(args);
    const depts = await departments(ctx);
    const people = await loadKind('employee', ctx);
    const shown = (col, v) => (v === null || v === undefined ? null
      : col === 'department_id' ? depts.find((d) => d.id === v)?.name || v
        : col === 'reports_to' ? people.find((e) => e.id === v)?.full_name || v
          : col === 'employment_type' ? EMPLOYMENT[v] || v
            : col === 'start_date' ? formatDate(v) : v);
    const diff = Object.entries(patch).map(([col, v]) => change(col, LABEL[col] || col, shown(col, row?.[col]), shown(col, v)));
    if (args.pay !== undefined) {
      const now = await loadPay(args.person, ctx);
      diff.push(change('pay', 'Pay', now ? (Number(now.amount) > 0 ? money(now.amount) : 'Unpaid') : null, args.pay > 0 ? money(args.pay) : 'Unpaid'));
    }
    return {
      title: 'Update team member',
      target: entityOf('employee', row),
      diff,
      confirmLabel: `Update ${firstName(row?.full_name)}`,
      fields: ['role', 'email', 'phone'].filter((k) => patch[k] !== undefined).map((k) => ({ key: k, label: LABEL[k], type: 'text', value: patch[k] || '' })),
    };
  },

  async plan(args, ctx) {
    const row = await fullRow(args.person, ctx);
    const patch = toPatch(args);
    const ops = [];
    if (Object.keys(patch).length) {
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, row[k] ?? null]));
      ops.push({ op: 'update', table: 'employees', key: 'employee', id: row.id, version: row.updated_at, patch, before, label: row.full_name });
    }
    if (args.pay !== undefined) {
      const now = await loadPay(row.id, ctx);
      if (now) {
        // employee_compensation is keyed by the person, not by an id of its own.
        ops.push({ op: 'update', table: 'employee_compensation', key: 'pay', idColumn: 'employee_id', id: row.id, version: now.updated_at || null, patch: { amount: args.pay, is_paid: args.pay > 0 }, before: { amount: now.amount, is_paid: now.is_paid }, label: row.full_name });
      } else {
        ops.push({ op: 'insert', table: 'employee_compensation', key: 'pay', row: { employee_id: row.id, org_id: ctx.orgId, is_paid: args.pay > 0, amount: args.pay, currency: 'INR', payment_frequency: 'Monthly' } });
      }
    }
    return ops;
  },

  summary(outcome) {
    const failed = outcome.results.find((r) => r.ok === false);
    if (failed && !outcome.results.some((r) => r.ok !== false)) return `Not updated: ${failed.error}`;
    const name = outcome.results.find((r) => r.key === 'employee')?.after?.full_name || outcome.results.find((r) => r.label)?.label || 'the team member';
    return `Updated ${q(name)}.${failed ? ` One part did not save: ${failed.error}` : ''}`;
  },
};

/** The employees columns a canonical argument set changes. */
function toPatch(args) {
  const patch = {};
  for (const k of ['full_name', 'role', 'employment_type', 'start_date', 'email', 'phone', 'reports_to']) if (args[k] !== undefined) patch[k] = args[k];
  if (args.department !== undefined) patch.department_id = args.department;
  return patch;
}

export default [create_employee, update_employee];
