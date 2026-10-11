import { toolsFor, toModelTools, getTool, allowed } from './registry.js';
import { assemblePrompt } from './assemble.js';
import { cofounderOf, situations } from './cofounders.js';
import { takeMood, moodFor } from '../../../src/shared/cofounders/mood.js';
import { situationOfTurn } from '../../../src/shared/cofounders/detect.js';
import { callModel, addUsage } from './model.js';
import { propose, modelView, confirm, cancel } from './pipeline.js';
import { loadAction } from './actions.js';
import { buildContext as brainContext } from '../brainRetrieval.js';
import { proposePlan } from './plans.js';
import { addView, takeViews } from './views.js';
import { tryLocal, resumeLocal, isLocalResume } from './local/engine.js';
import { modelDown } from './local/render.js';
import { logRoute } from './local/telemetry.js';

/**
 * One user message, start to finish.
 *
 *   context → model ⇄ tools (max 8 steps) → text and cards, streamed as events
 *
 * Read tools run immediately and their results go back to the model. A write
 * tool never runs: it becomes a proposal (pipeline.propose) and the turn ends,
 * because the next thing that should happen is the user reading the card.
 *
 * `emit(event, data)` is the SSE writer. Events:
 *   status    { text }                 a read tool is running
 *   text      { text }                 the assistant's words
 *   card      { card }                 a proposed change
 *   choice    { choice }               pick one of these records
 *   input     { input }                answer one question (chips)
 *   notice    { text, offer? }         nothing matched / not allowed
 *   navigate  { href, label }          open this screen
 *   entities  { entities }             records this turn referred to
 *   view      { view }                 a figures/list/timeline/insights block
 *                                      the model chose to show ([[show:vN]])
 *   mood      { mood, headline_word, tag, situation }
 *                                      last event of a turn: how the reply
 *                                      lands (warning, win, thinking,
 *                                      celebrate), decided here from the
 *                                      situation and what the turn produced —
 *                                      the model's [[mood:…]] is a suggestion
 *
 * Together a turn's events are the exchange the screen shows:
 *   { mood, headline_word, tag, answer, card?, picks? }
 * (src/chat/exchange.js folds them into that shape).
 *
 * The model is given this message only — no earlier chat turns. What carries
 * over is the system's own record: the records in play, an open question,
 * open cards and what was done (prompt.js buildTurnContext).
 *
 * A plan (propose_plan) is proposed like a write — one card, the turn ends.
 *
 * Before any of that, the local router (local/engine.js) reads the message.
 * What a business function can answer is answered there — the same tools,
 * the same propose() and cards, no model call — and only what genuinely
 * needs the model reaches chatTurn. docs/local-router.md.
 */

export const MAX_STEPS = 10;
// EdgeBrain's facts are best effort: past this the answer goes ahead without them.
export const BRAIN_WAIT_MS = 2000;

/**
 * Whether this message is worth an EdgeBrain lookup BEFORE the first model
 * call. The lookup is several queries and the model call waits for it, so it
 * is skipped where it cannot help — the model still has `ask_brain` and the
 * read tools for anything that needs company facts:
 *
 *   · the message answers a question Buddy just asked (pending): the context
 *     is already in the conversation;
 *   · it is a short reply or acknowledgement ("Ads", "yes", "thanks"), unless
 *     it is itself a question or a request to show something;
 *   · it is a plain command the tools carry out from the words alone
 *     ("remind Swetha…", "tell the group…", "mark it done", "make sure…").
 */
const ACTION_OPENER = /^(?:please\s+|pls\s+|can you\s+|could you\s+)?(?:remind|tell|text|message|ping|post|announce|make sure|ensure|keep after|chase|mark|complete|reopen|move|assign|schedule|stop|cancel|undo|scrap|never mind|yes|yeah|yep|no|nope|ok|okay|thanks|thank you|thx|hi|hello|hey)\b/i;
const QUESTION_OPENER = /^(?:who|what|whats|what's|how|why|which|when|where|show|list|give|tell me|any|is|are|do|does|did|can)\b/i;
export function wantsBrain(ctx, message) {
  const text = String(message || '').trim();
  if (!text) return false;
  if (ctx.pending) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  const question = text.includes('?') || QUESTION_OPENER.test(text);
  if (ACTION_OPENER.test(text) && !/\?\s*$/.test(text) && !/\btell me\b/i.test(text)) return false;
  if (words <= 3 && !question) return false;
  return true;
}

/**
 * Watches a turn's events so its mood can be decided when it ends: a question
 * asked, a card proposed or carried out, and the mood the model suggested.
 */
function trackTurn(ctx, emit) {
  const outcome = { asked: null, cards: [] };
  const turn = {
    detected: null,
    suggested: null,
    /** A card this turn proposed, with the arguments it was proposed from. */
    noteCard(tool, args, status = 'proposed') { outcome.cards.push({ tool, args, status }); },
    emit(event, data) {
      if (event === 'input' || event === 'choice') outcome.asked = event;
      else if (event === 'card_update' && data?.card?.status === 'executed') outcome.cards.unshift({ tool: data.card.tool, status: 'executed' });
      emit(event, data);
    },
    finish() {
      const all = situations();
      const situation = situationOfTurn({ detected: turn.detected, outcome, audience: ctx.audience }, all);
      emit('mood', moodFor(cofounderOf(ctx.persona), { situation, suggested: turn.suggested }, all));
    },
  };
  return turn;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
}

/** Emits a proposal's outcome. Returns what the model is told. */
/** The assistant's words, then the views it referenced, in that order. */
export function emitReply(text, ctx, emit) {
  const { text: unmarked, suggested } = takeMood(text);
  const { text: words, views } = takeViews(unmarked, ctx);
  if (words) emit('text', { text: words });
  for (const view of views) emit('view', { view });
  return { words, views, suggested };
}

export function emitOutcome(out, emit) {
  if (out.kind === 'card') {
    emit('card', { card: out.card });
    if (out.entities?.length) emit('entities', { entities: out.entities });
  } else if (out.kind === 'choice') emit('choice', { choice: out.choice });
  else if (out.kind === 'input') emit('input', { input: out.input });
  else if (out.kind === 'none') emit('notice', { text: out.message, offer: out.offer || null });
  return modelView(out);
}

/**
 * A tapped chip, or an offer taken — straight back into the tool, no model.
 * `resume` is { tool, args, param?, value? }; the args are re-validated like
 * any model's, so a client that edits them gains nothing.
 */
export async function runResume(ctx, resume, emit, ids) {
  // A chip on one of the local router's own questions.
  if (isLocalResume(resume)) {
    const turn = trackTurn(ctx, emit);
    await resumeLocal(ctx, resume, turn, ids || {}, { emitOutcome });
    turn.finish();
    return;
  }
  const tool = getTool(resume?.tool);
  if (!tool || tool.kind !== 'write') { emit('notice', { text: 'That option is no longer available.' }); return; }
  const args = { ...(resume.args || {}) };
  if (resume.param) args[resume.param] = resume.value;
  const turn = trackTurn(ctx, emit);
  const out = await propose(tool, args, ctx, ids);
  if (out.kind === 'card') turn.noteCard(tool.name, args);
  emitOutcome(out, turn.emit);
  turn.finish();
}

/* ── controls: acting on what is already on the table ──────────────────────
   Not write tools — they propose nothing new. They let the model act on its
   own understanding of the message ("scrap that", "yes go ahead" on a call)
   instead of the client matching words. cancel_proposal withdraws a card the
   user no longer wants; confirm_proposal exists only on a voice call, only
   for a low-risk card, and runs the same confirm() a tap runs (re-checked,
   idempotent). High-risk cards always need a tap. */

const CONTROL_TOOLS = {
  cancel_proposal: {
    description: 'Withdraw a change you proposed that the user no longer wants ("scrap that", "no, leave it", "cancel the invoice draft card"). Nothing had been changed; this only closes the card.',
    parameters: { type: 'object', properties: { action_id: { type: 'string', description: 'The id of one of the OPEN CARDS.' } }, required: ['action_id'] },
  },
  confirm_proposal: {
    description: 'On a voice call only: carry out a low-risk card the user has just clearly agreed to out loud. Never for a high-risk card, never on your own initiative.',
    parameters: { type: 'object', properties: { action_id: { type: 'string', description: 'The id of one of the OPEN CARDS.' } }, required: ['action_id'] },
  },
};

export function controlsFor(ctx) {
  const open = ctx.openCards || [];
  if (!open.length) return [];
  const names = ['cancel_proposal'];
  if (ctx.voice && open.some((c) => c.risk === 'low')) names.push('confirm_proposal');
  return names;
}

async function runControl(name, args, ctx, emit) {
  const card = (ctx.openCards || []).find((c) => c.action_id === args.action_id);
  if (!card) return { status: 'error', message: 'That is not one of the open cards.' };
  if (name === 'cancel_proposal') {
    const res = await cancel(ctx, card.action_id);
    if (res.card) emit('card_update', { card: res.card });
    return { status: res.status };
  }
  // confirm_proposal: the server's own guards, not the model's word.
  if (!ctx.voice) return { status: 'error', message: 'Confirming needs the user to tap the card.' };
  // Risk and kind from the stored action, never from what the client listed.
  const row = await loadAction(card.action_id, ctx).catch(() => null);
  if (!row || row.org_id !== ctx.orgId) return { status: 'error', message: 'That is not one of the open cards.' };
  if (row.kind === 'plan' || row.tool === 'plan') return { status: 'error', message: 'A plan needs the user to tap Approve on its card.' };
  if (row.risk !== 'low') return { status: 'error', message: 'A high-risk change needs the user to tap the card.' };
  const res = await confirm(ctx, card.action_id);
  if (res.card) emit('card_update', { card: res.card, entities: res.entities || [] });
  return { status: res.status, summary: res.card?.summary || res.message || null };
}

/**
 * `usage` (optional, from newUsage()) collects token counts from every model
 * call, including calls made before a failure, so the caller can log them.
 *
 * Message order is chosen for Gemini's implicit prompt cache, which discounts
 * a request's leading tokens when they match a recent request:
 *
 *   system prompt (fixed) · turn context + playbook + EdgeBrain · user message
 *
 * Everything that changes per message sits after the system prompt, so the
 * prompt and the tools form a prefix the next message and every later step of
 * this one reuse. No earlier chat turns are sent (a `history` passed by an
 * older caller is ignored).
 */
export async function runChat(ctx, input, emit, opts = {}) {
  const turn = trackTurn(ctx, emit);
  const started = Date.now();

  // Understand locally first. Handled here means no model was called.
  const local = await tryLocal(ctx, input, turn, { emitOutcome }, opts.router ? { mode: opts.router } : undefined);
  if (local.handled) {
    turn.finish();
    return { steps: 0, local: true, route: local.route, intent: local.intent, decision: local.decision || null };
  }

  // The model's turn. `gate` is the caller's metering: it runs only now, so
  // a message answered locally never counts against the plan's AI messages.
  if (opts.gate) {
    const g = await opts.gate();
    if (g?.blocked) {
      emit('notice', { text: g.message });
      turn.finish();
      return { steps: 0, blocked: true, route: 'blocked' };
    }
  }
  const forModel = local.message ? { ...input, message: local.message } : input;
  try {
    const result = await chatTurn(ctx, forModel, turn, opts);
    turn.finish();
    return { ...result, route: 'llm', intent: local.decision?.intent || null, decision: local.decision || null };
  } catch (err) {
    // No model, a timeout or a malformed reply: say so, and say what still
    // works. Never an invented answer.
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    emit('text', { text: modelDown(ctx) });
    logRoute(ctx, { intent: local.decision?.intent || 'OPEN_ENDED', route: 'llm', reasonCode: 'model_error', ok: false, errorKind: timeout ? 'model_timeout' : 'model_failed', llmUsed: true, latencyMs: Date.now() - started });
    turn.finish();
    err.explained = true;
    throw err;
  }
}

async function chatTurn(ctx, { message, chatId, messageId }, turn, { callModelImpl = callModel, usage = null } = {}) {
  const emit = turn.emit;
  const userMessage = String(message || '').trim().slice(0, 4000);
  const t0 = Date.now();
  // Where the time went, for the platform logs: counts and milliseconds only.
  const timing = { brain: 'skipped', prep: 0, models: [], tools: [] };
  const tools = toolsFor(ctx);

  // EdgeBrain's facts for this question, as data. Best effort and bounded:
  // a slow or missing brain narrows the answer, it never blocks it. Run
  // alongside the tools' own preparation (the cash tool's category list
  // goes into its schema before the model sees it) rather than after it.
  const fetchBrain = async () => {
    if (!ctx.can('edgebrain', 'view') || !wantsBrain(ctx, userMessage)) return '';
    emit('status', { text: 'Checking what I know…' });
    const started = Date.now();
    const pkg = await Promise.race([
      brainContext(ctx.orgId, ctx.allowed, userMessage, { maxEntities: 8 }).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), BRAIN_WAIT_MS)),
    ]);
    timing.brain = pkg?.context ? Date.now() - started : `none(${Date.now() - started}ms)`;
    return pkg?.context ? `\n<data source="edgebrain">\n${pkg.context}\n</data>` : '';
  };
  const [brain] = await Promise.all([
    fetchBrain(),
    Promise.all(tools.filter((t) => t.prepare).map((t) => t.prepare(ctx).catch(() => null))),
  ]);
  timing.prep = Date.now() - t0;

  const prompt = assemblePrompt(ctx, tools, userMessage);
  turn.detected = prompt.situation;
  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.turn + brain },
    { role: 'user', content: userMessage },
  ];

  const controls = controlsFor(ctx);
  const modelTools = [
    ...toModelTools(tools, ctx),
    ...controls.map((name) => ({ type: 'function', function: { name, ...CONTROL_TOOLS[name] } })),
  ];
  const ids = { chatId, messageId };

  for (let step = 0; step < MAX_STEPS; step++) {
    const modelStart = Date.now();
    const { message: reply, usage: stepUsage } = await callModelImpl({ messages, tools: modelTools });
    timing.models.push(Date.now() - modelStart);
    addUsage(usage, stepUsage);
    messages.push(reply);
    const calls = reply.tool_calls || [];
    if (!calls.length) {
      const { words, views, suggested } = emitReply(reply.content || '', ctx, emit);
      turn.suggested = suggested || turn.suggested;
      if (!words && !views.length) emit('text', { text: '' });
      logTiming(ctx, timing, t0, step + 1);
      return { steps: step + 1 };
    }

    let halt = false;
    for (const call of calls) {
      const name = call.function?.name;
      const tool = getTool(name);
      const { reason, ...args } = parseArgs(call.function?.arguments);
      let content;
      if (controls.includes(name)) {
        content = await runControl(name, args, ctx, emit).catch(() => ({ status: 'error', message: 'That did not work.' }));
        halt = true;
      } else if (!tool || !allowed(tool, ctx)) {
        content = { status: 'error', message: `${name} is not available to this user.` };
      } else if (tool.kind === 'write' || tool.kind === 'plan') {
        if (halt) {
          content = { status: 'skipped', note: 'One change or plan at a time; ask the user after this one.' };
        } else {
          const out = tool.kind === 'plan'
            ? await proposePlan(args, ctx, { ...ids, reason })
            : await propose(tool, args, ctx, { ...ids, reason });
          if (out.kind === 'card') turn.noteCard(name, args);
          content = emitOutcome(out, emit);
          if (out.stops) halt = true;
        }
      } else {
        if (tool.status) emit('status', { text: tool.status });
        const toolStart = Date.now();
        try {
          const res = await tool.run(args, ctx);
          timing.tools.push(`${name}:${Date.now() - toolStart}`);
          if (res.entities?.length) emit('entities', { entities: res.entities });
          if (res.navigate) emit('navigate', res.navigate);
          const viewId = res.view ? addView(ctx, res.view) : null;
          content = { status: 'ok', data: res.data, ...(viewId ? { view_id: viewId } : {}) };
        } catch (err) {
          console.error(`[agent] ${name}.run`, err);
          content = { status: 'error', message: 'That lookup failed.' };
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: `<data tool="${name}">${JSON.stringify(content)}</data>` });
    }
    if (halt) {
      if (reply.content?.trim()) turn.suggested = emitReply(reply.content, ctx, emit).suggested || turn.suggested;
      logTiming(ctx, timing, t0, step + 1);
      return { steps: step + 1 };
    }
  }
  emit('text', { text: 'That took more steps than I allow in one go. Could you ask for it in smaller pieces?' });
  logTiming(ctx, timing, t0, MAX_STEPS);
  return { steps: MAX_STEPS };
}

/** One line: where a chat turn's time went. Numbers and tool names only — never content. */
function logTiming(ctx, timing, t0, steps) {
  try {
    console.info(`[agent] timing ${JSON.stringify({
      org: ctx.orgId, channel: ctx.channel || 'chat', total_ms: Date.now() - t0, prep_ms: timing.prep,
      brain: timing.brain, steps, model_ms: timing.models, tools_ms: timing.tools,
    })}`);
  } catch { /* logging never fails a turn */ }
}
