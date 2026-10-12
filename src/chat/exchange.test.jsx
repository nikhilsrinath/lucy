import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { currentExchange, exchangeResponse, pendingDecision } from './exchange';
import Exchange from './ExchangeView';
import { DecisionBody } from './DecisionDialog';
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
        ], { mood: 'happy', headline_word: 'Nice.', tag: 'Good news' });
        expect(out).toEqual({ mood: 'happy', headline_word: 'Nice.', tag: 'Good news', answer: 'Yes.', card });
        const ask = exchangeResponse([
            msg('q', 'user', 'Log 12k'), msg('i', 'assistant', 'What was it for?', { kind: 'input', input: { options: [{ label: 'Travel', value: 't' }, { label: 'Software', value: 's' }] } }),
        ], { mood: 'thinking', headline_word: 'Hmm…', tag: 'Needs info' });
        expect(ask).toMatchObject({ mood: 'thinking', answer: 'What was it for?', picks: ['Travel', 'Software'] });
    });
});

describe('the chat screen', () => {
    it.each(PERSONAS.map((p) => [p.name, p]))('never renders more than one exchange (%s)', (_name, persona) => {
        // Even handed two exchanges, the screen shows only the current one.
        const html = renderToStaticMarkup(<Exchange a={fakeAssistant(TWO)} persona={persona} mood="happy" tag="Good news" onOpen={() => {}} />);
        expect(count(html, 'class="mc-q"')).toBe(1);
        expect(count(html, 'mc-say')).toBe(1);
        expect(count(html, 'class="mc-x"')).toBe(1);
        expect(html).toContain('Did Nova pay?');
        expect(html).toContain('Yes, it came in by UPI.');
        expect(html).not.toContain('Who owes me money?');
        expect(html).not.toContain('Kite Retail is late.');
    });

    it('renders nothing before anything is asked', () => {
        expect(renderToStaticMarkup(<Exchange a={fakeAssistant([])} persona={PERSONAS[0]} mood="thinking" onOpen={() => {}} />)).toBe('');
    });

    it('shows a typing state while loading', () => {
        const loading = { ...fakeAssistant([msg('q', 'user', 'Hi'), msg('r', 'assistant', '')]), streaming: true };
        expect(renderToStaticMarkup(<Exchange a={loading} persona={PERSONAS[0]} onOpen={() => {}} />)).toContain('mc-typing');
    });

    it('sets a short answer as a headline and steps a long one down', () => {
        const say = (text) => renderToStaticMarkup(<Exchange a={fakeAssistant([msg('q', 'user', 'Hi'), msg('r', 'assistant', text)])} persona={PERSONAS[0]} onOpen={() => {}} />);
        expect(say('Seven open, two due this week.')).toContain('mc-say xl');
        expect(say('word '.repeat(30))).toContain('mc-say lg');
        expect(say('word '.repeat(80))).toContain('mc-say md');
        // Markdown marks do not count towards the length.
        expect(say(`**${'a'.repeat(88)}**`)).toContain('mc-say xl');
    });
});

describe('a decision', () => {
    const future = new Date(Date.now() + 10 * 60000).toISOString();
    const card = (status, extra = {}) => msg('c', 'assistant', 'x', { kind: 'action', card: { action_id: 'a', tool: 'create_cash_entry', title: 'Record expense', status, expires_at: future, ...extra } });
    const ask = msg('i', 'assistant', 'What was it for?', { kind: 'input', input: { options: [{ label: 'Travel', value: 't' }, { label: 'Software', value: 's' }] } });
    const stage = { mood: 'thinking', word: 'Hmm…', tag: 'Needs info' };

    it('is a card still open or a question with picks, and nothing else', () => {
        expect(pendingDecision([msg('a', 'assistant', 'Yes.')])).toBeNull();
        expect(pendingDecision([card('proposed')])?.id).toBe('c');
        expect(pendingDecision([card('executing')])?.id).toBe('c');
        for (const done of ['executed', 'cancelled', 'expired', 'undone', 'failed']) expect(pendingDecision([card(done)])).toBeNull();
        // Out of time: the card says "Expired", so there is nothing to decide.
        expect(pendingDecision([card('proposed', { expires_at: new Date(Date.now() - 1000).toISOString() })])).toBeNull();
        expect(pendingDecision([ask])?.id).toBe('i');
        expect(pendingDecision([ask], { streaming: true })).toBeNull();
        expect(pendingDecision([msg('n', 'assistant', 'Which client?', { kind: 'input', input: {} })])).toBeNull();
        // A re-previewed card replaces the one it came from.
        expect(pendingDecision([card('expired'), { ...card('proposed'), id: 'c2' }])?.id).toBe('c2');
    });

    it('is a button in the panel, not a card or chips', () => {
        const a = fakeAssistant([msg('q', 'user', '200'), card('proposed')]);
        const waiting = renderToStaticMarkup(<Exchange a={a} persona={PERSONAS[0]} onOpen={() => {}} decisionId="c" />);
        expect(waiting).toContain('class="mc-wait"');
        expect(waiting).toContain('Record expense');
        expect(waiting).not.toContain('sb-ac');
        const picks = renderToStaticMarkup(<Exchange a={fakeAssistant([msg('q', 'user', 'Log 12k'), ask])} persona={PERSONAS[0]} onOpen={() => {}} decisionId="i" />);
        expect(picks).toContain('class="mc-wait"');
        expect(picks).not.toContain('mc-pick');
        // Once it is no longer waiting, the card itself is shown.
        const done = renderToStaticMarkup(<Exchange a={fakeAssistant([msg('q', 'user', '200'), card('cancelled')])} persona={PERSONAS[0]} onOpen={() => {}} />);
        expect(done).toContain('Cancelled. Nothing was changed.');
        expect(done).not.toContain('mc-wait');
    });

    it('shows the mood on top and the choice below it', () => {
        const persona = PERSONAS.find((p) => p.id === 'mark');
        const body = (m) => renderToStaticMarkup(<DecisionBody m={m} a={fakeAssistant([])} persona={persona} stage={stage} onOpen={() => {}} onLater={() => {}} />);
        const withCard = body(card('proposed'));
        expect(withCard.indexOf('mcd-scene')).toBeLessThan(withCard.indexOf('mcd-body'));
        expect(withCard).toContain('Hmm…');
        expect(withCard).toContain('Needs info');
        expect(withCard).toContain('cf-avatar');
        expect(withCard).toContain('Record expense');
        expect(withCard).toContain('Confirm');
        expect(withCard).toContain('Decide later');
        const withPicks = body(ask);
        expect(withPicks).toMatch(/class="mc-pick"[^>]*>Travel/);
        expect(withPicks).toContain('What was it for?');
        expect(withPicks).toContain('Type it instead');
    });
});

describe('the stage', () => {

    it('takes the mood from the server, and is "thinking" only while loading', () => {
        const persona = PERSONAS.find((p) => p.id === 'mark');
        const mood = { mood: 'laughing', headline_word: 'Ship it!', tag: 'Big win' };
        expect(stageFor({ persona, mood, streaming: false, empty: false })).toEqual({ mood: 'laughing', word: 'Ship it!', tag: 'Big win' });
        for (const m of ['neutral', 'explaining', 'happy', 'serious', 'surprised', 'disappointed']) {
            expect(stageFor({ persona, mood: { mood: m, headline_word: '', tag: 'x' }, streaming: false, empty: false })).toEqual({ mood: m, word: persona.headlines[m], tag: 'x' });
        }
        expect(stageFor({ persona, mood, streaming: true, empty: false })).toMatchObject({ mood: 'thinking', word: "Let's test it." });
        expect(stageFor({ persona, mood: null, streaming: false, empty: false })).toMatchObject({ mood: 'neutral', tag: 'For you' });
        // An answer stored under the old default no longer rests on "thinking".
        const old = { mood: 'thinking', headline_word: "Let's test it.", tag: 'Thinking it through' };
        expect(stageFor({ persona, mood: old, streaming: false, empty: false })).toEqual({ mood: 'neutral', word: "Here's where we are.", tag: 'Here you go' });
        // An exchange stored under the four old names is shown under today's.
        expect(stageFor({ persona, mood: { mood: 'warning', headline_word: 'This is a problem.', tag: 'Needs attention' }, streaming: false, empty: false })).toEqual({ mood: 'serious', word: 'This is a problem.', tag: 'Needs attention' });
        expect(stageFor({ persona, mood: { mood: 'celebrate', headline_word: 'Ship it!', tag: 'Big win' }, streaming: false, empty: false })).toEqual({ mood: 'laughing', word: 'Ship it!', tag: 'Big win' });
        expect(stageFor({ persona, mood: { mood: 'win', headline_word: "It's working.", tag: 'Good news' }, streaming: false, empty: false })).toEqual({ mood: 'happy', word: "It's working.", tag: 'Good news' });
        expect(stageFor({ persona, mood: { mood: 'win', headline_word: "It's working.", tag: 'Here you go' }, streaming: false, empty: false })).toMatchObject({ mood: 'neutral' });
        // A question the cofounder asks is still "thinking".
        const ask = { mood: 'thinking', headline_word: "Let's test it.", tag: 'Needs info' };
        expect(stageFor({ persona, mood: ask, streaming: false, empty: false })).toMatchObject({ mood: 'thinking', tag: 'Needs info' });
    });

    it('reacts to the brief before anything is asked', () => {
        const persona = PERSONAS.find((p) => p.id === 'mark');
        const idle = (facts) => stageFor({ persona, mood: null, streaming: false, empty: true, brief: facts && { facts } });
        const clear = { overdueCount: 0, tasksOverdue: 0, netCash: 5000 };
        expect(idle(null)).toEqual({ mood: 'neutral', word: "Here's where we are.", tag: 'Ask me anything' });
        expect(idle(clear)).toMatchObject({ mood: 'neutral' });
        expect(idle({ ...clear, netCash: null })).toMatchObject({ mood: 'neutral' });
        expect(idle({ ...clear, overdueCount: 2 })).toEqual({ mood: 'serious', word: 'This is a problem.', tag: 'Needs attention' });
        expect(idle({ ...clear, tasksOverdue: 1 })).toMatchObject({ mood: 'serious' });
        expect(idle({ ...clear, netCash: -1 })).toMatchObject({ mood: 'serious' });
    });
});
