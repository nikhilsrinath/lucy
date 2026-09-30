/**
 * Views: structured blocks Buddy can show under an answer — figures, lists,
 * a timeline, "Buddy noticed" cards.
 *
 * A view is built by CODE from a read tool's own result, never written by the
 * model, so every figure on it is the figure the tool computed. The model only
 * chooses which of this turn's views to show, by putting [[show:v2]] in its
 * reply; the loop swaps the marker for the view (loop.js). A view the model
 * does not reference is simply not shown.
 *
 * Shapes (all carry `id`, `type`, `title`):
 *   metrics   { items: [{ label, value, sub?, tone? }], href? }
 *   list      { items: [{ title, sub?, value?, badge?, tone?, href? }], total?, more?, href?, warning? }
 *   timeline  { items: [{ at, title, sub?, tone? }] }
 *   insights  { items: insight[] }  — see insights.js
 *
 * Tones: g good · r needs attention · a warning · b info · n neutral.
 */

export const MAX_VIEW_ITEMS = 8;

/** Registers a tool's view for this turn and returns its id. */
export function addView(ctx, view) {
  if (!view || !view.type) return null;
  ctx.views = ctx.views || new Map();
  const id = `v${ctx.views.size + 1}`;
  const items = Array.isArray(view.items) ? view.items : [];
  const shown = items.slice(0, MAX_VIEW_ITEMS);
  ctx.views.set(id, {
    ...view,
    id,
    items: shown,
    more: view.more ?? Math.max(0, (view.total ?? items.length) - shown.length),
  });
  return id;
}

const MARKER = /\[\[\s*show\s*:\s*(v\d+)\s*\]\]/gi;

/**
 * Splits the model's reply into its words and the views it asked to show.
 * Unknown ids are dropped; each view is shown at most once.
 */
export function takeViews(text, ctx) {
  const ids = [];
  const clean = String(text || '').replace(MARKER, (_m, id) => {
    if (ctx.views?.has(id) && !ids.includes(id)) ids.push(id);
    return '';
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: clean, views: ids.map((id) => ctx.views.get(id)) };
}

/** A one-line description of a view, for the conversation history. */
export function viewLine(view) {
  if (!view) return '';
  const n = view.total ?? view.items?.length ?? 0;
  return `[Shown to the user: ${view.title}${view.type === 'metrics' ? '' : ` — ${n} item${n === 1 ? '' : 's'}`}]`;
}
