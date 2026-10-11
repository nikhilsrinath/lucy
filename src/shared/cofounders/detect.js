/**
 * Which situation a turn is about. Rule-based and deterministic: no model
 * call, so the same message always picks the same playbook and the same mood.
 *
 *   detectSituation   before the model runs — from the words, and from the
 *                     insight that started the turn. Picks the playbook.
 *   situationOfTurn   after it — from what the turn produced (a question, a
 *                     card). Record data outranks words.
 *
 * A weak or tied match returns null: no playbook is better than a wrong one.
 * In a shared space (a Telegram group) a money situation is never returned.
 */

const norm = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9₹%]+/g, ' ').trim()} `;

export function detectSituation({ message = '', source = null, audience = 'private' } = {}, situations = []) {
  const usable = situations.filter((s) => !(audience === 'shared' && s.money));
  if (source) {
    const bySource = usable.find((s) => s.sources.some((p) => source.startsWith(p)));
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

/**
 * The situation once the turn has run. `outcome` is what it produced:
 *   { asked: 'input' | 'choice' | null, cards: [{ tool, status, args? }] }
 */
export function situationOfTurn({ detected = null, outcome = {}, audience = 'private' } = {}, situations = []) {
  const usable = situations.filter((s) => !(audience === 'shared' && s.money));
  const has = (id) => usable.some((s) => s.id === id);
  if (outcome.asked === 'input' && has('missing_info')) return 'missing_info';
  if (outcome.asked === 'choice' && has('quick_pick')) return 'quick_pick';
  for (const card of outcome.cards || []) {
    if (card.tool === 'move_client_stage' && /^(deal|won)$/i.test(String(card.args?.stage || '')) && has('deal_won')) return 'deal_won';
    const byTool = usable.find((s) => s.tools.includes(card.tool));
    if (byTool) return byTool.id;
  }
  return detected && has(detected) ? detected : null;
}
