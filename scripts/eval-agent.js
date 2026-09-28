#!/usr/bin/env node
/**
 * EdgeAI agent evals — run by hand against the real model.
 *
 *   node scripts/eval-agent.js                 # every case
 *   node scripts/eval-agent.js task-02 cash-   # ids starting with these
 *
 * Each case is one message sent through the real loop (api/_lib/agent/loop.js)
 * and the real Gemini model, over an in-memory copy of a fixture company
 * (eval-agent.world.js). Proposals are captured instead of stored, and the
 * fake database records every write — so the run also proves the third
 * target: no write without a confirm.
 *
 * Targets (docs/edgeai-agent.md): ≥ 95% correct tool, ≥ 90% fully correct
 * args, 0 unconfirmed writes.
 *
 * EVAL_PERSONA=<id> runs every case as that cofounder (default mira) — the
 * persona changes tone only, and the targets are the same for all of them.
 *
 * Needs GEMINI_API_KEY (read from .env if not in the environment). Costs one
 * to three model calls per case; it does not touch Supabase or the AI meter.
 */
import { readFileSync, existsSync } from 'node:fs';
import { runChat } from '../api/_lib/agent/loop.js';
import { toCard } from '../api/_lib/agent/actions.js';
import { fakeDb, fakeCtx } from '../api/_lib/agent/testing/fakeDb.js';
import { CASES } from './eval-agent.cases.js';
import { worldSeed, OWNER_PERMS, TODAY } from './eval-agent.world.js';

if (!process.env.GEMINI_API_KEY && existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set.');
  process.exit(2);
}

const filters = process.argv.slice(2);
const PERSONA = process.env.EVAL_PERSONA || 'mira';
console.log(`persona: ${PERSONA}`);
const cases = filters.length ? CASES.filter((c) => filters.some((f) => c.id.startsWith(f))) : CASES;

function same(want, got) {
  if (want instanceof RegExp) return typeof got === 'string' && want.test(got);
  if (Array.isArray(want)) {
    return Array.isArray(got) && want.length === got.length && want.every((w) => got.includes(w));
  }
  if (want === null) return got === null || got === undefined;
  if (typeof want === 'number') return Number(got) === want;
  if (typeof want === 'string' && typeof got === 'string') return want.toLowerCase() === got.toLowerCase();
  return want === got;
}

async function runCase(c) {
  const db = fakeDb(worldSeed());
  const ctx = fakeCtx({ db, perms: structuredClone(OWNER_PERMS), today: TODAY, recentEntities: c.recent || [] });
  ctx.persona = PERSONA;
  const proposals = [];
  ctx.actionStore = {
    countPending: async () => 0,
    insertProposal: async (_ctx, { tool, args, preview }) => {
      proposals.push({ tool: tool.name, args });
      return {
        id: `eval-${proposals.length}`, tool: tool.name, module: tool.module, risk: tool.risk, preview,
        status: 'proposed', expires_at: new Date(Date.now() + 1800e3).toISOString(),
      };
    },
  };
  const events = [];
  const started = Date.now();
  let error = null;
  try {
    await runChat(ctx, { message: c.say, history: c.history || [], chatId: 'eval', messageId: c.id }, (event, data) => events.push({ event, ...data }));
  } catch (err) {
    error = err.message + (err.detail ? ` ${err.detail}` : '');
  }
  const writes = db.writes.filter((w) => ['insert', 'update', 'delete', 'rpc'].includes(w.op));
  const kinds = new Set(events.map((e) => e.event));
  const first = proposals[0] || null;
  const text = events.filter((e) => e.event === 'text').map((e) => e.text).join(' ');

  let toolOk;
  let argsOk;
  const want = c.expect;
  if (want.tool) {
    toolOk = first?.tool === want.tool;
    argsOk = toolOk && Object.entries(want.args || {}).every(([k, v]) => same(v, first.args[k]));
  } else {
    const noCard = !kinds.has('card');
    const outcome = {
      choice: kinds.has('choice'),
      input: kinds.has('input'),
      none: kinds.has('notice') || (noCard && !!text),
      clarify: noCard && (kinds.has('choice') || kinds.has('input') || /\?\s*$/.test(text.trim())),
      noWrite: noCard && !kinds.has('choice') && !kinds.has('input'),
    }[want.kind];
    toolOk = !!outcome && noCard;
    argsOk = toolOk;
  }
  return { c, toolOk, argsOk, writes: writes.length, first, events, text, error, ms: Date.now() - started };
}

const results = [];
for (const c of cases) {
  const r = await runCase(c);
  results.push(r);
  const mark = r.argsOk ? 'PASS' : r.toolOk ? 'ARGS' : 'FAIL';
  console.log(`${mark}  ${c.id.padEnd(9)} ${String(r.ms).padStart(5)}ms  ${c.say}`);
  if (!r.argsOk) {
    console.log(`        expected ${JSON.stringify(c.expect, (k, v) => (v instanceof RegExp ? String(v) : v))}`);
    console.log(`        got      ${r.first ? JSON.stringify(r.first) : `[${[...new Set(r.events.map((e) => e.event))].join(', ')}] ${r.text.slice(0, 160)}`}`);
    const notice = r.events.find((e) => ['notice', 'input', 'choice'].includes(e.event));
    if (notice) console.log(`        said     ${notice.text || notice.input?.question || notice.choice?.question}`);
    if (r.error) console.log(`        error    ${r.error}`);
  }
  if (r.writes) console.log(`        !! ${r.writes} UNCONFIRMED WRITE(S)`);
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
const modules = [...new Set(results.map((r) => r.c.module))];
console.log('\nmodule     cases  tool     args');
for (const m of modules) {
  const rs = results.filter((r) => r.c.module === m);
  console.log(`${m.padEnd(10)} ${String(rs.length).padStart(5)}  ${pct(rs.filter((r) => r.toolOk).length, rs.length).padStart(6)}  ${pct(rs.filter((r) => r.argsOk).length, rs.length).padStart(6)}`);
}
const tool = results.filter((r) => r.toolOk).length;
const args = results.filter((r) => r.argsOk).length;
const writes = results.reduce((s, r) => s + r.writes, 0);
console.log(`${'all'.padEnd(10)} ${String(results.length).padStart(5)}  ${pct(tool, results.length).padStart(6)}  ${pct(args, results.length).padStart(6)}`);
console.log(`unconfirmed writes: ${writes}`);
const met = tool / results.length >= 0.95 && args / results.length >= 0.9 && writes === 0;
console.log(met ? 'targets met' : 'targets NOT met (≥95% tool, ≥90% args, 0 writes)');
void toCard;
process.exit(met ? 0 : 1);
