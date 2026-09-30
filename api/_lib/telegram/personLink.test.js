import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { fakeDb } from '../agent/testing/fakeDb.js';

/*
 * The two server-side halves of a person link (0071) that never touch the
 * model: the invite token an admin creates (B), and the session a linked
 * person gets — a token with no user, verified against the live link on
 * every request (R, Q).
 */

const mem = vi.hoisted(() => ({ db: null, rpc: null, opened: null }));

vi.mock('../supabaseAdmin.js', () => ({ supabaseAdmin: () => mem.db }));
vi.mock('../agent/db.js', async (importOriginal) => ({
  ...(await importOriginal()),
  userClient: (token) => ({ rpc: async (fn, params) => mem.rpc(token, fn, params) }),
}));
vi.mock('../agent/buddy.js', () => ({ openSession: vi.fn(async (args) => { mem.opened = args; return { ok: true }; }) }));

const store = await import('./store.js');
const { openChannelSession, verifyLinkedPerson, personToken, ChannelAccessError } = await import('../agent/channelSession.js');

const ORG_A = '0a000000-0000-4000-8000-00000000000a';
const ORG_B = '0b000000-0000-4000-8000-00000000000b';
const SWETHA = 'e0000000-0000-4000-8000-000000000001';
const LINK = '1c000000-0000-4000-8000-000000000001';
const SECRET = 'test-jwt-secret-for-person-tokens-0123456789';

const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const env = { ...process.env };

function seed({ revoked = null, exited = null, linkOrg = ORG_A } = {}) {
  mem.db = fakeDb({
    telegram_links: [{ id: LINK, org_id: linkOrg, employee_id: SWETHA, user_id: null, telegram_user_id: 7001, revoked_at: revoked }],
    employees: [{ id: SWETHA, org_id: ORG_A, full_name: 'Swetha NM', role: 'Business Development Lead', email: null, exited_at: exited, access_revoked_at: null }],
    telegram_link_tokens: [],
  });
  // A real user lookup would be a bug for a person link: fail loudly.
  mem.db.auth = { admin: { getUserById: () => { throw new Error('a person link must never look up an auth user'); } } };
}

beforeEach(() => {
  seed();
  mem.opened = null;
  mem.rpc = async () => ({ data: [{ resource: 'tasks', can_view: true, can_create: true, can_edit: true, can_delete: false }], error: null });
});
afterEach(() => { process.env = { ...env }; });

describe('B: the invite an admin creates for one person', () => {
  it('is random, single-purpose, bound to that person and company, and stored only as a hash', async () => {
    const t = await store.createToken({ orgId: ORG_A, purpose: 'person', employeeId: SWETHA, createdBy: 'u-nikhil', ttlMs: store.INVITE_TOKEN_TTL_MS });
    expect(store.isTokenShape(t.token)).toBe(true);
    expect(t.token).not.toContain(ORG_A.slice(0, 8));
    expect(t.token).not.toContain(SWETHA.slice(0, 8));
    const [row] = mem.db.tables.telegram_link_tokens;
    expect(row).toMatchObject({ purpose: 'person', org_id: ORG_A, employee_id: SWETHA, created_by: 'u-nikhil' });
    expect(row.token_hash).toBe(createHash('sha256').update(t.token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(t.token);
    expect(Date.parse(t.expires_at) - Date.now()).toBeGreaterThan(47 * 3600 * 1000);
    const other = await store.createToken({ orgId: ORG_A, purpose: 'person', employeeId: SWETHA, createdBy: 'u-nikhil', ttlMs: 1000 });
    expect(other.token).not.toBe(t.token);
  });
});

describe('R: a linked person\'s session has no StartupBuddy user behind it', () => {
  it('refuses to open without the JWT secret — a configuration error, not an empty session', async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    const { link, person } = await verifyLinkedPerson({ linkId: LINK, orgId: ORG_A });
    await expect(personToken({ link, person })).rejects.toMatchObject({ reason: 'config', ended: false });
  });

  it('signs a short-lived token with no sub and only the link as its claim', async () => {
    process.env.SUPABASE_JWT_SECRET = SECRET;
    const { link, person } = await verifyLinkedPerson({ linkId: LINK, orgId: ORG_A });
    const jwt = await personToken({ link, person });
    const claims = decode(jwt);
    expect(claims.sub).toBeUndefined();
    expect(claims).toMatchObject({ role: 'authenticated', aud: 'authenticated', sb_person: { link: LINK, person: SWETHA, org: ORG_A } });
    expect(claims.exp - claims.iat).toBe(600);
    const [h, b, sig] = jwt.split('.');
    expect(createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')).toBe(sig);
  });

  it('opens the same Buddy session as a user would, as the person, recording the Telegram account', async () => {
    process.env.SUPABASE_JWT_SECRET = SECRET;
    await openChannelSession({ link: { id: LINK, employee_id: SWETHA, user_id: null }, orgId: ORG_A, channel: 'telegram', body: { audience: 'private' }, channelActor: 'telegram:7001' });
    expect(mem.opened).toMatchObject({ person: { id: SWETHA, full_name: 'Swetha NM' }, linkId: LINK, orgId: ORG_A, channel: 'telegram', channelActor: 'telegram:7001' });
    expect(mem.opened.user).toBeUndefined();
    expect(decode(mem.opened.token).sb_person.person).toBe(SWETHA);
  });
});

describe('Q, P: the link is re-read on every request', () => {
  it('Q: a revoked link opens nothing', async () => {
    seed({ revoked: '2026-09-30T10:00:00Z' });
    await expect(verifyLinkedPerson({ linkId: LINK, orgId: ORG_A })).rejects.toBeInstanceOf(ChannelAccessError);
    await expect(verifyLinkedPerson({ linkId: LINK, orgId: ORG_A })).rejects.toMatchObject({ reason: 'unlinked', ended: true });
  });

  it('a person who left opens nothing', async () => {
    seed({ exited: '2026-09-29' });
    await expect(verifyLinkedPerson({ linkId: LINK, orgId: ORG_A })).rejects.toMatchObject({ reason: 'left', ended: true });
  });

  it('P: a Company A link cannot open a Company B session', async () => {
    await expect(verifyLinkedPerson({ linkId: LINK, orgId: ORG_B })).rejects.toMatchObject({ reason: 'unlinked' });
  });
});
