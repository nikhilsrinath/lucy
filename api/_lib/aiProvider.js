/**
 * The AI provider: OpenRouter's OpenAI-compatible chat completions API.
 *
 * Every server-side AI call (agent, /api/nvidia, EdgeBrain, library OCR) goes
 * through here, so the provider, key and model are chosen in one place.
 *
 * The model is always the server's. An OpenRouter key can reach every model it
 * lists, some at many times the price, so a model named in a request body is
 * never forwarded.
 */

export const AI_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Qwen 3.7 Flash: ~25x cheaper than Gemini 3.6 Flash ($0.03 / $0.13 per 1M
// tokens in / out) and ~97% on scripts/eval-agent.js. It reads images but not
// PDFs, so a scanned PDF in the library cannot be read by AI (see library.js).
export const AI_MODEL = process.env.AI_MODEL || 'qwen/qwen3.7-flash';

export function aiKey() {
  return process.env.OPENROUTER_API_KEY || null;
}

export function aiHeaders(apiKey, extra = {}) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    // Optional attribution OpenRouter shows on its dashboard.
    'X-Title': 'StartupBuddy',
    ...extra,
  };
}

// 'none' turns thinking off, which the short-answer callers need: thinking is
// billed against max_tokens, and Qwen at 'minimal' still spent a whole
// 100-token budget thinking and returned no text. Gemini 3.x is the exception:
// it refuses 'none' ("Reasoning is mandatory"), and 'minimal' is its closest.
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high']);
export function reasoningEffort(value, fallback = 'none', model = AI_MODEL) {
  const effort = EFFORTS.has(value) ? value : fallback;
  return effort === 'none' && model.startsWith('google/gemini-3') ? 'minimal' : effort;
}
