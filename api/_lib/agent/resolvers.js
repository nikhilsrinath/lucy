/**
 * Entity resolution: from what somebody said to the one record they meant.
 *
 * "that task", "the pricing one", "Acme", "INV-0042", "him" — each has to land
 * on exactly one row, or on a short list the person picks from, or on an
 * honest "I looked for X and found nothing". It never lands on a guess: two
 * plausible matches are always shown as a choice.
 *
 * The order of evidence is the conversation, then the screen, then the table:
 *   1. entities this chat has already referred to (`recentEntities`, sent by
 *      the client, newest first);
 *   2. the record open on the page the person is looking at;
 *   3. a fuzzy search of the table, ranked by how well the words match, then
 *      by recency, then by whether it is theirs.
 *
 * Scoring is pure (rankCandidates) so it can be tested without a database.
 * Loading goes through the user's own client, so a record their role cannot
 * see is never a candidate.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => UUID.test(String(s || '').trim());

/* ── text ─────────────────────────────────────────────────────────────────── */

// Words that carry no identity. "Connect with the client on pricing" and
// "the pricing one" share exactly one word that matters.
const STOP = new Set([
  'the', 'a', 'an', 'of', 'on', 'in', 'for', 'to', 'with', 'and', 'or', 'at', 'by', 'from', 'about',
  'that', 'this', 'these', 'those', 'one', 'ones', 'my', 'our', 'your', 'his', 'her', 'their',
  'task', 'tasks', 'client', 'clients', 'customer', 'lead', 'deal', 'project', 'invoice', 'employee',
  'record', 'item', 'thing', 'called', 'named', 'is', 'it', 're', 'pvt', 'ltd', 'limited', 'private',
  'inc', 'llp', 'llc', 'co', 'company',
]);

export function normalize(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const words = (s) => normalize(s).split(' ').filter((w) => w && !STOP.has(w));

/** Levenshtein distance, capped — only ever asked whether it is ≤ 1 or 2. */
function editDistance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      rowMin = Math.min(rowMin, prev[j]);
    }
    if (rowMin >= cap) return cap;
  }
  return prev[b.length];
}

/** Does query word `q` match label word `w`? Exact, a prefix, or one typo. */
function wordMatches(q, w) {
  if (q === w) return true;
  if (q.length >= 3 && w.startsWith(q)) return true;
  if (q.length >= 5 && w.length >= 5 && editDistance(q, w, 2) <= 1) return true;
  // Plural and possessive: "clients" / "client", "acme's" was already split.
  if (q.length >= 4 && (q === `${w}s` || w === `${q}s`)) return true;
  return false;
}

/**
 * How well `query` names something called any of `aliases`, 0–100.
 *
 *   100  the whole name, or an exact code (INV-0042)
 *    85  the name starts with what was said
 *    75  what was said appears inside the name
 *  55–75 every meaningful word said is in the name (more of the name covered
 *        scores higher, so "pricing" prefers "Pricing call" to "Pricing call
 *        with Acme about renewal")
 *  <40   some of the words
 */
export function matchScore(query, aliases) {
  const q = normalize(query);
  if (!q) return 0;
  const qWords = words(query);
  let best = 0;
  for (const alias of aliases || []) {
    const a = normalize(alias);
    if (!a) continue;
    if (a === q) return 100;
    // Scaled by how much of the name was said, so "pricing" prefers
    // "Pricing call" to a long title that merely starts the same way.
    const said = Math.min(1, q.length / a.length);
    if (q.length >= 3 && a.startsWith(q)) best = Math.max(best, Math.round(80 + 10 * said));
    else if (q.length >= 4 && a.includes(q)) best = Math.max(best, Math.round(70 + 8 * said));
    if (!qWords.length) continue;
    const aWords = words(alias);
    if (!aWords.length) continue;
    const matched = qWords.filter((qw) => aWords.some((aw) => wordMatches(qw, aw))).length;
    if (matched === qWords.length) {
      const coverage = Math.min(1, matched / aWords.length);
      best = Math.max(best, Math.round(55 + 20 * coverage));
    } else if (matched > 0) {
      best = Math.max(best, Math.round(38 * (matched / qWords.length)));
    }
  }
  return best;
}

/* ── ranking ──────────────────────────────────────────────────────────────── */

export const CONFIDENT = 70;   // a match this good stands on its own…
export const MARGIN = 15;      // …if nothing else comes within this much of it
export const FLOOR = 30;       // below this it is not a candidate at all

/**
 * Candidates for `query`, best first, with the decision attached.
 *
 * `rows` are `{ id, aliases, updatedAt?, mine?, inactive? }`. `recentIds` are
 * ids the conversation already mentioned (newest first); `pageId` is the
 * record open on screen. Those break ties between equally good names — they
 * never lift a poor name over a good one.
 *
 * Returns { status: 'one', match } | { status: 'many', candidates } |
 *         { status: 'none' }.
 */
export function rankCandidates(query, rows, { recentIds = [], pageId = null, limit = 5 } = {}) {
  const recentRank = new Map(recentIds.map((id, i) => [id, i]));
  const scored = [];
  for (const row of rows || []) {
    const base = matchScore(query, row.aliases);
    if (base < FLOOR) continue;
    let score = base;
    if (recentRank.has(row.id)) score += Math.max(6, 12 - recentRank.get(row.id) * 2);
    if (pageId && row.id === pageId) score += 12;
    if (row.mine) score += 4;
    if (row.inactive) score -= 8;
    scored.push({ ...row, base, score });
  }
  scored.sort((a, b) => b.score - a.score
    || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  if (!scored.length) return { status: 'none', candidates: [] };
  const [top, second] = scored;
  const clearWinner = !second || second.score <= top.score - MARGIN;
  if ((top.score >= CONFIDENT && clearWinner) || (scored.length === 1 && top.base >= 55)) {
    return { status: 'one', match: top, candidates: scored.slice(0, limit) };
  }
  return { status: 'many', candidates: scored.slice(0, limit) };
}

/* ── references that are not names ────────────────────────────────────────── */

const PRONOUN = /^(?:it|this|that|this one|that one|the same(?: one)?|him|her|them|they|he|she|the one|the last one|same|above|the above)$/i;
const DEMONSTRATIVE = /^(?:this|that|the|same)\s+(task|client|customer|lead|deal|project|invoice|quotation|employee|person|vendor|entry|one)$/i;

/** Is `ref` a pointer back ("that task", "him") rather than a name? */
export function isBackReference(ref) {
  const s = String(ref || '').trim();
  return !s || PRONOUN.test(s) || DEMONSTRATIVE.test(s);
}

/** A reference that is a document or project code: INV-0042, PRJ-2026-014, QT/2026/7. */
export const CODE = /^[a-z]{2,6}[-/ ]?\d[\w/-]*$/i;

/* ── kinds ────────────────────────────────────────────────────────────────── */

/**
 * What each kind of entity is, where it lives and what it may be called.
 * `resource` is the permission key a user needs `view` on for the kind to be
 * searchable at all — an array means any of those keys (the live database
 * calls attendance `attendance`, the migrations `attendance_days`).
 */
export const KINDS = {
  task: {
    table: 'tasks', resource: 'tasks', noun: 'task', href: (r) => `/tasks?task=${r.id}`,
    select: 'id, title, description, status, priority, deadline, assignee_id, assignee_label, project_id, updated_at',
    label: (r) => r.title,
    aliases: (r) => [r.title],
    inactive: (r) => r.status === 'done',
    mine: (r, ctx) => !!ctx.employeeId && r.assignee_id === ctx.employeeId,
  },
  client: {
    table: 'clients', resource: 'clients', noun: 'client', href: () => '/customers',
    select: 'id, name, person_name, email, phone, status, value, notes, source, archived_at, updated_at',
    label: (r) => r.name,
    aliases: (r) => [r.name, r.person_name, r.email].filter(Boolean),
    inactive: (r) => !!r.archived_at || r.status === 'archived',
  },
  employee: {
    table: 'employees', resource: 'employees', noun: 'person', href: () => '/employees',
    select: 'id, full_name, email, role, user_id, department_id, exited_at, updated_at',
    label: (r) => r.full_name,
    aliases: (r) => [r.full_name, r.email, (r.full_name || '').split(' ')[0]].filter(Boolean),
    inactive: (r) => !!r.exited_at,
    mine: (r, ctx) => r.user_id === ctx.user.id,
  },
  project: {
    table: 'projects', resource: 'projects', noun: 'project', href: (r) => `/projects/${r.id}`,
    select: 'id, code, name, status, client_id, manager_employee_id, archived_at, updated_at',
    label: (r) => `${r.code} · ${r.name}`,
    aliases: (r) => [r.name, r.code].filter(Boolean),
    inactive: (r) => !!r.archived_at || ['completed', 'cancelled'].includes(r.status),
    mine: (r, ctx) => !!ctx.employeeId && r.manager_employee_id === ctx.employeeId,
  },
  invoice: {
    table: 'financial_documents', resource: 'financial_documents', noun: 'document',
    href: (r) => `/${r.type === 'quotation' ? 'quotations' : r.type === 'proforma' ? 'proforma' : 'invoices'}`,
    select: 'id, doc_number, type, status, bill_to_name, customer_id, grand_total, amount_paid, currency, issue_date, due_date, updated_at',
    label: (r) => `${r.doc_number || `Draft ${r.type}`}${r.bill_to_name ? ` · ${r.bill_to_name}` : ''}`,
    aliases: (r) => [r.doc_number, r.bill_to_name].filter(Boolean),
    inactive: (r) => ['cancelled', 'expired', 'converted'].includes(r.status),
  },
  vendor: {
    table: 'vendors', resource: 'vendors', noun: 'vendor', href: () => '/vendors',
    select: 'id, company_name, contact_name, email, archived_at, updated_at',
    label: (r) => r.company_name,
    aliases: (r) => [r.company_name, r.contact_name].filter(Boolean),
    inactive: (r) => !!r.archived_at,
  },
};

const LOAD_LIMIT = 1000;

/**
 * Every row of a kind the user may see, loaded once per request.
 * Throws nothing: a kind the role cannot read is simply empty.
 */
export async function loadKind(kind, ctx) {
  const def = KINDS[kind];
  if (!def) return [];
  ctx.cache = ctx.cache || new Map();
  const key = `rows:${kind}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const pending = (async () => {
    if (!ctx.can(def.resource, 'view')) return [];
    const { data, error } = await ctx.db.from(def.table).select(def.select)
      .order('updated_at', { ascending: false }).limit(LOAD_LIMIT);
    if (error) {
      console.warn(`[agent] load ${kind}:`, error.message);
      return [];
    }
    return data || [];
  })();
  ctx.cache.set(key, pending);
  return pending;
}

/** Drops cached rows, after a write has changed them. */
export function forget(ctx, kind) {
  ctx.cache?.delete(`rows:${kind}`);
}

/** One row of a kind by id, or null. */
export async function byId(kind, id, ctx) {
  const rows = await loadKind(kind, ctx);
  return rows.find((r) => r.id === id) || null;
}

/** The public face of a row: what a card, a chip or recentEntities carries. */
export function entityOf(kind, row) {
  const def = KINDS[kind];
  return { type: kind, id: row.id, label: def.label(row), href: def.href(row) };
}

/**
 * Resolves one reference to one entity of `kind`.
 *
 * Returns
 *   { status: 'one',  row, entity }
 *   { status: 'many', candidates: [{ row, entity }] }   — never more than 5
 *   { status: 'none', searched }                        — what was looked for
 */
export async function resolveEntity(kind, ref, ctx, { filter = null } = {}) {
  const def = KINDS[kind];
  if (!def) throw new Error(`Unknown entity kind ${kind}`);
  let rows = await loadKind(kind, ctx);
  if (filter) rows = rows.filter(filter);
  const text = String(ref ?? '').trim();
  const one = (row) => ({ status: 'one', row, entity: entityOf(kind, row) });

  if (isUuid(text)) {
    const row = rows.find((r) => r.id === text);
    return row ? one(row) : { status: 'none', searched: `${def.noun} ${text}` };
  }

  const recent = (ctx.recentEntities || []).filter((e) => e.type === kind);
  const onPage = ctx.page?.recordType === kind ? ctx.page.recordId : null;

  if (isBackReference(text)) {
    // The newest things of this kind the conversation touched, else the one
    // on screen. If the latest turn that mentioned this kind mentioned
    // several — a list of three overdue tasks — "it" is one of them, and
    // which one is asked, not assumed. If nothing fits, "it" means nothing
    // yet, and we ask.
    const live = recent.filter((e) => rows.some((r) => r.id === e.id));
    if (live.length) {
      const turn = live[0].turn;
      const group = turn ? live.filter((e) => e.turn === turn) : [live[0]];
      if (group.length === 1) return one(rows.find((r) => r.id === group[0].id));
      return {
        status: 'many',
        candidates: group.slice(0, 5).map((e) => {
          const row = rows.find((r) => r.id === e.id);
          return { row, entity: entityOf(kind, row) };
        }),
      };
    }
    if (onPage) {
      const row = rows.find((r) => r.id === onPage);
      if (row) return one(row);
    }
    return { status: 'none', searched: `the ${def.noun} you meant` };
  }

  if (CODE.test(text)) {
    const exact = rows.filter((r) => def.aliases(r).some((a) => normalize(a) === normalize(text)));
    if (exact.length === 1) return one(exact[0]);
  }

  const ranked = rankCandidates(text, rows.map((r) => ({
    id: r.id,
    aliases: def.aliases(r),
    updatedAt: r.updated_at,
    mine: def.mine ? def.mine(r, ctx) : false,
    inactive: def.inactive ? def.inactive(r) : false,
  })), { recentIds: recent.map((e) => e.id), pageId: onPage });

  const rowOf = (c) => rows.find((r) => r.id === c.id);
  if (ranked.status === 'one') return one(rowOf(ranked.match));
  if (ranked.status === 'many') {
    return {
      status: 'many',
      candidates: ranked.candidates.map((c) => ({ row: rowOf(c), entity: entityOf(kind, rowOf(c)) })),
    };
  }
  return { status: 'none', searched: `${def.noun}s matching “${text}”` };
}

/**
 * Several references at once — a batch. Unresolvable or ambiguous ones are
 * reported rather than dropped, so the card can say what it left out.
 */
export async function resolveMany(kind, refs, ctx) {
  const found = [];
  const problems = [];
  for (const ref of refs || []) {
    const r = await resolveEntity(kind, ref, ctx);
    if (r.status === 'one') {
      if (!found.some((f) => f.row.id === r.row.id)) found.push(r);
    } else {
      problems.push({ ref, status: r.status, candidates: r.candidates || [] });
    }
  }
  return { found, problems };
}
