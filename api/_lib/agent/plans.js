import { getTool, allowed, undoableFor } from './registry.js';
import { onlyKnown } from './helpers.js';
import { applyPlan, undoPlan } from './executor.js';
import { forget, KINDS, loadKind } from './resolvers.js';
import * as actionLog from './actions.js';
import {
  loadAction, transition, patchAction, toCard, effectiveStatus, withEvent, MAX_PENDING_PER_CHAT, UNDO_WINDOW_MS,
} from './actions.js';

/**
 * Plans: a goal turned into several changes the person approves together.
 *
 * "We launch the new product in two weeks" → a project, five tasks with
 * owners and dates, a note on the lead. The model inspects the company with
 * read tools, then calls propose_plan with the steps — each step is a call
 * to an ordinary write tool, with the tool's own arguments and a one-line
 * why. Nothing new decides anything:
 *
 *   propose  every step goes through its tool's resolve → validate → preview,
 *            exactly as a single card would. A step that is ambiguous, missing
 *            something or invalid sends the whole plan back to the model with
 *            the reason, so it asks the one question or fixes the step —
 *            the person never approves a plan with a guess in it.
 *   approve  one tap (the plan card), with steps unticked or edited first.
 *            Each ticked step is re-resolved and re-validated against the
 *            database as it is at that moment, then applied as the user
 *            through the same executor, attributed to the plan's action id.
 *   partial  a failed step does not undo the others and does not stop the
 *            independent ones; steps that depend on it are skipped. The card
 *            says which, and "Retry failed steps" proposes just those again.
 *   undo     within the same 10 minutes, every executed step is reversed,
 *            newest first (tasks before the project they sit in).
 *
 * Only low-risk tools can be plan steps. Anything that sends, deletes or
 * moves money needs its own card and its own tap.
 *
 * A step can refer to something an earlier step creates ("the tasks go in the
 * launch project"): at proposal time the new project is stood in for by a
 * placeholder row (the tool's virtual()), so later steps resolve against it
 * and the preview reads naturally; at approval the placeholder's id is
 * swapped for the real one the moment its step has run.
 */

export const PLANNABLE = [
  'create_project', 'create_task', 'update_task', 'complete_task', 'add_task_note',
  'create_client', 'update_client', 'move_client_stage', 'add_client_note',
  'create_invoice_draft', 'create_quotation_draft',
];
export const MAX_PLAN_STEPS = 12;
const VIRTUAL = '00000000-0000-4000-a000-';
const virtualId = (n) => `${VIRTUAL}${String(n).padStart(12, '0')}`;
const isVirtual = (v) => typeof v === 'string' && v.startsWith(VIRTUAL);

function swapIds(value, map) {
  if (isVirtual(value)) return map.has(value) ? map.get(value) : value;
  if (Array.isArray(value)) return value.map((v) => swapIds(v, map));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swapIds(v, map)]));
  return value;
}
function virtualsIn(value, out = new Set()) {
  if (isVirtual(value)) out.add(value);
  else if (Array.isArray(value)) value.forEach((v) => virtualsIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => virtualsIn(v, out));
  return out;
}

/** Adds a placeholder row to this request's cache of a kind. */
async function injectVirtual(ctx, kind, row) {
  const key = `rows:${kind}`;
  const current = ctx.cache?.has(key) ? await ctx.cache.get(key) : null;
  const rows = current || await loadKind(kind, ctx);
  ctx.cache.set(key, Promise.resolve([row, ...rows.filter((r) => r.id !== row.id)]));
}

function describeNeeds(n, tool, r) {
  if (r.needs?.kind === 'choice') {
    return `Step ${n} (${tool.name}): "${r.needs.question}" — it matched several: ${r.needs.options.map((o) => o.label).join('; ')}. Ask the user which one, or use a more specific name.`;
  }
  if (r.needs?.kind === 'input') return `Step ${n} (${tool.name}) is missing something: ${r.needs.question}`;
  if (r.needs?.kind === 'none') return `Step ${n} (${tool.name}): ${r.needs.message}`;
  return `Step ${n} (${tool.name}): ${r.error}`;
}

/* ── propose ──────────────────────────────────────────────────────────────── */

/**
 * Same outcome shapes as pipeline.propose. `error` goes back to the model
 * (with every step problem at once) and does not end the turn.
 */
export async function proposePlan(rawArgs, ctx, { chatId, messageId, reason = null } = {}) {
  const goal = String(rawArgs?.goal || '').trim().slice(0, 300);
  const summary = String(rawArgs?.summary || reason || '').trim().slice(0, 600);
  const steps = Array.isArray(rawArgs?.steps) ? rawArgs.steps : [];
  if (!goal) return { kind: 'error', message: 'A plan needs the goal, in the user\'s words.' };
  if (steps.length < 2) return { kind: 'error', message: 'A plan needs at least two steps. For a single change, call that tool directly.' };
  if (steps.length > MAX_PLAN_STEPS) return { kind: 'error', message: `At most ${MAX_PLAN_STEPS} steps in one plan. Keep the first, most important ones; the rest can be a follow-up.` };

  const problems = [];
  const planned = [];
  const touchedKinds = new Set();
  try {
    for (const [i, step] of steps.entries()) {
      const n = i + 1;
      const tool = getTool(step?.tool);
      if (!tool || !PLANNABLE.includes(tool.name)) {
        problems.push(`Step ${n}: "${step?.tool}" cannot be a plan step. Steps may only use: ${PLANNABLE.join(', ')}. Sending, deleting and money changes need their own card.`);
        continue;
      }
      if (!allowed(tool, ctx)) {
        problems.push(`Step ${n}: the user's role cannot use ${tool.name}. Leave that step out and say so.`);
        continue;
      }
      let args = step.args && typeof step.args === 'object' ? step.args : {};
      if (typeof step.args === 'string') { try { args = JSON.parse(step.args); } catch { args = {}; } }
      const raw = onlyKnown(args, tool.params);
      let r;
      try { r = await tool.resolve(raw, ctx); } catch (err) {
        console.error(`[agent] plan ${tool.name}.resolve`, err);
        problems.push(`Step ${n} (${tool.name}): could not look that up.`);
        continue;
      }
      if (r.needs || r.error) { problems.push(describeNeeds(n, tool, r)); continue; }
      const invalid = await tool.validate(r.args, ctx);
      if (invalid.length) { problems.push(`Step ${n} (${tool.name}): ${invalid[0]}`); continue; }
      const preview = await tool.preview(r.args, ctx);
      const entry = {
        n, tool: tool.name, module: tool.module,
        why: String(step.why || '').trim().slice(0, 240) || null,
        raw, args: r.args, targets: r.targets || [],
        title: preview.title, diff: preview.diff || [], fields: preview.fields || [],
        items: (preview.items || []).map((it) => ({ label: it.label, sub: it.sub || null })),
        rows: preview.preview?.rows || null,
        entities: r.entities || [],
        undoable: undoableFor(tool, r.args, ctx),
      };
      if (tool.virtual) {
        const v = tool.virtual(r.args, virtualId(n));
        if (v && KINDS[v.kind]) {
          await injectVirtual(ctx, v.kind, v.row);
          touchedKinds.add(v.kind);
          entry.creates = v.row.id;
        }
      }
      planned.push(entry);
    }
  } finally {
    for (const k of touchedKinds) forget(ctx, k);
  }

  if (problems.length) {
    return { kind: 'error', message: `The plan was not shown — fix these first (ask the user one focused question if you need to):\n- ${problems.join('\n- ')}` };
  }

  const store = ctx.actionStore || actionLog;
  if (chatId && await store.countPending(ctx, chatId) >= MAX_PENDING_PER_CHAT) {
    return { kind: 'none', stops: true, message: `There are already ${MAX_PENDING_PER_CHAT} changes waiting for your confirmation in this chat — confirm or cancel those first.` };
  }

  const preview = {
    title: goal.length > 70 ? `${goal.slice(0, 69)}…` : goal,
    goal,
    approach: summary,
    steps: planned.map(({ raw: _r, args: _a, targets: _t, ...s }) => s),
    confirmLabel: `Approve ${planned.length} steps`,
    undoable: planned.some((s) => s.undoable),
    entities: planned.flatMap((s) => s.entities).slice(0, 10),
  };
  const pseudoTool = { name: 'plan', module: 'plan', risk: 'low' };
  try {
    const row = await store.insertProposal(ctx, {
      chatId, messageId, tool: pseudoTool, kind: 'plan', reason: summary || null, source: ctx.source || null,
      args: { goal, summary, steps: planned.map((s) => ({ n: s.n, tool: s.tool, why: s.why, raw: s.raw, args: s.args, creates: s.creates || null })) },
      targets: planned.flatMap((s) => s.targets),
      preview,
    });
    return { kind: 'card', stops: true, card: toCard(row), entities: preview.entities };
  } catch (err) {
    if (err.code === 'no_table') return { kind: 'none', stops: true, message: err.message };
    console.error('[agent] insert plan', err);
    return { kind: 'none', stops: true, message: 'I could not prepare that plan just now. Try again in a moment.' };
  }
}

/* ── approve ──────────────────────────────────────────────────────────────── */

const TABLE_KIND = Object.fromEntries(Object.entries(KINDS).map(([k, d]) => [d.table, k]));

/**
 * `selected` — step numbers to run (default all). `edits` — { [n]: { field: value } },
 * only for fields that step's card offered.
 */
export async function confirmPlan(ctx, row, { selected = null, edits = null } = {}) {
  const id = row.id;
  const steps = row.args?.steps || [];
  const chosen = Array.isArray(selected) && selected.length ? new Set(selected.map(Number)) : new Set(steps.map((s) => s.n));
  if (!steps.some((s) => chosen.has(s.n))) return { status: 'invalid', message: 'No step is selected.' };

  const edited = edits && typeof edits === 'object' && Object.keys(edits).length > 0;
  const claimed = await transition(id, 'proposed', {
    status: 'confirmed', decided_at: new Date().toISOString(),
    edits: edited ? edits : null,
    events: withEvent({ events: edited ? withEvent(row, 'edited') : row.events }, 'approved', `${chosen.size} of ${steps.length} steps`),
  });
  if (!claimed) {
    const now = await loadAction(id, ctx.user.id);
    return { status: effectiveStatus(now), card: toCard(now) };
  }

  const created = new Map();
  const failedIds = new Set();
  const results = [];
  const db = ctx.dbFor(id);
  for (const step of steps) {
    if (!chosen.has(step.n)) { results.push({ n: step.n, tool: step.tool, skipped: true, ok: null, summary: 'Left out.' }); continue; }
    const tool = getTool(step.tool);
    const fail = (error) => {
      if (step.creates) failedIds.add(step.creates);
      results.push({ n: step.n, tool: step.tool, ok: false, error });
    };
    if (!tool || !allowed(tool, ctx)) { fail('Your permissions no longer allow this step.'); continue; }

    let args = { ...step.args };
    const stepEdits = edits?.[step.n] || edits?.[String(step.n)];
    if (stepEdits && typeof stepEdits === 'object') {
      const editable = new Set((row.preview?.steps?.find((s) => s.n === step.n)?.fields || []).map((f) => f.key));
      for (const [k, v] of Object.entries(stepEdits)) if (editable.has(k)) args[k] = v;
    }
    const deps = [...virtualsIn(args)];
    const missing = deps.filter((v) => !created.has(v));
    if (missing.length) {
      const dep = steps.find((s) => s.creates === missing[0]);
      fail(dep && (failedIds.has(missing[0]) || !chosen.has(dep.n))
        ? `Skipped: it depends on step ${dep.n}, which did not run.`
        : 'Skipped: something it depends on was not created.');
      continue;
    }
    args = swapIds(args, created);

    try {
      const r = await tool.resolve(args, ctx);
      if (r.needs || r.error) { fail(r.needs?.message || r.needs?.question || r.error || 'That no longer matches anything.'); continue; }
      const invalid = await tool.validate(r.args, ctx);
      if (invalid.length) { fail(invalid[0]); continue; }
      const ops = await tool.plan(r.args, ctx);
      const outcome = await applyPlan(db, ops, { stopOnError: tool.stopOnError ?? ops.length <= 1 });
      for (const res of outcome.results) if (TABLE_KIND[res.table]) forget(ctx, TABLE_KIND[res.table]);
      const done = outcome.results.some((x) => x.ok !== false);
      if (!done) { fail(outcome.results.find((x) => x.ok === false)?.error || 'The change could not be saved.'); continue; }
      if (step.creates) {
        const newId = outcome.results.find((x) => x.op === 'insert' && x.ok !== false)?.id;
        if (newId) created.set(step.creates, newId);
      }
      results.push({
        n: step.n, tool: step.tool, ok: true,
        summary: tool.summary(outcome, r.args, ctx),
        warnings: outcome.warnings,
        undoable: undoableFor(tool, r.args, ctx) && !!(tool.undoPlan ? tool.undoPlan(outcome.results, r.args) : undoPlan(outcome.results)),
        entities: tool.entitiesOf ? tool.entitiesOf(outcome) : [],
        href: tool.href?.(r.args) || null,
        args: r.args,
        results: outcome.results,
      });
    } catch (err) {
      console.error(`[agent] plan step ${step.n} ${step.tool}`, err);
      fail('The change could not be saved.');
    }
  }

  const ran = results.filter((x) => !x.skipped);
  const ok = ran.filter((x) => x.ok);
  const failed = ran.filter((x) => x.ok === false);
  const anyDone = ok.length > 0;
  const summary = !anyDone
    ? `Nothing was done: ${failed[0]?.error || 'every step failed.'}`
    : failed.length
      ? `Done ${ok.length} of ${ran.length} steps. ${failed.length} did not go through — see below.`
      : `Done — all ${ok.length} steps.`;
  const entities = ok.flatMap((x) => x.entities || []).slice(0, 10);
  const tables = [...new Set(ok.flatMap((x) => (x.results || []).filter((r) => r.ok !== false && r.table).map((r) => r.table)))];

  const final = anyDone ? (failed.length ? 'partial' : 'completed') : 'failed';
  const saved = await patchAction(id, {
    status: anyDone ? 'executed' : 'failed',
    executed_at: anyDone ? new Date().toISOString() : null,
    before_state: ok.flatMap((x) => x.results.map((r) => r.before ?? null)),
    after_state: ok.flatMap((x) => x.results.map((r) => r.after ?? null)),
    result: {
      summary, partial: failed.length > 0 && anyDone,
      undoable: ok.some((x) => x.undoable),
      itemsDone: ok.length,
      href: entities[0]?.href || null,
      tables,
      steps: results.map(({ results: _r, args: _a, ...s }) => s),
      stepResults: results.map((x) => ({ n: x.n, tool: x.tool, ok: x.ok, results: x.results || null })),
    },
    error: anyDone ? null : failed[0]?.error || 'The plan could not be carried out.',
    events: withEvent({ events: withEvent(claimed, 'executing') }, final, failed.length ? `${failed.length} step(s) failed` : null),
  });
  return { status: saved.status, card: toCard(saved), entities };
}

/* ── undo ─────────────────────────────────────────────────────────────────── */

export async function undoPlanAction(ctx, row) {
  if (!row.result?.undoable) return { status: 'invalid', message: 'This plan cannot be undone.' };
  if (Date.now() - Date.parse(row.executed_at) > UNDO_WINDOW_MS) {
    return { status: 'invalid', message: 'The 10-minute undo window has closed. Change things back from their pages, or ask me to.' };
  }
  const db = ctx.dbFor(row.id);
  const done = (row.result.stepResults || []).filter((s) => s.ok && s.results);
  const undoResults = [];
  let reversed = 0;
  let kept = 0;
  for (const s of [...done].reverse()) {
    const tool = getTool(s.tool);
    const stepArgs = row.args?.steps?.find((x) => x.n === s.n)?.args || {};
    const plan = tool?.undoPlan ? tool.undoPlan(s.results, stepArgs) : undoPlan(s.results);
    if (!plan || !undoableFor(tool, stepArgs, ctx)) { kept += 1; continue; }
    const outcome = await applyPlan(db, plan, { stopOnError: false });
    for (const res of outcome.results) if (TABLE_KIND[res.table]) forget(ctx, TABLE_KIND[res.table]);
    if (outcome.results.some((x) => x.ok !== false)) reversed += 1; else kept += 1;
    undoResults.push({ n: s.n, results: outcome.results });
  }
  if (!reversed) return { status: 'invalid', message: 'Nothing could be undone — those records have changed since.' };
  const saved = await patchAction(row.id, {
    status: 'undone', undone_at: new Date().toISOString(),
    result: { ...row.result, undoResults, summary: kept ? `${row.result.summary} Undone ${reversed} step(s); ${kept} left as they are.` : row.result.summary },
    events: withEvent(row, 'undone', kept ? `${kept} step(s) could not be reversed` : null),
  });
  return { status: 'undone', card: toCard(saved) };
}

/** The raw steps that failed, ready to propose again. */
export function failedSteps(row) {
  const bad = new Set((row.result?.steps || []).filter((s) => s.ok === false).map((s) => s.n));
  return (row.args?.steps || []).filter((s) => bad.has(s.n)).map((s) => ({ tool: s.tool, why: s.why, args: s.raw }));
}
