import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { currentExchange, exchangeResponse } from './exchange';
import Exchange from './ExchangeView';
import { stageFor } from './stage';
import { PERSONAS } from '../design/personas';

const msg = (id, role, content, extra = {}) => ({ id, role, content, at: 1, ...extra });
const count = (html, needle) => html.split(needle).length - 1;

const TWO = [
    msg('q1', 'user', 'Who owes me money?'),
    msg('a1', 'assistant', 'Kite Retail is late.'),
    msg('q2', 'user', 'Did Nova pay?'),
    msg('a2', 'assistant', 'Yes, it came in by UPI.'),
];

const fakeAssistant = (messages) => ({
    messages, exchange: { id: 'x1' }, streaming: false, working: '',
    answer() {}, takeOffer() {}, regenerate() {}, confirmCard() {}, cancelCard() {}, undoCard() {}, retryCard() {}, setNote() {},
});

describe('the current exchange', () => {
    it('is the last question and what followed it', () => {
        const { question, items } = currentExchange(TWO);
        expect(question.id).toBe('q2');
        expect(items.map((m) => m.id)).toEqual(['a2']);
    });

    it('stands alone when nothing was asked (a call summary)', () => {
        const { question, items } = currentExchange([msg('c', 'assistant', '', { kind: 'call', call: {} })]);
        expect(question).toBeNull();
        expect(items).toHaveLength(1);
    });

    it('folds into the response shape', () => {
        const card = { action_id: 'a', title: 'Record payment', status: 'proposed' };
        const out = exchangeResponse([
            msg('q', 'user', 'Did Nova pay?'), msg('a', 'assistant', 'Yes.'), msg('c', 'assistant', 'x', { kind: 'action', card }),
        ], { mood: 'win', headline_word: 'Nice.', tag: 'Good news' });
        expect(out).toEqual({ mood: 'win', headline_word: 'Nice.', tag: 'Good news', answer: 'Yes.', card });
        const ask = exchangeResponse([
            msg('q', 'user', 'Log 12k'), msg('i', 'assistant', 'What was it for?', { kind: 'input', input: { options: [{ label: 'Travel', value: 't' }, { label: 'Software', value: 's' }] } }),
        ], { mood: 'thinking', headline_word: 'Hmm…', tag: 'Needs info' });
        expect(ask).toMatchObject({ mood: 'thinking', answer: 'What was it for?', picks: ['Travel', 'Software'] });
    });
});

describe('the chat screen', () => {
    it.each(PERSONAS.map((p) => [p.name, p]))('never renders more than one exchange (%s)', (_name, persona) => {
        // Even handed two exchanges, the screen shows only the current one.
        const html = renderToStaticMarkup(<Exchange a={fakeAssistant(TWO)} persona={persona} mood="win" tag="Good news" onOpen={() => {}} />);
        expect(count(html, 'class="mc-q"')).toBe(1);
        expect(count(html, 'class="mc-who"')).toBe(1);
        expect(count(html, 'class="mc-x"')).toBe(1);
        expect(html).toContain('Did Nova pay?');
        expect(html).toContain('Yes, it came in by UPI.');
        expect(html).not.toContain('Who owes me money?');
        expect(html).not.toContain('Kite Retail is late.');
    });

    it('renders nothing before anything is asked', () => {
        expect(renderToStaticMarkup(<Exchange a={fakeAssistant([])} persona={PERSONAS[0]} mood="thinking" onOpen={() => {}} />)).toBe('');
    });

    it('shows quick picks as chips and a typing state while loading', () => {
        const picks = [msg('q', 'user', 'Log 12k'), msg('i', 'assistant', 'What was it for?', { kind: 'input', input: { options: [{ label: 'Travel', value: 't' }] } })];
        expect(renderToStaticMarkup(<Exchange a={fakeAssistant(picks)} persona={PERSONAS[0]} mood="thinking" onOpen={() => {}} />)).toMatch(/class="mc-pick"[^>]*>Travel/);
        const loading = { ...fakeAssistant([msg('q', 'user', 'Hi'), msg('r', 'assistant', '')]), streaming: true };
        expect(renderToStaticMarkup(<Exchange a={loading} persona={PERSONAS[0]} mood="thinking" onOpen={() => {}} />)).toContain('mc-typing');
    });

    it('takes the mood from the server, and is "thinking" while loading or idle', () => {
        const persona = PERSONAS.find((p) => p.id === 'mark');
        const mood = { mood: 'celebrate', headline_word: 'Ship it!', tag: 'Big win' };
        expect(stageFor({ persona, mood, streaming: false, empty: false })).toEqual({ mood: 'celebrate', word: 'Ship it!', tag: 'Big win' });
        expect(stageFor({ persona, mood, streaming: true, empty: false })).toMatchObject({ mood: 'thinking', word: "Let's test it." });
        expect(stageFor({ persona, mood: null, streaming: false, empty: true })).toMatchObject({ mood: 'thinking', tag: 'Ask me anything' });
    });
});
