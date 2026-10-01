/**
 * One model turn: OpenRouter's chat completions (see ../aiProvider.js), with tools.
 *
 * Deliberately non-streaming. The agent's steps are tool calls, and Gemini 3
 * attaches its reasoning to each tool call (OpenRouter: reasoning_details) that
 * must be sent back verbatim on the next request or the call is rejected.
 * Echoing a whole message object back is trivially correct; reassembling one
 * from stream deltas is where it gets lost. The endpoint still streams to the
 * browser (SSE events per step), so nothing is lost for the user.
 */
import { AI_URL, AI_MODEL, aiKey, aiHeaders, reasoningEffort } from '../aiProvider.js';

export const AGENT_MODEL = process.env.AGENT_MODEL || AI_MODEL;

/**
 * OpenRouter provider routing for the agent. A model on OpenRouter is served
 * by several providers at very different speeds; by default OpenRouter
 * load-balances for price. AGENT_PROVIDER_SORT picks what to prefer instead:
 * `throughput` (default — the fastest generation), `latency` (the quickest
 * first token) or `price`; `none` leaves OpenRouter's default routing.
 *
 * `require_parameters` keeps routing to providers that support everything
 * the request uses (tools, reasoning), so a fast provider that would ignore
 * the tools is never chosen. If OpenRouter cannot route the request that way
 * (no such provider: 404/400), the call is repeated once with its default
 * routing, and the setting is dropped for the life of this instance so no
 * later call pays for a second attempt.
 */
const SORTS = new Set(['throughput', 'latency', 'price']);
export function providerRouting(env = process.env.AGENT_PROVIDER_SORT) {
  const v = String(env ?? 'throughput').trim().toLowerCase();
  return SORTS.has(v) ? { sort: v, require_parameters: true } : undefined;
}
let routingDisabled = false;

export async function callModel({ messages, tools, fetchImpl = fetch, signal } = {}) {
  const apiKey = aiKey();
  if (!apiKey) throw new Error('Server is missing OPENROUTER_API_KEY');
  const send = (provider) => fetchImpl(AI_URL, {
    method: 'POST',
    headers: aiHeaders(apiKey),
    body: JSON.stringify({
      model: AGENT_MODEL,
      messages,
      tools: tools?.length ? tools : undefined,
      tool_choice: tools?.length ? 'auto' : undefined,
      temperature: 0.1,
      // Thinking is billed against max_tokens; 'low' buys better tool choice
      // for a small latency cost, and 4096 leaves room for the answer.
      reasoning_effort: reasoningEffort(process.env.AGENT_REASONING_EFFORT, 'low'),
      max_tokens: 4096,
      stream: false,
      ...(provider ? { provider } : {}),
    }),
    signal,
  });
  const routing = routingDisabled ? undefined : providerRouting();
  let res = await send(routing);
  if (!res.ok && routing && (res.status === 404 || res.status === 400)) {
    routingDisabled = true;
    console.warn(`[agent] OpenRouter refused provider routing (${res.status}); using default routing from now on. Set AGENT_PROVIDER_SORT=none to silence this.`);
    res = await send(undefined);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`AI provider error ${res.status}`);
    err.status = res.status;
    err.detail = text.slice(0, 400);
    throw err;
  }
  const json = await res.json();
  const choice = json.choices?.[0] || {};
  return { message: choice.message || { role: 'assistant', content: '' }, finish: choice.finish_reason, usage: json.usage || null };
}

/**
 * Token accounting across every model call of one chat message.
 *
 * Output is total - prompt when total is present, so thinking (billed as
 * output) is counted whether or not the provider folds it into
 * completion_tokens. Cached input and cost (USD) are read where reported;
 * OpenRouter reports both.
 */
/** Test hook: forget a failed routing attempt. */
export const resetRouting = () => { routingDisabled = false; };

export function newUsage() {
  return { calls: 0, prompt: 0, output: 0, cached: 0, cost: 0, perCall: [] };
}

export function addUsage(acc, usage) {
  if (!acc || !usage) return acc;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const prompt = n(usage.prompt_tokens);
  const output = usage.total_tokens != null ? Math.max(0, n(usage.total_tokens) - prompt) : n(usage.completion_tokens);
  const cached = n(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens);
  acc.calls += 1;
  acc.prompt += prompt;
  acc.output += output;
  acc.cached += cached;
  acc.cost += n(usage.cost);
  acc.perCall.push(prompt);
  return acc;
}

export function describeUsage(acc) {
  const f = (v) => v.toLocaleString('en-US');
  const cost = acc.cost ? ` · $${acc.cost.toFixed(5)}` : '';
  return `in ${f(acc.prompt)}${acc.cached ? ` (cached ${f(acc.cached)})` : ''} · out ${f(acc.output)}${cost} · ${acc.calls} call${acc.calls === 1 ? '' : 's'} [${acc.perCall.map(f).join(', ')}]`;
}
