import { resolveEntity, entityOf, normalize, isUuid } from '../resolvers.js';
import {
  askNext, choiceFrom, needsInput, notFound, money, formatDate, readDate, q,
} from '../helpers.js';
import { emailConfigured, isEmailAddress } from '../../mailer.js';
import { canMintLinks } from '../../portalLink.js';
import { PLANS } from '../../../../src/services/planConfig.js';
import { readPay, firstName } from './people.js';

/**
 * Letters: the offer letter, made and sent from chat.
 *
 * A letter is a `records` row whose `data` is the whole form, which is also
 * what its preview, PDF and signing page are drawn from. So the row written
 * here uses the offer form's own field names (src/components/OfferForm.jsx)
 * and the columns storageService.save promotes — the Team page cannot tell a
 * letter made here from one made on the form.
 *
 * Status follows the form too: complete → 'pending' ("Not sent"); anything
 * the letter still needs → 'draft', to be finished on Team. Sending is its
 * own tool and its own card: it mints the signing link and emails it.
 */

const OFFER_TYPES = { internship: 'Internship', fulltime: 'Full-time', parttime: 'Part-time', collaboration: 'Collaboration' };
const TYPE_OPTIONS = [{ value: 'internship', label: 'Internship' }, { value: 'fulltime', label: 'Full-time' }];
const FROM_EMPLOYMENT = { intern: 'internship', fulltime: 'fulltime', parttime: 'parttime', contract: 'collaboration' };
const PAY_WORD = { internship: 'stipend', collaboration: 'fee' };
const FREQUENCIES = ['Monthly', 'Weekly', 'Hourly', 'One-time'];

function readOfferType(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (OFFER_TYPES[s]) return { value: s };
  if (/^(?:intern|internship|trainee)$/.test(s)) return { value: 'internship' };
  if (/^(?:fulltime|ft|permanent|job|employment|employee)$/.test(s)) return { value: 'fulltime' };
  if (/^(?:parttime|pt)$/.test(s)) return { value: 'parttime' };
  if (/^(?:collab|collaboration|contract|contractor|freelance|freelancer|consultant)$/.test(s)) return { value: 'collaboration' };
  return { error: 'I did not catch that.' };
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function readDay(raw, ctx, { prefer = 'future' } = {}) {
  const s = String(raw ?? '').trim();
  const rel = s.match(/^in\s+(?:(\d{1,3})|a|one)\s+(day|week)s?$/i);
  if (rel) return { value: addDays(ctx.today, (Number(rel[1]) || 1) * (/week/i.test(rel[2]) ? 7 : 1)) };
  const d = readDate(s, ctx.today, { prefer });
  return d.error || !d.value ? { error: d.error || 'I could not read that date.' } : { value: d.value };
}

const SLOTS = [
  { key: 'offer_type', question: (v) => `What kind of offer is it for ${firstName(v.name)}?`, options: TYPE_OPTIONS, read: readOfferType },
  { key: 'role', question: (v) => `What role is ${firstName(v.name)} being offered?`, read: (raw) => ({ value: String(raw).trim().slice(0, 120) }) },
  {
    key: 'pay',
    question: (v) => `What is the monthly ${PAY_WORD[v.offer_type] || 'salary'}?`,
    options: [{ label: 'Unpaid', value: 'unpaid' }],
    read: readPay,
  },
  { key: 'start_date', question: (v) => `When does ${firstName(v.name)} start?`, read: (raw, ctx) => readDay(raw, ctx) },
  {
    key: 'end_date', when: (v) => v.offer_type === 'internship',
    question: 'When does the internship end?',
    read: (raw, ctx, v) => {
      const d = readDay(raw, { ...ctx, today: v.start_date || ctx.today });
      return !d.error && v.start_date && d.value < v.start_date ? { error: 'It cannot end before it starts.' } : d;
    },
  },
  {
    key: 'reply_by', optional: true,
    question: (v) => `By when should ${firstName(v.name)} accept?`,
    options: (_v, ctx) => [{ label: 'In 7 days', value: addDays(ctx.today, 7) }, { label: 'In 3 days', value: addDays(ctx.today, 3) }],
    read: (raw, ctx) => readDay(raw, ctx),
  },
];

/** The candidate: someone on the team (whose record fills the letter) or a new name. */
async function readCandidate(raw, ctx) {
  const ref = String(raw ?? '').trim();
  if (!ref) return needsInput('candidate', 'Who is the offer letter for?');
  if (ctx.can('employees', 'view')) {
    const r = await resolveEntity('employee', ref, ctx, { filter: (e) => !e.exited_at });
    if (r.status === 'many') return choiceFrom('candidate', 'person', r, (e) => e.role || e.email);
    if (r.status === 'one') {
      const { data: row } = await ctx.db.from('employees').select('*').eq('id', r.row.id).maybeSingle();
      return { employee: row || r.row };
    }
  }
  if (isUuid(ref)) return notFound('That person is no longer on the team.');
  if (ref.length > 120 || !/\p{L}/u.test(ref) || /\d/.test(ref)) return needsInput('candidate', 'I need the person’s name. Who is the offer letter for?');
  return { name: ref.replace(/\s+/g, ' ') };
}

/** What Team already knows about someone, as the arguments the letter would otherwise ask for. */
async function knownFrom(employee, ctx) {
  if (!employee) return {};
  const out = {
    offer_type: FROM_EMPLOYMENT[employee.employment_type] || undefined,
    role: employee.role || undefined,
    start_date: employee.start_date || undefined,
    end_date: employee.end_date || undefined,
    reply_by: employee.acceptance_deadline || undefined,
    email: employee.email || undefined,
    phone: employee.phone || undefined,
    address: employee.address || undefined,
    reports_to: employee.supervisor_name || undefined,
    responsibilities: employee.responsibilities || undefined,
  };
  if (employee.department_id) {
    const { data } = await ctx.db.from('departments').select('name').eq('id', employee.department_id).maybeSingle();
    if (data?.name) out.department = data.name;
  }
  if (employee.reports_to && !out.reports_to) {
    const { data } = await ctx.db.from('employees').select('full_name').eq('id', employee.reports_to).maybeSingle();
    if (data?.full_name) out.reports_to = data.full_name;
  }
  if (ctx.can('employee_compensation', 'view')) {
    const { data } = await ctx.db.from('employee_compensation').select('*').eq('employee_id', employee.id).maybeSingle();
    if (data) { out.pay = data.is_paid === false ? 0 : Number(data.amount) || 0; out.payment_frequency = data.payment_frequency || undefined; }
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

/** What a letter still needs before it can be sent — the form's own required fields. */
function missingFor(a) {
  const need = [];
  if (!a.address) need.push('their address');
  if (!a.department) need.push('the department');
  if (!a.reports_to) need.push('who they report to');
  if (!a.responsibilities) need.push('their responsibilities');
  if (!a.reply_by) need.push('the date to accept by');
  return need;
}

/** The offer form's own data, from canonical arguments. */
function formOf(a, ctx) {
  const org = ctx.org || {};
  return {
    offerType: a.offer_type,
    companyName: org.company_name || ctx.orgName || '',
    companyTagline: org.company_tagline || '',
    companyAddress: org.company_address || '',
    companyLogo: org.logo_url || null,
    cin: org.cin || '',
    companyWebsite: org.company_website || '',
    authorizedPersonName: org.owner_full_name || '',
    authorizedPersonDesignation: org.document_designation || '',
    contactEmail: org.company_email || '',
    contactPhone: org.company_phone || '',
    stampType: org.stamp_type || 'generated',
    stampUrl: org.stamp_url || '',
    stampCity: org.stamp_city || '',
    showStamp: true,
    studentName: a.name,
    signature: org.signature_url || null,
    studentAddress: a.address || '',
    email: a.email || '',
    phone: a.phone || '',
    role: a.role,
    department: a.department || '',
    supervisorName: a.reports_to || '',
    responsibilities: a.responsibilities || '',
    startDate: a.start_date,
    endDate: a.end_date || '',
    acceptanceDeadline: a.reply_by || '',
    isPaid: a.pay > 0,
    stipend: a.pay,
    currency: 'INR',
    paymentFrequency: a.payment_frequency || 'Monthly',
    ...(a.employee_id ? { employee_id: a.employee_id } : {}),
  };
}

const text = (v, n = 200) => (v === undefined || v === null ? null : String(v).trim().slice(0, n) || null);

const create_offer_letter = {
  name: 'create_offer_letter',
  module: 'team',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'records', action: 'create' },
  // Not in a team group, where everyone would read the card.
  privateOnly: true,
  description: 'Create an offer letter: "create an offer letter for Ravi", "internship offer for Meera as a design intern at 15k from 1st Oct". '
    + 'Pass the person as `candidate` (someone on the team, or a new name) and whatever else the user said — they are asked for the kind of offer, role, pay, '
    + 'start date and the date to accept by in turn. It is saved to Team; sending it to the person is send_offer_letter.',
  params: {
    type: 'object',
    properties: {
      candidate: { type: 'string', description: 'Who the letter is for, as named, or their id.' },
      offer_type: { type: 'string', enum: Object.keys(OFFER_TYPES) },
      role: { type: 'string' },
      pay: { type: 'string', description: 'Pay per period as said ("50k", "unpaid").' },
      payment_frequency: { type: 'string', enum: FREQUENCIES },
      start_date: { type: 'string' }, end_date: { type: 'string' },
      reply_by: { type: 'string', description: 'The date they must accept by.' },
      email: { type: 'string' }, phone: { type: 'string' },
      address: { type: 'string' }, department: { type: 'string' },
      reports_to: { type: 'string', description: 'Their manager\'s name, as printed on the letter.' },
      responsibilities: { type: 'string' },
    },
    required: [],
  },
  slots: [{ key: 'candidate' }, ...SLOTS, { key: 'address', free: true }, { key: 'responsibilities', free: true }],
  undoable: (_args, ctx) => ctx.can('records', 'delete'),
  href: () => '/team',

  async resolve(args, ctx) {
    const who = await readCandidate(args.candidate, ctx);
    if (who.needs) return who;
    const employee = who.employee || null;
    const name = employee?.full_name || who.name;
    const given = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== ''));
    const merged = { ...(await knownFrom(employee, ctx)), ...given, name };
    const asked = await askNext(merged, [{ key: 'name' }, ...SLOTS], ctx);
    if (asked.needs) return asked;
    const v = asked.values;
    const email = text(merged.email, 200)?.toLowerCase() || null;
    if (email && !isEmailAddress(email)) return needsInput('email', `“${email}” is not an email address. What is ${firstName(name)}’s email?`);
    return {
      args: {
        candidate: employee?.id || name,
        name, employee_id: employee?.id || null,
        offer_type: v.offer_type, role: v.role, pay: v.pay,
        payment_frequency: FREQUENCIES.find((f) => f.toLowerCase() === String(merged.payment_frequency || '').toLowerCase()) || 'Monthly',
        start_date: v.start_date, end_date: v.end_date ?? null, reply_by: v.reply_by ?? null,
        email, phone: text(merged.phone, 40),
        address: text(merged.address, 400), department: text(merged.department, 120),
        reports_to: text(merged.reports_to, 120), responsibilities: text(merged.responsibilities, 2000),
      },
      entities: employee ? [entityOf('employee', employee)] : [],
    };
  },

  async validate(args, ctx) {
    const problems = [];
    if (args.end_date && args.end_date < args.start_date) problems.push('The end date cannot be before the start date.');
    const limit = PLANS[ctx.plan]?.limits?.offerLetters;
    if (Number.isFinite(limit)) {
      const { data } = await ctx.db.from('usage_counters').select('offer_letters').eq('org_id', ctx.orgId).maybeSingle();
      if ((Number(data?.offer_letters) || 0) >= limit) problems.push(`You have used all ${limit} offer letters on the ${PLANS[ctx.plan].name} plan. Upgrade to create more.`);
    }
    return problems;
  },

  preview(args) {
    const missing = missingFor(args);
    const pay = args.pay > 0 ? `${money(args.pay)} · ${args.payment_frequency}` : 'Unpaid';
    return {
      title: `Offer letter for ${args.name}`,
      preview: {
        kind: 'record',
        rows: [
          ['For', args.name], ['Offer', OFFER_TYPES[args.offer_type]], ['Role', args.role], ['Pay', pay],
          ['Starts', formatDate(args.start_date)],
          ...(args.end_date ? [['Ends', formatDate(args.end_date)]] : []),
          ['Accept by', args.reply_by ? formatDate(args.reply_by) : '—'],
          ['Email', args.email || '—'], ['Department', args.department || '—'], ['Reports to', args.reports_to || '—'],
        ],
        note: missing.length
          ? `Saved as a draft until it has ${list(missing)}. Fill them in here, or finish it on Team.`
          : 'Saved to Team as not sent. Nothing goes to them until you send it.',
      },
      confirmLabel: missing.length ? 'Save as draft' : 'Create offer letter',
      fields: [
        { key: 'role', label: 'Role', type: 'text', value: args.role },
        { key: 'start_date', label: 'Starts', type: 'date', value: args.start_date },
        ...(args.offer_type === 'internship' ? [{ key: 'end_date', label: 'Ends', type: 'date', value: args.end_date || '' }] : []),
        { key: 'reply_by', label: 'Accept by', type: 'date', value: args.reply_by || '' },
        { key: 'email', label: 'Email', type: 'text', value: args.email || '' },
        { key: 'address', label: 'Their address', type: 'text', value: args.address || '' },
        { key: 'department', label: 'Department', type: 'text', value: args.department || '' },
        { key: 'reports_to', label: 'Reports to', type: 'text', value: args.reports_to || '' },
        { key: 'responsibilities', label: 'Responsibilities', type: 'textarea', value: args.responsibilities || '' },
      ],
    };
  },

  async plan(args, ctx) {
    const { data: number, error } = await ctx.db.rpc('next_document_number', { p_org: ctx.orgId, p_type: 'offer' });
    if (error || !number) throw new Error('Could not allocate a letter number.');
    return [{
      op: 'insert', table: 'records', key: 'letter',
      row: {
        org_id: ctx.orgId, doc_number: number, type: 'offer',
        status: missingFor(args).length ? 'draft' : 'pending',
        title: args.name,
        employee_id: args.employee_id || null,
        recipient_name: args.name, recipient_email: args.email || null,
        issue_date: ctx.today,
        data: formOf(args, ctx),
        ...(ctx.user?.id ? { created_by: ctx.user.id } : {}),
      },
    }];
  },

  summary(outcome, args) {
    const row = outcome.results.find((r) => r.key === 'letter')?.after;
    if (!row) return `The offer letter was not created: ${outcome.results[0]?.error || 'it could not be saved.'}`;
    const missing = missingFor(args);
    return missing.length
      ? `Saved the offer letter for ${q(args.name)} (${row.doc_number}) as a draft. It still needs ${list(missing)} — finish it on Team.`
      : `Created the offer letter for ${q(args.name)} (${row.doc_number}). It is on Team, not sent yet.`;
  },

  async after(outcome, ctx) {
    const row = outcome.results.find((r) => r.key === 'letter')?.after;
    if (!row || row.status !== 'pending' || !row.recipient_email || !ctx.can('records', 'edit') || !canMintLinks()) return null;
    return `Say “send the offer letter to ${row.recipient_name}” and I will email them the signing link.`;
  },
};

const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/* ── sending ──────────────────────────────────────────────────────────────── */

const SENDABLE = ['pending', 'sent', 'viewed'];
const STATUS_WORD = { draft: 'Draft', pending: 'Not sent', sent: 'Sent', viewed: 'Viewed', accepted: 'Accepted', signed: 'Signed', declined: 'Declined', cancelled: 'Cancelled', expired: 'Expired' };

async function offerLetters(ctx) {
  const { data } = await ctx.db.from('records').select('*').eq('org_id', ctx.orgId).eq('type', 'offer');
  return data || [];
}

function emailFor(letter, ctx) {
  const company = ctx.org?.company_name || ctx.orgName || 'our company';
  const d = letter.data || {};
  const name = letter.recipient_name || d.studentName || 'there';
  const role = d.role ? ` for the role of ${d.role}` : '';
  const by = d.acceptanceDeadline ? `\nPlease respond on or before ${formatDate(d.acceptanceDeadline)}.\n` : '';
  return {
    subject: `Your Offer Letter from ${company} – Action Required`,
    text: `Dear ${name},\n\n${company} has issued you an offer letter${role}. You can view and sign it securely here:\n\n{{link}}\n${by}\nThis link is for you alone, so please do not share it.\n\nWarm regards,\n${company}`,
  };
}

const send_offer_letter = {
  name: 'send_offer_letter',
  module: 'team',
  kind: 'write',
  risk: 'high',
  // It emails someone outside the app: approved only in the app (registry.appApprovalOnly).
  approval: 'app',
  permission: { resource: 'records', action: 'edit' },
  // Not in a team group, where everyone would read the card.
  privateOnly: true,
  available: () => canMintLinks(),
  description: 'Email an offer letter\'s signing link to the person it is for, from the company\'s Gmail: "send the offer letter to Ravi", "email Meera her offer". '
    + 'The user sees and can edit the exact email first. Only a finished letter can be sent; a draft is finished on Team.',
  params: {
    type: 'object',
    properties: {
      letter: { type: 'string', description: 'Whose letter (the person\'s name), its number (OL-2026-0004), or its id.' },
      to: { type: 'string', description: 'Recipient email, only if the user gave one or the letter has none.' },
      subject: { type: 'string' },
      message: { type: 'string', description: 'Full email body, only when the user asked for specific wording. Keep {{link}} where the link goes.' },
    },
    required: ['letter'],
  },
  undoable: false,
  stopOnError: true,

  async resolve(args, ctx) {
    const ref = String(args.letter ?? '').trim();
    const all = (await offerLetters(ctx)).filter((r) => !['accepted', 'signed', 'declined', 'cancelled', 'expired'].includes(r.status));
    if (!ref && all.length !== 1) return needsInput('letter', 'Whose offer letter should I send?', all.slice(0, 6).map((r) => ({ label: `${r.recipient_name || r.title} · ${r.doc_number}`, value: r.id })));
    const said = normalize(ref);
    const hits = !ref ? all : all.filter((r) => r.id === ref || normalize(r.doc_number) === said
      || normalize(r.recipient_name || r.title || '').split(' ').includes(said) || normalize(r.recipient_name || r.title || '') === said);
    if (!hits.length) return notFound(`I could not find an open offer letter for “${ref}”.`, isUuid(ref) || !ref ? null : { tool: 'create_offer_letter', args: { candidate: ref }, label: `Create an offer letter for “${ref}”` });
    const ready = hits.filter((r) => SENDABLE.includes(r.status));
    if (!ready.length) return notFound(`${hits[0].doc_number} for ${hits[0].recipient_name || hits[0].title} is still a draft. Finish it on Team, then I can send it.`);
    if (ready.length > 1) return needsInput('letter', 'Which offer letter?', ready.slice(0, 6).map((r) => ({ label: `${r.recipient_name || r.title} · ${r.doc_number} · ${STATUS_WORD[r.status] || r.status}`, value: r.id })));
    const row = ready[0];
    const to = String(args.to || row.recipient_email || '').trim().toLowerCase();
    if (!to) return needsInput('to', `${row.recipient_name || 'This person'} has no email on the letter. Where should it go?`);
    if (!isEmailAddress(to)) return needsInput('to', `“${to}” is not an email address. Where should it go?`);
    const draft = emailFor(row, ctx);
    const message = String(args.message || draft.text).trim().slice(0, 8000);
    return {
      args: {
        letter: row.id, to,
        subject: String(args.subject || draft.subject).replace(/[\r\n]+/g, ' ').trim().slice(0, 200),
        message: message.includes('{{link}}') ? message : `${message}\n\n{{link}}`,
      },
      targets: [{ table: 'records', id: row.id, version: row.updated_at }],
    };
  },

  async validate(args, ctx) {
    const problems = [];
    if (!args.subject) problems.push('The email needs a subject.');
    if (!(await emailConfigured(ctx.orgId))) problems.push('Email is not connected yet, so I cannot send letters. Connect Gmail in Settings → Email, or send it from Team.');
    return problems;
  },

  async preview(args, ctx) {
    const row = (await offerLetters(ctx)).find((r) => r.id === args.letter);
    return {
      title: `Send offer letter to ${row?.recipient_name || args.to}`,
      preview: {
        kind: 'email',
        rows: [['Letter', `${row?.doc_number || ''} · ${row?.data?.role || 'Offer'}`.replace(/^ · /, '')], ['Status', STATUS_WORD[row?.status] || row?.status || '—']],
        note: '{{link}} becomes their private signing link when the email goes out.',
      },
      email: { to: args.to, subject: args.subject, text: args.message },
      fields: [
        { key: 'subject', label: 'Subject', type: 'text', value: args.subject },
        { key: 'message', label: 'Message', type: 'textarea', value: args.message },
      ],
      confirmLabel: `Send to ${args.to}`,
      irreversible: 'An email cannot be unsent. It goes from your company Gmail.',
    };
  },

  async plan(args, ctx) {
    const row = (await offerLetters(ctx)).find((r) => r.id === args.letter);
    return [
      // The send first: if it fails, nothing claims the letter went out.
      {
        op: 'portal_email', orgId: ctx.orgId, userId: ctx.user?.id || null, documentId: args.letter, scope: 'sign',
        to: args.to, subject: args.subject, text: args.message,
        fromName: ctx.org?.company_name || ctx.orgName || 'StartupBuddy', label: 'Email',
      },
      ...(row && ['draft', 'pending'].includes(row.status)
        ? [{ op: 'update', table: 'records', key: 'letter', id: row.id, version: null, patch: { status: 'sent', ...(row.recipient_email ? {} : { recipient_email: args.to }) }, before: { status: row.status } }]
        : []),
    ];
  },

  summary(outcome, args) {
    const mail = outcome.results[0];
    return mail?.ok === false ? `Not sent: ${mail.error}` : `Sent the offer letter to ${args.to}.`;
  },
};

/* ── NDA ──────────────────────────────────────────────────────────────────── */

/** The other party: a client (whose record fills the letter) or a new name. */
async function readCounterparty(raw, ctx) {
  const ref = String(raw ?? '').trim();
  if (!ref) return needsInput('counterparty', 'Who is the NDA with?');
  if (ctx.can('clients', 'view')) {
    const r = await resolveEntity('client', ref, ctx);
    if (r.status === 'many') return choiceFrom('counterparty', 'client', r, (c) => c.person_name || c.email);
    if (r.status === 'one') {
      const { data: row } = await ctx.db.from('clients').select('*').eq('id', r.row.id).maybeSingle();
      return { client: row || r.row };
    }
  }
  if (isUuid(ref)) return notFound('That client is no longer visible to you.');
  if (ref.length > 160 || !/\p{L}/u.test(ref)) return needsInput('counterparty', 'I need the other party’s name. Who is the NDA with?');
  return { name: ref.replace(/\s+/g, ' ') };
}

const NDA_SLOTS = [
  { key: 'address', free: true, question: (v) => `What is ${v.name}’s registered address?`, read: (raw) => ({ value: String(raw).replace(/\s+/g, ' ').trim().slice(0, 400) }) },
  { key: 'purpose', free: true, optional: true, question: 'What is being discussed under it? One line is enough.', read: (raw) => ({ value: String(raw).trim().slice(0, 1000) }) },
  {
    key: 'effective_date', question: 'From which date does it apply?',
    options: (_v, ctx) => [{ label: 'Today', value: ctx.today }],
    read: (raw, ctx) => readDay(raw, ctx),
  },
];

function ndaMissing(a) {
  const need = [];
  if (!a.city || !a.state) need.push('the city and state it is signed in');
  if (!a.signatory_name || !a.signatory_title) need.push('who signs for them and their title');
  return need;
}

/** The NDA form's own data (src/components/NdaForm.jsx), from canonical arguments. */
function ndaFormOf(a, ctx) {
  const org = ctx.org || {};
  return {
    effectiveDate: a.effective_date,
    executionCity: a.city || '',
    executionState: a.state || '',
    companyLogo: org.logo_url || null,
    companyTagline: org.company_tagline || '',
    cin: org.cin || '',
    companyPhone: org.company_phone || '',
    companyEmail: org.company_email || '',
    companyWebsite: org.company_website || '',
    stampType: org.stamp_type || 'generated',
    stampUrl: org.stamp_url || '',
    stampCity: org.stamp_city || '',
    showStamp: true,
    disclosingPartyName: org.company_name || ctx.orgName || '',
    disclosingPartyIncorporation: 'India',
    disclosingPartyAddress: org.company_address || '',
    receivingPartyName: a.name,
    receivingPartyIncorporation: 'India',
    receivingPartyAddress: a.address,
    proposedTransaction: a.purpose || '',
    purposeOfDisclosure: a.purpose || '',
    specificConfidentialItems: '',
    obligationYears: '5',
    nonSolicitationYears: '1',
    arbitrationCity: a.city || '',
    arbitrationState: a.state || '',
    disclosingSignatoryName: org.owner_full_name || '',
    disclosingSignatoryDesignation: org.document_designation || '',
    disclosingSignatoryDate: a.effective_date,
    disclosingSignature: org.signature_url || null,
    receivingSignatoryName: a.signatory_name || '',
    receivingSignatoryDesignation: a.signatory_title || '',
    receivingSignatoryDate: a.effective_date,
    receivingSignature: null,
  };
}

const create_nda = {
  name: 'create_nda',
  module: 'team',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'records', action: 'create' },
  // Not in a team group, where everyone would read the card.
  privateOnly: true,
  description: 'Create a non-disclosure agreement with another company or person: "create an NDA with Kite Labs", "NDA for Orbit Tech". '
    + 'Pass the other party as `counterparty` (a client by name, or a new name) and what the user said about it; their address, what it covers and the date are asked for in turn. '
    + 'It is saved to Team, where it is downloaded or sent for signing.',
  params: {
    type: 'object',
    properties: {
      counterparty: { type: 'string', description: 'Who the NDA is with, as named, or the client\'s id.' },
      address: { type: 'string', description: 'Their registered address.' },
      purpose: { type: 'string', description: 'What is being discussed under it.' },
      effective_date: { type: 'string' },
      city: { type: 'string', description: 'The city it is signed in.' },
      state: { type: 'string' },
      signatory_name: { type: 'string', description: 'Who signs for the other party.' },
      signatory_title: { type: 'string' },
    },
    required: [],
  },
  slots: [{ key: 'counterparty' }, { key: 'address', free: true }, { key: 'purpose', free: true, optional: true }, { key: 'effective_date' }],
  undoable: (_args, ctx) => ctx.can('records', 'delete'),
  href: () => '/team',

  async resolve(args, ctx) {
    const who = await readCounterparty(args.counterparty, ctx);
    if (who.needs) return who;
    const client = who.client || null;
    const name = client?.name || who.name;
    const given = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== ''));
    const merged = { ...(client?.address ? { address: client.address } : {}), ...given, name };
    const asked = await askNext(merged, [{ key: 'name' }, ...NDA_SLOTS], ctx);
    if (asked.needs) return asked;
    const v = asked.values;
    return {
      args: {
        counterparty: client?.id || name, name, email: client?.email || null,
        address: v.address, purpose: v.purpose ?? null, effective_date: v.effective_date,
        city: text(args.city, 80), state: text(args.state, 80),
        signatory_name: text(args.signatory_name ?? client?.person_name, 120), signatory_title: text(args.signatory_title, 120),
      },
      entities: client ? [entityOf('client', client)] : [],
    };
  },

  async validate(args, ctx) {
    const limit = PLANS[ctx.plan]?.limits?.nda;
    if (!Number.isFinite(limit)) return [];
    const { data } = await ctx.db.from('usage_counters').select('nda').eq('org_id', ctx.orgId).maybeSingle();
    return (Number(data?.nda) || 0) >= limit ? [`You have used all ${limit} NDAs on the ${PLANS[ctx.plan].name} plan. Upgrade to create more.`] : [];
  },

  preview(args, ctx) {
    const missing = ndaMissing(args);
    return {
      title: `NDA with ${args.name}`,
      preview: {
        kind: 'record',
        rows: [
          ['Between', `${ctx.org?.company_name || ctx.orgName || 'Us'} and ${args.name}`],
          ['Their address', args.address], ['Covers', args.purpose || '—'], ['From', formatDate(args.effective_date)],
          ['Signed in', [args.city, args.state].filter(Boolean).join(', ') || '—'],
          ['Signs for them', [args.signatory_name, args.signatory_title].filter(Boolean).join(', ') || '—'],
          ['Confidentiality', '5 years, non-solicitation 1 year'],
        ],
        note: missing.length
          ? `Saved as a draft until it has ${list(missing)}. Fill them in here, or finish it on Team.`
          : 'Saved to Team as not sent. Nothing goes to them until you send it from there.',
      },
      confirmLabel: missing.length ? 'Save as draft' : 'Create NDA',
      fields: [
        { key: 'address', label: 'Their address', type: 'text', value: args.address },
        { key: 'purpose', label: 'Covers', type: 'textarea', value: args.purpose || '' },
        { key: 'effective_date', label: 'From', type: 'date', value: args.effective_date },
        { key: 'city', label: 'Signed in (city)', type: 'text', value: args.city || '' },
        { key: 'state', label: 'State', type: 'text', value: args.state || '' },
        { key: 'signatory_name', label: 'Signs for them', type: 'text', value: args.signatory_name || '' },
        { key: 'signatory_title', label: 'Their title', type: 'text', value: args.signatory_title || '' },
      ],
    };
  },

  async plan(args, ctx) {
    const { data: number, error } = await ctx.db.rpc('next_document_number', { p_org: ctx.orgId, p_type: 'nda' });
    if (error || !number) throw new Error('Could not allocate a document number.');
    const form = ndaFormOf(args, ctx);
    return [{
      op: 'insert', table: 'records', key: 'letter',
      row: {
        org_id: ctx.orgId, doc_number: number, type: 'nda',
        status: ndaMissing(args).length ? 'draft' : 'pending',
        title: `${form.disclosingPartyName} & ${form.receivingPartyName}`,
        recipient_name: args.name, recipient_email: args.email || null,
        issue_date: ctx.today,
        data: form,
        ...(ctx.user?.id ? { created_by: ctx.user.id } : {}),
      },
    }];
  },

  summary(outcome, args) {
    const row = outcome.results.find((r) => r.key === 'letter')?.after;
    if (!row) return `The NDA was not created: ${outcome.results[0]?.error || 'it could not be saved.'}`;
    const missing = ndaMissing(args);
    return missing.length
      ? `Saved the NDA with ${q(args.name)} (${row.doc_number}) as a draft. It still needs ${list(missing)} — finish it on Team.`
      : `Created the NDA with ${q(args.name)} (${row.doc_number}). It is on Team, ready to download or send for signing.`;
  },
};

export default [create_offer_letter, send_offer_letter, create_nda];
