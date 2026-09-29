/**
 * EdgeBrain · the server endpoint.
 *
 *   POST /api/brain  { action, org_id, ... }
 *
 * Everything privileged lives here: building and resynchronising the brain
 * (which reads every tenant table through the service role) and answering a
 * question (which spends money on the AI provider). Plain reads — search, the graph, a
 * node's neighbourhood — are also offered here as generic capabilities, but the
 * browser can equally read brain_nodes / brain_edges / brain_metrics directly,
 * because their RLS policies enforce exactly the same permission check this
 * file applies by hand. Two paths, one rule, and the database has the final say
 * on both.
 *
 * Every action re-derives the caller's permissions from the org's own matrix.
 * An org_id in the body proves nothing; requireOrgRole and allowedResources
 * are what decide.
 */
import { requireUser, requireOrgRole, HttpError, sendError, methodIs, readJsonBody } from './_lib/auth.js';
import { supabaseAdmin } from './_lib/supabaseAdmin.js';
import { logAiUsage } from './_lib/aiUsage.js';
import {
  allowedResources, requireBrainPermission, searchNodes, getNode,
  neighbors, getMetrics, buildContext, libraryContext,
} from './_lib/brainRetrieval.js';
import { AI_URL, AI_MODEL as MODEL, aiKey, aiHeaders, reasoningEffort } from './_lib/aiProvider.js';

// Mirrors AI_MESSAGE_LIMITS in api/nvidia.js and limits.aiMessages in
// planConfig.js. A brain question costs the same upstream as a co-founder
// message, so it is metered against the same counter.
const AI_MESSAGE_LIMITS = { free: 10, pro: 50, max: Infinity };

// Source tables probed to tell whether the brain has fallen behind Postgres.
// Deliberately a handful of the ones that actually move, not all twenty: this
// runs on every status poll and a "have I drifted" check that costs a full
// table sweep is a check that gets turned off.
const FRESHNESS_PROBES = [
  { table: 'employees', resource: 'employees' },
  { table: 'financial_documents', resource: 'financial_documents' },
  { table: 'clients', resource: 'clients' },
  { table: 'tasks', resource: 'tasks' },
];

export default async function handler(req, res) {
  if (!methodIs(req, res, 'POST')) return undefined;

  try {
    const body = await readJsonBody(req);
    const { action, org_id: orgId } = body || {};
    if (!action) throw new HttpError(400, 'Missing action');

    const user = await requireUser(req);
    await requireOrgRole(user.id, orgId, 'viewer');
    const { role, allowed, perms } = await allowedResources(orgId, user.id);

    switch (action) {
      case 'status':   return res.status(200).json(await status(orgId, perms, allowed, role));
      case 'build':    return res.status(200).json(await sync(orgId, user.id, perms, 'full'));
      case 'sync':     return res.status(200).json(await sync(orgId, user.id, perms, 'incremental'));
      case 'search': {
        requireBrainPermission(perms, 'view');
        const nodes = await searchNodes(orgId, allowed, {
          text: body.query || '', kinds: body.kinds || null,
          limit: Math.min(Number(body.limit) || 20, 60),
        });
        return res.status(200).json({ success: true, nodes });
      }
      case 'entity': {
        requireBrainPermission(perms, 'view');
        if (!body.node_id) throw new HttpError(400, 'Missing node_id');
        const node = await getNode(orgId, allowed, body.node_id);
        const graph = await neighbors(orgId, allowed, body.node_id, { depth: 1 });
        return res.status(200).json({ success: true, node, ...graph });
      }
      case 'neighbors': {
        requireBrainPermission(perms, 'view');
        if (!body.node_id) throw new HttpError(400, 'Missing node_id');
        const graph = await neighbors(orgId, allowed, body.node_id, {
          depth: Math.min(Number(body.depth) || 1, 3),
        });
        return res.status(200).json({ success: true, ...graph });
      }
      case 'metrics': {
        requireBrainPermission(perms, 'view');
        return res.status(200).json({
          success: true, metrics: await getMetrics(orgId, allowed, { keys: body.keys || null }),
        });
      }
      case 'context':  return await context(res, { orgId, perms, allowed, body });
      case 'ask':      return await ask(res, { orgId, user, perms, allowed, body });
      default:         throw new HttpError(400, `Unknown action: ${action}`);
    }
  } catch (err) {
    return sendError(res, err, 'brain');
  }
}

/* ── status ───────────────────────────────────────────────────────────────── */

async function status(orgId, perms, allowed, role) {
  requireBrainPermission(perms, 'view');
  const db = supabaseAdmin();

  const [{ data: state }, { data: runs }] = await Promise.all([
    db.from('brain_state').select('*').eq('org_id', orgId).maybeSingle(),
    db.from('brain_sync_runs').select('*').eq('org_id', orgId)
      .order('started_at', { ascending: false }).limit(5),
  ]);

  // What the brain holds, by kind — the coverage figure the health view reads.
  let byKind = [];
  if (state?.status === 'ready') {
    const { data } = await db
      .from('brain_nodes').select('kind, resource').eq('org_id', orgId).is('deleted_at', null)
      .limit(20000);
    const tally = new Map();
    for (const n of data || []) {
      if (n.resource !== null && !allowed.has(n.resource)) continue;
      tally.set(n.kind, (tally.get(n.kind) || 0) + 1);
    }
    byKind = [...tally.entries()].map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count);
  }

  // Has Supabase moved since the last sync? Counted, not guessed.
  let pendingChanges = 0;
  const since = state?.last_sync_at;
  if (since) {
    const probes = await Promise.all(FRESHNESS_PROBES
      .filter((p) => allowed.has(p.resource))
      .map(async (p) => {
        const { count } = await db.from(p.table)
          .select('id', { count: 'exact', head: true })
          .eq('org_id', orgId).gt('updated_at', since);
        return count || 0;
      }));
    pendingChanges = probes.reduce((a, b) => a + b, 0);
  }

  return {
    success: true,
    role,
    can: {
      view: !!perms?.edgebrain?.view,
      build: !!perms?.edgebrain?.create,
      sync: !!perms?.edgebrain?.edit,
    },
    state: state || { org_id: orgId, status: 'absent', node_count: 0, edge_count: 0, metric_count: 0 },
    runs: runs || [],
    byKind,
    pendingChanges,
    // Node counts are already permission-filtered above; the headline figure on
    // brain_state is not, so the UI is told which one it is looking at.
    visibleNodeCount: byKind.reduce((a, k) => a + k.count, 0),
  };
}

/* ── build / sync ─────────────────────────────────────────────────────────── */

async function sync(orgId, userId, perms, mode) {
  requireBrainPermission(perms, mode === 'full' ? 'create' : 'edit');

  const { data, error } = await supabaseAdmin()
    .rpc('brain_sync', { p_org: orgId, p_mode: mode, p_actor: userId });
  if (error) throw new HttpError(500, `Synchronisation failed: ${error.message}`);

  // Another sync already holds this org's lock. Not an error — the work the
  // caller asked for is happening; it just is not this call doing it.
  if (data?.skipped) {
    return { success: true, skipped: true, message: data.reason, result: data };
  }

  const failed = data?.failed_domains || [];
  return {
    success: true,
    // A run where some domains failed still produced a usable brain. Saying so
    // is the difference between a partial failure and a silent one.
    partial: failed.length > 0,
    result: data,
  };
}

/* ── context ──────────────────────────────────────────────────────────────── */

/**
 * The retrieval half of `ask`, without the model.
 *
 * This is what the AI co-founder and the assistant panel call. They already
 * have streaming, conversation history, company memory and their own persona;
 * what they lacked was data — one was handed a fistful of hardcoded zeroes and
 * the other loaded the entire org cache into the browser to run a thousand-line
 * formatter over it. Both now get the same permission-filtered, provenance-
 * stamped package the EdgeBrain Ask view reasons over, assembled server-side in
 * a few indexed queries.
 *
 * Costs no AI quota: nothing is generated here, so it is not metered.
 */
async function context(res, { orgId, perms, allowed, body }) {
  requireBrainPermission(perms, 'view');

  const question = String(body.question || '').trim();

  const { data: state } = await supabaseAdmin()
    .from('brain_state')
    .select('status, last_sync_at').eq('org_id', orgId).maybeSingle();

  // No brain yet is not an error — the caller falls back to its own context.
  // The document library does not depend on a build (it is read at upload),
  // so its passages are still offered on their own.
  if (!state || state.status === 'absent') {
    const library = await libraryContext(orgId, allowed, question).catch(() => null);
    if (!library) {
      return res.status(200).json({ success: true, available: false, context: '', sources: [] });
    }
    return res.status(200).json({
      success: true, available: true, context: library.text, sources: library.sources,
      retrieval: { libraryDocuments: library.total, libraryPassages: library.passages }, synced_at: null,
    });
  }

  const pkg = await buildContext(orgId, allowed, question, {
    maxEntities: Math.min(Number(body.max_entities) || 14, 40),
    syncedAt: state.last_sync_at,
  });

  return res.status(200).json({
    success: true,
    available: true,
    context: pkg.context,
    sources: pkg.sources,
    retrieval: pkg.counts,
    synced_at: state.last_sync_at,
  });
}

/* ── ask ──────────────────────────────────────────────────────────────────── */

const SYSTEM_PROMPT = `You are EdgeBrain, the company intelligence layer inside EdgeOS.

You answer questions about THIS company using only the context below, which was
retrieved from the organisation's own Supabase records and is already filtered
to what this user is permitted to see.

Rules:
1. AUTHORITATIVE AGGREGATES are computed in PostgreSQL. Quote them exactly. Never
   recompute a total by adding up the ENTITIES you were shown — that list is a
   relevant sample, not the whole table.
2. A breakdown you were given as an aggregate is the answer to that breakdown.
   If the question asks for a split — by country, by month, by department — and
   an aggregate covers it, read the ranking off those buckets. Do not rebuild
   the same split by joining the ENTITIES yourself: they are a sample, so the
   ranking you get from them is a ranking of the sample, which is how the same
   question ends up with a different answer each time it is asked.
3. Where an aggregate's definition says which field it uses and an entity
   carries a conflicting value, the definition wins. Say which one you used —
   "by the country on the invoice" — rather than switching silently.
4. ENTITIES are verbatim records. Their values are current as of the as_of stamp.
5. NEVER claim something does not exist, or that a list is everything, unless
   INVENTORY or an aggregate says so. "We have no other X", "that is all of
   them", "X has zero" and "there are none" are claims about a whole table, and
   the ENTITIES block is a selection, so it cannot support one. Where INVENTORY
   counts more records than you were shown, say what you were given and that
   more exist — "the three largest of twelve clients", not "our clients".
6. If the context does not contain the answer, say so plainly and name what is
   missing, then say what would answer it — an aggregate that is not computed,
   a field that is empty, records not retrieved. A precise "I cannot tell you
   that from this, because…" is a correct answer. A confident wrong one is not.
   Never estimate, extrapolate or invent a figure to avoid saying it.
7. Do not change your answer between turns unless the records changed or you
   were wrong. If you were wrong, say which of the two answers was wrong and
   why — a silently different second answer destroys trust in both. If the user
   pushes back and the records still say what they said, hold the answer and
   show the record behind it.
8. If you offer an interpretation or a recommendation, mark it clearly as your
   reading rather than as something the records state.
9. Be concise: a direct answer first, then at most a few supporting lines. Give
   figures with their units and currency as they appear.
10. The user cannot see the context block. Refer to records by name or document
    number, never by node id.
11. DOCUMENT LIBRARY passages are the company's own uploaded files, quoted
    verbatim. Answer from them when the question is about what a document says,
    and name the document and the page, slide or section you used. A passage is
    part of a file, not the whole of it: if it does not contain the answer, say
    so and name the document that probably does. Never supply what such a
    document "usually" says.`;

/**
 * The conversation so far, bounded and sanitised.
 *
 * Until this existed, every question was a fresh call carrying nothing but the
 * question itself. That is what produced the flip-flopping: asked a follow-up,
 * the model could not see what it had just said, so it re-derived an answer
 * from whichever records that particular retrieval happened to surface, and
 * "check again?" was not a check but a second independent guess.
 *
 * Bounded at eight turns and 2000 characters each: enough to hold a thread,
 * far too little for a long conversation to crowd out the records, which stay
 * the thing the answer is built from.
 */
export function conversationHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.text.trim().slice(0, 2000) }))
    .filter((m) => m.content);
}

async function ask(res, { orgId, user, perms, allowed, body }) {
  requireBrainPermission(perms, 'view');

  const question = String(body.question || '').trim();
  if (!question) throw new HttpError(400, 'Missing question');
  if (question.length > 2000) throw new HttpError(400, 'Question is too long');

  const history = conversationHistory(body.history);

  const apiKey = aiKey();
  if (!apiKey) {
    console.error('[brain] Missing OPENROUTER_API_KEY');
    throw new HttpError(500, 'Server configuration error');
  }

  const db = supabaseAdmin();
  const { data: state } = await db.from('brain_state')
    .select('status, last_sync_at').eq('org_id', orgId).maybeSingle();
  if (!state || state.status === 'absent') {
    throw new HttpError(409, 'This organization has no Company Brain yet. Build it first.');
  }

  // Metered before the upstream call, exactly as /api/nvidia does and for the
  // same reason: a request that is abandoned half-way still cost money.
  const used = await meterMessage(orgId);
  const limit = await limitFor(orgId);
  if (used > limit) {
    await logAiUsage({ orgId, user, surface: 'brain', outcome: 'blocked' });
    return res.status(429).json({
      success: false, error: 'AI message limit reached for your plan', used: used - 1, limit,
    });
  }

  // Retrieval reads the thread, not just the sentence.
  //
  // "2nd highest and the lowest?" names no entity, no kind and no metric: on
  // its own it retrieves essentially nothing, and the model then answers a
  // question about revenue from whatever generic rows came back. Prefixing the
  // last couple of user turns puts the subject back into the search terms, so a
  // follow-up retrieves the same records the question it follows did.
  const priorAsks = history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content);
  const pkg = await buildContext(orgId, allowed, [...priorAsks, question].join('\n'), {
    syncedAt: state.last_sync_at,
  });

  const response = await fetch(AI_URL, {
    method: 'POST',
    headers: aiHeaders(apiKey),
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        // The thread, then the records, then the question. The context goes in
        // the final message rather than the first so it is the freshest thing
        // in the window: it is retrieved for THIS question, and an older turn's
        // wording must not outweigh the records this one was given.
        ...history,
        {
          role: 'user',
          content: `Context retrieved from the company's records ` +
            `(last synchronised ${state.last_sync_at || 'unknown'}):\n\n${pkg.context}\n\n` +
            (history.length
              ? 'The turns above are this same conversation. Records in this block supersede ' +
                'anything said earlier; if they contradict an answer you already gave, correct ' +
                'it explicitly rather than quietly changing it.\n\n'
              : '') +
            `Question: ${question}`,
        },
      ],
      max_tokens: 900,
      temperature: 0.1,
      top_p: 0.8,
      stream: false,
      // Same reasoning as api/nvidia.js: with thinking billed against
      // max_tokens, a 3.x model can spend the whole budget before writing a word.
      reasoning_effort: reasoningEffort('none'),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('[brain] AI provider error', response.status, detail.slice(0, 400));
    await logAiUsage({ orgId, user, surface: 'brain', outcome: 'failed', model: MODEL });
    throw new HttpError(502, `AI provider error (${response.status})`);
  }

  const json = await response.json();
  await logAiUsage({
    orgId, user, surface: 'brain', model: MODEL,
    promptTokens: json?.usage?.prompt_tokens, completionTokens: json?.usage?.completion_tokens,
  });
  const answer = json?.choices?.[0]?.message?.content?.trim() || '';
  if (!answer) throw new HttpError(502, 'The AI returned an empty answer');

  return res.status(200).json({
    success: true,
    answer,
    // Provenance travels with the answer so the UI can show what it was built
    // from, and a reader can go and check.
    sources: pkg.sources,
    retrieval: pkg.counts,
    synced_at: state.last_sync_at,
    usage: { used, limit: limit === Infinity ? null : limit },
  });
}

/** Atomic increment of the org's AI message counter. See api/nvidia.js. */
async function meterMessage(orgId) {
  const { data, error } = await supabaseAdmin().rpc('bump_ai_usage', { p_org: orgId });
  if (error) {
    console.warn('[brain] AI usage not counted:', error.message);
    return 0;
  }
  return Number(data) || 0;
}

async function limitFor(orgId) {
  const { data } = await supabaseAdmin()
    .from('subscriptions').select('plan').eq('org_id', orgId).maybeSingle();
  return AI_MESSAGE_LIMITS[data?.plan || 'free'] ?? AI_MESSAGE_LIMITS.free;
}
