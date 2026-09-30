import {
  resolveEntity, loadKind, byId, entityOf, normalize, words, isBackReference,
} from '../resolvers.js';
import {
  change, choiceFrom, needsInput, notFound, readDate, money, formatDate, q,
} from '../helpers.js';
import { parseAmount, parseMethod } from '../../../../src/shared/cashIntent.js';
import { PAYMENT_METHODS, methodLabel } from '../../../../src/shared/financeTaxonomy.js';
import { shiftDays, isIsoDate } from '../../../../src/shared/dates.js';
import {
  documentTotals, companyProfileOf, finDocToRow, lineItemRows, financialDocFromRow,
  balanceOf, docNumber,
} from '../../../../src/shared/finDocs.js';
import {
  conversionTargets, existingConversion, recommendTarget, buildConversion, carriedAdvance, DUE_DAYS,
} from '../../../../src/shared/documentConversion.js';
import { lifecycleOf, revertedStatusOf, isCarriedAdvance } from '../../../../src/shared/documentLifecycle.js';
import { DEFAULT_ADVANCE_PERCENT } from '../../../../src/shared/proformaAdvance.js';
import { PLANS } from '../../../../src/services/planConfig.js';

/**
 * Finance: invoices, quotations and proformas (drafts, conversion, issuing,
 * cancelling), payments against them, vendors and purchase bills.
 *
 * Everything a form decides is decided by the same code here: the row comes
 * from src/shared/finDocs.js (finDocToRow / lineItemRows, which orgStore also
 * uses), the totals the card promises follow app.recompute_document_totals()
 * exactly (documentTotals), and conversion, cancel and delete follow
 * src/shared/documentConversion.js and documentLifecycle.js — the rules
 * InvoiceList applies. The database still computes and guards every figure;
 * these only let the card say beforehand what it will compute.
 *
 * Risk: drafts and conversions (which produce drafts) are low. Issuing,
 * money, vendors, bills, cancelling and deleting are high.
 */

const TYPE_NOUN = { invoice: 'invoice', quotation: 'quotation', proforma: 'proforma' };
const TYPE_TITLE = { invoice: 'Tax Invoice', quotation: 'Quotation', proforma: 'Proforma Invoice' };
const PLAN_KEY = { invoice: 'invoices', quotation: 'quotations', proforma: null };
const OPEN = ['sent', 'viewed', 'partially_paid', 'overdue', 'pending', 'payment_submitted', 'advance_paid', 'order_confirmed', 'accepted'];

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ── loading ──────────────────────────────────────────────────────────────── */

/** One document with its lines and payments, in the app's shape. */
async function fullDoc(id, ctx) {
  const key = `doc:${id}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const p = ctx.db.from('financial_documents').select('*, document_line_items(*), payments(*)')
    .eq('id', id).maybeSingle().then(({ data }) => (data ? { row: data, doc: financialDocFromRow(data) } : null));
  ctx.cache.set(key, p);
  return p;
}

/** Every document, in the app's shape (payload included), for the lifecycle rules. */
async function allDocs(ctx) {
  if (ctx.cache.has('docs:all')) return ctx.cache.get('docs:all');
  const p = ctx.db.from('financial_documents')
    .select('*, payments(*)').order('created_at', { ascending: false }).limit(3000)
    // _payload: the stored jsonb, byte for byte. Status writes put it back
    // untouched but for converted_to, so the version guard (0064) never sees
    // a content change in a sent document.
    .then(({ data }) => (data || []).map((r) => ({ ...financialDocFromRow(r), _payload: r.payload || {} })));
  ctx.cache.set('docs:all', p);
  return p;
}

async function orgRow(ctx) {
  if (ctx.org && Object.keys(ctx.org).length) return ctx.org;
  const { data } = await ctx.db.from('organizations').select('*').eq('id', ctx.orgId).maybeSingle();
  ctx.org = data || {};
  return ctx.org;
}

/* ── resolving ────────────────────────────────────────────────────────────── */

const docSub = (d) => [
  d.type !== 'invoice' ? TYPE_NOUN[d.type] : null,
  d.status, d.grand_total != null ? money(d.grand_total, d.currency || 'INR') : null,
  d.issue_date ? formatDate(d.issue_date) : null,
].filter(Boolean).join(' · ');

/**
 * A document by number, client name or "it", among `types` and passing
 * `filter`. With only a client named ("Acme's invoice"), several documents for
 * that client is a choice, not a guess.
 */
async function resolveDoc(ref, ctx, { types = ['invoice', 'quotation', 'proforma'], filter = null, param = 'document', noun = 'document' } = {}) {
  const keep = (r) => types.includes(r.type) && (!filter || filter(r));
  const r = await resolveEntity('invoice', ref ?? 'it', ctx, { filter: keep });
  if (r.status === 'one') return { row: r.row };
  if (r.status === 'many') return choiceFrom(param, noun, r, docSub);
  if (isBackReference(ref)) return needsInput(param, `Which ${noun}?`);
  const said = String(ref ?? '').trim();
  // "the Acme invoice": no number matched, but a client does.
  if (said && !/^(it|that|this)/i.test(said)) {
    const c = await resolveEntity('client', said.replace(/'s\b|\b(invoice|quote|quotation|proforma|bill|the)\b/gi, ' ').trim() || said, ctx);
    if (c.status === 'one') {
      const rows = (await loadKind('invoice', ctx)).filter((d) => keep(d) && d.customer_id === c.row.id);
      if (rows.length === 1) return { row: rows[0] };
      if (rows.length > 1) {
        return choiceFrom(param, noun, { candidates: rows.slice(0, 5).map((d) => ({ row: d, entity: entityOf('invoice', d) })) }, docSub);
      }
      return notFound(`${c.row.name} has no ${noun} that fits.`);
    }
  }
  return notFound(`I looked for ${r.searched.replace('documents', `${noun}s`)} and found none.`);
}

async function resolveClient(ref, ctx) {
  if (ref === undefined || ref === null || ref === '') return needsInput('client', 'Who is it for?');
  const r = await resolveEntity('client', ref, ctx);
  if (r.status === 'one') return { row: r.row };
  if (r.status === 'many') return choiceFrom('client', 'client', r, (c) => [c.person_name, c.email].filter(Boolean).join(' · '));
  return notFound(`There is no client called “${ref}” yet.`, { tool: 'create_client', args: { name: String(ref) }, label: `Add “${ref}” as a client first` });
}

/* ── line items ───────────────────────────────────────────────────────────── */

async function catalog(ctx) {
  if (!ctx.can('catalog_items', 'view')) return [];
  if (ctx.cache.has('catalog')) return ctx.cache.get('catalog');
  const p = ctx.db.from('catalog_items').select('id, name, sku, unit_price, unit, hsn_sac, tax_rate, archived_at')
    .is('archived_at', null).limit(1000).then(({ data }) => data || []);
  ctx.cache.set('catalog', p);
  return p;
}

function readRate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (Number.isFinite(Number(v))) return Number(v);
  return parseAmount(String(v))?.amount ?? null;
}

/**
 * Line items as the model passed them — a list of {description, quantity,
 * rate, …}, or one sentence ("website design 50k") — with catalogue products
 * matched by name for their price, HSN and unit.
 */
async function readItems(raw, ctx) {
  let list = raw;
  if (typeof raw === 'string') {
    const a = parseAmount(raw);
    const desc = a ? raw.replace(a.match, ' ').replace(/\s+(for|of|at|@)\s*$/i, '').replace(/\s+/g, ' ').trim() : raw.trim();
    list = [{ description: desc, rate: a?.amount ?? null }];
  }
  if (!Array.isArray(list) || !list.length) return { items: [] };
  const products = await catalog(ctx);
  const items = [];
  for (const it of list.slice(0, 50)) {
    const said = String(it.product || it.description || '').trim();
    // A product named in passing — "Support retainer (3 months)" — is still
    // that product: every word of its name present, and nothing else as good.
    let product = said ? products.find((p) => normalize(p.name) === normalize(said) || (p.sku && normalize(p.sku) === normalize(said))) : null;
    if (!product && said && products.length) {
      const saidWords = new Set(words(said));
      const named = products
        .map((p) => ({ p, w: words(p.name) }))
        .filter(({ w }) => w.length && w.every((x) => saidWords.has(x) || saidWords.has(`${x}s`)))
        .sort((a, b) => b.w.length - a.w.length);
      // The most specific name wins ("Support retainer plus" over "Support
      // retainer"); two equally specific names are left for the person to pick.
      if (named.length && (named.length === 1 || named[0].w.length > named[1].w.length)) product = named[0].p;
    }
    const rate = readRate(it.rate ?? it.price ?? it.amount) ?? (product ? Number(product.unit_price) : null);
    // "(3 months)", "x 12", "5 hours" in the text when no quantity was passed.
    const counted = String(it.description || '').match(/(?:\bx\s*|\()?(\d+(?:\.\d+)?)\s*(?:months?|mo|hours?|hrs?|days?|units?|pcs|nos|seats?|licen[cs]es?)\b/i);
    const quantity = Number(it.quantity) > 0 ? Number(it.quantity) : counted ? Number(counted[1]) : 1;
    items.push({
      description: String(it.description || product?.name || '').trim().slice(0, 300),
      quantity,
      rate,
      unit: it.unit || product?.unit || 'Nos',
      hsn: it.hsn || product?.hsn_sac || null,
      catalog_item_id: product?.id || null,
    });
  }
  return { items };
}

/* ── defaults the org already uses ────────────────────────────────────────── */

/**
 * What this org usually does, read from its own documents: the GST rate it
 * bills at most, how long it gives this client to pay, the terms and payment
 * instructions on the last document of this kind (this client's first).
 */
async function usual(type, clientId, ctx) {
  const docs = await allDocs(ctx);
  const ofType = docs.filter((d) => d.type === type && d.status !== 'cancelled');
  const recent = docs.slice(0, 30);
  const rates = new Map();
  for (const d of recent) {
    const k = Number(d.gst_rate);
    if (d.gst_enabled !== false && Number.isFinite(k)) rates.set(k, (rates.get(k) || 0) + 1);
  }
  const gstRate = [...rates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 18;
  const forClient = ofType.filter((d) => d.customer_id === clientId);
  const lastForClient = forClient[0] || null;
  const last = lastForClient || ofType[0] || null;
  let dueDays = DUE_DAYS[type] || 30;
  const withTerms = [...forClient, ...ofType].find((d) => d.issue_date && d.due_date);
  if (withTerms) {
    const days = Math.round((Date.parse(withTerms.due_date) - Date.parse(withTerms.issue_date)) / 86400000);
    if (days > 0 && days <= 180) dueDays = days;
  }
  return {
    gstRate,
    dueDays,
    terms: last?.terms || null,
    paymentInstructions: last?.payment_instructions || null,
    advancePercent: type === 'proforma' ? (ofType[0]?.advance_percent ?? DEFAULT_ADVANCE_PERCENT) : null,
    source: lastForClient ? 'this client’s last one' : last ? `your last ${TYPE_NOUN[type]}` : null,
  };
}

async function planProblem(type, ctx) {
  const key = PLAN_KEY[type];
  const limit = key ? PLANS[ctx.plan]?.limits?.[key] : Infinity;
  if (!key || !Number.isFinite(limit)) return null;
  const { data } = await ctx.db.from('usage_counters').select(key).eq('org_id', ctx.orgId).maybeSingle();
  const used = Number(data?.[key]) || 0;
  return used >= limit
    ? `You have used all ${limit} ${key} on the ${PLANS[ctx.plan].name} plan. Upgrade to create more.`
    : null;
}

/* ── the draft tools ──────────────────────────────────────────────────────── */

const DRAFT_PARAMS = {
  client: { type: 'string', description: 'Who it is for — an existing client, by name.' },
  items: {
    type: 'array',
    description: 'The lines. Amounts as said ("50k", "1.2 lakh"). A catalogue product may be named instead of a rate.',
    items: {
      type: 'object',
      properties: {
        description: { type: 'string' }, quantity: { type: 'number' },
        rate: { type: 'string', description: 'Price per unit, as said.' },
        unit: { type: 'string' }, hsn: { type: 'string' },
        product: { type: 'string', description: 'Catalogue product name, if billing one.' },
      },
    },
  },
  gst_rate: { type: 'number', description: 'Only if the user said one; otherwise the org’s usual rate is used.' },
  no_gst: { type: 'boolean', description: 'True only if the user said no GST.' },
  discount_percent: { type: 'number' },
  discount_amount: { type: 'string', description: 'A flat discount, as said.' },
  issue_date: { type: 'string' },
  terms: { type: 'string' },
  notes: { type: 'string' },
  project: { type: 'string', description: 'Project name or code to link it to (invoices).' },
  client_abroad: { type: 'boolean', description: 'True if the client is outside India (IGST).' },
};

function draftTool(type) {
  const noun = TYPE_NOUN[type];
  const extra = type === 'invoice'
    ? { due_date: { type: 'string', description: 'As said, or omit for the client’s usual terms.' } }
    : type === 'quotation'
      ? { valid_until: { type: 'string', description: 'As said, or omit for 30 days.' } }
      : { advance_percent: { type: 'number', description: 'Advance asked up front, %; omit for the usual.' }, due_date: { type: 'string' } };

  return {
    name: `create_${type}_draft`,
    module: 'finance',
    kind: 'write',
    risk: 'low',
    permission: { resource: 'financial_documents', action: 'create' },
    description: {
      invoice: 'Draft a tax invoice (not sent): "invoice Acme 50k for the website", "bill Kite for 3 months of support at 20k each". '
        + 'It is saved as a draft with the next invoice number; issue_document sends it.',
      quotation: 'Draft a quotation (not sent): "quote Orbit 2 lakh for the app build", "make a quote for Kite, 10 hours consulting at 3k".',
      proforma: 'Draft a proforma invoice asking for an advance (not sent): "proforma for Acme, 1 lakh, 50% advance".',
    }[type],
    params: { type: 'object', properties: { ...DRAFT_PARAMS, ...extra }, required: ['client'] },
    // An invoice draft already holds a number in the GST series, so undoing it
    // cancels it (the series stays complete); a quotation or proforma draft
    // nobody has seen is simply deleted.
    undoable: true,

    async resolve(args, ctx) {
      const c = await resolveClient(args.client, ctx);
      if (c.needs || c.error) return c;
      const { items } = await readItems(args.items, ctx);
      if (!items.length || items.some((it) => !it.description)) {
        return needsInput('items', `What is the ${noun} for, and how much? (e.g. “website design 50k”)`);
      }
      const unpriced = items.find((it) => !(Number(it.rate) > 0));
      if (unpriced) return needsInput('items', `How much for “${unpriced.description}”?`);

      const d = await usual(type, c.row.id, ctx);
      const issue = readDate(args.issue_date, ctx.today, { prefer: 'past' });
      if (issue.error) return needsInput('issue_date', `${issue.error} What date should it carry?`);
      const issueDate = issue.value || ctx.today;
      // Also reads its own output (gst_enabled, discount_type, is_inter_state…):
      // confirm re-resolves the stored arguments, and must land on the same draft.
      const noGst = args.no_gst === true || args.gst_enabled === false;
      const saidRate = args.gst_rate !== undefined && args.gst_rate !== null && args.gst_rate !== '' && Number.isFinite(Number(args.gst_rate));
      const out = {
        client: c.row.id,
        items,
        gst_enabled: !noGst,
        gst_rate: noGst ? 0 : (saidRate ? Number(args.gst_rate) : d.gstRate),
        discount_type: null,
        discount_value: 0,
        issue_date: issueDate,
        is_inter_state: args.is_inter_state === true || args.client_abroad === true
          || (!!c.row.country_code && c.row.country_code !== ((await orgRow(ctx)).country_code || 'IN')),
        terms: args.terms ?? d.terms,
        notes: args.notes ?? null,
        payment_instructions: args.payment_instructions ?? d.paymentInstructions,
        defaults_from: args.defaults_from ?? d.source,
      };
      if (['percent', 'flat'].includes(args.discount_type) && Number(args.discount_value) > 0) {
        out.discount_type = args.discount_type; out.discount_value = Number(args.discount_value);
      } else if (Number(args.discount_percent) > 0) { out.discount_type = 'percent'; out.discount_value = Number(args.discount_percent); }
      else if (args.discount_amount) {
        const a = readRate(args.discount_amount);
        if (a > 0) { out.discount_type = 'flat'; out.discount_value = a; }
      }
      if (type === 'quotation') {
        const v = readDate(args.valid_until, issueDate, { prefer: 'future' });
        if (v.error) return needsInput('valid_until', `${v.error} Valid until when?`);
        out.valid_until = v.value || shiftDays(issueDate, 30);
      } else {
        const due = readDate(args.due_date, issueDate, { prefer: 'future' });
        if (due.error) return needsInput('due_date', `${due.error} When is it due?`);
        out.due_date = due.value || shiftDays(issueDate, d.dueDays);
      }
      if (type === 'proforma') {
        const pct = args.advance_percent ?? d.advancePercent;
        out.advance_percent = Math.min(100, Math.max(0, Number(pct) || 0));
      }
      if (type === 'invoice' && args.project) {
        const p = await resolveEntity('project', args.project, ctx);
        if (p.status === 'many') return choiceFrom('project', 'project', p);
        if (p.status === 'none') return notFound(`I could not find a project matching “${args.project}”.`);
        out.project = p.row.id;
      }
      return { args: out, entities: [entityOf('client', c.row)] };
    },

    async validate(args, ctx) {
      const problems = [];
      const plan = await planProblem(type, ctx);
      if (plan) problems.push(plan);
      if (args.gst_rate < 0 || args.gst_rate > 40) problems.push('A GST rate must be between 0 and 40%.');
      if (args.due_date && args.due_date < args.issue_date) problems.push('The due date is before the issue date.');
      if (args.valid_until && args.valid_until < args.issue_date) problems.push('It would expire before it is issued.');
      if (args.discount_type === 'percent' && args.discount_value > 100) problems.push('A discount cannot be more than 100%.');
      return problems;
    },

    async preview(args, ctx) {
      const client = await byId('client', args.client, ctx);
      const doc = await docPreview(type, args, client, ctx);
      const rows = [
        ['Client', client?.name || '—'],
        ['Date', formatDate(args.issue_date)],
        type === 'quotation' ? ['Valid until', formatDate(args.valid_until)] : ['Due', formatDate(args.due_date)],
        ['GST', args.gst_enabled ? `${args.gst_rate}% ${args.is_inter_state ? 'IGST' : 'CGST + SGST'}` : 'None'],
      ];
      if (type === 'proforma') rows.push(['Advance asked', `${args.advance_percent}% — ${money(doc.totals.grandTotal * args.advance_percent / 100)}`]);
      if (args.project) {
        const p = await byId('project', args.project, ctx);
        if (p) rows.push(['Project', `${p.code} · ${p.name}`]);
      }
      return {
        title: `Draft ${noun}`,
        target: client ? entityOf('client', client) : null,
        preview: { kind: 'document', rows, document: doc, note: args.defaults_from ? `Terms and GST follow ${args.defaults_from}.` : null },
        confirmLabel: `Save ${noun} draft · ${money(doc.totals.grandTotal)}`,
        notes: [
          type === 'invoice' ? 'Saved as a draft with the next invoice number. Nothing is sent to the client.' : 'Saved as a draft. Nothing is sent to the client.',
        ],
        fields: [
          { key: 'issue_date', label: 'Date', type: 'date', value: args.issue_date },
          type === 'quotation'
            ? { key: 'valid_until', label: 'Valid until', type: 'date', value: args.valid_until }
            : { key: 'due_date', label: 'Due', type: 'date', value: args.due_date },
          { key: 'gst_rate', label: 'GST %', type: 'select', value: String(args.gst_rate), options: [0, 5, 12, 18, 28].map((r) => ({ value: String(r), label: r ? `${r}%` : 'No GST' })) },
          { key: 'notes', label: 'Notes', type: 'textarea', value: args.notes || '' },
        ],
      };
    },

    async plan(args, ctx) {
      const client = await byId('client', args.client, ctx);
      const org = await orgRow(ctx);
      const { data: number, error } = await ctx.db.rpc('next_document_number', { p_org: ctx.orgId, p_type: type });
      if (error) throw error;
      const doc = {
        type,
        status: 'draft',
        doc_number: number,
        customer_id: client.id,
        title: TYPE_TITLE[type],
        issued_by: org.company_name || '',
        issued_to: client.name,
        company_profile: companyProfileOf(org),
        clientName: client.name,
        clientEmail: client.email || null,
        clientAddress: client.address || null,
        buyerGSTIN: client.gstin || null,
        buyerState: client.state || null,
        issue_date: args.issue_date,
        due_date: args.due_date || null,
        valid_until: args.valid_until || null,
        gst_enabled: args.gst_enabled,
        gst_rate: args.gst_enabled ? args.gst_rate : 0,
        is_inter_state: args.is_inter_state,
        discount_type: args.discount_type,
        discount_value: args.discount_value,
        advance_percent: type === 'proforma' ? args.advance_percent : undefined,
        terms: args.terms || null,
        notes: args.notes || null,
        payment_instructions: args.payment_instructions || null,
        created_via: 'edgeai',
      };
      const row = { ...stripUndefined(finDocToRow(doc, { signaturePath: org.signature_path, today: ctx.today })), org_id: ctx.orgId };
      return [{
        op: 'insert', table: 'financial_documents', row, refresh: true, key: 'document',
        then: (inserted) => [
          {
            op: 'insertMany', table: 'document_line_items', key: 'lines',
            rows: lineItemRows(args.items).map((li, position) => ({ ...li, document_id: inserted.id, org_id: ctx.orgId, position })),
          },
          ...(args.project && ctx.can('project_allocations', 'create') ? [{
            op: 'rpc', fn: 'set_project_allocations', key: 'project',
            params: { p_source_type: 'invoice', p_source_id: inserted.id, p_splits: [{ project_id: args.project, amount: null }] },
          }] : []),
        ],
      }];
    },

    undoPlan(results) {
      const d = results.find((x) => x.key === 'document' && x.ok !== false);
      if (!d) return null;
      return type === 'invoice'
        ? [{ op: 'update', table: 'financial_documents', id: d.id, version: d.after?.updated_at || null, patch: { status: 'cancelled' }, before: { status: 'draft' } }]
        : [{ op: 'delete', table: 'financial_documents', id: d.id, version: d.after?.updated_at || null, before: d.after }];
    },

    summary(outcome) {
      const d = outcome.results.find((x) => x.key === 'document');
      if (!d || d.ok === false) return `The ${noun} was not saved: ${d?.error || 'unknown error'}`;
      let line = `Saved ${noun} draft **${d.after.doc_number}** for ${d.after.bill_to_name} — ${money(d.after.grand_total, d.after.currency || 'INR')}.`;
      if (outcome.warnings?.length) line += ` Note: ${outcome.warnings[0]}`;
      return line;
    },

    entitiesOf(outcome) {
      const d = outcome.results.find((x) => x.key === 'document' && x.ok !== false);
      return d?.after ? [entityOf('invoice', d.after)] : [];
    },
  };
}

const stripUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * What the card draws: the document as InvoicePreview reads it, with the
 * totals app.recompute_document_totals() will store.
 */
async function docPreview(type, args, client, ctx) {
  const org = await orgRow(ctx);
  const totals = documentTotals({
    items: args.items, discountType: args.discount_type, discountValue: args.discount_value,
    gstEnabled: args.gst_enabled, gstRate: args.gst_rate, isInterState: args.is_inter_state,
  });
  return {
    type,
    title: TYPE_TITLE[type],
    number: args.doc_number || '(next number)',
    issueDate: args.issue_date,
    dueDate: args.due_date || args.valid_until || null,
    client: {
      name: client?.name || '', email: client?.email || '', address: client?.address || '',
      gstin: client?.gstin || '', state: client?.state || '',
    },
    company: {
      name: org.company_name || '', address: org.company_address || '', email: org.company_email || '',
      phone: org.company_phone || '', city: org.stamp_city || '',
    },
    items: (args.items || []).map((it, i) => ({
      description: it.description, hsn: it.hsn || '', quantity: Number(it.quantity), rate: Number(it.rate), amount: totals.lines[i],
    })),
    gstRate: args.gst_enabled ? args.gst_rate : 0,
    isInterState: !!args.is_inter_state,
    discountRate: args.discount_type === 'percent' ? args.discount_value : 0,
    notes: args.notes || args.terms || '',
    currency: 'INR',
    totals: {
      subtotal: totals.subtotal, discountAmount: totals.discount, taxableAmount: totals.taxable,
      cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst, grandTotal: totals.grandTotal,
    },
  };
}

/** The same drawing for a document that already exists. */
function storedPreview(doc) {
  return {
    type: doc.type,
    title: TYPE_TITLE[doc.type],
    number: docNumber(doc),
    issueDate: doc.issue_date,
    dueDate: doc.due_date || doc.valid_until || null,
    client: { name: doc.clientName || '', email: doc.clientEmail || '', address: doc.clientAddress || '', gstin: doc.buyerGSTIN || '', state: doc.buyerState || '' },
    company: {
      name: doc.company_profile?.company_name || '', address: doc.company_profile?.address || '',
      email: doc.company_profile?.email || '', phone: doc.company_profile?.phone || '', city: doc.company_profile?.stamp_city || '',
    },
    items: (doc.items || []).map((it) => ({ description: it.description, hsn: it.hsn || '', quantity: Number(it.quantity), rate: Number(it.rate), amount: Number(it.amount) })),
    gstRate: doc.gst_enabled === false ? 0 : Number(doc.gst_rate) || 0,
    isInterState: !!doc.is_inter_state,
    discountRate: doc.discount_type === 'percent' ? Number(doc.discount_value) || 0 : 0,
    notes: doc.notes || doc.terms || '',
    currency: doc.currency || 'INR',
    totals: (() => {
      const gst = Number(doc.gst_amount) || 0;
      const half = r2(gst / 2);
      return {
        subtotal: Number(doc.subtotal) || 0, discountAmount: Number(doc.discount_amount) || 0,
        taxableAmount: Number(doc.taxable_amount) || 0,
        cgst: doc.is_inter_state ? 0 : half, sgst: doc.is_inter_state ? 0 : r2(gst - half),
        igst: doc.is_inter_state ? gst : 0, grandTotal: Number(doc.grand_total) || 0,
      };
    })(),
  };
}

/* ── convert ──────────────────────────────────────────────────────────────── */

const convert_quotation = {
  name: 'convert_quotation',
  module: 'finance',
  kind: 'write',
  risk: 'low',
  permission: { resource: 'financial_documents', action: 'create' },
  description: 'Turn an accepted quotation into a proforma or a tax invoice draft, or a paid proforma into its tax invoice draft. '
    + 'Implied by "Kite accepted the quote, bill them", "convert QT-2026-0007 to an invoice". Omit target to use the recommended one.',
  params: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'The quotation or proforma: number, client name, or "it".' },
      target: { type: 'string', enum: ['proforma', 'invoice'] },
      advance_percent: { type: 'number', description: 'For a proforma: advance %, if the user said one.' },
    },
    required: ['source'],
  },
  undoable: true,

  async resolve(args, ctx) {
    const s = await resolveDoc(args.source, ctx, { types: ['quotation', 'proforma'], param: 'source', noun: 'quotation or proforma', filter: (d) => d.status !== 'cancelled' });
    if (s.needs || s.error) return s;
    const full = await fullDoc(s.row.id, ctx);
    const source = full.doc;
    const targets = conversionTargets(source);
    if (!targets.length) {
      const why = source.type === 'quotation'
        ? `${docNumber(source)} is ${source.status}; only an accepted quotation can be converted — the client has to accept it first.`
        : `${docNumber(source)} is ${source.status}; a proforma becomes its tax invoice once the advance is in.`;
      return { error: why, fatal: true };
    }
    const docs = await allDocs(ctx);
    const done = existingConversion(source, docs);
    if (done) return { error: `${docNumber(source)} was already converted to ${docNumber(done)}.`, fatal: true };
    const rec = source.type === 'quotation' ? recommendTarget(source, docs, ctx.today) : { target: 'invoice', reasons: [] };
    const target = args.target && targets.includes(args.target) ? args.target : targets.includes(rec.target) ? rec.target : targets[0];
    if (args.target && !targets.includes(args.target)) {
      return { error: `${docNumber(source)} can only become a ${targets.join(' or ')} right now.`, fatal: true };
    }
    return {
      args: {
        source: source.id, target,
        advance_percent: target === 'proforma'
          ? Math.min(100, Math.max(0, Number(args.advance_percent ?? source.advance_percent ?? DEFAULT_ADVANCE_PERCENT) || 0))
          : undefined,
        reasons: args.reasons ?? (args.target ? [] : rec.reasons),
      },
      targets: [{ table: 'financial_documents', id: source.id, version: full.row.updated_at }],
      entities: [entityOf('invoice', full.row)],
    };
  },

  async validate(args, ctx) {
    const p = await planProblem(args.target, ctx);
    return p ? [p] : [];
  },

  async preview(args, ctx) {
    const { doc: source, row } = await fullDoc(args.source, ctx);
    const built = buildConversion(source, args.target, { advancePercent: args.advance_percent, today: ctx.today });
    const advance = source.type === 'proforma' ? carriedAdvance(source) : null;
    const preview = storedPreview({ ...source, type: args.target, doc_number: '(next number)', issue_date: built.issue_date, due_date: built.due_date, valid_until: null });
    const rows = [
      ['From', `${docNumber(source)} (${source.status})`],
      ['New', `${TYPE_NOUN[args.target]} draft, dated ${formatDate(built.issue_date)}, due ${formatDate(built.due_date)}`],
      ['Total', money(row.grand_total, row.currency || 'INR')],
    ];
    if (args.target === 'proforma') rows.push(['Advance asked', `${built.advance_percent}% — ${money(Number(row.grand_total) * built.advance_percent / 100)}`]);
    if (advance) rows.push(['Advance carried over', `${money(advance.amount)} already received, recorded on the invoice`]);
    return {
      title: `Convert to ${TYPE_NOUN[args.target]}`,
      target: entityOf('invoice', row),
      preview: {
        kind: 'document', rows, document: preview,
        note: args.reasons?.length ? `Why a ${args.target}: ${args.reasons.join(' ')}` : null,
      },
      confirmLabel: `Create ${TYPE_NOUN[args.target]} draft`,
      notes: ['Saved as a draft. Nothing is sent to the client.'],
      fields: args.target === 'proforma' ? [{ key: 'advance_percent', label: 'Advance %', type: 'text', value: String(built.advance_percent) }] : [],
    };
  },

  async plan(args, ctx) {
    const { doc: source, row: sourceRow } = await fullDoc(args.source, ctx);
    const org = await orgRow(ctx);
    const built = buildConversion(source, args.target, { advancePercent: args.advance_percent, today: ctx.today });
    const advance = source.type === 'proforma' ? carriedAdvance(source) : null;
    const { data: number, error } = await ctx.db.rpc('next_document_number', { p_org: ctx.orgId, p_type: args.target });
    if (error) throw error;
    const row = { ...stripUndefined(finDocToRow({ ...built, doc_number: number, created_via: 'edgeai' }, { signaturePath: org.signature_path, today: ctx.today })), org_id: ctx.orgId };
    return [{
      op: 'insert', table: 'financial_documents', row, refresh: true, key: 'document',
      then: (inserted) => [
        {
          op: 'insertMany', table: 'document_line_items', key: 'lines',
          rows: lineItemRows(source.items).map((li, position) => ({ ...li, document_id: inserted.id, org_id: ctx.orgId, position })),
        },
        ...(advance ? [{
          op: 'insert', table: 'payments', key: 'advance',
          row: {
            org_id: ctx.orgId, document_id: inserted.id, amount: advance.amount, paid_on: advance.paidOn || ctx.today,
            method: advance.method, reference: advance.reference, note: advance.note,
            submitted_by_recipient: false, confirmed_at: new Date().toISOString(), confirmed_by: ctx.user.id,
          },
        }] : []),
        {
          op: 'update', table: 'financial_documents', id: source.id, key: 'source',
          patch: { status: 'converted', payload: { ...(sourceRow.payload || {}), converted_to: inserted.id } },
          before: { status: source.status },
        },
      ],
    }];
  },

  undoPlan(results) {
    const d = results.find((x) => x.key === 'document' && x.ok !== false);
    const s = results.find((x) => x.key === 'source' && x.ok !== false);
    const adv = results.find((x) => x.key === 'advance' && x.ok !== false);
    if (!d) return null;
    const plan = [];
    if (adv) plan.push({ op: 'delete', table: 'payments', id: adv.id, version: null, before: adv.after });
    plan.push(d.after.type === 'invoice'
      ? { op: 'update', table: 'financial_documents', id: d.id, version: d.after.updated_at, patch: { status: 'cancelled' }, before: { status: 'draft' } }
      : { op: 'delete', table: 'financial_documents', id: d.id, version: d.after.updated_at, before: d.after });
    if (s) {
      const back = revertedStatusOf({ ...s.after, status: 'converted' }) || s.before?.status;
      plan.push({ op: 'update', table: 'financial_documents', id: s.id, version: s.after?.updated_at || null, patch: { status: back, payload: { ...(s.after?.payload || {}), converted_to: null } }, before: { status: 'converted' } });
    }
    return plan;
  },

  summary(outcome, args) {
    const d = outcome.results.find((x) => x.key === 'document');
    if (!d || d.ok === false) return `Not converted: ${d?.error || 'unknown error'}`;
    const adv = outcome.results.find((x) => x.key === 'advance' && x.ok !== false);
    let line = `Created ${TYPE_NOUN[args.target]} draft **${d.after.doc_number}** — ${money(d.after.grand_total, d.after.currency || 'INR')}${adv ? `, with the ${money(adv.after?.amount)} advance applied` : ''}.`;
    if (outcome.warnings?.length) line += ` Note: ${outcome.warnings[0]}`;
    return line;
  },

  entitiesOf(outcome) {
    const d = outcome.results.find((x) => x.key === 'document' && x.ok !== false);
    return d?.after ? [entityOf('invoice', d.after)] : [];
  },
};

/* ── issue ────────────────────────────────────────────────────────────────── */

const issue_document = {
  name: 'issue_document',
  module: 'finance',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'financial_documents', action: 'edit' },
  description: 'Issue a draft invoice, quotation or proforma: it becomes "sent", its content is locked as version 1, and a tax invoice enters the books. '
    + 'Does NOT email it — say so. "issue INV-2026-0042", "finalise the Acme invoice", "mark the Kite quote as sent".',
  params: { type: 'object', properties: { document: { type: 'string' } }, required: ['document'] },
  undoable: false,

  async resolve(args, ctx) {
    const d = await resolveDoc(args.document, ctx, { filter: (r) => r.status === 'draft', noun: 'draft' });
    if (d.needs || d.error) return d;
    const full = await fullDoc(d.row.id, ctx);
    return {
      args: { document: d.row.id },
      targets: [{ table: 'financial_documents', id: d.row.id, version: full.row.updated_at }],
      entities: [entityOf('invoice', full.row)],
    };
  },

  async validate(args, ctx) {
    const { doc, row } = await fullDoc(args.document, ctx);
    const p = [];
    if (row.status !== 'draft' || row.current_version_id) p.push(`${docNumber(doc)} has already been issued.`);
    if (!(doc.items || []).length) p.push(`${docNumber(doc)} has no line items.`);
    if (!(Number(row.grand_total) > 0)) p.push(`${docNumber(doc)} totals ${money(row.grand_total)}; add its lines before issuing.`);
    return p;
  },

  async preview(args, ctx) {
    const { doc, row } = await fullDoc(args.document, ctx);
    const noun = TYPE_NOUN[row.type];
    return {
      title: `Issue ${noun} ${row.doc_number}`,
      target: entityOf('invoice', row),
      preview: {
        kind: 'document',
        rows: [['To', row.bill_to_name], ['Email on file', row.bill_to_email || '— (none)'], ['Total', money(row.grand_total, row.currency || 'INR')]],
        document: storedPreview(doc),
        full: true,
      },
      confirmLabel: `Issue ${row.doc_number} · ${money(row.grand_total, row.currency || 'INR')}`,
      irreversible: row.type === 'invoice'
        ? 'Once issued, the invoice counts as revenue and can only be cancelled, never deleted. It is not emailed — share it from the invoice list.'
        : `Once issued, the ${noun} is locked as version 1; any change goes out as a new version. It is not emailed — share it from the list.`,
    };
  },

  async plan(args, ctx) {
    const { row } = await fullDoc(args.document, ctx);
    return [{ op: 'update', table: 'financial_documents', id: row.id, version: row.updated_at, patch: { status: 'sent' }, before: { status: 'draft' }, key: 'document' }];
  },

  summary(outcome) {
    const r = outcome.results[0];
    return r?.ok === false ? `Not issued: ${r.error}` : `Issued **${r.after.doc_number}** to ${r.after.bill_to_name} — ${money(r.after.grand_total, r.after.currency || 'INR')}. It has not been emailed.`;
  },
};

/* ── payments ─────────────────────────────────────────────────────────────── */

function readMethod(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  return PAYMENT_METHODS.find((m) => m.key === s || m.label.toLowerCase() === s)?.key || parseMethod(s)?.method || null;
}

const openForPayment = (r) => ['invoice', 'proforma'].includes(r.type) && OPEN.includes(r.status) && balanceOf(r) > 0.009;

function paymentTool({ name, full, description }) {
  return {
    name,
    module: 'finance',
    kind: 'write',
    risk: 'high',
    permission: { resource: 'payments', action: 'create' },
    description,
    params: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'The invoice or proforma: number, or the client ("Acme\'s invoice").' },
        ...(full ? {} : { amount: { type: 'string', description: 'As said ("54,000", "half"); "full" for the whole balance.' } }),
        date: { type: 'string', description: 'When it was received, as said. Omit for today.' },
        method: { type: 'string', enum: PAYMENT_METHODS.map((m) => m.key) },
        reference: { type: 'string', description: 'UTR, cheque number, if given.' },
      },
      required: ['document'],
    },
    // Undo deletes the payment row — only for a role that may delete payments.
    undoable: (_args, ctx) => ctx.can('payments', 'delete'),

    async resolve(args, ctx) {
      const d = await resolveDoc(args.document, ctx, { types: ['invoice', 'proforma'], filter: openForPayment, noun: 'unpaid invoice' });
      if (d.needs || d.error) return d;
      const full0 = await fullDoc(d.row.id, ctx);
      const owed = balanceOf(full0.row);
      let amount;
      const said = full ? 'full' : String(args.amount ?? '').trim();
      if (!said) return needsInput('amount', `How much was received? ${money(owed)} is still owed.`, [{ label: `All ${money(owed)}`, value: 'full' }]);
      if (/^(full|all|entire|everything|whole|balance|the rest|remaining)$/i.test(said)) amount = owed;
      else if (/^half$/i.test(said)) amount = r2(owed / 2);
      else {
        amount = readRate(said);
        if (!(amount > 0)) return needsInput('amount', `I could not read “${said}” as an amount. How much was received?`, [{ label: `All ${money(owed)}`, value: 'full' }]);
      }
      const when = readDate(args.date, ctx.today, { prefer: 'past' });
      if (when.error) return needsInput('date', `${when.error} When was it received?`, [{ label: 'Today', value: 'today' }, { label: 'Yesterday', value: 'yesterday' }]);
      return {
        args: {
          document: d.row.id, amount: r2(amount), date: when.value || ctx.today,
          method: readMethod(args.method) || 'bank_transfer', reference: args.reference ? String(args.reference).slice(0, 120) : null,
        },
        targets: [{ table: 'financial_documents', id: d.row.id, version: full0.row.updated_at }],
        entities: [entityOf('invoice', full0.row)],
      };
    },

    async validate(args, ctx) {
      const { row } = await fullDoc(args.document, ctx);
      const owed = balanceOf(row);
      const p = [];
      if (!openForPayment(row)) p.push(`${row.doc_number} is ${row.status}; there is nothing to receive against it.`);
      if (args.amount > owed + 0.01) p.push(`That is more than the ${money(owed)} still owed on ${row.doc_number}.`);
      if (args.date > ctx.today) p.push('A payment cannot be dated in the future.');
      return p;
    },

    async preview(args, ctx) {
      const { row } = await fullDoc(args.document, ctx);
      const owed = balanceOf(row);
      const after = r2(owed - args.amount);
      return {
        title: after <= 0.01 ? `Mark ${row.doc_number} paid` : `Record payment on ${row.doc_number}`,
        target: entityOf('invoice', row),
        preview: {
          kind: 'payment',
          rows: [
            ['From', row.bill_to_name], ['Against', `${row.doc_number} · total ${money(row.grand_total, row.currency || 'INR')}`],
            ['Amount', money(args.amount, row.currency || 'INR')], ['Received on', formatDate(args.date)],
            ['Method', methodLabel(args.method)], ...(args.reference ? [['Reference', args.reference]] : []),
            ['Still owed after', after <= 0.01 ? 'Nothing — it will show as paid' : money(after, row.currency || 'INR')],
          ],
          note: 'Recorded as confirmed money received. Revenue, receivables and the cash position update from it.',
        },
        confirmLabel: `Record ${money(args.amount, row.currency || 'INR')} payment`,
        fields: [
          { key: 'amount', label: 'Amount', type: 'text', value: String(args.amount) },
          { key: 'date', label: 'Received on', type: 'date', value: args.date, max: ctx.today },
          { key: 'method', label: 'Method', type: 'select', value: args.method, options: PAYMENT_METHODS.map((m) => ({ value: m.key, label: m.label })) },
          { key: 'reference', label: 'Reference', type: 'text', value: args.reference || '' },
        ],
      };
    },

    async plan(args, ctx) {
      return [{
        op: 'insert', table: 'payments', key: 'payment',
        row: {
          org_id: ctx.orgId, document_id: args.document, amount: args.amount, paid_on: args.date,
          method: methodLabel(args.method), reference: args.reference || null, note: 'Recorded by EdgeAI',
          submitted_by_recipient: false, confirmed_at: new Date().toISOString(), confirmed_by: ctx.user.id,
        },
      }];
    },

    summary(outcome, args, ctx) {
      const r = outcome.results[0];
      if (r?.ok === false) return `Not recorded: ${r.error}`;
      void ctx;
      return `Recorded **${money(args.amount)}** received${args.reference ? ` (${args.reference})` : ''} on ${formatDate(args.date)}.`;
    },

    async after(outcome, ctx) {
      const { data } = await ctx.db.from('financial_documents').select('doc_number, status, grand_total, amount_paid').eq('id', outcome.results[0]?.after?.document_id).maybeSingle();
      if (!data) return null;
      const owed = balanceOf(data);
      return owed <= 0.01 ? `${data.doc_number} is now paid.` : `${data.doc_number} has ${money(owed)} left to collect.`;
    },
  };
}

const record_payment = paymentTool({
  name: 'record_payment',
  full: false,
  description: 'Record money received against an issued invoice or proforma. Implied by "Acme paid 54,000 against INV-0042", '
    + '"Kite paid half the invoice by UPI", "got the advance for the Orbit proforma". For money with no invoice, use create_cash_entry.',
});

const mark_invoice_paid = paymentTool({
  name: 'mark_invoice_paid',
  full: true,
  description: 'Record the whole remaining balance of an invoice as received: "Acme paid the invoice", "INV-0042 is settled".',
});

/* ── vendors and bills ────────────────────────────────────────────────────── */

const create_vendor = {
  name: 'create_vendor',
  module: 'finance',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'vendors', action: 'create' },
  description: 'Add a supplier: "add Dell India as a vendor, 45 days credit", "new vendor Sharma Stationers, GSTIN 29ABCDE1234F1Z5".',
  params: {
    type: 'object',
    properties: {
      company_name: { type: 'string' }, contact_name: { type: 'string' }, email: { type: 'string' },
      phone: { type: 'string' }, gstin: { type: 'string' }, state: { type: 'string' },
      payment_terms_days: { type: 'number' }, category: { type: 'string' },
    },
    required: ['company_name'],
  },
  undoable: (_args, ctx) => ctx.can('vendors', 'delete'),

  async resolve(args) {
    const name = String(args.company_name ?? '').trim();
    if (!name) return needsInput('company_name', 'What is the vendor called?');
    return {
      args: {
        company_name: name.slice(0, 200),
        contact_name: args.contact_name || null, email: args.email ? String(args.email).toLowerCase() : null,
        phone: args.phone || null, gstin: args.gstin ? String(args.gstin).trim().toUpperCase() : null,
        state: args.state || null,
        payment_terms_days: Number(args.payment_terms_days) > 0 ? Math.round(Number(args.payment_terms_days)) : 30,
        category: args.category || null,
      },
    };
  },

  async validate(args, ctx) {
    const p = [];
    const vendors = await loadKind('vendor', ctx);
    const dupe = vendors.find((v) => normalize(v.company_name) === normalize(args.company_name));
    if (dupe) p.push(`${q(dupe.company_name)} is already a vendor.`);
    if (args.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(args.gstin)) p.push(`“${args.gstin}” is not a valid GSTIN.`);
    if (args.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email)) p.push(`“${args.email}” is not an email address.`);
    return p;
  },

  preview(args) {
    return {
      title: 'Add vendor',
      preview: {
        kind: 'record',
        rows: [
          ['Name', args.company_name], ['Contact', args.contact_name || '—'], ['Email', args.email || '—'],
          ['Phone', args.phone || '—'], ['GSTIN', args.gstin || '—'], ['Credit', `${args.payment_terms_days} days`],
        ],
      },
      confirmLabel: `Add ${args.company_name}`,
      fields: [
        { key: 'company_name', label: 'Name', type: 'text', value: args.company_name },
        { key: 'payment_terms_days', label: 'Credit days', type: 'text', value: String(args.payment_terms_days) },
      ],
    };
  },

  plan(args, ctx) {
    return [{ op: 'insert', table: 'vendors', key: 'vendor', row: { org_id: ctx.orgId, ...args } }];
  },

  summary(outcome) {
    const r = outcome.results[0];
    return r?.ok === false ? `Not added: ${r.error}` : `Added vendor **${r.after.company_name}**.`;
  },

  entitiesOf(outcome) {
    const r = outcome.results[0];
    return r?.after?.id ? [entityOf('vendor', r.after)] : [];
  },
};

const create_purchase_bill = {
  name: 'create_purchase_bill',
  module: 'finance',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'purchase_invoices', action: 'create' },
  description: 'Record a bill received from a vendor (money we owe): "got Dell\'s bill 85k incl GST, bill no DL-9981", '
    + '"Sharma Stationers billed us 4,200 plus 12% GST". Not for money already paid with no bill — that is create_cash_entry.',
  params: {
    type: 'object',
    properties: {
      vendor: { type: 'string' },
      bill_number: { type: 'string' },
      amount: { type: 'string', description: 'As said.' },
      amount_is: { type: 'string', enum: ['total', 'subtotal'], description: '"subtotal" if the user said "plus GST"; otherwise total (GST included).' },
      tax_rate: { type: 'number' },
      bill_date: { type: 'string' },
      due_date: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string' },
    },
    required: ['vendor'],
  },
  undoable: (_args, ctx) => ctx.can('purchase_invoices', 'delete'),

  async resolve(args, ctx) {
    const v = await resolveEntity('vendor', args.vendor ?? 'it', ctx, { filter: (x) => !x.archived_at });
    if (v.status === 'many') return choiceFrom('vendor', 'vendor', v);
    if (v.status === 'none') {
      return notFound(`There is no vendor called “${args.vendor}” yet.`, args.vendor ? { tool: 'create_vendor', args: { company_name: String(args.vendor) }, label: `Add “${args.vendor}” as a vendor first` } : null);
    }
    const vendor = v.row;
    const amount = readRate(args.amount);
    if (!(amount > 0)) return needsInput('amount', `How much is ${vendor.company_name}’s bill for?`);
    if (!String(args.bill_number ?? '').trim()) return needsInput('bill_number', 'What is the bill number on it?');
    const billDate = readDate(args.bill_date, ctx.today, { prefer: 'past' });
    if (billDate.error) return needsInput('bill_date', `${billDate.error} What date is on the bill?`);
    const bd = billDate.value || ctx.today;
    const { data: last } = await ctx.db.from('purchase_invoices').select('tax_rate, category').eq('vendor_id', vendor.id).order('bill_date', { ascending: false }).limit(1);
    const rate = Number.isFinite(Number(args.tax_rate)) && args.tax_rate !== null && args.tax_rate !== '' ? Number(args.tax_rate) : Number(last?.[0]?.tax_rate ?? 18);
    const subtotal = args.amount_is === 'subtotal' ? r2(amount) : r2(amount / (1 + rate / 100));
    const due = readDate(args.due_date, bd, { prefer: 'future' });
    if (due.error) return needsInput('due_date', `${due.error} When is it due?`);
    return {
      args: {
        vendor: vendor.id, bill_number: String(args.bill_number).trim().slice(0, 80),
        bill_date: bd, due_date: due.value || shiftDays(bd, Number(vendor.payment_terms_days) || 30),
        // Canonical in the tool's own input terms, so confirm re-reads it as is.
        amount: String(subtotal), subtotal, tax_rate: rate, amount_is: 'subtotal',
        description: args.description || null,
        category: args.category || last?.[0]?.category || vendor.category || 'Operations',
      },
      entities: [entityOf('vendor', vendor)],
    };
  },

  async validate(args, ctx) {
    const p = [];
    const { data } = await ctx.db.from('purchase_invoices').select('id').eq('vendor_id', args.vendor).eq('bill_number', args.bill_number).limit(1);
    if (data?.length) p.push(`Bill ${args.bill_number} from this vendor is already recorded.`);
    if (args.tax_rate < 0 || args.tax_rate > 40) p.push('A GST rate must be between 0 and 40%.');
    if (!isIsoDate(args.bill_date) || args.bill_date > ctx.today) p.push('A bill date cannot be in the future.');
    return p;
  },

  async preview(args, ctx) {
    const vendor = await byId('vendor', args.vendor, ctx);
    const tax = r2(args.subtotal * args.tax_rate / 100);
    return {
      title: 'Record purchase bill',
      target: vendor ? entityOf('vendor', vendor) : null,
      preview: {
        kind: 'bill',
        rows: [
          ['Vendor', vendor?.company_name || '—'], ['Bill no.', args.bill_number],
          ['Bill date', formatDate(args.bill_date)], ['Due', formatDate(args.due_date)],
          ['Amount before GST', money(args.subtotal)], [`GST ${args.tax_rate}%`, money(tax)],
          ['Total owed', money(args.subtotal + tax)], ['Category', args.category],
        ],
        note: 'Recorded as unpaid; it shows in payables until it is paid.',
      },
      confirmLabel: `Record ${money(args.subtotal + tax)} bill`,
      fields: [
        { key: 'bill_number', label: 'Bill no.', type: 'text', value: args.bill_number },
        { key: 'bill_date', label: 'Bill date', type: 'date', value: args.bill_date, max: ctx.today },
        { key: 'due_date', label: 'Due', type: 'date', value: args.due_date },
        { key: 'tax_rate', label: 'GST %', type: 'select', value: String(args.tax_rate), options: [0, 5, 12, 18, 28].map((r) => ({ value: String(r), label: r ? `${r}%` : 'No GST' })) },
      ],
    };
  },

  plan(args, ctx) {
    return [{
      op: 'insert', table: 'purchase_invoices', key: 'bill',
      row: {
        org_id: ctx.orgId, vendor_id: args.vendor, bill_number: args.bill_number, bill_date: args.bill_date,
        due_date: args.due_date, category: args.category, description: args.description,
        subtotal: args.subtotal, tax_rate: args.tax_rate, amount_paid: 0, status: 'unpaid',
      },
    }];
  },

  summary(outcome) {
    const r = outcome.results[0];
    return r?.ok === false ? `Not recorded: ${r.error}` : `Recorded bill **${r.after.bill_number}** — ${money(r.after.total)} due ${formatDate(r.after.due_date)}.`;
  },

  href: () => '/purchases',
};

/* ── cancel and delete ────────────────────────────────────────────────────── */

async function lifecycleFor(id, ctx) {
  const [{ doc, row }, docs] = await Promise.all([fullDoc(id, ctx), allDocs(ctx)]);
  const parent = doc.converted_from ? docs.find((x) => x.id === doc.converted_from) || null : null;
  return { doc, row, docs, parent, rule: lifecycleOf(doc, docs) };
}

function releaseParentOp(parent) {
  const status = revertedStatusOf(parent);
  if (!status) return [];
  return [{ op: 'update', table: 'financial_documents', id: parent.id, key: 'parent', patch: { status, payload: { ...(parent._payload || {}), converted_to: null } }, before: { status: parent.status } }];
}

const delete_financial_document = {
  name: 'delete_financial_document',
  module: 'finance',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'financial_documents', action: 'delete' },
  description: 'Delete a quotation or proforma draft that was never sent — only when the user says delete. Tax invoices are never deleted (use cancel_financial_document).',
  params: { type: 'object', properties: { document: { type: 'string' } }, required: ['document'] },
  undoable: false,

  async resolve(args, ctx) {
    const d = await resolveDoc(args.document, ctx, { filter: (r) => r.status !== 'cancelled' });
    if (d.needs || d.error) return d;
    const { rule, row } = await lifecycleFor(d.row.id, ctx);
    if (!rule.delete.allowed) {
      return notFound(`${row.doc_number} cannot be deleted: ${rule.delete.reason}`,
        (await lifecycleFor(d.row.id, ctx)).rule.cancel.allowed ? { tool: 'cancel_financial_document', args: { document: row.id }, label: `Cancel ${row.doc_number} instead` } : null);
    }
    return { args: { document: row.id }, targets: [{ table: 'financial_documents', id: row.id, version: row.updated_at }], entities: [entityOf('invoice', row)] };
  },

  async validate(args, ctx) {
    const { rule } = await lifecycleFor(args.document, ctx);
    return rule.delete.allowed ? [] : [rule.delete.reason];
  },

  async preview(args, ctx) {
    const { row, parent } = await lifecycleFor(args.document, ctx);
    return {
      title: `Delete ${TYPE_NOUN[row.type]} ${row.doc_number}`,
      target: entityOf('invoice', row),
      preview: {
        kind: 'delete',
        rows: [['Document', `${row.doc_number} (${row.status})`], ['Client', row.bill_to_name], ['Total', money(row.grand_total, row.currency || 'INR')]],
        note: parent && revertedStatusOf(parent) ? `${docNumber(parent)} goes back to ${revertedStatusOf(parent)}, so it can be converted again.` : 'It was never sent, so it is removed completely with its lines.',
      },
      confirmLabel: `Delete ${row.doc_number}`,
      irreversible: 'A deleted draft cannot be restored.',
    };
  },

  async plan(args, ctx) {
    const { row, parent } = await lifecycleFor(args.document, ctx);
    return [
      { op: 'delete', table: 'financial_documents', id: row.id, version: row.updated_at, before: row, key: 'document' },
      ...(parent ? releaseParentOp(parent) : []),
    ];
  },

  summary(outcome) {
    const r = outcome.results.find((x) => x.key === 'document');
    return r?.ok === false ? `Not deleted: ${r.error}` : `Deleted ${r.before.doc_number}.`;
  },
};

const cancel_financial_document = {
  name: 'cancel_financial_document',
  module: 'finance',
  kind: 'write',
  risk: 'high',
  permission: { resource: 'financial_documents', action: 'edit' },
  description: 'Cancel an issued invoice, quotation or proforma (it keeps its number and is reported as cancelled). "cancel INV-0042", "the Globex quote is off, cancel it".',
  params: { type: 'object', properties: { document: { type: 'string' }, reason: { type: 'string' } }, required: ['document'] },
  undoable: false,

  async resolve(args, ctx) {
    const d = await resolveDoc(args.document, ctx, { filter: (r) => r.status !== 'cancelled' });
    if (d.needs || d.error) return d;
    const { rule, row } = await lifecycleFor(d.row.id, ctx);
    if (!rule.cancel.allowed) {
      return notFound(`${row.doc_number} cannot be cancelled: ${rule.cancel.reason}`,
        rule.delete.allowed ? { tool: 'delete_financial_document', args: { document: row.id }, label: `Delete the draft ${row.doc_number} instead` } : null);
    }
    return {
      args: { document: row.id, reason: args.reason ? String(args.reason).slice(0, 280) : null },
      targets: [{ table: 'financial_documents', id: row.id, version: row.updated_at }],
      entities: [entityOf('invoice', row)],
    };
  },

  async validate(args, ctx) {
    const { rule } = await lifecycleFor(args.document, ctx);
    return rule.cancel.allowed ? [] : [rule.cancel.reason];
  },

  async preview(args, ctx) {
    const { row, doc, parent } = await lifecycleFor(args.document, ctx);
    const carried = (doc.payments || []).filter((p) => isCarriedAdvance(p, parent));
    const notes = [];
    if (carried.length) notes.push(`The ${money(carried.reduce((s, p) => s + Number(p.amount), 0))} advance copied from ${docNumber(parent)} is removed from it (it stays recorded on the proforma).`);
    if (parent && revertedStatusOf(parent)) notes.push(`${docNumber(parent)} goes back to ${revertedStatusOf(parent)}, so it can be converted again.`);
    return {
      title: `Cancel ${TYPE_NOUN[row.type]} ${row.doc_number}`,
      target: entityOf('invoice', row),
      preview: {
        kind: 'delete',
        rows: [['Document', `${row.doc_number} (${row.status})`], ['Client', row.bill_to_name], ['Total', money(row.grand_total, row.currency || 'INR')], ...(args.reason ? [['Reason', args.reason]] : [])],
        note: notes.join(' ') || 'It keeps its number and shows as cancelled.',
      },
      confirmLabel: `Cancel ${row.doc_number}`,
      irreversible: 'A cancelled document cannot be reinstated; issue a new one instead.',
    };
  },

  async plan(args, ctx) {
    const { row, doc, parent } = await lifecycleFor(args.document, ctx);
    const carried = (doc.payments || []).filter((p) => isCarriedAdvance(p, parent));
    return [
      ...carried.map((p) => ({ op: 'delete', table: 'payments', id: p.id, version: null, before: p, key: 'carried' })),
      {
        op: 'update', table: 'financial_documents', id: row.id, version: row.updated_at, key: 'document',
        // Status only. A sent document's content is frozen (0064), and the
        // reason is not part of it: it is kept on this action (and in the
        // summary), as the app keeps it in a notification.
        patch: { status: 'cancelled' },
        before: { status: row.status },
      },
      ...(parent ? releaseParentOp(parent) : []),
    ];
  },

  summary(outcome, args) {
    const r = outcome.results.find((x) => x.key === 'document');
    return r?.ok === false ? `Not cancelled: ${r.error}` : `Cancelled ${r.after.doc_number}${args.reason ? ` — ${args.reason}` : ''}.`;
  },
};

/* ── reading bills ────────────────────────────────────────────────────────── */

const list_bills = {
  name: 'list_bills',
  module: 'finance',
  kind: 'read',
  permission: { resource: 'purchase_invoices', action: 'view' },
  description: 'Purchase bills from vendors: what we owe, to whom, what is overdue. Counts and totals over all matches.',
  params: {
    type: 'object',
    properties: {
      vendor: { type: 'string' },
      status: { type: 'string', enum: ['unpaid', 'partially_paid', 'paid', 'overdue', 'open'] },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  status: 'Checking bills…',
  async run(args, ctx) {
    let query = ctx.db.from('purchase_invoices').select('id, vendor_id, bill_number, bill_date, due_date, total, amount_paid, status')
      .order('bill_date', { ascending: false }).limit(3000);
    if (args.vendor) {
      const v = await resolveEntity('vendor', args.vendor, ctx);
      if (v.status !== 'one') return { data: { [v.status === 'many' ? 'ambiguous' : 'not_found']: args.vendor } };
      query = query.eq('vendor_id', v.row.id);
    }
    const { data, error } = await query;
    if (error) return { data: { error: 'Could not read bills.' } };
    const owed = (b) => Math.max(0, (Number(b.total) || 0) - (Number(b.amount_paid) || 0));
    const overdue = (b) => b.status !== 'paid' && b.status !== 'void' && b.due_date && b.due_date < ctx.today && owed(b) > 0.009;
    let rows = data || [];
    if (args.status === 'overdue') rows = rows.filter(overdue);
    else if (args.status === 'open') rows = rows.filter((b) => ['unpaid', 'partially_paid'].includes(b.status));
    else if (args.status) rows = rows.filter((b) => b.status === args.status);
    const limit = Math.min(50, Number(args.limit) || 20);
    const out = [];
    for (const b of rows.slice(0, limit)) {
      out.push({ vendor: (await byId('vendor', b.vendor_id, ctx))?.company_name || null, bill: b.bill_number, date: formatDate(b.bill_date), due: b.due_date ? formatDate(b.due_date) : null, total: money(b.total), owed: money(owed(b)), status: b.status, overdue: overdue(b) });
    }
    return {
      data: {
        total_matching: rows.length, total_owed: money(rows.reduce((s, b) => s + owed(b), 0)),
        overdue_among_them: rows.filter(overdue).length, showing: out.length, bills: out,
      },
      view: {
        type: 'list', title: args.status === 'overdue' ? 'Overdue vendor bills' : 'Vendor bills', total: rows.length, href: '/purchases',
        items: out.map((b) => ({ title: b.vendor || 'Vendor', sub: [b.bill, b.due && `due ${b.due}`].filter(Boolean).join(' · '), value: b.owed, badge: b.overdue ? 'Overdue' : b.status.replace(/_/g, ' '), tone: b.overdue ? 'r' : b.status === 'paid' ? 'g' : 'n' })),
      },
    };
  },
};

export default [
  draftTool('invoice'), draftTool('quotation'), draftTool('proforma'),
  convert_quotation, issue_document,
  record_payment, mark_invoice_paid,
  create_vendor, create_purchase_bill,
  cancel_financial_document, delete_financial_document,
  list_bills,
];

export const __test = { documentTotals, readItems, usual, docPreview, storedPreview, change };
