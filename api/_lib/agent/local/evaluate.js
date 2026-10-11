import { runChat } from '../loop.js';
import { fakeDb, fakeCtx } from '../testing/fakeDb.js';
import { toolsFor, toModelTools } from '../registry.js';
import { assemblePrompt } from '../assemble.js';
import { getIntent } from './intents.js';
import { worldSeed, OWNER_PERMS, TODAY, IDS } from '../../../../scripts/eval-agent.world.js';

/**
 * The router's evaluation harness: runs messages through the real chat loop
 * (runChat, router on) over the fixture company, with a model that only
 * counts how often it is called. Nothing here reaches a network.
 *
 * Used by local/eval.test.js (which pins the floor) and by
 * scripts/eval-router.js (which prints the report). Not a test file itself.
 *
 * What is measured
 *   intent accuracy              the route — and, where local, the intent — is the expected one
 *   parameter accuracy           of cases that expect parameters, all of them match
 *   unnecessary model calls      expected local/clarify, but the model was called
 *   wrong local executions       answered or proposed locally when it should not
 *                                have been, or as the wrong intent — the number
 *                                that must stay at zero
 *   clarification rate           how often one question is asked
 *   model calls avoided          messages that made no model call at all
 *   latency                      of locally handled messages (in-memory data)
 */

const ALL = { view: true, create: true, edit: true, delete: true };
const VIEW = { view: true, create: false, edit: false, delete: false };

/** An owner of the fixture company. `over` narrows or changes the session. */
export function evalCtx(over = {}) {
  const db = over.db || fakeDb(worldSeed());
  const perms = over.perms || { ...structuredClone(OWNER_PERMS), edgebrain: VIEW, library_documents: ALL, notifications: ALL };
  const ctx = fakeCtx({ db, perms, today: TODAY, employeeId: IDS.neha, recentEntities: over.recentEntities || [] });
  Object.assign(ctx, { channel: 'chat', audience: 'private', openCards: [], pending: null, lastRoute: null, routeLog: false, persona: 'steve' }, over.session || {});
  const proposals = [];
  ctx.actionStore = {
    countPending: async () => 0,
    insertProposal: async (_ctx, { tool, args, preview }) => {
      proposals.push({ tool: tool.name, args });
      return { id: `eval-${proposals.length}`, org_id: ctx.orgId, tool: tool.name, module: tool.module, risk: tool.risk, args, preview, status: 'proposed', expires_at: new Date(Date.now() + 1800e3).toISOString() };
    },
  };
  return { ctx, db, proposals };
}

/** A model that answers nothing and counts its calls. */
export function countingModel(reply = { role: 'assistant', content: '(the model would answer here)' }) {
  const fn = async () => { fn.calls += 1; return { message: typeof reply === 'function' ? reply() : reply, usage: { prompt_tokens: 0, completion_tokens: 0 } }; };
  fn.calls = 0;
  return fn;
}

/** One message through the loop. */
export async function send(ctx, message, { model = countingModel(), router = 'on', gate = undefined } = {}) {
  const events = [];
  const started = performance.now();
  let error = null;
  let out = null;
  try {
    out = await runChat(ctx, { message, chatId: 'eval-chat', messageId: `m-${Math.random().toString(36).slice(2, 8)}` }, (event, data) => events.push({ event, ...data }), { callModelImpl: model, router, gate });
  } catch (err) {
    error = err;
  }
  return { out, events, error, modelCalls: model.calls, ms: performance.now() - started };
}

const textOf = (events) => events.filter((e) => e.event === 'text').map((e) => e.text).join('\n');

function same(want, got) {
  if (want instanceof RegExp) return typeof got === 'string' && want.test(got);
  if (typeof want === 'number') return Number(got) === want;
  if (typeof want === 'boolean') return got === want;
  return String(want).toLowerCase() === String(got ?? '').toLowerCase();
}

export async function runCase(c) {
  const world = evalCtx();
  if (c.after) {
    const before = await send(world.ctx, c.after);
    const memo = before.events.find((e) => e.event === 'route')?.memo || null;
    world.ctx.lastRoute = memo;
    world.ctx.cache = new Map();
    world.ctx.views = undefined;
    world.proposals.length = 0;
  }
  const writesBefore = world.db.writes.filter((w) => w.op !== 'rpc').length;
  const r = await send(world.ctx, c.say);
  const decision = r.out?.decision || null;
  const route = r.out?.route === 'llm' || r.error ? 'llm' : r.out?.route || 'llm';
  const kinds = new Set(r.events.map((e) => e.event));
  const outcome = kinds.has('card') ? 'card' : kinds.has('choice') ? 'choice' : kinds.has('input') ? 'input' : kinds.has('notice') ? 'notice' : 'text';

  const want = c.expect;
  const routes = Array.isArray(want.route) ? want.route : [want.route];
  const routeOk = routes.includes(route);
  const intents = want.intent ? (Array.isArray(want.intent) ? want.intent : [want.intent]) : null;
  const intentOk = routeOk && (route === 'llm' || !intents || intents.includes(decision?.intent));
  const paramsOk = intentOk && Object.entries(want.params || {}).every(([k, v]) => same(v, decision?.parameters?.[k]));
  const outcomeOk = !want.outcome || outcome === want.outcome;
  // Local when it should have gone to the model, or local as the wrong thing.
  const expectLocal = routes.includes('local');
  const wrongLocal = route === 'local' && (!expectLocal || (intents && !intents.includes(decision?.intent)));
  return {
    c, route, intent: decision?.intent || null, parameters: decision?.parameters || {}, outcome,
    pass: intentOk && paramsOk && outcomeOk, intentOk, paramsOk: intentOk && paramsOk && outcomeOk,
    wrongLocal,
    unnecessaryModel: route === 'llm' && !routes.includes('llm'),
    modelCalls: r.modelCalls, ms: r.ms,
    writes: world.db.writes.filter((w) => w.op !== 'rpc').length - writesBefore,
    proposals: world.proposals.slice(),
    text: textOf(r.events), error: r.error?.message || null,
  };
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0);
const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };

export async function evaluate(cases) {
  const rows = [];
  for (const c of cases) rows.push(await runCase(c));
  const n = rows.length;
  const withParams = rows.filter((r) => r.c.expect.params || r.c.expect.outcome);
  const shouldBeLocal = rows.filter((r) => !(Array.isArray(r.c.expect.route) ? r.c.expect.route : [r.c.expect.route]).includes('llm'));
  const local = rows.filter((r) => r.route !== 'llm');
  const groups = {};
  for (const r of rows) {
    const gname = r.c.group || 'other';
    groups[gname] = groups[gname] || { cases: 0, pass: 0, noModel: 0 };
    groups[gname].cases += 1;
    groups[gname].pass += r.pass ? 1 : 0;
    groups[gname].noModel += r.modelCalls === 0 ? 1 : 0;
  }
  return {
    rows,
    groups,
    metrics: {
      cases: n,
      intentAccuracy: pct(rows.filter((r) => r.intentOk).length, n),
      parameterAccuracy: pct(withParams.filter((r) => r.paramsOk).length, withParams.length),
      unnecessaryModelRate: pct(shouldBeLocal.filter((r) => r.unnecessaryModel).length, shouldBeLocal.length),
      wrongLocalExecutions: rows.filter((r) => r.wrongLocal).length,
      wrongLocalRate: pct(rows.filter((r) => r.wrongLocal).length, n),
      clarificationRate: pct(rows.filter((r) => r.route === 'clarify').length, n),
      noModelRate: pct(rows.filter((r) => r.modelCalls === 0).length, n),
      modelCalls: rows.reduce((sum, r) => sum + r.modelCalls, 0),
      unconfirmedWrites: rows.reduce((sum, r) => sum + r.writes, 0),
      localLatencyMsP50: Math.round(quantile(local.map((r) => r.ms), 0.5) * 10) / 10,
      localLatencyMsP95: Math.round(quantile(local.map((r) => r.ms), 0.95) * 10) / 10,
    },
  };
}

/**
 * Roughly what ONE model call costs in prompt tokens for this session: the
 * system prompt, the turn context and every tool schema, at ~4 characters a
 * token. An estimate, for sizing what a locally answered message saves — a
 * model-answered read is usually two such calls (the tool call, then the words).
 */
export function promptTokensPerCall(ctx = evalCtx().ctx) {
  const tools = toolsFor(ctx);
  const prompt = assemblePrompt(ctx, tools, 'who owes us money?');
  const chars = prompt.system.length + prompt.turn.length + JSON.stringify(toModelTools(tools, ctx)).length;
  return { tools: tools.length, tokens: Math.round(chars / 4) };
}

/** The tool an intent runs, for scoring against cases that name a tool. */
export const toolOf = (intentId) => getIntent(intentId)?.tool || null;
