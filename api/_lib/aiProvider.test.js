import { describe, it, expect } from 'vitest';
import { AI_URL, aiHeaders, reasoningEffort } from './aiProvider.js';

describe('aiProvider', () => {
  it('talks to OpenRouter with the key as a bearer token', () => {
    expect(AI_URL).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(aiHeaders('k', { Accept: 'text/event-stream' })).toMatchObject({
      Authorization: 'Bearer k', 'Content-Type': 'application/json', Accept: 'text/event-stream',
    });
  });

  it('turns thinking off, except on Gemini 3, which only goes down to "minimal"', () => {
    expect(reasoningEffort('none', 'none', 'qwen/qwen3.7-flash')).toBe('none');
    expect(reasoningEffort('none', 'none', 'google/gemini-3.6-flash')).toBe('minimal');
    expect(reasoningEffort('low', 'none', 'qwen/qwen3.7-flash')).toBe('low');
    expect(reasoningEffort(undefined, 'low', 'qwen/qwen3.7-flash')).toBe('low');
    expect(reasoningEffort('extreme', 'none', 'qwen/qwen3.7-flash')).toBe('none');
  });
});
