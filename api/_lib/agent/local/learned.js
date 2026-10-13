/**
 * A company's own way of saying things.
 *
 * When the reader is not sure of a reading it asks ("did you mean unpaid
 * invoices?"). When the person says yes, the SHAPE of what they said is kept
 * for their company with the reading it led to; once that has happened twice,
 * the same shape is read directly, without asking again.
 *
 * What is kept is never the sentence: names of records are replaced by
 * {name}, figures by #, so "show Acme's 50k invoice" is stored as
 * "show {name} # invoice". No amounts, no client names, no message text.
 *
 * A learned shape only ever settles a doubt the reader already had about its
 * own reading — it cannot make the reader do something it did not itself
 * read from the sentence, and a change still goes through its confirm card.
 * A shape the person later calls wrong is forgotten.
 *
 * The table (0075) is optional: without it nothing is learned and nothing
 * breaks.
 */

const TABLE = 'buddy_learned_phrasings';
export const LEARN_AFTER = 2;

/** The shape of a message: lower case, record names and figures replaced. */
export function shapeOf(core, entityLabels = []) {
  let s = ` ${String(core || '').toLowerCase()} `;
  for (const label of [...entityLabels].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const words = String(label).toLowerCase().split(/\s+/).filter(Boolean);
    // The whole label, or the part of it that was said ("Kite" for "Kite Labs").
    for (let n = words.length; n >= 1; n--) {
      const part = words.slice(0, n).join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<=\\s)${part}(?:'s)?(?=\\s)`, 'g');
      if (re.test(s)) { s = s.replace(re, '{name}'); break; }
    }
  }
  return s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '{email}').replace(/\d[\d,.]*/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** This company's learned shapes, read once per turn. Empty when the table is not there. */
export async function loadLearned(ctx) {
  if (ctx.cache?.has('learned')) return ctx.cache.get('learned');
  const pending = (async () => {
    try {
      const { data, error } = await ctx.db.from(TABLE).select('shape, intent, confirmations').eq('org_id', ctx.orgId).limit(2000);
      if (error) return new Map();
      return new Map((data || []).map((r) => [r.shape, { intent: r.intent, confirmations: Number(r.confirmations) || 0 }]));
    } catch { return new Map(); }
  })();
  ctx.cache?.set('learned', pending);
  return pending;
}

/** The person confirmed a reading: count it. */
export async function confirmShape(ctx, shape, intent) {
  if (!shape || !intent) return;
  try {
    const { data } = await ctx.db.from(TABLE).select('id, intent, confirmations').eq('org_id', ctx.orgId).eq('shape', shape).maybeSingle();
    if (data && data.intent === intent) {
      await ctx.db.from(TABLE).update({ confirmations: (Number(data.confirmations) || 0) + 1, last_confirmed_at: new Date().toISOString() }).eq('id', data.id);
    } else {
      if (data) await ctx.db.from(TABLE).delete().eq('id', data.id);
      await ctx.db.from(TABLE).insert({ org_id: ctx.orgId, shape, intent, confirmations: 1, last_confirmed_at: new Date().toISOString() });
    }
    ctx.cache?.delete('learned');
  } catch { /* learning never fails a turn */ }
}

/** The person said the reading was wrong: forget it. */
export async function forgetShape(ctx, shape) {
  if (!shape) return;
  try {
    await ctx.db.from(TABLE).delete().eq('org_id', ctx.orgId).eq('shape', shape);
    ctx.cache?.delete('learned');
  } catch { /* nothing to forget */ }
}
