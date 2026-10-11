import { describe, it, expect, beforeAll } from 'vitest';
import { evaluate, runCase } from './evaluate.js';
import { EVAL_CASES } from './evalset.js';
import { T_LOCAL, T_CLARIFY } from './understand.js';

/**
 * The evaluation set, run end to end (the real loop, the real tools, an
 * in-memory company, a model that only counts its calls).
 *
 * These are floors, not targets, and they are set below what the engine
 * scores today so that a new phrasing added to the set can fail honestly for
 * a while. Two numbers are not floors but invariants: the router must never
 * execute something it should not have, and nothing is written without a
 * confirmation.
 *
 * `node scripts/eval-router.js --misses` prints the full report.
 */

let report;
beforeAll(async () => { report = await evaluate(EVAL_CASES); }, 60_000);

describe('the evaluation set', () => {
  it('is large enough to mean something, and covers every category', () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(250);
    expect(Object.keys(report.groups).sort()).toEqual([
      'ambiguous', 'change', 'decompose', 'follow-up', 'missing', 'needs-model', 'negation', 'no-guess', 'paraphrase', 'read-vs-write', 'spelling', 'talk',
    ]);
  });

  it('never executes locally what it should not — the invariant', () => {
    const wrong = report.rows.filter((r) => r.wrongLocal).map((r) => `${r.c.say} → ${r.intent}`);
    expect(wrong).toEqual([]);
  });

  it('writes nothing without a confirmation', () => {
    expect(report.metrics.unconfirmedWrites).toBe(0);
  });

  it('never calls the model for a message it handled', () => {
    for (const r of report.rows) {
      if (r.route !== 'llm') expect(r.modelCalls, r.c.say).toBe(0);
    }
  });

  it('calls the model exactly once per message it hands over (the counting model answers at once)', () => {
    for (const r of report.rows) {
      if (r.route === 'llm') expect(r.modelCalls, r.c.say).toBe(1);
    }
  });

  it('meets its floors', () => {
    const m = report.metrics;
    expect(m.intentAccuracy).toBeGreaterThanOrEqual(95);
    expect(m.parameterAccuracy).toBeGreaterThanOrEqual(95);
    expect(m.unnecessaryModelRate).toBeLessThanOrEqual(5);
    expect(m.clarificationRate).toBeLessThanOrEqual(12);
  });

  it('everything that genuinely needs the model reaches it', () => {
    const kept = report.rows.filter((r) => r.c.group === 'needs-model' && r.route !== 'llm').map((r) => r.c.say);
    expect(kept).toEqual([]);
  });

  it('answers in milliseconds when it answers locally', () => {
    expect(report.metrics.localLatencyMsP95).toBeLessThan(250);
  });
});

describe('the thresholds are where the eval set puts them', () => {
  it('every correct local execution clears T_LOCAL; one unexplained word never does', () => {
    expect(T_LOCAL).toBeGreaterThan(T_CLARIFY);
    // base 0.92 less one residue word (0.30) or one unused concept (0.30).
    expect(0.92 - 0.3).toBeLessThan(T_LOCAL);
    expect(0.92 - 0.3).toBeGreaterThanOrEqual(T_CLARIFY);
    // two spelling corrections still execute.
    expect(0.92 - 2 * 0.04).toBeGreaterThanOrEqual(T_LOCAL);
  });

  it.each([
    ['show unpaid invoices', 'local'],
    ['show unpaid invoices sorted by amount', 'clarify'],
    ['show unpaid invoices sorted by amount descending for the board', 'llm'],
  ])('%s → %s', async (say, route) => {
    expect((await runCase({ say, expect: { route } })).route).toBe(route);
  });
});
