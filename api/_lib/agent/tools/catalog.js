import { normalize, isUuid } from '../resolvers.js';
import {
  askNext, change, needsInput, notFound, money, q,
} from '../helpers.js';
import { parseAmount } from '../../../../src/shared/cashIntent.js';

/**
 * The catalogue: what the company sells, with the price, unit, HSN/SAC and GST
 * a document line starts from (catalog_items). They are defaults and nothing
 * more — a line keeps its own columns, so a price changed here never restates
 * an invoice already issued.
 */

const UNITS = ['Nos', 'Hrs', 'Days', 'Months', 'Units', 'Pcs', 'Lots', 'Kg', 'Ltr', 'Sqft'];
const TAX_RATES = [0, 5, 12, 18, 28];
const TAX_OPTIONS = TAX_RATES.map((r) => ({ label: r ? `${r}%` : 'No GST', value: String(r) }));

function readPrice(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw >= 0 ? { value: raw } : { error: 'A price cannot be negative.' };
  const s = String(raw ?? '').trim();
  if (/^(?:free|nil|zero)$/i.test(s)) return { value: 0 };
  const plain = Number(s.replace(/,/g, ''));
  if (s !== '' && Number.isFinite(plain)) return plain >= 0 ? { value: plain } : { error: 'A price cannot be negative.' };
  const a = parseAmount(s);
  return a && a.amount >= 0 ? { value: a.amount } : { error: `I could not read “${s}” as a price.` };
}

function readTax(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^(?:no gst|none|nil|exempt|zero)$/.test(s)) return { value: 0 };
  const n = Number(s.replace(/%|\s|gst/g, ''));
  return Number.isFinite(n) && s !== '' && n >= 0 && n <= 100 ? { value: n } : { error: 'I could not read that as a GST rate.' };
}

const readUnit = (raw) => UNITS.find((u) => u.toLowerCase() === String(raw ?? '').trim().toLowerCase()
  || u.toLowerCase().replace(/s$/, '') === String(raw ?? '').trim().toLowerCase().replace(/s$/, '')) || null;

async function items(ctx) {
  const { data } = await ctx.db.from('catalog_items').select('*').eq('org_id', ctx.orgId);
  return data || [];
}

const SLOTS = [
  { key: 'name', question: 'What is the item called?', read: (raw) => { const s = String(raw).replace(/\s+/g, ' ').trim(); return s && s.length <= 200 ? { value: s } : { error: 'I need a name of up to 200 characters.' }; } },
  { key: 'price', question: (v) => `What does ${q(v.name)} cost?`, read: readPrice },
  { key: 'tax_rate', question: 'What GST rate applies?', options: TAX_OPTIONS, read: readTax },
];

const create_catalog_item = {
  name: 'create_catalog_item',
  module: 'finance',
  kind: 'write',
  risk: 'low',
  permission: { resource: 'catalog_items', action: 'create' },
  description: 'Add something the company sells to the catalogue: "add a product", "add Logo design to the catalogue at 25k". '
    + 'Pass the name and the price as said; the GST rate is asked for. Invoice and quotation lines can then name it.',
  params: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      price: { type: 'string', description: 'The price per unit, as said ("25k").' },
      tax_rate: { type: 'string', description: 'GST percent ("18"), or "no gst".' },
      unit: { type: 'string', enum: UNITS },
      hsn_sac: { type: 'string' },
      description: { type: 'string' },
    },
    required: [],
  },
  slots: SLOTS,
  undoable: (_args, ctx) => ctx.can('catalog_items', 'delete'),

  async resolve(args, ctx) {
    const asked = await askNext(args, SLOTS, ctx);
    if (asked.needs) return asked;
    const v = asked.values;
    return {
      args: {
        name: v.name, price: v.price, tax_rate: String(v.tax_rate), unit: readUnit(args.unit) || 'Nos',
        hsn_sac: String(args.hsn_sac ?? '').trim().slice(0, 20) || null,
        description: String(args.description ?? '').trim().slice(0, 500) || null,
      },
    };
  },

  async validate(args, ctx) {
    const dupe = (await items(ctx)).find((i) => normalize(i.name) === normalize(args.name));
    return dupe ? [`${q(dupe.name)} is already in the catalogue${dupe.archived_at ? ' (archived — restore it under Money → Items)' : ''}. Change its price instead of adding it again.`] : [];
  },

  preview(args) {
    return {
      title: 'Add catalogue item',
      diff: [
        change('name', 'Name', null, args.name),
        change('price', 'Price', null, `${money(args.price)} per ${args.unit}`),
        change('tax_rate', 'GST', null, Number(args.tax_rate) ? `${Number(args.tax_rate)}%` : 'None'),
        ...(args.hsn_sac ? [change('hsn_sac', 'HSN/SAC', null, args.hsn_sac)] : []),
      ],
      fields: [
        { key: 'name', label: 'Name', type: 'text', value: args.name },
        { key: 'price', label: 'Price', type: 'text', value: String(args.price) },
        { key: 'unit', label: 'Unit', type: 'select', value: args.unit, options: UNITS.map((u) => ({ value: u, label: u })) },
        { key: 'tax_rate', label: 'GST', type: 'select', value: String(Number(args.tax_rate)), options: TAX_OPTIONS },
        { key: 'hsn_sac', label: 'HSN/SAC', type: 'text', value: args.hsn_sac || '' },
      ],
      confirmLabel: 'Add item',
    };
  },

  plan(args, ctx) {
    return [{
      op: 'insert', table: 'catalog_items',
      row: {
        org_id: ctx.orgId, name: args.name, unit_price: args.price, unit: args.unit, tax_rate: Number(args.tax_rate),
        ...(args.hsn_sac ? { hsn_sac: args.hsn_sac } : {}), ...(args.description ? { description: args.description } : {}),
      },
    }];
  },

  summary(outcome) {
    const row = outcome.results[0]?.after;
    return row ? `Added ${q(row.name)} to the catalogue at ${money(row.unit_price)}.` : `Not added: ${outcome.results[0]?.error || 'it could not be saved.'}`;
  },
};

/* ── update ───────────────────────────────────────────────────────────────── */

const update_catalog_item = {
  name: 'update_catalog_item',
  module: 'finance',
  kind: 'write',
  risk: 'low',
  permission: { resource: 'catalog_items', action: 'edit' },
  description: 'Change a catalogue item\'s price, name, unit, GST rate or HSN/SAC: "change the price of Support retainer to 25k". '
    + 'Documents already issued keep the price they were issued at.',
  params: {
    type: 'object',
    properties: {
      item: { type: 'string', description: 'The item as named, or its id.' },
      price: { type: 'string' }, name: { type: 'string' }, unit: { type: 'string', enum: UNITS },
      tax_rate: { type: 'string' }, hsn_sac: { type: 'string' },
    },
    required: ['item'],
  },
  undoable: true,

  async resolve(args, ctx) {
    const ref = String(args.item ?? '').trim();
    const all = (await items(ctx)).filter((i) => !i.archived_at);
    if (!ref) return needsInput('item', 'Which item?', all.slice(0, 6).map((i) => ({ label: i.name, value: i.id })));
    const said = normalize(ref);
    const exact = all.filter((i) => i.id === ref || normalize(i.name) === said);
    const hits = exact.length ? exact : all.filter((i) => normalize(i.name).includes(said) || (i.sku && normalize(i.sku) === said));
    if (!hits.length) return notFound(`There is no catalogue item matching “${ref}”.`, isUuid(ref) ? null : { tool: 'create_catalog_item', args: { name: ref, ...(args.price ? { price: args.price } : {}) }, label: `Add “${ref}” to the catalogue` });
    if (hits.length > 1) return needsInput('item', 'Which item did you mean?', hits.slice(0, 6).map((i) => ({ label: `${i.name} · ${money(i.unit_price)}`, value: i.id })));
    const row = hits[0];
    const patch = {};
    if (args.price !== undefined && String(args.price).trim() !== '') { const p = readPrice(args.price); if (p.error) return needsInput('price', `${p.error} What should it cost?`); patch.unit_price = p.value; }
    if (args.name !== undefined && String(args.name).trim()) patch.name = String(args.name).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (args.unit !== undefined && readUnit(args.unit)) patch.unit = readUnit(args.unit);
    if (args.tax_rate !== undefined && String(args.tax_rate).trim() !== '') { const t = readTax(args.tax_rate); if (t.error) return needsInput('tax_rate', `${t.error} Which rate?`, TAX_OPTIONS); patch.tax_rate = t.value; }
    if (args.hsn_sac !== undefined) patch.hsn_sac = String(args.hsn_sac ?? '').trim().slice(0, 20) || null;
    if (!Object.keys(patch).length) return needsInput('price', `What should ${q(row.name)} cost now?`);
    // Canonical: the id, and each change as the tool will write it.
    const canon = { item: row.id };
    if (patch.unit_price !== undefined) canon.price = patch.unit_price;
    if (patch.name !== undefined) canon.name = patch.name;
    if (patch.unit !== undefined) canon.unit = patch.unit;
    if (patch.tax_rate !== undefined) canon.tax_rate = String(patch.tax_rate);
    if (patch.hsn_sac !== undefined) canon.hsn_sac = patch.hsn_sac;
    return { args: canon, targets: [{ table: 'catalog_items', id: row.id, version: row.updated_at }] };
  },

  async validate(args, ctx) {
    const row = (await items(ctx)).find((i) => i.id === args.item);
    if (!row) return ['That item is no longer in the catalogue.'];
    const patch = patchOf(args);
    return Object.entries(patch).every(([k, v]) => String(row[k] ?? '') === String(v ?? '') || Number(row[k]) === Number(v))
      ? [`${q(row.name)} already has those details.`] : [];
  },

  async preview(args, ctx) {
    const row = (await items(ctx)).find((i) => i.id === args.item);
    const patch = patchOf(args);
    const shown = (k, v) => (v === null || v === undefined ? null : k === 'unit_price' ? money(v) : k === 'tax_rate' ? `${Number(v)}%` : v);
    const LABEL = { unit_price: 'Price', name: 'Name', unit: 'Unit', tax_rate: 'GST', hsn_sac: 'HSN/SAC' };
    return {
      title: `Update ${row?.name || 'item'}`,
      diff: Object.entries(patch).map(([k, v]) => change(k, LABEL[k], shown(k, row?.[k]), shown(k, v))),
      fields: patch.unit_price !== undefined ? [{ key: 'price', label: 'Price', type: 'text', value: String(patch.unit_price) }] : [],
      confirmLabel: 'Update item',
    };
  },

  async plan(args, ctx) {
    const row = (await items(ctx)).find((i) => i.id === args.item);
    const patch = patchOf(args);
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, row[k] ?? null]));
    return [{ op: 'update', table: 'catalog_items', id: row.id, version: row.updated_at || null, patch, before, label: row.name }];
  },

  summary(outcome) {
    const r = outcome.results[0];
    return r?.ok === false ? `Not updated: ${r.error}` : `Updated ${q(r?.after?.name || 'the item')}. Documents already issued keep their own prices.`;
  },
};

function patchOf(args) {
  const patch = {};
  if (args.price !== undefined) patch.unit_price = Number(args.price);
  if (args.name !== undefined) patch.name = args.name;
  if (args.unit !== undefined) patch.unit = args.unit;
  if (args.tax_rate !== undefined) patch.tax_rate = Number(args.tax_rate);
  if (args.hsn_sac !== undefined) patch.hsn_sac = args.hsn_sac;
  return patch;
}

export default [create_catalog_item, update_catalog_item];
