import { describe, it, expect } from 'vitest';
import { readChats, cardIds, selectMigratable, mergeChats, scopedKey } from './chatStore';

const mem = (obj = {}) => ({ getItem: (k) => (k in obj ? obj[k] : null), setItem: (k, v) => { obj[k] = v; } });
const chat = (id, messages, extra) => ({ id, title: id, at: 1, messages, ...extra });
const text = (c) => ({ id: `${c}-m`, role: 'user', content: 'hi' });
const card = (aid) => ({ id: `m-${aid}`, role: 'assistant', kind: 'action', actionId: aid, card: { status: 'executed' } });

describe('chat storage', () => {
    it('keys chats by org and user', () => {
        expect(scopedKey('o1', 'u1')).toBe('startupbuddy.chats.o1.u1');
        expect(scopedKey('o1', 'u1')).not.toBe(scopedKey('o2', 'u1'));
    });

    it('reads and cleans a stored list', () => {
        const s = mem({ k: JSON.stringify([chat('a', [{ id: 'x', role: 'assistant', content: '' }, { id: 'y', kind: 'card', content: 'old' }])]) });
        const out = readChats('k', s);
        expect(out[0].messages[0]).toMatchObject({ error: true, content: 'This reply was interrupted.' });
        expect(out[0].messages[1].kind).toBeUndefined();
        expect(out[0].entities).toEqual([]);
    });

    it('answers null for missing or corrupt data', () => {
        expect(readChats('none', mem())).toBeNull();
        expect(readChats('bad', mem({ bad: '{nope' }))).toBeNull();
    });

    it('moves a carded chat only when every card is verified', () => {
        const old = [
            chat('mine', [text('a'), card('c1'), card('c2')]),
            chat('other-org', [text('b'), card('c3')]),
            chat('mixed', [card('c1'), card('c9')]),
            chat('plain', [text('c')]),
            chat('empty', []),
        ];
        expect(cardIds(old).sort()).toEqual(['c1', 'c2', 'c3', 'c9']);
        const verified = new Set(['c1', 'c2']);
        expect(selectMigratable(old, verified, true).map((c) => c.id)).toEqual(['mine', 'plain']);
        expect(selectMigratable(old, verified, false).map((c) => c.id)).toEqual(['mine']);
    });

    it('merges without duplicates and drops a lone blank chat', () => {
        const blank = chat('blank', []);
        const merged = mergeChats([blank], [chat('a', [text('a')], { at: 5 }), chat('b', [text('b')], { at: 9 })]);
        expect(merged.map((c) => c.id)).toEqual(['b', 'a']);
        const again = mergeChats(merged, [chat('a', [text('a')])]);
        expect(again).toBe(merged);
        const kept = mergeChats([blank], [chat('a', [text('a')], { at: 5 })], 'blank');
        expect(kept.map((c) => c.id)).toEqual(['a', 'blank']);
    });
});
