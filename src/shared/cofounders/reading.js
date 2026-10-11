import { norm } from './detect.js';

/**
 * The mood an answer's figures call for, judged against what was asked.
 *
 * A read tool reports `readings`: [{ metric, value, previous? }], plain
 * numbers from the same rows as its view. A metric has a kind
 * (cofounders/_core/situations.md, "# Metrics"), and the kind says how a
 * figure reads:
 *
 *   gain      more is good    zero → disappointed · down a quarter → serious · up a quarter → happy
 *   balance   signed          below zero → serious · above → happy
 *   cost      less is good    zero → happy · up a quarter → serious · down a quarter → happy
 *   problem   any is bad      zero → happy · above zero → serious
 *
 * The focus is the metric the message names ("revenue", "expenses"); with
 * none named the readings are judged together. `previous` is the same figure
 * for the window of equal length just before. In a shared space a money
 * metric is never read.
 */

export const SWING = 0.25;

const up = (r) => Number.isFinite(r.previous) && r.previous > 0 && r.value >= r.previous * (1 + SWING);
const down = (r) => Number.isFinite(r.previous) && r.previous > 0 && r.value <= r.previous * (1 - SWING);

const VERDICT = {
  gain(r) {
    if (r.value === 0) return { mood: 'disappointed', tag: 'Nothing yet' };
    if (down(r)) return { mood: 'serious', tag: 'Down' };
    if (up(r) || r.previous === 0) return { mood: 'happy', tag: 'Up' };
    return { mood: 'neutral', tag: 'Here you go' };
  },
  balance(r) {
    if (r.value < 0) return { mood: 'serious', tag: 'In the red' };
    if (r.value > 0) return { mood: 'happy', tag: 'In the green' };
    return { mood: 'neutral', tag: 'Here you go' };
  },
  cost(r) {
    if (r.value === 0) return { mood: 'happy', tag: 'All clear' };
    if (up(r)) return { mood: 'serious', tag: 'Up' };
    if (down(r)) return { mood: 'happy', tag: 'Down' };
    return { mood: 'neutral', tag: 'Here you go' };
  },
  problem(r) {
    return r.value > 0 ? { mood: 'serious', tag: 'Needs attention' } : { mood: 'happy', tag: 'All clear' };
  },
};

/** { mood, tag, metric } for a turn's readings, or null when they say nothing. */
export function readMood(message = '', readings = [], metrics = [], audience = 'private') {
  // The later reading of a metric wins.
  const byMetric = new Map();
  for (const r of readings || []) {
    const value = Number(r?.value);
    if (!r?.metric || !Number.isFinite(value)) continue;
    const previous = r.previous === undefined || r.previous === null ? undefined : Number(r.previous);
    byMetric.set(r.metric, { metric: r.metric, value, previous });
  }
  const known = metrics.filter((m) => byMetric.has(m.id) && VERDICT[m.kind] && !(audience === 'shared' && m.money));
  if (!known.length) return null;

  const text = norm(message);
  const focus = known.find((m) => m.phrases.some((p) => text.includes(norm(p))));
  if (focus) return { ...VERDICT[focus.kind](byMetric.get(focus.id)), metric: focus.id };

  const of = (kind) => known.filter((m) => m.kind === kind).map((m) => byMetric.get(m.id));
  const bad = of('problem').find((r) => r.value > 0) || of('balance').find((r) => r.value < 0);
  if (bad) return { mood: 'serious', tag: 'Needs attention', metric: bad.metric };
  const good = of('balance').find((r) => r.value > 0);
  if (good) return { mood: 'happy', tag: 'In the green', metric: good.metric };
  return null;
}
