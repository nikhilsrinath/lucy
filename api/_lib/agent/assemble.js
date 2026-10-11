import { buildSystemPrompt, buildTurnContext } from './prompt.js';
import { cofounderOf, situations } from './cofounders.js';
import { detectSituation } from '../../../src/shared/cofounders/detect.js';

/**
 * The one place a prompt is assembled. Chat, voice calls, Telegram and
 * Buddy's own scheduled work all come through runChat (loop.js), which calls
 * this — so every channel gets the same pieces in the same order:
 *
 *   system   identity · shared rules · persona · mind · operating rules
 *            (fixed per user, cofounder and tool set, so it stays cached)
 *   turn     this message's facts, then — when a situation is detected —
 *            that cofounder's playbook for it and one or two of their examples
 *
 * The playbook sits in the turn block, not the system prompt, so the cached
 * prefix is the same for every message.
 */
export function assemblePrompt(ctx, tools, message) {
  const cofounder = cofounderOf(ctx.persona);
  const all = situations();
  const situation = detectSituation({ message, source: ctx.source, audience: ctx.audience }, all);
  return {
    system: buildSystemPrompt(ctx, tools),
    turn: buildTurnContext(ctx) + playbookBlock(cofounder, situation, all),
    situation,
    cofounder,
  };
}

const MAX_EXAMPLES = 2;

export function playbookBlock(cofounder, situationId, all = situations()) {
  const s = all.find((x) => x.id === situationId);
  const pb = s && cofounder.playbooks[s.id];
  if (!pb) return '';
  // The example for this situation first; one more of theirs for manner.
  const own = cofounder.examples[s.id];
  const other = Object.entries(cofounder.examples).find(([id]) => id !== s.id)?.[1];
  const examples = [own, other].filter(Boolean).slice(0, MAX_EXAMPLES);
  return `
<data source="playbook">
YOUR PLAYBOOK FOR THIS (${s.title}): what you, ${cofounder.name}, recommend and in what order. It is your advice, not a tool call and not a fact: take every figure, name and date from the records.
${pb.prose}
${examples.length ? `\nHOW YOU SOUND (manner only; never reuse their content):\n${examples.join('\n\n')}\n` : ''}</data>`;
}
