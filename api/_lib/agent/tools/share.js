import { resolveEntity, entityOf } from '../resolvers.js';
import {
  choiceFrom, needsInput, notFound, money, formatDate,
} from '../helpers.js';
import { emailConfigured, isEmailAddress } from '../../mailer.js';
import { canMintLinks } from '../../portalLink.js';

/**
 * Emailing a document to its client.
 *
 * What goes out is the document's own portal link — the page where a client
 * reads an invoice, or accepts, questions or declines a quotation — minted at
 * the moment of sending (executor 'portal_email'), with a few lines saying
 * what it is. Nothing is attached and nothing about the document changes:
 * issuing it is issue_document, and a draft is not something to send.
 */

const NOUN = { invoice: 'invoice', quotation: 'quotation', proforma: 'proforma invoice' };
const TITLE = { invoice: 'Invoice', quotation: 'Quotation', proforma: 'Proforma invoice' };
const NOT_SENDABLE = ['cancelled', 'expired', 'converted'];

async function fullDoc(id, ctx) {
  const { data } = await ctx.db.from('financial_documents').select('*').eq('id', id).maybeSingle();
  return data || null;
}

async function clientEmail(doc, ctx) {
  if (doc.bill_to_email) return doc.bill_to_email;
  if (!doc.customer_id || !ctx.can('clients', 'view')) return null;
  const { data } = await ctx.db.from('clients').select('email').eq('id', doc.customer_id).maybeSingle();
  return data?.email || null;
}

function draftEmail(doc, ctx) {
  const company = ctx.org?.company_name || ctx.orgName || 'us';
  const name = doc.bill_to_name || 'there';
  const amount = money(doc.grand_total, doc.currency || 'INR');
  const lines = [`Hi ${name},`, ''];
  if (doc.type === 'quotation') {
    lines.push(`Please find your quotation ${doc.doc_number} from ${company}.`, '', `Amount: ${amount}`);
    if (doc.valid_until) lines.push(`Valid until: ${formatDate(doc.valid_until)}`);
    lines.push('', 'View and respond here:', '{{link}}');
  } else {
    lines.push(`Please find ${doc.type === 'proforma' ? 'proforma invoice' : 'invoice'} ${doc.doc_number} from ${company}.`, '', `Amount: ${amount}`);
    if (doc.due_date) lines.push(`Due: ${formatDate(doc.due_date)}`);
    lines.push('', 'View it here:', '{{link}}');
  }
  lines.push('', 'Thank you!', company);
  return { subject: `${TITLE[doc.type] || 'Document'} ${doc.doc_number} from ${company}`, text: lines.join('\n') };
}

const send_document_email = {
  name: 'send_document_email',
  module: 'finance',
  kind: 'write',
  risk: 'high',
  // It emails a client: approved only in the app (registry.appApprovalOnly).
  approval: 'app',
  permission: { resource: 'financial_documents', action: 'edit' },
  available: () => canMintLinks(),
  description: 'Email an issued invoice, quotation or proforma to its client, as a link to their own view of it, from the company\'s Gmail: '
    + '"email INV-2026-0042 to the client", "send the Kite quote to Priya", "send Acme their invoice". The user sees and can edit the exact email first. '
    + 'A draft cannot be sent — issue it first (issue_document). For chasing payment use send_payment_reminder.',
  params: {
    type: 'object',
    properties: {
      document: { type: 'string', description: 'The document number, the client\'s name, or "it" for the one being discussed.' },
      type: { type: 'string', enum: Object.keys(NOUN), description: 'The kind of document, when the user said which.' },
      to: { type: 'string', description: 'Recipient email, only if the user gave one or the document has none.' },
      subject: { type: 'string' },
      message: { type: 'string', description: 'Full email body, only when the user asked for specific wording. Keep {{link}} where the link goes.' },
    },
    required: ['document'],
  },
  undoable: false,
  stopOnError: true,

  async resolve(args, ctx) {
    const ref = String(args.document ?? '').trim() || 'it';
    const type = NOUN[args.type] ? args.type : null;
    const r = await resolveEntity('invoice', ref, ctx, { filter: (d) => (!type || d.type === type) && !NOT_SENDABLE.includes(d.status) });
    if (r.status === 'many') return choiceFrom('document', 'document', r, (d) => `${money(d.grand_total, d.currency || 'INR')} · ${d.status}`);
    if (r.status !== 'one') return notFound(`I could not find ${type ? `a ${NOUN[type]}` : 'a document'} matching “${ref}”.`);
    const doc = await fullDoc(r.row.id, ctx);
    if (!doc) return notFound('That document is no longer visible to you.');
    if (doc.status === 'draft') {
      return notFound(`${doc.doc_number} is still a draft, and a draft is not sent to a client.`,
        ctx.can('financial_documents', 'edit') ? { tool: 'issue_document', args: { document: doc.id }, label: `Issue ${doc.doc_number} first` } : null);
    }
    const to = String(args.to || await clientEmail(doc, ctx) || '').trim().toLowerCase();
    if (!to) return needsInput('to', `${doc.bill_to_name || 'This client'} has no email saved. Where should ${doc.doc_number} go?`);
    if (!isEmailAddress(to)) return needsInput('to', `“${to}” is not an email address. Where should ${doc.doc_number} go?`);
    const d = draftEmail(doc, ctx);
    const message = String(args.message || d.text).trim().slice(0, 8000);
    return {
      args: {
        document: doc.id, to,
        subject: String(args.subject || d.subject).replace(/[\r\n]+/g, ' ').trim().slice(0, 200),
        message: message.includes('{{link}}') ? message : `${message}\n\n{{link}}`,
      },
      targets: [{ table: 'financial_documents', id: doc.id, version: doc.updated_at }],
      entities: [entityOf('invoice', doc)],
    };
  },

  async validate(args, ctx) {
    const problems = [];
    if (!args.subject) problems.push('The email needs a subject.');
    if (!(await emailConfigured(ctx.orgId))) problems.push('Email is not connected yet, so I cannot send documents. Connect Gmail in Settings → Email, or copy the link from the document under Money.');
    return problems;
  },

  async preview(args, ctx) {
    const doc = await fullDoc(args.document, ctx);
    return {
      title: `Email ${doc.doc_number} to ${doc.bill_to_name || args.to}`,
      target: entityOf('invoice', doc),
      preview: {
        kind: 'email',
        rows: [[TITLE[doc.type] || 'Document', `${doc.doc_number} · ${money(doc.grand_total, doc.currency || 'INR')}`], ['Status', doc.status]],
        note: '{{link}} becomes the client’s own link to this document when the email goes out.',
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

  plan(args, ctx) {
    return [{
      op: 'portal_email', orgId: ctx.orgId, userId: ctx.user?.id || null, documentId: args.document, scope: 'sign',
      to: args.to, subject: args.subject, text: args.message,
      fromName: ctx.org?.company_name || ctx.orgName || 'StartupBuddy', label: 'Email',
    }];
  },

  summary(outcome, args) {
    const mail = outcome.results[0];
    return mail?.ok === false ? `Not sent: ${mail.error}` : `Sent to ${args.to}.`;
  },
};

export default [send_document_email];
