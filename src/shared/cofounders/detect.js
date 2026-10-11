/**
 * Which situation a turn is about. Rule-based and deterministic: no model
 * call, so the same message always picks the same playbook and the same mood.
 *
 *   detectSituation   before the model runs — from the words, and from the
 *                     insight that started the turn. Picks the playbook.
 *   situationOfTurn   after it — from what the turn produced (a question, a
 *                     card). Record data outranks words.
 *   detectCue         a mood the words alone ask for (a laugh, "explain…"),
 *                     used only when no situation applies (mood.js).
 *
 * A weak or tied match returns null: no playbook is better than a wrong one.
 * In a shared space (a Telegram group) a money situation is never returned.
 */

export const norm = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9₹%]+/g, ' ').trim()} `;

/** The situations this audience may see: no money situation in a shared space. */
export const usableSituations = (situations = [], audience = 'private') => situations.filter((s) => !(audience === 'shared' && s.money));

/** Whether the insight that started the turn is one of this situation's sources. */
export const fromSource = (situation, source) => !!(source && situation?.sources?.some((p) => source.startsWith(p)));

export function detectSituation({ message = '', source = null, audience = 'private' } = {}, situations = []) {
  const usable = usableSituations(situations, audience);
  if (source) {
    const bySource = usable.find((s) => fromSource(s, source));
    if (bySource) return bySource.id;
  }
  const text = norm(message);
  if (!text.trim()) return null;
  let best = null;
  let bestScore = 0;
  let tied = false;
  for (const s of usable) {
    let score = 0;
    for (const k of s.keywords) {
      // Longer phrases are stronger evidence than a single word.
      if (text.includes(norm(k))) score += k.includes(' ') ? 2 : 1;
    }
    if (score > bestScore) { best = s.id; bestScore = score; tied = false; } else if (score && score === bestScore) tied = true;
  }
  return bestScore > 0 && !tied ? best : null;
}

/** The situation a card means, from its tool: `usable` is already filtered for the audience. */
export function cardSituation(card, usable = []) {
  const has = (id) => usable.find((s) => s.id === id) || null;
  if (card?.tool === 'move_client_stage') {
    const stage = String(card.args?.stage || '').toLowerCase();
    if (/^(deal|won)$/.test(stage) && has('deal_won')) return has('deal_won');
    if (stage === 'lost' && has('deal_lost')) return has('deal_lost');
  }
  return usable.find((s) => s.tools.includes(card?.tool)) || null;
}

/**
 * The situation once the turn has run. `outcome` is what it produced:
 *   { asked: 'input' | 'choice' | null, cards: [{ tool, status, args? }] }
 */
export function situationOfTurn({ detected = null, outcome = {}, audience = 'private' } = {}, situations = []) {
  const usable = usableSituations(situations, audience);
  const has = (id) => usable.some((s) => s.id === id);
  if (outcome.asked === 'input' && has('missing_info')) return 'missing_info';
  if (outcome.asked === 'choice' && has('quick_pick')) return 'quick_pick';
  for (const card of outcome.cards || []) {
    const s = cardSituation(card, usable);
    if (s) return s.id;
  }
  return detected && has(detected) ? detected : null;
}

/** The first cue, in file order, with a phrase in the message: { mood } or null. */
export function detectCue(message = '', cues = []) {
  const raw = String(message || '').toLowerCase();
  const text = norm(raw);
  if (!text.trim() && !raw.trim()) return null;
  // A phrase with no letters (an emoji) is looked for as written.
  const said = (p) => (norm(p).trim() ? text.includes(norm(p)) : raw.includes(p));
  return cues.find((c) => c.phrases.some(said)) || null;
}
