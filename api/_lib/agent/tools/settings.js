import { change, needsInput, notFound } from '../helpers.js';
import { isEmailAddress } from '../../mailer.js';

/**
 * The company's own profile: the plain details printed on its documents.
 *
 * Only the columns listed here, ever. Banking and tax identifiers
 * (org_banking), email credentials (org_secrets), roles, the plan and the
 * logo, signature and stamp files are changed on the Settings page, where
 * the person can see what they are doing — never from a sentence in chat.
 */

const FIELDS = {
  company_name: { label: 'Company name', max: 200, required: true },
  company_tagline: { label: 'Tagline', max: 300 },
  company_address: { label: 'Address', max: 500 },
  company_phone: { label: 'Phone', max: 40 },
  company_email: { label: 'Email', max: 200, check: (v) => (isEmailAddress(v) ? null : `“${v}” is not an email address.`) },
  company_website: { label: 'Website', max: 200, check: (v) => (/^(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/i.test(v) ? null : `“${v}” does not look like a web address.`) },
  owner_full_name: { label: 'Signatory name', max: 120 },
  document_designation: { label: 'Signatory title', max: 120 },
};
const FIELD_OPTIONS = Object.entries(FIELDS).map(([value, f]) => ({ value, label: f.label }));

function readField(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (FIELDS[s.replace(/ /g, '_')]) return s.replace(/ /g, '_');
  if (/^(?:company name|name|business name)$/.test(s)) return 'company_name';
  if (/^(?:tagline|slogan)$/.test(s)) return 'company_tagline';
  if (/^(?:address|company address|office address|registered address)$/.test(s)) return 'company_address';
  if (/^(?:phone|phone number|company phone|contact number|mobile)$/.test(s)) return 'company_phone';
  if (/^(?:email|company email|email address|contact email)$/.test(s)) return 'company_email';
  if (/^(?:website|site|web address|url|company website)$/.test(s)) return 'company_website';
  if (/^(?:signatory|signatory name|authorised signatory|authorized signatory)$/.test(s)) return 'owner_full_name';
  if (/^(?:signatory title|designation|signatory designation)$/.test(s)) return 'document_designation';
  return null;
}

async function orgRow(ctx) {
  const { data } = await ctx.db.from('organizations').select('*').eq('id', ctx.orgId).maybeSingle();
  return data || null;
}

const update_company_profile = {
  name: 'update_company_profile',
  module: 'core',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'organizations', action: 'edit' },
  // Not in a team group, where everyone would read the card.
  privateOnly: true,
  description: 'Change one plain detail of the company\'s own profile, as printed on its documents: name, tagline, address, phone, email, website, '
    + 'or the signatory\'s name and title. "change our address to …", "set our website to …". '
    + 'Bank details, GSTIN, email credentials, roles and the plan are NOT changed here — say so and open Settings.',
  params: {
    type: 'object',
    properties: {
      field: { type: 'string', enum: Object.keys(FIELDS) },
      value: { type: 'string', description: 'The new value, exactly as it should read.' },
    },
    required: [],
  },
  slots: [{ key: 'field' }, { key: 'value', free: true }],
  undoable: () => true,

  async resolve(args, ctx) {
    const said = String(args.field ?? '').trim();
    if (!said) return needsInput('field', 'Which detail of the company profile?', FIELD_OPTIONS);
    const field = readField(said);
    if (!field) return notFound(`I can change the company’s ${FIELD_OPTIONS.map((f) => f.label.toLowerCase()).join(', ')} from here. Anything else — bank details, GSTIN, email settings — is on the Settings page.`);
    const value = String(args.value ?? '').replace(/\s+/g, ' ').trim();
    if (!value) return needsInput('value', `What should the ${FIELDS[field].label.toLowerCase()} be?`);
    const row = await orgRow(ctx);
    if (!row) return notFound('I could not read the company profile.');
    return { args: { field, value: value.slice(0, FIELDS[field].max) }, targets: [{ table: 'organizations', id: row.id, version: row.updated_at || null }] };
  },

  async validate(args, ctx) {
    const f = FIELDS[args.field];
    if (!f) return ['That is not a detail I can change from chat.'];
    const problem = f.check ? f.check(args.value) : null;
    if (problem) return [problem];
    const row = await orgRow(ctx);
    return row && String(row[args.field] ?? '') === args.value ? [`The ${f.label.toLowerCase()} is already “${args.value}”.`] : [];
  },

  async preview(args, ctx) {
    const row = await orgRow(ctx);
    const f = FIELDS[args.field];
    return {
      title: 'Update company profile',
      diff: [change(args.field, f.label, row?.[args.field] ?? null, args.value)],
      preview: { note: 'New documents use this from now on. Documents already issued keep what they were issued with.' },
      fields: [{ key: 'value', label: f.label, type: 'text', value: args.value }],
      confirmLabel: `Change ${f.label.toLowerCase()}`,
    };
  },

  async plan(args, ctx) {
    const row = await orgRow(ctx);
    return [{
      op: 'update', table: 'organizations', id: row.id, version: row.updated_at || null,
      patch: { [args.field]: args.value }, before: { [args.field]: row[args.field] ?? null },
    }];
  },

  summary(outcome, args) {
    const r = outcome.results[0];
    return r?.ok === false ? `Not changed: ${r.error}` : `Changed the ${FIELDS[args.field].label.toLowerCase()} to “${args.value}”.`;
  },
};

export default [update_company_profile];
