import { describe, it, expect } from 'vitest';
import { PERSONAS, cleanPersona, DEFAULT_PERSONA } from './personas.js';
import { buildSystemPrompt, AGENT_PROMPT_VERSION } from './prompt.js';
import { fakeCtx } from './testing/fakeDb.js';
import { PERSONAS as CLIENT_PERSONAS } from '../../../src/design/personas.js';

describe('personas', () => {
    it('accepts only known ids', () => {
        expect(cleanPersona('arjun')).toBe('arjun');
        expect(cleanPersona('ARJUN')).toBe(DEFAULT_PERSONA);
        expect(cleanPersona('__proto__')).toBe(DEFAULT_PERSONA);
        expect(cleanPersona(undefined)).toBe(DEFAULT_PERSONA);
        expect(cleanPersona({ id: 'arjun' })).toBe(DEFAULT_PERSONA);
    });

    it('matches the client list id for id', () => {
        expect(Object.keys(PERSONAS).sort()).toEqual(CLIENT_PERSONAS.map((p) => p.id).sort());
        for (const p of CLIENT_PERSONAS) expect(PERSONAS[p.id].name).toBe(p.name);
    });

    it('names the persona and keeps tone below the rules', () => {
        const ctx = { ...fakeCtx(), persona: 'arjun' };
        const prompt = buildSystemPrompt(ctx, []);
        expect(prompt).toMatch(/^You are Arjun, the user's cofounder in StartupBuddy/);
        expect(prompt).toMatch(/never overrides the rules, the tools, the confirmations or the safety/);
        expect(prompt).toMatch(/SAFETY/);
        expect(prompt).not.toMatch(/EdgeAI|EdgeOS/);
        expect(AGENT_PROMPT_VERSION).toMatch(/startupbuddy/);
    });

    it('falls back to the default persona', () => {
        expect(buildSystemPrompt({ ...fakeCtx(), persona: 'nobody' }, [])).toMatch(/^You are Mira,/);
    });
});
