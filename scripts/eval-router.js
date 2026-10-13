#!/usr/bin/env node
/**
 * The local router's evaluation — no model, no network, no key needed.
 *
 *   node scripts/eval-router.js            # the report
 *   node scripts/eval-router.js --misses   # every case that missed, with what happened
 *   node scripts/eval-router.js --to-model # the model-era cases that still reach the model: what to teach next
 *
 * Two datasets, both over the fixture company (eval-agent.world.js):
 *
 *   1. api/_lib/agent/local/evalset.js — messages written for the router,
 *      each with the route, intent and parameters a correct router gives.
 *   2. scripts/eval-agent.cases.js — the agent's own eval cases, written for
 *      the MODEL long before the router existed. Run here with a model that
 *      only counts its calls: how many of them the router carries out alone,
 *      and whether what it proposed is what the case expects. An independent
 *      check, since none of these were written with the router in mind.
 *
 * Exit code 1 if the router ever executed something it should not have.
 */
import { evaluate, evalCtx, send, promptTokensPerCall, toolOf } from '../api/_lib/agent/local/evaluate.js';
import { EVAL_CASES } from '../api/_lib/agent/local/evalset.js';
import { CASES } from './eval-agent.cases.js';

process.env.BUDDY_ROUTER_LOG = 'off';
const quiet = console.info;
console.info = () => {};
// The fixture has no service-role database: tools that need one fail, by design, and say so.
console.error = () => {};
console.warn = () => {};
const showMisses = process.argv.includes('--misses');
const showToModel = process.argv.includes('--to-model');
const toModel = [];
const out = (s = '') => process.stdout.write(`${s}\n`);

const { rows, metrics, groups } = await evaluate(EVAL_CASES);

out('LOCAL ROUTER · evaluation set');
out('─'.repeat(72));
out('group            cases   correct   answered without a model');
for (const [name, v] of Object.entries(groups)) {
  out(`${name.padEnd(16)} ${String(v.cases).padStart(5)}   ${`${Math.round((100 * v.pass) / v.cases)}%`.padStart(7)}   ${`${Math.round((100 * v.noModel) / v.cases)}%`.padStart(7)}`);
}
out('─'.repeat(72));
out(`cases                          ${metrics.cases}`);
out(`intent accuracy                ${metrics.intentAccuracy}%`);
out(`parameter accuracy             ${metrics.parameterAccuracy}%`);
out(`unnecessary model calls        ${metrics.unnecessaryModelRate}%   (should have been local, went to the model)`);
out(`wrong local executions         ${metrics.wrongLocalExecutions}   (${metrics.wrongLocalRate}% — must be 0)`);
out(`clarification rate             ${metrics.clarificationRate}%`);
out(`messages with no model call    ${metrics.noModelRate}%`);
out(`unconfirmed writes             ${metrics.unconfirmedWrites}`);
out(`local latency                  p50 ${metrics.localLatencyMsP50} ms · p95 ${metrics.localLatencyMsP95} ms  (in-memory data)`);

const misses = rows.filter((r) => !r.pass);
if (misses.length) {
  out(`\n${misses.length} miss(es)${showMisses ? ':' : ' — run with --misses to list them'}`);
  if (showMisses) {
    for (const r of misses) {
      out(`  [${r.c.group}] ${r.c.say}`);
      out(`      expected ${JSON.stringify(r.c.expect, (k, v) => (v instanceof RegExp ? String(v) : v))}`);
      out(`      got      route=${r.route} intent=${r.intent} outcome=${r.outcome} params=${JSON.stringify(r.parameters)}${r.wrongLocal ? '   !! WRONG LOCAL EXECUTION' : ''}`);
    }
  }
}

/* ── the agent's own cases, with the router in front ──────────────────────── */

function same(want, got) {
  if (want instanceof RegExp) return typeof got === 'string' && want.test(got);
  if (Array.isArray(want)) return Array.isArray(got) && want.length === got.length && want.every((w) => got.includes(w));
  if (want === null) return got === null || got === undefined;
  if (typeof want === 'number') return Number(got) === want;
  if (typeof want === 'string' && typeof got === 'string') return want.toLowerCase() === got.toLowerCase();
  return want === got;
}

const tally = { total: 0, local: 0, localRight: 0, localWrong: 0, model: 0, writes: 0 };
const wrong = [];
const byModule = {};
for (const c of CASES) {
  const world = evalCtx({ recentEntities: c.recent || [] });
  const r = await send(world.ctx, c.say);
  const kinds = new Set(r.events.map((e) => e.event));
  const first = world.proposals[0] || null;
  const local = r.modelCalls === 0;
  const m = (byModule[c.module] = byModule[c.module] || { total: 0, local: 0, right: 0 });
  tally.total += 1; m.total += 1;
  tally.writes += world.db.writes.filter((w) => w.op !== 'rpc').length;
  if (!local) { tally.model += 1; toModel.push(`[${c.module}] ${c.say}  (${r.out?.decision?.intent || 'no reading'}${r.out?.decision?.reason ? `: ${r.out.decision.reason}` : ''})`); continue; }
  tally.local += 1; m.local += 1;
  let ok;
  const want = c.expect;
  const noCard = !kinds.has('card');
  if (want.tool) {
    ok = first?.tool === want.tool && Object.entries(want.args || {}).every(([k, v]) => same(v, first.args[k]));
    // A question the tool itself asks before proposing is not a wrong execution.
    if (!ok && noCard && (kinds.has('choice') || kinds.has('input')) && toolOf(r.out?.decision?.intent) === want.tool) ok = 'asked';
  } else {
    ok = {
      choice: kinds.has('choice'),
      input: kinds.has('input'),
      none: noCard,
      clarify: noCard,
      noWrite: noCard && !kinds.has('choice'),
    }[want.kind];
  }
  if (ok) { tally.localRight += 1; m.right += 1; } else {
    tally.localWrong += 1;
    wrong.push({ id: c.id, say: c.say, want, got: first || { events: [...kinds], intent: r.out?.decision?.intent } });
  }
}

out('\nAGENT EVAL CASES (written for the model) · with the router in front');
out('─'.repeat(72));
out('module      cases   handled locally   of those, as the case expects');
for (const [name, v] of Object.entries(byModule)) {
  out(`${name.padEnd(10)} ${String(v.total).padStart(6)}   ${`${v.local} (${Math.round((100 * v.local) / v.total)}%)`.padStart(15)}   ${v.local ? `${v.right}/${v.local}` : '—'}`);
}
out('─'.repeat(72));
out(`cases                          ${tally.total}`);
out(`handled with no model call     ${tally.local}  (${Math.round((100 * tally.local) / tally.total)}%)`);
out(`  as the case expects          ${tally.localRight}`);
out(`  not as the case expects      ${tally.localWrong}`);
out(`handed to the model            ${tally.model}  (${Math.round((100 * tally.model) / tally.total)}%)`);
out(`unconfirmed writes             ${tally.writes}`);
if (showToModel) {
  out('\nstill handed to the model (what to teach next, or what genuinely needs it):');
  for (const line of toModel) out(`  ${line}`);
}
if (wrong.length) {
  out('\nlocal, but not what the case expects:');
  for (const w of wrong) {
    out(`  ${w.id}  ${w.say}`);
    out(`      expected ${JSON.stringify(w.want, (k, v) => (v instanceof RegExp ? String(v) : v))}`);
    out(`      got      ${JSON.stringify(w.got)}`);
  }
}

const per = promptTokensPerCall();
out('\nWHAT A LOCAL ANSWER SAVES (estimate)');
out('─'.repeat(72));
out(`one model call for this session  ≈ ${per.tokens.toLocaleString('en-US')} prompt tokens (${per.tools} tool schemas + prompt, ~4 chars/token)`);
out('a model-answered read is usually 2 calls (the tool call, then the words); a local answer is 0.');
out(`evaluation set: ${Math.round((metrics.noModelRate / 100) * metrics.cases)} of ${metrics.cases} messages made no call → at least ${(Math.round((metrics.noModelRate / 100) * metrics.cases) * per.tokens).toLocaleString('en-US')} prompt tokens not sent (1 call each, a floor).`);

console.info = quiet;
process.exit(metrics.wrongLocalExecutions === 0 && metrics.unconfirmedWrites === 0 && tally.writes === 0 ? 0 : 1);
