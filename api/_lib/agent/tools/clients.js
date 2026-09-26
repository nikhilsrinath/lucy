import { resolveEntity, resolveMany, loadKind, entityOf, normalize, isBackReference } from '../resolvers.js';
import {
  change, choiceFrom, needsInput, notFound, money, formatDate, q,
} from '../helpers.js';
import { parseAmount } from '../../../../src/shared/cashIntent.js';

/**
 * Clients and the CRM pipeline. Since 0016 a lead and a billing client are one
 * `clients` row; the CRM board's stage is that row's status:
 *
 *     stage    lead   contacted   deal     lost   (archived)
 *     status   lead   contacted   active   lost   archived
 *
 * — the same mapping orgStore's crm_leads adapter applies, so a stage moved
 * here lands in the same column on the board.
 */

const STAGES = {
  lead: { status: 'lead', label: 'Lead' },
  contacted: { status: 'contacted', label: 'Contacted' },
  deal: { status: 'active', label: 'Deal' },
  lost: { status: 'lost', label: 'Lost' },
  archived: { status: 'archived', label: 'Archived' },
};
const STATUS_LABEL = { lead: 'Lead', contacted: 'Contacted', active: 'Deal / active', lost: 'Lost', archived: 'Archived' };

export function readStage(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (STAGES[s]) return s;
  if (/^(?:new|prospect|cold|lead)$/.test(s)) return 'lead';
  if (/^(?:contacted|reached out|in talks|talking|warm|qualified|negotiat\w*|proposal( sent)?)$/.test(s)) return 'contacted';
  if (/^(?:won|win|closed[ -]?won|signed|active|customer|converted|deal|client)$/.test(s)) return 'deal';
  if (/^(?:lost|closed[ -]?lost|dropped|dead|not[ _]deal|not interested|declined|rejected)$/.test(s)) return 'lost';
  if (/^(?:archive|archived|inactive)$/.test(s)) return 'archived';
  return null;
}

const STAGE_OPTIONS = Object.entries(STAGES).map(([value, s]) => ({ value, label: s.label }));

const clientSub = (r) => [STATUS_LABEL[r.status] || r.status, r.person_name, r.email].filter(Boolean).join(' · ');

async function resolveClient(ref, ctx, param = 'client') {
  const r = await resolveEntity('client', ref ?? 'it', ctx);
  if (r.status === 'one') return { row: r.row };
  if (r.status === 'many') return choiceFrom(param, 'client', r, clientSub);
  if (isBackReference(ref)) return needsInput(param, 'Which client?');
  const said = String(ref ?? '').trim();
  return notFound(`I looked for ${r.searched} and found none.`,
    said && !/^(it|that|this|them|him|her)/i.test(said)
      ? { tool: 'create_client', args: { name: said }, label: `Add “${said}” as a client` } : null);
}

function readValue(raw) {
  if (raw === undefined) return { value: undefined };
  if (raw === null || raw === '') return { value: null };
  if (Number.isFinite(Number(raw))) return { value: Number(raw) };
  const a = parseAmount(String(raw));
  if (!a) return { error: `I could not read “${raw}” as an amount.` };
  return { value: a.amount };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

/** The client columns an argument set changes, as { column: value }. */
function readFields(args) {
  const out = {};
  if (args.name !== undefined && String(args.name).trim()) out.name = String(args.name).trim().slice(0, 200);
  if (args.person_name !== undefined) out.person_name = String(args.person_name ?? '').trim() || null;
  if (args.email !== undefined) out.email = String(args.email ?? '').trim().toLowerCase() || null;
  if (args.phone !== undefined) out.phone = String(args.phone ?? '').trim() || null;
  if (args.address !== undefined) out.address = String(args.address ?? '').trim() || null;
  if (args.gstin !== undefined) out.gstin = String(args.gstin ?? '').trim().toUpperCase() || null;
  const v = readValue(args.value);
  if (v.error) return v;
  if (v.value !== undefined) out.value = v.value;
  return { fields: out };
}

function fieldProblems(fields) {
  const p = [];
  if (fields.email && !EMAIL.test(fields.email)) p.push(`“${fields.email}” is not an email address.`);
  if (fields.gstin && !GSTIN.test(fields.gstin)) p.push(`“${fields.gstin}” is not a valid GSTIN.`);
  if (fields.value !== undefined && fields.value !== null && fields.value < 0) p.push('A deal value cannot be negative.');
  return p;
}

const LABEL = {
  name: 'Name', person_name: 'Contact', email: 'Email', phone: 'Phone', address: 'Address',
  gstin: 'GSTIN', value: 'Deal value', status: 'Stage', notes: 'Notes',
};
const shown = (col, v) => (v === null || v === undefined ? null
  : col === 'value' ? money(v) : col === 'status' ? STATUS_LABEL[v] || v : v);

function diffRows(row, patch) {
  return Object.entries(patch).map(([col, v]) => change(col, LABEL[col] || col, shown(col, row?.[col]), shown(col, v)));
}

async function rowsById(ids, ctx) {
  const all = await loadKind('client', ctx);
  return ids.map((id) => all.find((r) => r.id === id)).filter(Boolean);
}

const CLIENT_PARAM = { type: 'string', description: 'The client as the user named them (company or contact name, partial is fine), "them"/"that client" for the one just discussed, or an id.' };

/* ── create ───────────────────────────────────────────────────────────────── */

const create_client = {
  name: 'create_client',
  module: 'clients',
  kind: 'write',
  risk: 'low',
  permission: { resource: 'clients', action: 'create' },
  description: 'Add a client or CRM lead: "add Kite Labs as a lead, contact Priya, priya@kite.io", '
    + '"new client Acme, deal worth 2 lakh". Stage defaults to lead.',
  params: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Company (or person, for an individual client).' },
      person_name: { type: 'string', description: 'Contact person.' },
      email: { type: 'string' }, phone: { type: 'string' },
      address: { type: 'string' }, gstin: { type: 'string' },
      value: { type: 'string', description: 'Deal value as said ("2 lakh", "50k").' },
      stage: { type: 'string', enum: Object.keys(STAGES) },
      notes: { type: 'string' },
    },
    required: ['name'],
  },
  undoable: true,

  async resolve(args) {
    if (!String(args.name ?? '').trim()) return needsInput('name', 'What is the client called?');
    const read = readFields(args);
    if (read.error) return read;
    const stage = args.stage === undefined ? 'lead' : readStage(args.stage);
    if (!stage) return needsInput('stage', 'Which stage are they at?', STAGE_OPTIONS);
    return { args: { ...read.fields, stage, notes: String(args.notes ?? '').trim() || null } };
  },

  async validate(args, ctx) {
    const problems = fieldProblems(args);
    const all = await loadKind('client', ctx);
    const dupe = all.find((c) => normalize(c.name) === normalize(args.name)
      || (args.email && c.email && c.email.toLowerCase() === args.email.toLowerCase()));
    if (dupe) problems.push(`${q(dupe.name)} is already a client${dupe.archived_at ? ' (archived)' : ''} — update that one instead of adding a second.`);
    return problems;
  },

  preview(args) {
    const { stage, ...fields } = args;
    const row = { ...fields, status: STAGES[stage].status };
    return {
      title: stage === 'lead' ? 'Add lead' : 'Add client',
      diff: diffRows(null, Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined))),
      fields: [
        { key: 'name', label: 'Name', type: 'text', value: args.name },
        { key: 'email', label: 'Email', type: 'text', value: args.email || '' },
        { key: 'stage', label: 'Stage', type: 'select', value: stage, options: STAGE_OPTIONS },
      ],
    };
  },

  plan(args, ctx) {
    const { stage, ...fields } = args;
    return [{
      op: 'insert',
      table: 'clients',
      row: {
        org_id: ctx.orgId, ...fields, status: STAGES[stage].status,
        source: 'manual', extra: {},
      },
    }];
  },

  summary(outcome) {
    const row = outcome.results[0]?.after;
    return row ? `Added ${q(row.name)} as ${row.status === 'lead' ? 'a lead' : `a client (${STATUS_LABEL[row.status]})`}.` : 'The client was not added.';
  },

  entitiesOf(outcome) {
    const row = outcome.results[0]?.after;
    return row?.id ? [entityOf('client', row)] : [];
  },
};

/* ── update ───────────────────────────────────────────────────────────────── */

const update_client = {
  name: 'update_client',
  module: 'clients',
  kind: 'write',
  risk: 'low',
  permission: { resource: 'clients', action: 'edit' },
  description: 'Change a client\'s details: name, contact person, email, phone, address, GSTIN or deal value. '
    + '"Acme\'s new email is ap@acme.com", "the Kite deal is now worth 3 lakh". Stage changes use move_client_stage; notes use add_client_note.',
  params: {
    type: 'object',
    properties: {
      client: CLIENT_PARAM,
      name: { type: 'string' }, person_name: { type: 'string' }, email: { type: 'string' },
      phone: { type: 'string' }, address: { type: 'string' }, gstin: { type: 'string' },
      value: { type: 'string', description: 'Deal value as said.' },
    },
    required: ['client'],
  },
  undoable: true,

  async resolve(args, ctx) {
    const c = await resolveClient(args.client, ctx);
    if (c.needs || c.error) return c;
    const read = readFields(args);
    if (read.error) return read;
    if (!Object.keys(read.fields).length) return { error: 'No change was named. Pass the field that should change.' };
    return {
      args: { client: c.row.id, ...read.fields },
      targets: [{ table: 'clients', id: c.row.id, version: c.row.updated_at }],
      entities: [entityOf('client', c.row)],
    };
  },

  async validate(args, ctx) {
    const [row] = await rowsById([args.client], ctx);
    const { client: _c, ...fields } = args;
    const problems = fieldProblems(fields);
    if (row && Object.entries(fields).every(([k, v]) => (row[k] ?? null) === (v ?? null))) {
      problems.push(`${q(row.name)} already has those details.`);
    }
    return problems;
  },

  async preview(args, ctx) {
    const [row] = await rowsById([args.client], ctx);
    const { client: _c, ...fields } = args;
    return {
      title: 'Update client',
      target: entityOf('client', row),
      diff: diffRows(row, fields),
      fields: Object.keys(fields).filter((k) => k !== 'value').map((k) => ({ key: k, label: LABEL[k], type: 'text', value: fields[k] || '' })),
    };
  },

  async plan(args, ctx) {
    const [row] = await rowsById([args.client], ctx);
    const { client: _c, ...patch } = args;
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, row[k] ?? null]));
    return [{ op: 'update', table: 'clients', id: row.id, version: row.updated_at, patch, before, label: row.name }];
  },

  summary(outcome) {
    const r = outcome.results[0];
    return r?.ok === false ? `Not updated: ${r.error}` : `Updated ${q(r?.after?.name || 'the client')}.`;
  },
};

/* ── stage ────────────────────────────────────────────────────────────────── */

const move_client_stage = {
  name: 'move_client_stage',
  module: 'clients',
  kind: 'write',
  risk: 'low',
  permission: { resource: 'clients', action: 'edit' },
  description: 'Move a client or lead to a CRM stage. Implied by news about the deal: "we lost the Kite deal" → lost; '
    + '"Acme signed" / "we won Acme" → deal; "I spoke to Priya at Kite" → contacted; "archive Globex" → archived.',
  params: {
    type: 'object',
    properties: {
      client: CLIENT_PARAM,
      clients: { type: 'array', items: { type: 'string' }, description: 'Several clients for the same stage move (max 25).' },
      stage: { type: 'string', enum: Object.keys(STAGES) },
    },
    required: ['stage'],
  },
  undoable: true,

  async resolve(args, ctx) {
    const stage = readStage(args.stage);
    if (!stage) return needsInput('stage', 'Which stage?', STAGE_OPTIONS);
    let rows;
    if (Array.isArray(args.clients) && args.clients.length > 1) {
      if (args.clients.length > 25) return { error: 'I can move at most 25 clients at once.' };
      const { found } = await resolveMany('client', args.clients, ctx);
      if (!found.length) return notFound('None of those clients matched anything I can see.');
      rows = found.map((f) => f.row);
    } else {
      const c = await resolveClient(args.client ?? args.clients?.[0], ctx);
      if (c.needs || c.error) return c;
      rows = [c.row];
    }
    return {
      args: { clients: rows.map((r) => r.id), stage },
      targets: rows.map((r) => ({ table: 'clients', id: r.id, version: r.updated_at })),
      entities: rows.map((r) => entityOf('client', r)),
    };
  },

  async validate(args, ctx) {
    const rows = await rowsById(args.clients, ctx);
    const to = STAGES[args.stage].status;
    if (rows.every((r) => r.status === to)) {
      return [rows.length === 1 ? `${q(rows[0].name)} is already at ${STAGES[args.stage].label}.` : 'They are all already at that stage.'];
    }
    return [];
  },

  async preview(args, ctx) {
    const rows = await rowsById(args.clients, ctx);
    const to = STAGES[args.stage].status;
    if (rows.length === 1) {
      return {
        title: 'Move client stage',
        target: entityOf('client', rows[0]),
        diff: diffRows(rows[0], { status: to }),
        fields: [{ key: 'stage', label: 'Stage', type: 'select', value: args.stage, options: STAGE_OPTIONS }],
      };
    }
    return {
      title: `Move ${rows.length} clients to ${STAGES[args.stage].label}`,
      items: rows.map((r) => ({
        id: r.id, label: r.name, sub: clientSub(r), diff: diffRows(r, { status: to }),
        checked: r.status !== to, disabled: r.status === to,
      })),
    };
  },

  async plan(args, ctx) {
    const rows = await rowsById(args.clients, ctx);
    const to = STAGES[args.stage].status;
    return rows.filter((r) => r.status !== to).map((r) => ({
      op: 'update', table: 'clients', id: r.id, version: r.updated_at,
      patch: { status: to }, before: { status: r.status }, label: r.name,
    }));
  },

  summary(outcome, args) {
    const done = outcome.results.filter((r) => r.ok !== false);
    const failed = outcome.results.filter((r) => r.ok === false);
    const label = STAGES[args.stage].label;
    let line = done.length === 1 ? `Moved ${q(done[0].after?.name || 'the client')} to **${label}**.` : `Moved ${done.length} clients to **${label}**.`;
    if (failed.length) line += ` ${failed.length} could not be moved: ${failed[0].error}`;
    return line;
  },
};

/* ── notes ────────────────────────────────────────────────────────────────── */

const add_client_note = {
  name: 'add_client_note',
  module: 'clients',
  kind: 'write',
  risk: 'low',
  permission: { resource: 'clients', action: 'edit' },
  description: 'Add a dated note to a client: "note that Acme wants the proposal in Hindi", '
    + '"Kite\'s budget is frozen till March". Appends; never replaces earlier notes.',
  params: {
    type: 'object',
    properties: { client: CLIENT_PARAM, note: { type: 'string', description: 'The note, in the user\'s words.' } },
    required: ['note'],
  },
  undoable: true,

  async resolve(args, ctx) {
    const note = String(args.note ?? '').trim();
    if (!note) return needsInput('note', 'What should the note say?');
    const c = await resolveClient(args.client, ctx);
    if (c.needs || c.error) return c;
    return {
      args: { client: c.row.id, note: note.slice(0, 2000) },
      targets: [{ table: 'clients', id: c.row.id, version: c.row.updated_at }],
      entities: [entityOf('client', c.row)],
    };
  },

  validate() { return []; },

  async preview(args, ctx) {
    const [row] = await rowsById([args.client], ctx);
    return {
      title: 'Add note to client',
      target: entityOf('client', row),
      diff: [change('notes', 'New note', null, `${formatDate(ctx.today)} — ${args.note}`)],
      fields: [{ key: 'note', label: 'Note', type: 'textarea', value: args.note }],
    };
  },

  async plan(args, ctx) {
    const [row] = await rowsById([args.client], ctx);
    const line = `${formatDate(ctx.today)} — ${args.note}`;
    const notes = row.notes ? `${row.notes.replace(/\s+$/, '')}\n${line}` : line;
    return [{ op: 'update', table: 'clients', id: row.id, version: row.updated_at, patch: { notes }, before: { notes: row.notes ?? null }, label: row.name }];
  },

  summary(outcome) {
    const r = outcome.results[0];
    return r?.ok === false ? `Note not added: ${r.error}` : `Added the note to ${q(r?.after?.name || 'the client')}.`;
  },
};

/* ── delete ───────────────────────────────────────────────────────────────── */

async function dependents(clientId, ctx) {
  const count = async (table, col, resource) => {
    if (!ctx.can(resource, 'view')) return null;
    const { count: n, error } = await ctx.db.from(table).select('id', { count: 'exact', head: true }).eq(col, clientId);
    return error ? null : n || 0;
  };
  const [docs, projects, income, expenses, recurring] = await Promise.all([
    count('financial_documents', 'customer_id', 'financial_documents'),
    count('projects', 'client_id', 'projects'),
    count('income_entries', 'client_id', 'income_entries'),
    count('expenses', 'client_id', 'expenses'),
    count('recurring_invoices', 'customer_id', 'recurring_invoices'),
  ]);
  return { docs, projects, income, expenses, recurring };
}

const delete_client = {
  name: 'delete_client',
  module: 'clients',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'clients', action: 'delete' },
  description: 'Delete a client permanently — only when the user explicitly says delete/remove. Prefer move_client_stage to "archived" when they just want it out of the way.',
  params: { type: 'object', properties: { client: CLIENT_PARAM }, required: ['client'] },
  undoable: false,

  async resolve(args, ctx) {
    const c = await resolveClient(args.client, ctx);
    if (c.needs || c.error) return c;
    return {
      args: { client: c.row.id },
      targets: [{ table: 'clients', id: c.row.id, version: c.row.updated_at }],
      entities: [entityOf('client', c.row)],
    };
  },

  async validate(args, ctx) {
    const d = await dependents(args.client, ctx);
    if (d.projects > 0) {
      const [row] = await rowsById([args.client], ctx);
      return [`${q(row?.name || 'This client')} has ${d.projects} project${d.projects > 1 ? 's' : ''}, which must be moved or deleted first. Archiving the client keeps everything and takes it off the board.`];
    }
    return [];
  },

  async preview(args, ctx) {
    const [row] = await rowsById([args.client], ctx);
    const d = await dependents(args.client, ctx);
    const unlink = [
      d.docs ? `${d.docs} invoice/quotation${d.docs > 1 ? 's' : ''}` : null,
      d.recurring ? `${d.recurring} recurring invoice${d.recurring > 1 ? 's' : ''}` : null,
      d.income ? `${d.income} money-in entr${d.income > 1 ? 'ies' : 'y'}` : null,
      d.expenses ? `${d.expenses} expense${d.expenses > 1 ? 's' : ''}` : null,
    ].filter(Boolean);
    return {
      title: 'Delete client',
      target: entityOf('client', row),
      preview: {
        kind: 'delete',
        rows: [['Client', row.name], ['Stage', STATUS_LABEL[row.status] || row.status], ['Contact', row.person_name || row.email || '—']],
        note: unlink.length
          ? `Kept, but no longer linked to this client: ${unlink.join(', ')}.`
          : 'Nothing else is linked to this client.',
      },
      confirmLabel: `Delete ${q(row.name)}`,
      irreversible: 'A deleted client cannot be restored from here.',
    };
  },

  async plan(args, ctx) {
    const [row] = await rowsById([args.client], ctx);
    return [{ op: 'delete', table: 'clients', id: row.id, version: row.updated_at, before: row, label: row.name }];
  },

  summary(outcome) {
    const r = outcome.results[0];
    return r?.ok === false ? `Not deleted: ${r.error}` : `Deleted ${q(r?.before?.name || 'the client')}.`;
  },
};

export default [create_client, update_client, move_client_stage, add_client_note, delete_client];
