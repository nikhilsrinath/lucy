import { getTool, allowed } from '../registry.js';
import { propose, cancel } from '../pipeline.js';
import { KINDS, loadKind, rankCandidates, entityOf } from '../resolvers.js';
import { addView, addReadings } from '../views.js';
import { situations } from '../cofounders.js';
import { detectSituation } from '../../../../src/shared/cofounders/detect.js';
import { isCancel } from '../../../../src/shared/cashIntent.js';
import { understand, cleanRoute, T_LOCAL } from './understand.js';
import { getIntent, cleanArgs, describeIntent } from './intents.js';
import { renderResult, renderTalk, renderGst, nameOf, forChannel, pageLabel } from './render.js';
import { normalizeMessage } from './text.js';
import { logRoute } from './telemetry.js';

/**
 * The local execution router: one message, answered without a model whenever
 * a business function can answer it.
 *
 *   understand (understand.js) → a routing decision
 *     local    read: the tool runs through the person's own database client
 *              and a template words the result (render.js)
 *              change: the same propose() the model uses — resolve →
 *              validate → preview → a card. Nothing is written without the
 *              person's confirmation, exactly as before.
 *     clarify  one question, with the answers as chips; the intent and what
 *              was already understood are kept, so the answer finishes it
 *     llm      handed to the model, unchanged
 *
 * Understanding and authorisation stay separate. The engine checks the tool's
 * own permission (registry.allowed) before running anything, the tool reads
 * through the caller's token (RLS), and a change goes through propose() and
 * confirm(), which re-check everything. Recognising an intent grants nothing.
 *
 * Arguments that come back from a client (a tapped chip, an open question)
 * are cleaned against the intent's declared parameters and re-run through the
 * same checks: a client that edits them gains nothing.
 *
 * BUDDY_LOCAL_ROUTER = on (default) | shadow | off
 *   shadow  decides and logs, then lets the model answer — for comparing the
 *           two on live traffic before switching on.
 */

export function routerMode(env = process.env.BUDDY_LOCAL_ROUTER) {
  const v = String(env ?? 'on').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' ? 'off' : v === 'shadow' ? 'shadow' : 'on';
}

const LOCAL = 'local:';
const STRONG = 70;

/* ── names → records the person may see ───────────────────────────────────── */

/**
 * `kinds` are tried in order. A name that is one record of the first kind it
 * fits is that record; `across` (a question about "Acme" with no kind said)
 * asks when it fits records of several kinds.
 */
export async function resolveName(ctx, text, kinds, { across = false } = {}) {
  const said = String(text || '').trim();
  if (!said || said.length > 80) return { status: 'none' };
  const found = [];
  for (const kind of kinds) {
    const def = KINDS[kind];
    if (!def || !ctx.can(def.resource, 'view')) continue;
    // A document answers to its client's name as well as its number. Asked
    // "about Zephyr" with no kind said, that is the client, not its invoices.
    if (across && kind === 'invoice' && kinds.length > 1 && !/\d/.test(said)) continue;
    const rows = await loadKind(kind, ctx);
    const ranked = rankCandidates(said, rows.map((r) => ({ id: r.id, aliases: def.aliases(r), updatedAt: r.updated_at, inactive: def.inactive ? def.inactive(r) : false })), { limit: 5 });
    const strong = (ranked.candidates || []).filter((c) => c.base >= STRONG);
    if (!strong.length) continue;
    const ent = (c) => { const e = entityOf(kind, rows.find((r) => r.id === c.id)); return { kind, id: e.id, label: e.label, score: c.base }; };
    const one = ranked.status === 'one' && ranked.match.base >= STRONG;
    found.push({ kind, one, options: (one ? [ranked.match] : strong).map(ent) });
    if (!across) break;
  }
  if (!found.length) return { status: 'none' };
  if (found.length === 1) {
    const f = found[0];
    return f.one ? { status: 'one', ...f.options[0] } : { status: 'many', options: f.options.slice(0, 5) };
  }
  // Several kinds: an exact name settles it only when nothing else comes close
  // (two people called Priya are asked about, never chosen between).
  const all = found.flatMap((f) => f.options);
  const exact = all.filter((o) => o.score === 100);
  if (exact.length === 1 && !all.some((o) => o !== exact[0] && o.score >= 80)) return { status: 'one', ...exact[0] };
  return { status: 'many', options: found.flatMap((f) => f.options.slice(0, 2)).slice(0, 5) };
}

const OPEN = ['sent', 'viewed', 'partially_paid', 'overdue', 'pending', 'payment_submitted', 'advance_paid'];
async function hasOpenInvoices(ctx, hit) {
  const ids = hit.status === 'one' ? [hit.id] : (hit.options || []).filter((o) => o.kind === 'client').map((o) => o.id);
  if (!ids.length) return false;
  const docs = await loadKind('invoice', ctx);
  return docs.some((d) => ids.includes(d.customer_id) && OPEN.includes(d.status) && (Number(d.grand_total) || 0) - (Number(d.amount_paid) || 0) > 0.005);
}

function envFor(ctx, { pending = ctx.pending } = {}) {
  return {
    today: ctx.today,
    lastRoute: cleanRoute(ctx.lastRoute),
    pending,
    voice: ctx.voice === true || ctx.channel === 'voice',
    openCards: ctx.openCards || [],
    resolve: (text, kinds, opts) => resolveName(ctx, text, kinds, { across: opts?.across ?? kinds.length > 3 }),
    hasOpenInvoices: (hit) => hasOpenInvoices(ctx, hit),
  };
}

/* ── asking ───────────────────────────────────────────────────────────────── */

/** One question with chips. The answer comes back to resumeLocal / the open-question path. */
function ask(emit, { intent, param, question, options, args = {}, original = '' }) {
  emit('input', {
    input: {
      kind: 'input', param, question,
      options: options.slice(0, 6).map((o) => ({ label: o.label, value: o.value })),
      hint: null,
      resume: { tool: `${LOCAL}${intent}`, args: { ...args, _options: options.slice(0, 6).map((o) => ({ value: o.value, label: o.label, args: o.args || null })), _original: String(original).slice(0, 300) } },
    },
  });
}

function refusal(tool, ctx) {
  if (tool.privateOnly && ctx.audience === 'shared') return 'I can only go into that in a private chat with me.';
  if (ctx.audience === 'shared') return 'That is not something I discuss in a group. Ask me in a private chat.';
  return 'Your role does not have access to that, so I cannot show it.';
}

/* ── running one intent ───────────────────────────────────────────────────── */

/**
 * Runs a read or navigation intent. Returns
 *   { ok, text, view, entities, navigate, asked }  — nothing is emitted here.
 */
async function runRead(ctx, intent, decision) {
  const tool = getTool(intent.tool);
  if (!tool || !allowed(tool, ctx)) return { ok: false, errorKind: 'permission', text: refusal(tool || {}, ctx) };
  const args = cleanArgs(intent, decision.parameters);
  const toolArgs = { ...args };
  for (const key of intent.local || []) delete toolArgs[key];
  let res;
  try {
    res = await tool.run(toolArgs, ctx);
  } catch (err) {
    console.error(`[local] ${tool.name}.run`, err);
    return { ok: false, errorKind: 'tool_failed', text: 'That lookup failed on my side, so I have nothing reliable to show. Try again in a moment.' };
  }
  const out = renderResult(intent.render, { data: res?.data || {}, view: res?.view || null, params: args, decision }, ctx);
  if (out.ask) return { ok: true, asked: out.ask };
  let text = out.text || '';
  if (intent.render === 'navigate' && res?.navigate && !text) text = '';
  return {
    ok: !out.failed,
    errorKind: out.failed ? 'tool_failed' : null,
    text,
    view: out.show && res?.view ? res.view : null,
    reading: res?.reading || null,
    entities: res?.entities || [],
    navigate: res?.navigate || null,
    status: tool.status || null,
  };
}

function emitRead(ctx, emit, r) {
  addReadings(ctx, r.reading);
  if (r.entities?.length) emit('entities', { entities: r.entities });
  if (r.navigate) emit('navigate', r.navigate);
  if (r.text) emit('text', { text: forChannel(r.text, ctx) });
  // A spoken reply has no room for a list; the words carry the figures.
  if (r.view && !ctx.voice && ctx.channel !== 'voice') {
    const id = addView(ctx, r.view);
    if (id) emit('view', { view: ctx.views.get(id) });
  }
}

/** What becomes of a proposal that produced no card. `escalate` hands the message to the model. */
function proposalOutcome(out) {
  if (out.kind === 'card' || out.kind === 'choice' || out.kind === 'input') return 'show';
  if (out.kind === 'error') return 'escalate';
  // A refusal the records justify is an answer; "found nothing" may be the
  // pattern's misreading, so the model takes another look.
  if (out.problems?.length || /^(?:Your role|There are already|I could not prepare|Deleting|That is not something)/.test(out.message || '')) return 'show';
  return 'escalate';
}

/**
 * Carries out a decision. Returns { handled, ... } — `handled: false` means
 * nothing was emitted and the model should take the message.
 */
async function execute(ctx, decision, turn, ids, { emitOutcome }) {
  const emit = turn.emit;
  const intent = getIntent(decision.intent);

  if (decision.steps?.length) {
    const results = [];
    for (const step of decision.steps) results.push(await runRead(ctx, getIntent(step.intent), step));
    if (results.every((r) => r.errorKind === 'permission')) { emit('text', { text: results[0].text }); return { handled: true, ok: false, errorKind: 'permission' }; }
    for (const r of results) if (r.errorKind !== 'permission') emitRead(ctx, emit, r);
    return { handled: true, ok: results.some((r) => r.ok) };
  }
  if (intent.steps?.length) {
    const results = [];
    for (const id of intent.steps) {
      const step = getIntent(id);
      const tool = getTool(step.tool);
      if (!tool || !allowed(tool, ctx)) continue; // the part this person may not see is simply left out
      results.push(await runRead(ctx, step, { ...decision, intent: id, parameters: {} }));
    }
    if (!results.length) { emit('text', { text: refusal({}, ctx) }); return { handled: true, ok: false, errorKind: 'permission' }; }
    for (const r of results) emitRead(ctx, emit, r);
    return { handled: true, ok: results.some((r) => r.ok) };
  }

  if (!intent.tool) {
    if (decision.intent === 'CALCULATE_GST') {
      emit('text', { text: forChannel(renderGst(decision.parameters), ctx) });
      return { handled: true, ok: true };
    }
    if (decision.intent === 'CANCEL_PROPOSAL') {
      const card = (ctx.openCards || []).find((c) => c.action_id === decision.parameters.action_id);
      if (!card) return { handled: false };
      const res = await cancel(ctx, card.action_id).catch(() => null);
      if (!res) return { handled: false };
      if (res.card) emit('card_update', { card: res.card });
      emit('text', { text: renderTalk('CANCEL_PROPOSAL', ctx) });
      return { handled: true, ok: true };
    }
    emit('text', { text: forChannel(renderTalk(decision.intent, ctx, decision.parameters), ctx) });
    return { handled: true, ok: true };
  }

  const tool = getTool(intent.tool);
  if (!tool) return { handled: false };

  if (tool.kind === 'write') {
    const args = cleanArgs(intent, decision.parameters);
    const out = await propose(tool, args, ctx, ids);
    if (proposalOutcome(out) === 'escalate' && intent.escalate === 'unresolved') return { handled: false, reasonCode: 'unresolved' };
    if (out.kind === 'card') turn.noteCard(tool.name, args, out.card);
    emitOutcome(out, emit);
    return { handled: true, ok: out.kind !== 'none', clarified: out.kind === 'choice' || out.kind === 'input', errorKind: out.kind === 'none' ? 'not_found' : null };
  }

  const r = await runRead(ctx, intent, decision);
  if (r.asked) {
    ask(emit, { intent: decision.intent, param: r.asked.param, question: r.asked.question, options: r.asked.options, args: decision.parameters });
    return { handled: true, ok: true, clarified: true };
  }
  if (r.errorKind === 'permission') { emit('text', { text: r.text }); return { handled: true, ok: false, errorKind: 'permission' }; }
  if (r.status) emit('status', { text: r.status });
  emitRead(ctx, emit, r);
  if (decision.memo && r.ok) emit('route', { memo: decision.memo });
  return { handled: true, ok: r.ok, errorKind: r.errorKind };
}

/** Puts a decision's open question to the person. */
function clarify(ctx, decision, emit, original) {
  const amb = decision.ambiguities?.[0];
  if (amb) {
    ask(emit, {
      intent: decision.intent, param: amb.param || 'intent', original,
      question: amb.question || 'Which one did you mean?',
      options: amb.options,
      args: { ...decision.parameters, _memo: decision.memo || null, _period: decision.period || null, _entities: (decision.entities || []).filter((e) => e.param).map((e) => ({ param: e.param, label: e.label })) },
    });
    return;
  }
  // Supported, but part of the message was not accounted for: confirm the reading.
  ask(emit, {
    intent: decision.intent, param: 'intent', original,
    question: `I read that as **${nameOf(decision)}**, but I could not place part of what you said. Is that what you meant?`,
    options: [
      { label: `Yes, ${nameOf(decision)}`, value: decision.intent, args: { ...decision.parameters, _memo: decision.memo || null, _period: decision.period || null, _entities: (decision.entities || []).map((e) => ({ param: e.param, label: e.label })) } },
      { label: 'No, something else', value: 'llm' },
    ],
    args: {},
  });
}

/* ── answers to an open question ──────────────────────────────────────────── */

const YES = /^(?:yes|yeah|yep|yup|ya|y|sure|ok(?:ay)?|correct|right|exactly|that is right|yes please|the first(?: one)?|first|1)[\s!.]*$/i;
const NO = /^(?:no|nope|nah|n|not that|neither|something else|none of (?:these|those|them)|the second(?: one)?|second|2)[\s!.]*$/i;

function decisionFrom(intentId, args, extra = {}) {
  const intent = getIntent(intentId);
  if (!intent || intent.escalate === 'always') return null;
  const d = describeIntent(intentId);
  const memo = cleanRoute(args?._memo);
  const period = args?._period && typeof args._period === 'object' ? { label: String(args._period.label || '').slice(0, 40), from: args._period.from || null, to: args._period.to || null } : null;
  const entities = Array.isArray(args?._entities) ? args._entities.filter((e) => e && typeof e.param === 'string').slice(0, 4).map((e) => ({ param: e.param.slice(0, 20), label: String(e.label || '').slice(0, 120) })) : [];
  return {
    intent: intentId, parameters: cleanArgs(intent, args || {}), entities, confidence: 1, missingParameters: [], ambiguities: [],
    executionRoute: 'local', reason: 'Chosen by the person.', requiresConfirmation: d.requiresConfirmation, requiredPermissions: d.requiredPermissions,
    readOnly: d.readOnly, memo, period, ...extra,
  };
}

/**
 * The option an answer picks, from the options the question offered.
 * Returns { option } | { llm: true } | null (not an answer to this question).
 */
function pick(options, text) {
  const said = normalizeMessage(text).clean.toLowerCase().replace(/[.!?]+$/, '');
  if (!options?.length) return null;
  const byLabel = options.filter((o) => String(o.label || '').toLowerCase() === said || String(o.label || '').toLowerCase().replace(/\s*\([^)]*\)$/, '') === said);
  if (byLabel.length === 1) return { option: byLabel[0] };
  const n = said.match(/^(?:option\s+)?(\d)$/);
  if (n && options[Number(n[1]) - 1]) return { option: options[Number(n[1]) - 1] };
  if (YES.test(said)) return options[0].value === 'llm' ? { llm: true } : { option: options[0] };
  if (NO.test(said)) {
    if (options.length === 2 && options[1].value === 'llm') return { llm: true };
    return options.length === 2 && !/^(?:no|nope|nah|n|not that|neither|something else|none)/.test(said) ? { option: options[1] } : { llm: true };
  }
  const partial = options.filter((o) => said.length >= 3 && String(o.label || '').toLowerCase().includes(said));
  if (partial.length === 1) return { option: partial[0] };
  return null;
}

/** Runs the intent a local question was about, with the chosen answer. */
async function finishLocal(ctx, intentId, args, param, option, turn, ids, helpers) {
  const options = Array.isArray(args?._options) ? args._options : [];
  const chosen = options.find((o) => String(o.value) === String(option.value)) || null;
  if (!chosen) return { handled: false };
  if (chosen.value === 'llm') return { handled: false, override: args._original || null, reasonCode: 'declined_reading' };
  let decision;
  if (param === 'intent') decision = decisionFrom(String(chosen.value), chosen.args || {});
  else decision = decisionFrom(intentId, { ...args, ...(chosen.args || {}), [param]: chosen.value }, chosen.args?.type ? {} : {});
  if (!decision) return { handled: false };
  if (param !== 'intent' && chosen.label) decision.entities = [...decision.entities.filter((e) => e.param !== param), { param, label: String(chosen.label).replace(/\s*\([^)]*\)$/, '') }];
  const done = await execute(ctx, decision, turn, ids, helpers);
  return { ...done, decision, correctedTo: decision.intent };
}

/* ── the entry points ─────────────────────────────────────────────────────── */

/** May this turn be read locally at all? */
function eligible(ctx, input) {
  if (ctx.actor?.kind === 'buddy') return 'autonomous';
  if (ctx.autonomy?.trigger && ctx.autonomy.trigger !== 'interactive') return 'autonomous';
  if (String(input?.chatId || '').startsWith('job:')) return 'autonomous';
  if (ctx.source?.startsWith('pulse:')) return 'daily_checkin';
  return null;
}

/**
 * One chat message. Returns
 *   { handled: true,  route, intent, ok }   answered here, no model
 *   { handled: false, decision?, message? } the model's turn (`message` is the
 *                                           original request when the person
 *                                           said "no, something else")
 */
export async function tryLocal(ctx, input, turn, helpers, { mode = routerMode() } = {}) {
  if (mode === 'off') return { handled: false };
  const started = Date.now();
  const ids = { chatId: input.chatId, messageId: input.messageId };
  const message = String(input.message || '');
  const log = (e) => logRoute(ctx, { latencyMs: Date.now() - started, ...e });
  const skip = eligible(ctx, input);
  if (skip) return { handled: false, decision: { intent: skip === 'daily_checkin' ? 'DAILY_CHECKIN' : 'OPEN_ENDED', executionRoute: 'llm', reason: skip } };

  try {
    turn.detected = detectSituation({ message, source: ctx.source, audience: ctx.audience }, situations());

    /* An answer to Buddy's open question. */
    const pending = ctx.pending;
    if (pending && mode === 'on') {
      const words = normalizeMessage(message);
      if (pending.tool.startsWith(LOCAL)) {
        const options = Array.isArray(pending.args?._options) ? pending.args._options : [];
        const choice = pick(options, message);
        if (choice?.llm) {
          log({ intent: pending.tool.slice(LOCAL.length), route: 'llm', reasonCode: 'declined_reading', llmUsed: true });
          return { handled: false, message: pending.args?._original || null, decision: { intent: 'OPEN_ENDED', executionRoute: 'llm', reason: 'The person said the reading was wrong.' } };
        }
        if (choice?.option) {
          const done = await finishLocal(ctx, pending.tool.slice(LOCAL.length), pending.args, pending.param, choice.option, turn, ids, helpers);
          if (done.handled) { log({ intent: done.decision.intent, route: 'local', confidence: 1, ok: done.ok, errorKind: done.errorKind, correctedTo: done.correctedTo, reasonCode: 'answered' }); return { handled: true, route: 'local', intent: done.decision.intent, ok: done.ok }; }
        }
        // Not an answer: read it as a new message.
      } else {
        const tool = getTool(pending.tool);
        if (tool?.kind === 'write') {
          if (isCancel(message) || /^(?:no|nope|nah|stop|cancel)[\s!.]*$/i.test(words.clean)) {
            emitTalk(ctx, turn.emit, 'CANCEL_PROPOSAL');
            log({ intent: 'CANCEL_PROPOSAL', route: 'local', confidence: 1, reasonCode: 'dropped_question' });
            return { handled: true, route: 'local', intent: 'CANCEL_PROPOSAL', ok: true };
          }
          // Something new altogether is read as itself.
          const fresh = await understand(message, envFor(ctx, { pending: null }));
          const isNew = fresh.executionRoute === 'local' && fresh.confidence >= T_LOCAL && !['ACKNOWLEDGE', 'BARE_ANSWER', 'CONFIRM_HINT'].includes(fresh.intent) && words.tokens.length > 2;
          if (!isNew && pending.param && words.tokens.length <= 8 && !/\?\s*$/.test(words.clean)) {
            const out = await propose(tool, { ...(pending.args || {}), [pending.param]: words.clean }, ctx, ids);
            if (out.kind !== 'error') {
              if (out.kind === 'card') turn.noteCard(tool.name, pending.args || {}, out.card);
              helpers.emitOutcome(out, turn.emit);
              log({ intent: `ANSWER:${tool.name}`.slice(0, 64), route: 'local', confidence: 1, ok: out.kind !== 'none', clarified: out.kind === 'input' || out.kind === 'choice', reasonCode: 'answered' });
              return { handled: true, route: 'local', intent: tool.name, ok: true };
            }
          }
          if (!isNew) {
            log({ intent: 'OPEN_ENDED', route: 'llm', reasonCode: 'answer_unclear', llmUsed: true });
            return { handled: false, decision: { intent: 'OPEN_ENDED', executionRoute: 'llm', reason: 'An answer the engine could not place.' } };
          }
        }
      }
    }

    const env = envFor(ctx, { pending: null });
    const decision = await understand(message, env);

    if (mode === 'shadow') {
      log({ intent: decision.intent, route: 'shadow', reasonCode: decision.executionRoute, confidence: decision.confidence, signature: decision.signature, llmUsed: true });
      return { handled: false, decision };
    }
    if (decision.executionRoute === 'llm') {
      log({ intent: decision.intent, route: 'llm', reasonCode: 'needs_model', confidence: decision.confidence, signature: decision.signature, llmUsed: true });
      return { handled: false, decision };
    }
    if (decision.executionRoute === 'clarify') {
      clarify(ctx, decision, turn.emit, message);
      log({ intent: decision.intent, route: 'clarify', confidence: decision.confidence, clarified: true, signature: decision.signature });
      return { handled: true, route: 'clarify', intent: decision.intent, ok: true, decision };
    }
    const done = await execute(ctx, decision, turn, ids, helpers);
    if (!done.handled) {
      log({ intent: decision.intent, route: 'llm', reasonCode: done.reasonCode || 'unresolved', confidence: decision.confidence, signature: decision.signature, llmUsed: true });
      return { handled: false, decision: { ...decision, executionRoute: 'llm', reason: 'Recognised, but the records did not fit the reading: the model takes another look.' } };
    }
    log({ intent: decision.intent, route: 'local', confidence: decision.confidence, ok: done.ok, errorKind: done.errorKind, clarified: !!done.clarified, signature: decision.signature });
    return { handled: true, route: 'local', intent: decision.intent, ok: done.ok, decision };
  } catch (err) {
    // The local path never takes a turn down with it: the model answers.
    console.error('[local] router', err);
    log({ intent: 'OPEN_ENDED', route: 'llm', reasonCode: 'router_error', ok: false, errorKind: 'other', llmUsed: true });
    return { handled: false };
  }
}

function emitTalk(ctx, emit, intentId, params) {
  emit('text', { text: forChannel(renderTalk(intentId, ctx, params), ctx) });
}

/** Is this a chip that belongs to a local question? */
export const isLocalResume = (resume) => typeof resume?.tool === 'string' && resume.tool.startsWith(LOCAL);

/**
 * A tapped chip on a local question — back into its intent, no model.
 * "No, something else" cannot reach the model from a chip (a chip runs no
 * model), so it asks for the request in other words.
 */
export async function resumeLocal(ctx, resume, turn, ids, helpers) {
  const started = Date.now();
  const intentId = resume.tool.slice(LOCAL.length);
  const args = resume.args && typeof resume.args === 'object' ? resume.args : {};
  const options = Array.isArray(args._options) ? args._options : [];
  const chosen = options.find((o) => String(o.value) === String(resume.value));
  if (!getIntent(intentId) || !chosen) { turn.emit('notice', { text: 'That option is no longer available.' }); return; }
  if (chosen.value === 'llm') {
    turn.emit('text', { text: 'Okay. Say it another way and I will take another look.' });
    logRoute(ctx, { intent: intentId, route: 'clarify', reasonCode: 'declined_reading', latencyMs: Date.now() - started });
    return;
  }
  const done = await finishLocal(ctx, intentId, args, resume.param || 'intent', chosen, turn, ids, helpers);
  if (!done.handled) { turn.emit('notice', { text: 'I could not finish that from here. Ask me again in your own words.' }); return; }
  logRoute(ctx, { intent: done.decision.intent, route: 'local', confidence: 1, ok: done.ok, errorKind: done.errorKind, correctedTo: done.correctedTo, reasonCode: 'chip', latencyMs: Date.now() - started });
}

export { pageLabel };
