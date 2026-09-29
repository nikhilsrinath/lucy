import { describe, it, expect } from 'vitest';
import { resolveLegacyPath, REDIRECT_SECTIONS } from './redirects';
import { sectionOf, SECTIONS } from './sections';
import { PAGES } from '../../api/_lib/agent/tools/navigate.js';
import { KINDS } from '../../api/_lib/agent/resolvers.js';

// Every section live — the end state, and what the agent's hrefs must reach.
const ALL = new Set(SECTIONS.map((s) => s.id));
const NEW_ROOTS = new Set(SECTIONS.map((s) => s.path.slice(1)));
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const rootOf = (p) => p.replace(/^\//, '').split(/[/?#]/)[0];

describe('legacy redirects', () => {
    it('sends every open_page target to a new screen', () => {
        for (const [key, page] of Object.entries(PAGES)) {
            const to = resolveLegacyPath(page.href, { live: ALL });
            expect(to, `${key} (${page.href})`).toBeTruthy();
            expect(NEW_ROOTS.has(rootOf(to)), `${key} → ${to}`).toBe(true);
        }
    });

    it('sends every open_record href to a new screen', () => {
        const rows = [
            { id: ID, type: 'invoice' }, { id: ID, type: 'quotation' }, { id: ID, type: 'proforma' },
        ];
        for (const [kind, def] of Object.entries(KINDS)) {
            for (const r of kind === 'invoice' ? rows : [{ id: ID }]) {
                const href = def.href(r);
                const to = resolveLegacyPath(href, { live: ALL });
                expect(to, `${kind} (${href})`).toBeTruthy();
                expect(NEW_ROOTS.has(rootOf(to)), `${kind} → ${to}`).toBe(true);
            }
        }
    });

    it('also covers the write tools’ result hrefs', () => {
        expect(resolveLegacyPath('/cashbook', { live: ALL })).toBe('/money/transactions');
        expect(resolveLegacyPath('/purchases', { live: ALL })).toBe('/money/bills');
        expect(resolveLegacyPath('/', { live: ALL })).toBe('/home');
        expect(resolveLegacyPath('/dashboard', { live: ALL })).toBe('/home');
        expect(resolveLegacyPath('/buddy', { live: ALL })).toBe('/chat');
    });

    it('keeps the record a link points at', () => {
        expect(resolveLegacyPath(`/tasks?task=${ID}`, { live: ALL })).toBe(`/work?task=${ID}`);
        expect(resolveLegacyPath(`/projects/${ID}`, { live: ALL })).toBe(`/work?project=${ID}`);
        expect(resolveLegacyPath('/projects/new?fromQuotation=abc', { live: ALL })).toBe('/work?newProject=1&fromQuotation=abc');
        expect(resolveLegacyPath('/new-quotation/xyz', { live: ALL })).toBe('/money/invoices/xyz/edit');
        expect(resolveLegacyPath('/profile#email', { live: ALL })).toBe('/settings#email');
    });

    it('leaves a section alone until its new screen is live', () => {
        expect(resolveLegacyPath('/invoices', { live: new Set(['chat']) })).toBeNull();
        expect(resolveLegacyPath('/hub', { live: new Set(['chat']) })).toBe('/chat');
    });

    it('ignores paths that are not legacy ones', () => {
        expect(resolveLegacyPath('/money/bills', { live: ALL })).toBeNull();
        expect(resolveLegacyPath('/portal/abc', { live: ALL })).toBeNull();
        expect(resolveLegacyPath('https://evil.example/x', { live: ALL })).toBeNull();
    });

    it('only redirects into real sections', () => {
        for (const s of REDIRECT_SECTIONS) expect(ALL.has(s)).toBe(true);
    });
});

describe('sectionOf', () => {
    it('knows new and legacy paths', () => {
        expect(sectionOf('/money/bills')).toBe('money');
        expect(sectionOf('/cashbook')).toBe('money');
        expect(sectionOf('/customers')).toBe('clients');
        expect(sectionOf('/tasks')).toBe('work');
        expect(sectionOf('/ndas')).toBe('team');
        expect(sectionOf('/profile')).toBe('settings');
        expect(sectionOf('/')).toBe('home');
        expect(sectionOf('/business')).toBe('business');
        expect(sectionOf('/buddy')).toBe('chat');
        expect(sectionOf('/dashboard')).toBeNull();
    });
});

describe('agent labels', async () => {
    const { openedLabel, statusLabel } = await import('./agentLabels');
    it('renames old pages and leaves record labels alone', () => {
        expect(openedLabel('/timesheets', 'Timesheets')).toBe('Work');
        expect(openedLabel('/edgebrain', 'EdgeBrain')).toBe('Settings');
        expect(openedLabel('/customers', 'Acme Corp')).toBe('Acme Corp');
        expect(statusLabel('Asking EdgeBrain…')).toBe('Checking what I know…');
        expect(statusLabel('Checking tasks…')).toBe('Checking tasks…');
    });
});
