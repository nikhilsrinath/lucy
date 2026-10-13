import { resolveEntity, entityOf } from '../resolvers.js';
import { change, choiceFrom, needsInput, notFound, money, q } from '../helpers.js';
import { loadKind } from '../resolvers.js';

/**
 * Removing a vendor archives it, as the Vendors page does: the vendor is no
 * longer offered for new bills, and the bills already recorded against it
 * stay exactly as they are.
 */

const live = (v) => !v.archived_at;

const archive_vendor = {
  name: 'archive_vendor',
  module: 'finance',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'vendors', action: 'edit' },
  description: 'Remove a vendor (supplier): "remove the Dell vendor", "get rid of Sharma Stationers as a supplier". '
    + 'The vendor is archived, not destroyed: bills already recorded stay, and unpaid ones are named on the card.',
  params: { type: 'object', properties: { vendor: { type: 'string', description: 'The vendor as named, or its id.' } }, required: [] },
  slots: [{ key: 'vendor' }],
  undoable: () => true,

  async resolve(args, ctx) {
    const ref = String(args.vendor ?? '').trim();
    if (!ref) {
      const all = (await loadKind('vendor', ctx)).filter(live);
      if (!all.length) return notFound('There are no vendors to remove.');
      return needsInput('vendor', 'Which vendor should I remove?', all.slice(0, 8).map((v) => ({ label: v.company_name, value: v.id })));
    }
    const r = await resolveEntity('vendor', ref, ctx, { filter: live });
    if (r.status === 'many') return choiceFrom('vendor', 'vendor', r);
    if (r.status !== 'one') return notFound(`There is no vendor matching “${ref}”.`);
    return { args: { vendor: r.row.id }, targets: [{ table: 'vendors', id: r.row.id, version: r.row.updated_at }], entities: [entityOf('vendor', r.row)] };
  },

  validate() { return []; },

  async preview(args, ctx) {
    const row = (await loadKind('vendor', ctx)).find((v) => v.id === args.vendor);
    let owed = null;
    if (ctx.can('purchase_invoices', 'view')) {
      const { data } = await ctx.db.from('purchase_invoices').select('grand_total, amount_paid, status').eq('vendor_id', args.vendor);
      const open = (data || []).filter((b) => b.status !== 'paid' && b.status !== 'cancelled');
      const sum = open.reduce((t, b) => t + ((Number(b.grand_total) || 0) - (Number(b.amount_paid) || 0)), 0);
      if (open.length) owed = `${open.length} bill${open.length === 1 ? '' : 's'} still unpaid, ${money(sum)} in all. They stay on the books.`;
    }
    return {
      title: `Remove vendor ${row?.company_name || ''}`.trim(),
      target: row ? entityOf('vendor', row) : null,
      diff: [change('vendor', 'Vendor', row?.company_name, null)],
      preview: { note: `It is archived: bills already recorded stay as they are.${owed ? ` ${owed}` : ''}` },
      confirmLabel: 'Remove vendor',
    };
  },

  async plan(args, ctx) {
    const row = (await loadKind('vendor', ctx)).find((v) => v.id === args.vendor);
    return [{ op: 'update', table: 'vendors', id: row.id, version: row.updated_at || null, patch: { archived_at: new Date().toISOString() }, before: { archived_at: null }, label: row.company_name }];
  },

  summary(outcome) {
    const r = outcome.results[0];
    return r?.ok === false ? `Not removed: ${r.error}` : `Removed ${q(r?.after?.company_name || 'the vendor')} from your vendors. Their bills are kept.`;
  },
};

export default [archive_vendor];
