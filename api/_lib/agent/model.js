/**
 * One model turn: Gemini's OpenAI-compatible chat completions, with tools.
 *
 * Deliberately non-streaming. The agent's steps are tool calls, and Gemini 3
 * attaches a thought signature to each tool call (extra_content.google) that
 * must be sent back verbatim on the next request or the call is rejected.
 * Echoing a whole message object back is trivially correct; reassembling one
 * from stream deltas is where signatures get lost. The endpoint still streams
 * to the browser (SSE events per step), so nothing is lost for the user.
 */

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
export const AGENT_MODEL = process.env.AGENT_MODEL || 'gemini-3.6-flash';

export async function callModel({ messages, tools, fetchImpl = fetch, signal } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Server is missing GEMINI_API_KEY');
  const res = await fetchImpl(GEMINI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: AGENT_MODEL,
      messages,
      tools: tools?.length ? tools : undefined,
      tool_choice: tools?.length ? 'auto' : undefined,
      temperature: 0.1,
      // Thinking is billed against max_tokens; 'low' buys better tool choice
      // for a small latency cost, and 4096 leaves room for the answer.
      reasoning_effort: process.env.AGENT_REASONING_EFFORT || 'low',
      max_tokens: 4096,
      stream: false,
    }),
    signal,
  });
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
