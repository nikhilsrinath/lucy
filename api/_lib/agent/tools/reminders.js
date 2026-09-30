import { resolveEntity, entityOf } from '../resolvers.js';
import { choiceFrom, needsInput, notFound, formatDate, money } from '../helpers.js';
import { emailConfigured, isEmailAddress } from '../../mailer.js';

/**
 * Payment reminders: the one thing Buddy can send outside the company.
 *
 * High risk, never undoable. The card shows the exact email — recipient,
 * subject, body — with the subject and body editable, and the button names
 * the address it goes to. It is sent only by that tap (pipeline.confirm),
 * through the org's own Gmail and hourly quota (../../mailer.js), and the
 * invoice's reminder count is updated the same way the invoice screen's
 * "Send reminder" does (payload.reminder_count / last_reminder_at), so the
 * automatic cadence counts it too.
 */

const OPEN = ['sent', 'viewed', 'partially_paid', 'overdue', 'pending', 'advance_paid'];
const balanceOf = (d) => (Number(d.grand_total) || 0) - (Number(d.amount_paid) || 0);
const lateBy = (d, today) => (d.due_date && d.due_date < today
  ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d.due_date}T00:00:00Z`)) / 86400000) : 0);

async function loadInvoice(id, ctx) {
  const { data } = await ctx.db.from('financial_documents')
    .select('id, doc_number, type, status, bill_to_name, bill_to_email, customer_id, grand_total, amount_paid, currency, issue_date, due_date, payload, updated_at')
    .eq('id', id).maybeSingle();
  return data || null;
}

function draft(doc, ctx) {
  const company = ctx.org?.company_name || ctx.orgName || 'our team';
  const late = lateBy(doc, ctx.today);
  const first = String(doc.bill_to_name || '').split(' ')[0] || 'there';
  const cur = doc.currency || 'INR';
  return {
    subject: late
      ? `Payment reminder: invoice ${doc.doc_number} is ${late} day${late === 1 ? '' : 's'} overdue`
      : `Payment reminder: invoice ${doc.doc_number}${doc.due_date ? ` due ${formatDate(doc.due_date)}` : ''}`,
    text: `Hi ${first},\n\n`
      + `This is a friendly reminder that invoice ${doc.doc_number} from ${company}${doc.due_date ? ` was due on ${formatDate(doc.due_date)}` : ' is awaiting payment'}.\n\n`
      + `Amount outstanding: ${money(balanceOf(doc), cur)}\n`
      + (late ? `Days overdue: ${late}\n` : '')
      + '\nIf you have already made this payment, please ignore this message and accept our thanks.\n\n'
      + `Best regards,\n${ctx.user.name && ctx.user.name !== 'you' ? `${ctx.user.name}\n` : ''}${company}`,
  };
}

const send_payment_reminder = {
  name: 'send_payment_reminder',
  module: 'finance',
  kind: 'write',
  risk: 'high',
  // It emails a client: approved only in the app, where the exact email is
  // shown and editable — never from a chat channel (registry.appApprovalOnly).
  approval: 'app',
  permission: { resource: 'financial_documents', action: 'edit' },
  description: 'Email a payment reminder for one unpaid invoice to the client, from the company\'s Gmail: "remind Acme about INV-0042", '
    + '"chase Kite for the overdue invoice", "send the same reminder again". The user sees and can edit the exact email before it is sent. '
    + 'Pass `message` only when the user asked for particular wording or tone; otherwise the standard reminder is drafted.',
  params: {
    type: 'object',
    properties: {
      invoice: { type: 'string', description: 'Invoice number (INV-0042), the client\'s name, or "it" for the one being discussed.' },
      to: { type: 'string', description: 'Recipient email, only if the user gave one or the invoice has none.' },
      subject: { type: 'string' },
      message: { type: 'string', description: 'Full email body, only when the user asked for specific wording or tone.' },
    },
    required: ['invoice'],
  },
  undoable: false,
  // A failed send must not go on to record a reminder.
  stopOnError: true,

  async resolve(args, ctx) {
    const ref = String(args.invoice ?? '').trim() || 'it';
    const isOpenInvoice = (d) => d.type === 'invoice' && OPEN.includes(d.status) && balanceOf(d) > 0.5;
    const r = await resolveEntity('invoice', ref, ctx, { filter: isOpenInvoice });
    if (r.status === 'many') {
      return choiceFrom('invoice', 'invoice', r, (d) => `${money(balanceOf(d), d.currency || 'INR')} due${d.due_date ? ` · ${formatDate(d.due_date)}` : ''}`);
    }
    if (r.status !== 'one') {
      return notFound(`I could not find an unpaid invoice matching “${ref}”. Reminders go only for issued invoices with a balance.`);
    }
    const doc = await loadInvoice(r.row.id, ctx);
    if (!doc) return notFound('That invoice is no longer visible to you.');
    const to = String(args.to || doc.bill_to_email || '').trim();
    if (!to) return needsInput('to', `${doc.bill_to_name || 'This client'} has no email on the invoice. Where should the reminder go?`);
    if (!isEmailAddress(to)) return needsInput('to', `“${to}” is not an email address. Where should the reminder go?`);
    const d = draft(doc, ctx);
    const subject = String(args.subject || d.subject).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    const message = String(args.message || d.text).trim().slice(0, 8000);
    return {
      args: { invoice: doc.id, to, subject, message },
      targets: [{ table: 'financial_documents', id: doc.id, version: doc.updated_at }],
      entities: [entityOf('invoice', doc)],
    };
  },

  async validate(args, ctx) {
    const problems = [];
    if (!args.subject) problems.push('The reminder needs a subject.');
    if (!args.message) problems.push('The reminder is empty.');
    if (!(await emailConfigured(ctx.orgId))) {
      problems.push('Email is not connected yet, so I cannot send reminders. Connect Gmail in Settings → Email, then ask me again — or open the invoice to share it yourself.');
    }
    return problems;
  },

  async preview(args, ctx) {
    const doc = await loadInvoice(args.invoice, ctx);
    const late = lateBy(doc, ctx.today);
    const sent = Number(doc.payload?.reminder_count) || 0;
    const last = doc.payload?.last_reminder_at;
    return {
      title: `Payment reminder to ${doc.bill_to_name || args.to}`,
      target: entityOf('invoice', doc),
      preview: {
        kind: 'email',
        rows: [
          ['Invoice', `${doc.doc_number} · ${money(balanceOf(doc), doc.currency || 'INR')} due`],
          ['Overdue', late ? `${late} day${late === 1 ? '' : 's'}` : 'Not yet'],
          ['Reminders so far', sent ? `${sent}${last ? `, last ${formatDate(String(last).slice(0, 10))}` : ''}` : 'None'],
        ],
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
    const doc = await loadInvoice(args.invoice, ctx);
    const payload = doc?.payload && typeof doc.payload === 'object' ? doc.payload : {};
    return [
      // The send first: if it fails, nothing claims a reminder went out.
      {
        op: 'email', orgId: ctx.orgId, userId: ctx.user.id, to: args.to, subject: args.subject, text: args.message,
        fromName: ctx.org?.company_name || ctx.orgName || 'StartupBuddy', label: 'Email',
      },
      {
        op: 'update', table: 'financial_documents', id: args.invoice, version: null,
        patch: { payload: { ...payload, reminder_count: (Number(payload.reminder_count) || 0) + 1, last_reminder_at: new Date().toISOString() } },
        before: { payload },
      },
    ];
  },

  summary(outcome, args) {
    const mail = outcome.results.find((r) => r.op === 'email');
    if (!mail || mail.ok === false) return `The reminder was not sent: ${mail?.error || 'the email could not be sent.'}`;
    const logged = outcome.results.find((r) => r.op === 'update');
    return `Sent the reminder to **${args.to}**.${logged && logged.ok === false ? ' (It went out, but the invoice\'s reminder count could not be updated.)' : ''}`;
  },

  entitiesOf(outcome) {
    const row = outcome.results.find((r) => r.table === 'financial_documents')?.after;
    return row?.id ? [entityOf('invoice', row)] : [];
  },

  href: () => '/money/invoices',
};

export default [send_payment_reminder];
