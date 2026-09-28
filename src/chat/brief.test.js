import { describe, it, expect } from 'vitest';
import { buildBrief, taskBuckets, endOfWeek, inr } from './brief';
import { PERSONAS } from '../design/personas';

const NOW = new Date(2026, 8, 28, 9, 0); // Monday 28 Sep 2026, 9am
const inv = (id, over) => ({ id, type: 'invoice', status: 'sent', doc_number: `INV-${id}`, issued_to: `Client ${id}`, grand_total: 1000, amount_paid: 0, issue_date: '2026-09-01', ...over });

describe('taskBuckets', () => {
    it('splits open tasks into overdue, this week and later', () => {
        const b = taskBuckets([
            { title: 'a', status: 'pending', deadline: '2026-09-27' },
            { title: 'b', status: 'pending', deadline: '2026-09-28' },
            { title: 'c', status: 'in-progress', deadline: '2026-10-04' },
            { title: 'd', status: 'pending', deadline: '2026-10-05' },
            { title: 'e', status: 'done', deadline: '2026-09-01' },
            { title: 'f', status: 'pending' },
        ], NOW);
        expect(b.overdue.map((t) => t.title)).toEqual(['a']);
        expect(b.week.map((t) => t.title)).toEqual(['b', 'c']);
        expect(b.dueByWeekEnd).toBe(3);
        expect(b.open).toHaveLength(5);
    });
    it('ends the week on Sunday', () => {
        expect(endOfWeek(NOW)).toBe('2026-10-04');
        expect(endOfWeek(new Date(2026, 9, 4))).toBe('2026-10-04');
    });
});

describe('buildBrief', () => {
    const base = {
        now: NOW, name: 'Asha', persona: PERSONAS[0],
        docs: [inv('1', { due_date: '2026-09-20' }), inv('2', { due_date: '2026-10-20' }), inv('3', { status: 'paid', amount_paid: 1000 })],
        income: [], expenses: [], purchases: [], vendors: [],
        tasks: [{ title: 'Late one', status: 'pending', deadline: '2026-09-20' }],
    };

    it('uses real receivables and flags overdue', () => {
        const b = buildBrief(base);
        const owed = b.kpis.find((k) => k.id === 'owed');
        expect(owed.value).toBe(inr(2000));
        expect(owed.sub).toBe('1 overdue');
        expect(b.greeting).toBe('Good morning, Asha.');
        expect(b.suggestions[0].doc).toBe('1');
        expect(b.suggestions[0].sub).toMatch(/8 days overdue/);
    });

    it('hides a figure the person cannot fully see', () => {
        const b = buildBrief({ ...base, can: (r) => r !== 'expenses' });
        expect(b.kpis.map((k) => k.id)).toEqual(['owed', 'week']);
        expect(b.facts.netCash).toBeNull();
    });

    it('offers Gmail and the brain only when they are really missing', () => {
        const off = buildBrief({ ...base, gmail: { configured: true }, brain: { built: true, canBuild: true } });
        expect(off.suggestions.some((s) => s.id === 'gmail' || s.id === 'brain')).toBe(false);
        const on = buildBrief({ ...base, docs: [], tasks: [], gmail: { configured: false }, brain: { built: false, canBuild: true } });
        expect(on.suggestions.map((s) => s.id)).toEqual(['gmail', 'brain']);
    });

    it('never offers a build the person may not run', () => {
        const b = buildBrief({ ...base, docs: [], tasks: [], brain: { built: false, canBuild: false } });
        expect(b.suggestions).toEqual([]);
    });

    it('caps suggestions at three', () => {
        const docs = [1, 2, 3].map((i) => inv(String(i), { due_date: '2026-09-01' }));
        const b = buildBrief({ ...base, docs, gmail: { configured: false } });
        expect(b.suggestions).toHaveLength(3);
    });

    it('gives every persona a lede for an empty company', () => {
        for (const p of PERSONAS) {
            const b = buildBrief({ ...base, persona: p, docs: [], tasks: [] });
            expect(b.lede.length).toBeGreaterThan(5);
            expect(b.lede).not.toMatch(/undefined|NaN/);
        }
    });
});
