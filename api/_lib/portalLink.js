import { supabaseAdmin } from './supabaseAdmin.js';
import { buildToken, assertPortalSecret } from './portalToken.js';

/**
 * Minting a recipient-portal link from server code that has no browser
 * behind it (Buddy sending a letter or a document by email).
 *
 * The same row api/portal-token.js writes for the app: portal_tokens has no
 * INSERT grant for `authenticated`, so the service role mints it — after the
 * document is checked to belong to the company the verified session names.
 * The link's host comes from the server's own configuration, never from a
 * caller.
 */

const DEFAULT_TTL_DAYS = 30;

/** Where the app is served, for links that leave it. Null when the server has not been told. */
export function appOrigin() {
  const allowed = (process.env.PORTAL_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const raw = allowed[0] || process.env.APP_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return raw ? raw.replace(/\/+$/, '') : null;
}

/** Whether this server can mint links at all (the signing secret and an address for them). */
export function canMintLinks() {
  try { assertPortalSecret(); } catch { return false; }
  return !!appOrigin();
}

/**
 * @param {object} p
 * @param {string} p.orgId        the verified company
 * @param {string} p.documentId   a `records` or `financial_documents` row of that company
 * @param {'view'|'sign'} [p.scope]
 * @param {string|null} [p.recipientEmail]
 * @param {string|null} [p.issuedBy] the user the link is minted for
 * @returns {Promise<{ url: string, expiresAt: string }>}
 */
export async function mintPortalLink({ orgId, documentId, scope = 'sign', recipientEmail = null, issuedBy = null, ttlDays = DEFAULT_TTL_DAYS }) {
  assertPortalSecret();
  const origin = appOrigin();
  if (!origin) throw new Error('The app address for links is not configured.');
  if (!orgId || !documentId) throw new Error('Missing document.');
  const admin = supabaseAdmin();

  const { data: record } = await admin.from('records').select('id').eq('id', documentId).eq('org_id', orgId).maybeSingle();
  const { data: findoc } = record ? { data: null }
    : await admin.from('financial_documents').select('id').eq('id', documentId).eq('org_id', orgId).maybeSingle();
  if (!record && !findoc) throw new Error('That document is not in this company.');

  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin.from('portal_tokens').insert({
    org_id: orgId,
    record_id: record?.id || null,
    financial_doc_id: findoc?.id || null,
    scope: scope === 'view' ? 'view' : 'sign',
    recipient_email: recipientEmail || null,
    issued_by: issuedBy,
    expires_at: expiresAt,
  }).select('jti, expires_at').single();
  if (error) throw new Error(error.message);

  const token = buildToken(data.jti, data.expires_at);
  return { url: `${origin}/portal/${documentId}?t=${encodeURIComponent(token)}`, expiresAt: data.expires_at };
}
