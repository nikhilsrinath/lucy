import { resolveEntity, entityOf } from '../resolvers.js';
import { change, choiceFrom, needsInput, notFound, readDate, formatDate, money, q } from '../helpers.js';
import { parseAmount } from '../../../../src/shared/cashIntent.js';

/**
 * Projects: create one. Everything else about a project (members, milestones,
 * budgets) stays on its page; this is the piece a plan needs — "launch the
 * new product in two weeks" becomes a project with tasks in it.
 *
 * The database numbers it (app.next_project_code), enforces the plan's
 * project limit (0055) and checks the client belongs to the org, so this only
 * has to say what the person asked for.
 */

const STATUS = { planned: 'Planned', active: 'Active' };

const create_project = {
  name: 'create_project',
  module: 'projects',
  kind: 'write',
  risk: 'low',
  permission: { resource: 'projects', action: 'create' },
  description: 'Create a project: "start a project for the Acme website", "set up a project for the product launch ending 15th Oct". '
    + 'Client by name (optional), dates as said, contract value as said.',
  params: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Project name, e.g. "Product launch".' },
      client: { type: 'string', description: 'Client name, if the project is for a client.' },
      description: { type: 'string' },
      start_date: { type: 'string', description: 'As said or YYYY-MM-DD. Default today.' },
      target_end_date: { type: 'string', description: 'As said ("in two weeks", "15th Oct") or YYYY-MM-DD.' },
      contract_value: { type: 'string', description: 'As said ("2 lakh", "150000"), for client work.' },
      status: { type: 'string', enum: ['planned', 'active'] },
    },
    required: ['name'],
  },
  undoable: (_args, ctx) => ctx.can('projects', 'delete'),

  async resolve(args, ctx) {
    const name = String(args.name ?? '').trim().slice(0, 200);
    if (!name) return needsInput('name', 'What should the project be called?');
    let client = null;
    if (args.client && String(args.client).trim()) {
      const r = await resolveEntity('client', args.client, ctx, { filter: (c) => !c.archived_at });
      if (r.status === 'many') return choiceFrom('client', 'client', r, (c) => c.status);
      if (r.status !== 'one') return notFound(`I could not find a client called “${args.client}”.`);
      client = r.row.id;
    }
    const start = readDate(args.start_date, ctx.today, { prefer: 'future' });
    if (start.error) return needsInput('start_date', `${start.error} When does it start?`, [{ label: 'Today', value: 'today' }, { label: 'Next Monday', value: 'next monday' }]);
    const end = readDate(args.target_end_date, ctx.today, { prefer: 'future' });
    if (end.error) return needsInput('target_end_date', `${end.error} When should it finish?`, [{ label: 'In two weeks', value: 'in two weeks' }, { label: 'End of month', value: 'end of month' }]);
    let value = 0;
    if (args.contract_value !== undefined && args.contract_value !== null && String(args.contract_value).trim()) {
      value = Number(args.contract_value);
      if (!Number.isFinite(value)) value = parseAmount(String(args.contract_value))?.amount ?? NaN;
      if (!Number.isFinite(value) || value < 0) return needsInput('contract_value', 'What is the contract value?');
    }
    return {
      args: {
        name,
        client,
        description: args.description ? String(args.description).trim().slice(0, 2000) : null,
        start_date: start.value || ctx.today,
        target_end_date: end.value || null,
        contract_value: Math.round(value * 100) / 100,
        status: STATUS[args.status] ? args.status : 'planned',
      },
    };
  },

  validate(args) {
    const problems = [];
    if (!args.name) problems.push('A project needs a name.');
    if (args.target_end_date && args.start_date && args.target_end_date < args.start_date) problems.push('The end date is before the start date.');
    return problems;
  },

  async preview(args, ctx) {
    const clientName = args.client ? (await resolveEntity('client', args.client, ctx)).row?.name : null;
    const diff = [change('name', 'Name', null, args.name)];
    if (clientName) diff.push(change('client', 'Client', null, clientName));
    diff.push(change('start_date', 'Starts', null, formatDate(args.start_date)));
    if (args.target_end_date) diff.push(change('target_end_date', 'Target end', null, formatDate(args.target_end_date)));
    if (args.contract_value) diff.push(change('contract_value', 'Contract value', null, money(args.contract_value)));
    diff.push(change('status', 'Status', null, STATUS[args.status]));
    return {
      title: 'Create project',
      diff,
      fields: [
        { key: 'name', label: 'Name', type: 'text', value: args.name },
        { key: 'target_end_date', label: 'Target end', type: 'date', value: args.target_end_date || '' },
      ],
    };
  },

  plan(args, ctx) {
    return [{
      op: 'insert',
      table: 'projects',
      row: {
        org_id: ctx.orgId,
        code: 'PENDING', // replaced by the database's own number
        name: args.name,
        description: args.description,
        client_id: args.client || null,
        status: args.status || 'planned',
        start_date: args.start_date,
        target_end_date: args.target_end_date,
        contract_value: args.contract_value || 0,
      },
    }];
  },

  summary(outcome) {
    const row = outcome.results[0]?.after;
    if (!row || outcome.results[0]?.ok === false) return 'The project was not created.';
    return `Created project ${q(row.name)}${row.code && row.code !== 'PENDING' ? ` (${row.code})` : ''}${row.target_end_date ? `, ending **${formatDate(row.target_end_date)}**` : ''}.`;
  },

  entitiesOf(outcome) {
    const row = outcome.results[0]?.after;
    return row?.id ? [entityOf('project', row)] : [];
  },

  /** A stand-in for the project a plan will create, so later steps can name it. */
  virtual(args, id) {
    return { kind: 'project', row: { id, code: 'NEW', name: args.name, status: args.status || 'planned', client_id: args.client || null, archived_at: null, updated_at: new Date().toISOString() } };
  },
};

export default [create_project];
