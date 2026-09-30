import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabaseAdmin.js';
import { requireOrgRole, HttpError } from '../auth.js';
import * as buddy from './buddy.js';
import { userClient } from './db.js';

/**
 * A Buddy session for a person who reached us through a channel with no
 * browser session — Telegram today, email or another messenger later.
 *
 * The web app hands Buddy the person's own Supabase access token, and every
 * read and write runs under it (db.js): RLS, the permission matrix and every
 * app.* guard apply because the database sees that person. A channel adapter
 * has only a verified channel identity (a linked Telegram account), so this
 * module is the bridge:
 *
 *   1. verifyPerson — StartupBuddy is the source of truth, checked on EVERY
 *      request, never cached: the auth account exists and is not banned, the
 *      memberships row for this company still exists (an exit deletes it),
 *      and the employee record's login has not been revoked. A link without
 *      all three opens nothing.
 *   2. userToken — a short-lived access token for exactly that user, so the
 *      session is indistinguishable from the one they would have in the app.
 *      Signed with the project's JWT secret when SUPABASE_JWT_SECRET is set
 *      (preferred: no side effects), otherwise obtained from Supabase Auth
 *      through a server-side magic-link exchange (no email is sent).
 *   3. buddy.openSession — the same context, permissions and tools as the web.
 *
 * Nothing here widens access: the token carries the person's own identity
 * and nothing else, and the channel only chooses who it is after the adapter
 * proved it.
 */

export const COFOUNDER_KEY = 'startupbuddy_cofounder';
const TOKEN_TTL_S = 10 * 60;

/** Why a channel identity may not act (shown to the person in plain words by the adapter). */
export class ChannelAccessError extends Error {
  constructor(reason, { role = null } = {}) {
    super(`channel access refused: ${reason}`);
    this.reason = reason; // 'account' | 'banned' | 'membership' | 'revoked' | 'role'
    this.role = role;
    // 'role' is the one refusal that is not the end of access: the person is
    // still a member, their role just does not include Buddy. Links stay.
    this.ended = reason !== 'role';
  }
}

export async function verifyPerson({ userId, orgId }) {
  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.admin.getUserById(userId);
  const user = data?.user;
  if (error || !user || user.deleted_at) throw new ChannelAccessError('account');
  if (user.banned_until && Date.parse(user.banned_until) > Date.now()) throw new ChannelAccessError('banned');

  // The same gate the web agent applies (buildAgentContext → requireOrgRole).
  // No membership row = access ended; a row whose role that gate does not
  // admit (e.g. 'employee') = still a member, just not a Buddy user.
  let membership;
  try {
    membership = await requireOrgRole(userId, orgId, 'viewer');
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 403) throw err;
    const { data: row } = await admin.from('memberships').select('role').eq('org_id', orgId).eq('user_id', userId).maybeSingle();
    throw new ChannelAccessError(row ? 'role' : 'membership', { role: row?.role || null });
  }

  // A login an admin revoked on the employee record. Tolerant of databases
  // without the column (0029): no record, or no column, is not a refusal.
  const emp = await admin.from('employees').select('id, exited_at, access_revoked_at')
    .eq('org_id', orgId).eq('user_id', userId).maybeSingle();
  if (!emp.error && emp.data && (emp.data.exited_at || emp.data.access_revoked_at)) {
    throw new ChannelAccessError('revoked');
  }
  return { user, membership };
}

/* ── tokens ───────────────────────────────────────────────────────────────── */

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function signJwt(user, secret) {
  const now = Math.floor(Date.now() / 1000);
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: url ? `${url.replace(/\/$/, '')}/auth/v1` : 'supabase',
    aud: 'authenticated',
    role: 'authenticated',
    sub: user.id,
    email: user.email || '',
    phone: user.phone || '',
    app_metadata: user.app_metadata || {},
    user_metadata: user.user_metadata || {},
    is_anonymous: false,
    aal: 'aal1',
    iat: now,
    exp: now + TOKEN_TTL_S,
  };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`;
}

// Magic-link sessions, reused within a warm instance until close to expiry.
const exchanged = new Map();

async function exchangeToken(user) {
  const hit = exchanged.get(user.id);
  if (hit && hit.exp - 60_000 > Date.now()) return hit.token;
  if (!user.email) throw new Error('Set SUPABASE_JWT_SECRET: this account has no email for a server-side session.');
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const { data, error } = await supabaseAdmin().auth.admin.generateLink({ type: 'magiclink', email: user.email });
  const hashed = data?.properties?.hashed_token;
  if (error || !hashed) throw new Error(`Could not open a session: ${error?.message || 'no token'}`);
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data: s, error: e2 } = await client.auth.verifyOtp({ token_hash: hashed, type: 'magiclink' });
  if (e2 || !s?.session?.access_token) throw new Error(`Could not open a session: ${e2?.message || 'no session'}`);
  exchanged.set(user.id, { token: s.session.access_token, exp: (s.session.expires_at || 0) * 1000 });
  return s.session.access_token;
}

/*
 * Whether this project accepts tokens signed with SUPABASE_JWT_SECRET.
 * Projects moved to asymmetric signing keys may not; a rejected token would
 * make every read quietly come back empty, so the first one per instance is
 * probed and, if PostgREST refuses it, the magic-link exchange is used.
 */
let signedAccepted = null;

async function accepted(token) {
  const { error } = await userClient(token).from('memberships').select('id', { head: true, count: 'exact' }).limit(1);
  return !(error && (error.code === 'PGRST301' || error.code === 'PGRST302' || /jwt|jws|signature/i.test(error.message || '')));
}

/** A short-lived access token acting as exactly this user. */
export async function userToken(user) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (secret && signedAccepted !== false) {
    const token = signJwt(user, secret);
    if (signedAccepted === null) {
      signedAccepted = await accepted(token);
      if (!signedAccepted) console.warn('[channel] SUPABASE_JWT_SECRET is not accepted by this project; using magic-link sessions instead.');
    }
    if (signedAccepted) return token;
  }
  return exchangeToken(user);
}

/* ── the session ──────────────────────────────────────────────────────────── */

/**
 * Verifies the person and opens a Buddy session for them. `body` has the same
 * shape the web client sends to /api/agent (context, pending, audience…);
 * their chosen cofounder persona is filled in from their profile, as the app
 * does, when the adapter did not pass one.
 */
export async function openChannelSession({ userId, orgId, channel, body = {} }) {
  const { user } = await verifyPerson({ userId, orgId });
  const token = await userToken(user);
  const persona = body.context?.persona || user.user_metadata?.[COFOUNDER_KEY] || undefined;
  const ctx = await buddy.openSession({
    user, token, orgId, channel,
    body: { ...body, context: { ...(body.context || {}), persona } },
  });
  return ctx;
}
