import { describe, it, expect } from 'vitest';
import { matchScore, rankCandidates, isBackReference, normalize } from './resolvers.js';
import { ALL_TOOLS, registryProblems, toolsFor, getTool } from './registry.js';
import { sameInstant } from './executor.js';
import { fakeCtx } from './testing/fakeDb.js';
import { cleanEntities } from './context.js';
import { friendlyDbError } from './db.js';

describe('matchScore', () => {
  it('scores the whole name, a prefix, and all-words matches in that order', () => {
    const name = ['Connect with client on pricing'];
    expect(matchScore('connect with client on pricing', name)).toBe(100);
    expect(matchScore('Connect with', name)).toBeGreaterThanOrEqual(80);
    expect(matchScore('the pricing one', name)).toBeGreaterThanOrEqual(55);
    expect(matchScore('pricing call', name)).toBeLessThan(40);
  });

  it('tolerates one typo in a long word and ignores accents and punctuation', () => {
    expect(matchScore('pricng', ['Pricing review'])).toBeGreaterThanOrEqual(55);
    expect(normalize('Café—Déjà')).toBe('cafe deja');
  });

  it('prefers the name that the words cover more of', () => {
    expect(matchScore('pricing', ['Pricing call'])).toBeGreaterThan(matchScore('pricing', ['Pricing call with Acme about renewal']));
  });
});

describe('rankCandidates', () => {
  const rows = [
    { id: 'a', aliases: ['Acme renewal call'] },
    { id: 'b', aliases: ['Send Acme the deck'] },
    { id: 'c', aliases: ['Hire a designer'] },
  ];

  it('returns one only when it is clearly best', () => {
    expect(rankCandidates('acme renewal', rows)).toMatchObject({ status: 'one', match: { id: 'a' } });
    expect(rankCandidates('acme', rows).status).toBe('many');
    expect(rankCandidates('payroll', rows).status).toBe('none');
  });

  it('lets the conversation and the open page break a tie, never overturn a clear name', () => {
    expect(rankCandidates('acme', rows, { recentIds: ['b'] })).toMatchObject({ status: 'many' });
    expect(rankCandidates('acme', rows, { pageId: 'b', recentIds: ['b'] }).candidates[0].id).toBe('b');
    expect(rankCandidates('acme renewal', rows, { recentIds: ['b'] }).match.id).toBe('a');
  });

  it('caps candidates at five', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, aliases: [`Report ${i}`] }));
    expect(rankCandidates('report', many).candidates).toHaveLength(5);
  });
});

describe('back references', () => {
  it.each(['it', 'that', 'that task', 'this client', 'him', 'the same one', ''])('"%s" points back', (s) => {
    expect(isBackReference(s)).toBe(true);
  });
  it.each(['Acme', 'the pricing one', 'INV-0042'])('"%s" is a name', (s) => {
    expect(isBackReference(s)).toBe(false);
  });
});

describe('registry', () => {
  it('has no invariant violations', () => {
    expect(registryProblems()).toEqual([]);
  });

  it('every write tool carries a risk and a permission, decided here and not by the model', () => {
    for (const t of ALL_TOOLS.filter((x) => x.kind === 'write')) {
      expect(['low', 'high'], t.name).toContain(t.risk);
      expect(t.permission?.resource, t.name).toBeTruthy();
    }
  });

  it('classifies money, deletes and anything irreversible as high risk', () => {
    const high = ALL_TOOLS.filter((t) => t.risk === 'high').map((t) => t.name).sort();
    expect(high).toEqual([
      'cancel_financial_document', 'create_cash_entry', 'create_purchase_bill', 'create_vendor',
      'delete_client', 'delete_financial_document', 'delete_task', 'issue_document',
      'mark_invoice_paid', 'record_payment', 'send_payment_reminder',
    ]);
    for (const t of ALL_TOOLS.filter((x) => x.risk === 'high')) {
      expect(!t.undoable || typeof t.undoable === 'function', t.name).toBe(true);
    }
  });

  it('catches a malformed tool', () => {
    expect(registryProblems([{ name: 'bad_write', kind: 'write', description: 'x', params: { type: 'object' } }]))
      .toEqual(expect.arrayContaining(['bad_write: a write tool needs risk low|high', 'bad_write: missing plan()']));
  });

  it('offers a viewer reads only, and an employee (no org-wide rights) no writes', () => {
    const viewer = fakeCtx({ perms: { tasks: { view: true }, clients: { view: true }, expenses: { view: true } } });
    expect(toolsFor(viewer).some((t) => t.kind === 'write')).toBe(false);
    expect(toolsFor(viewer).map((t) => t.name)).toContain('list_tasks');
    const employee = fakeCtx({ perms: {} });
    expect(toolsFor(employee).every((t) => t.kind !== 'write')).toBe(true);
  });

  it('shows the cash tool to anyone who can record either side', () => {
    const inOnly = fakeCtx({ perms: { income_entries: { view: true, create: true } } });
    expect(toolsFor(inOnly).map((t) => t.name)).toContain('create_cash_entry');
    expect(getTool('create_cash_entry').permission.resource).toEqual(['expenses', 'income_entries']);
  });
});

describe('plumbing', () => {
  it('compares Postgres timestamps to the microsecond', () => {
    expect(sameInstant('2026-09-20T10:00:00.000001+00:00', '2026-09-20T10:00:00.000001Z')).toBe(true);
    expect(sameInstant('2026-09-20T10:00:00.000001+00:00', '2026-09-20T10:00:00.000002+00:00')).toBe(false);
  });

  it('keeps only well-formed recent entities, at most ten', () => {
    const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const list = [
      { type: 'task', id: id(1), label: 'A', turn: 'm1' },
      { type: 'task', id: id(1), label: 'dup' },
      { type: 'nonsense', id: id(2) },
      { type: 'client', id: 'not-a-uuid' },
      ...Array.from({ length: 20 }, (_, i) => ({ type: 'client', id: id(10 + i), label: `C${i}` })),
    ];
    const clean = cleanEntities(list);
    expect(clean).toHaveLength(10);
    expect(clean[0]).toEqual({ type: 'task', id: id(1), label: 'A', turn: 'm1' });
  });

  it('turns database refusals into sentences', () => {
    expect(friendlyDbError({ code: '42501', message: 'new row violates row-level security policy' })).toBe('Your role does not allow that change.');
    expect(friendlyDbError({ code: 'P0001', message: 'You cannot approve your own leave.' })).toBe('You cannot approve your own leave.');
    expect(friendlyDbError({ code: 'XX000', message: 'internal: relation foo at line 3' })).toBe('The change could not be saved.');
  });
});

describe('deployability', () => {
  // Vitest resolves modules the way Vite does and would hide an import that
  // plain Node ESM (what Vercel runs) cannot resolve. Load it for real.
  it('api/agent.js loads in plain Node', async () => {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, ['-e', "import('./api/agent.js').then((m) => console.log(typeof m.default))"], { encoding: 'utf8' });
    expect(out.trim()).toBe('function');
  }, 20000);
});
