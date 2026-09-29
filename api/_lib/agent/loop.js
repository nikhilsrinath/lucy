import { toolsFor, toModelTools, getTool, allowed } from './registry.js';
import { buildSystemPrompt, buildTurnContext } from './prompt.js';
import { callModel, addUsage } from './model.js';
import { propose, modelView, confirm, cancel } from './pipeline.js';
import { buildContext as brainContext } from '../brainRetrieval.js';

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
 */

export const MAX_STEPS = 8;
const MAX_HISTORY = 12;

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
}

/** Emits a proposal's outcome. Returns what the model is told. */
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
  const tool = getTool(resume?.tool);
  if (!tool || tool.kind !== 'write') { emit('notice', { text: 'That option is no longer available.' }); return; }
  const args = { ...(resume.args || {}) };
  if (resume.param) args[resume.param] = resume.value;
  const out = await propose(tool, args, ctx, ids);
  emitOutcome(out, emit);
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
  if (card.risk !== 'low') return { status: 'error', message: 'A high-risk change needs the user to tap the card.' };
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
 *   system prompt (fixed) · history · turn context + EdgeBrain · user message
 *
 * Everything that changes per message sits after the history, so the prompt,
 * the tools and the earlier conversation form a prefix the next message and
 * every later step of this one reuse.
 */
export async function runChat(ctx, { message, history, chatId, messageId }, emit, { callModelImpl = callModel, usage = null } = {}) {
  const userMessage = String(message || '').trim().slice(0, 4000);
  const tools = toolsFor(ctx);
  // Tools that read reference data into their own schema (the cash tool's
  // category list) do it before the model sees them.
  await Promise.all(tools.filter((t) => t.prepare).map((t) => t.prepare(ctx).catch(() => null)));

  // EdgeBrain's facts for this question, as data. Best effort and bounded:
  // a slow or missing brain narrows the answer, it never blocks it.
  let brain = '';
  if (ctx.can('edgebrain', 'view')) {
    const pkg = await Promise.race([
      brainContext(ctx.orgId, ctx.allowed, userMessage, { maxEntities: 8 }).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 4000)),
    ]);
    if (pkg?.context) brain = `\n<data source="edgebrain">\n${pkg.context}\n</data>`;
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt(ctx, tools) },
    ...cleanHistory(history),
    { role: 'user', content: buildTurnContext(ctx) + brain },
    { role: 'user', content: userMessage },
  ];

  const controls = controlsFor(ctx);
  const modelTools = [
    ...toModelTools(tools, ctx),
    ...controls.map((name) => ({ type: 'function', function: { name, ...CONTROL_TOOLS[name] } })),
  ];
  const ids = { chatId, messageId };

  for (let step = 0; step < MAX_STEPS; step++) {
    const { message: reply, usage: stepUsage } = await callModelImpl({ messages, tools: modelTools });
    addUsage(usage, stepUsage);
    messages.push(reply);
    const calls = reply.tool_calls || [];
    if (!calls.length) {
      emit('text', { text: reply.content || '' });
      return { steps: step + 1 };
    }

    let halt = false;
    for (const call of calls) {
      const name = call.function?.name;
      const tool = getTool(name);
      const args = parseArgs(call.function?.arguments);
      let content;
      if (controls.includes(name)) {
        content = await runControl(name, args, ctx, emit).catch(() => ({ status: 'error', message: 'That did not work.' }));
        halt = true;
      } else if (!tool || !allowed(tool, ctx)) {
        content = { status: 'error', message: `${name} is not available to this user.` };
      } else if (tool.kind === 'write') {
        if (halt) {
          content = { status: 'skipped', note: 'One change at a time; ask the user after this one.' };
        } else {
          const out = await propose(tool, args, ctx, ids);
          content = emitOutcome(out, emit);
          if (out.stops) halt = true;
        }
      } else {
        if (tool.status) emit('status', { text: tool.status });
        try {
          const res = await tool.run(args, ctx);
          if (res.entities?.length) emit('entities', { entities: res.entities });
          if (res.navigate) emit('navigate', res.navigate);
          content = { status: 'ok', data: res.data };
        } catch (err) {
          console.error(`[agent] ${name}.run`, err);
          content = { status: 'error', message: 'That lookup failed.' };
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: `<data tool="${name}">${JSON.stringify(content)}</data>` });
    }
    if (halt) {
      if (reply.content?.trim()) emit('text', { text: reply.content });
      return { steps: step + 1 };
    }
  }
  emit('text', { text: 'That took more steps than I allow in one go. Could you ask for it in smaller pieces?' });
  return { steps: MAX_STEPS };
}
