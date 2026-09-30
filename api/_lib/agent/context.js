import { requireOrgRole, HttpError } from '../auth.js';
import { userClient } from './db.js';
import { KINDS, isUuid } from './resolvers.js';
import { todayIn, DEFAULT_TZ } from '../../../src/shared/dates.js';
import { PLANS, DEFAULT_PLAN } from '../../../src/services/planConfig.js';
import { cleanPersona } from './personas.js';

/**
 * Everything a tool may know about who is asking, built fresh per request.
 *
 * The permission map comes from public.my_permissions — the role plus the
 * person's own exceptions (0062), the same function the app's sidebar reads —
 * called with the user's token, so it is theirs by construction. Tools are
 * filtered on it before the model sees the catalogue, and every write is
 * refused by RLS anyway if the map were ever wrong: the filter is for honesty
 * ("I can't do that"), the database is for safety.
 */

const ACTIONS = ['view', 'create', 'edit', 'delete'];

export async function buildAgentContext({ user, token, orgId, body = {}, actionId = null }) {
  if (!orgId) throw new HttpError(400, 'Missing org_id');
  const membership = await requireOrgRole(user.id, orgId, 'viewer');
  const db = userClient(token);

  const [permsRes, planRes, orgRes, meRes] = await Promise.all([
    db.rpc('my_permissions', { p_org: orgId }),
    db.from('subscriptions').select('plan').eq('org_id', orgId).maybeSingle(),
    db.from('organizations').select('*').eq('id', orgId).maybeSingle(),
    db.from('employees').select('id, full_name').eq('org_id', orgId).eq('user_id', user.id).maybeSingle(),
  ]);

  let permRows = permsRes.data;
  if (permsRes.error) {
    // A database without 0062: the role's matrix alone.
    const fb = await db.from('role_permissions').select('resource, can_view, can_create, can_edit, can_delete')
      .eq('org_id', orgId).eq('role', membership.role);
    permRows = fb.data || [];
  }
  const perms = {};
  for (const r of permRows || []) {
    perms[r.resource] = { view: !!r.can_view, create: !!r.can_create, edit: !!r.can_edit, delete: !!r.can_delete };
  }

  const plan = PLANS[planRes.data?.plan] ? planRes.data.plan : DEFAULT_PLAN;
  const org = orgRes.data || {};
  const tz = org.timezone || org.time_zone || DEFAULT_TZ;

  const ctx = {
    user: { id: user.id, email: user.email || null, name: meRes.data?.full_name || user.user_metadata?.full_name || user.email || 'you' },
    orgId,
    orgName: org.company_name || org.name || 'your company',
    org,
    role: membership.role,
    perms,
    plan,
    tz,
    today: todayIn(tz),
    now: new Date().toISOString(),
    employeeId: meRes.data?.id || null,
    token,
    db,
    /** A client whose writes the audit trigger attributes to EdgeAI (0068). */
    dbFor: (id) => userClient(token, { actionId: id }),
    actionId,
    page: cleanPage(body.context?.page),
    recentEntities: cleanEntities(body.context?.recentEntities),
    // What is on the table in this chat: the question EdgeAI last asked, and
    // the cards still waiting. The model reads the next message against them.
    pending: cleanPending(body.pending),
    openCards: cleanCards(body.context?.openCards),
    voice: body.voice === true,
    // Which surface asked (chat, voice, insight, api — later telegram, email).
    // Recorded on every action; it changes nothing about what is allowed.
    channel: cleanChannel(body.channel, body.voice === true),
    // What prompted this message, e.g. a tapped "Buddy noticed" card.
    source: typeof body.context?.source === 'string' && /^insight:[\w:.-]{1,150}$/.test(body.context.source) ? body.context.source : null,
    // What Buddy has already done or tried in this chat, for "undo that",
    // "send the same reminder again", "did it work?".
    recentActions: cleanActions(body.context?.recentActions),
    // The chosen cofounder's voice for the prompt — tone only (personas.js).
    persona: cleanPersona(body.context?.persona),
    cache: new Map(),
  };

  /** Any of `resource` (a key or a list of aliases) grants `action`. */
  ctx.can = (resource, action) => {
    if (!ACTIONS.includes(action)) return false;
    const keys = Array.isArray(resource) ? resource : [resource];
    return keys.some((k) => perms[k]?.[action] === true);
  };
  ctx.allowed = new Set(Object.entries(perms).filter(([, p]) => p.view).map(([k]) => k));
  ctx.hasPlanFeature = (feature) => {
    const cfg = PLANS[plan];
    return cfg?.features?.[feature] === true || cfg?.limits?.[feature] === true;
  };
  ctx.aiLimit = PLANS[plan]?.limits?.aiMessages ?? PLANS[DEFAULT_PLAN].limits.aiMessages;
  return ctx;
}

/** The page the person is on, as the client reported it. Only shapes, never trusted as access. */
function cleanPage(page) {
  if (!page || typeof page !== 'object') return null;
  const route = typeof page.route === 'string' ? page.route.slice(0, 200) : null;
  const recordType = KINDS[page.recordType] ? page.recordType : null;
  const recordId = isUuid(page.recordId) ? page.recordId : null;
  return { route, recordType: recordId ? recordType : null, recordId: recordType ? recordId : null };
}

const CHANNELS = new Set(['chat', 'voice', 'insight', 'api']);
function cleanChannel(c, voice) {
  if (typeof c === 'string' && CHANNELS.has(c)) return c;
  return voice ? 'voice' : 'chat';
}

function cleanActions(list) {
  if (!Array.isArray(list)) return [];
  const STATUSES = ['executed', 'failed', 'undone', 'cancelled', 'expired', 'proposed'];
  return list
    .filter((a) => a && isUuid(a.action_id) && STATUSES.includes(a.status))
    .slice(-6)
    .map((a) => ({
      action_id: a.action_id,
      tool: String(a.tool || '').slice(0, 64),
      title: String(a.title || '').slice(0, 120),
      status: a.status,
      summary: String(a.summary || a.error || '').slice(0, 200),
    }));
}

function cleanPending(p) {
  if (!p || typeof p !== 'object' || typeof p.tool !== 'string') return null;
  return {
    tool: p.tool.slice(0, 64),
    param: typeof p.param === 'string' ? p.param.slice(0, 64) : null,
    question: typeof p.question === 'string' ? p.question.slice(0, 300) : null,
    args: p.args && typeof p.args === 'object' ? p.args : {},
  };
}

function cleanCards(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && isUuid(c.action_id))
    .slice(0, 5)
    .map((c) => ({ action_id: c.action_id, title: String(c.title || '').slice(0, 120), risk: c.risk === 'high' ? 'high' : 'low' }));
}

/**
 * The entities this chat has referred to, newest first. Ids are only pointers
 * — a tool still loads the row through the user's client, so an id for a
 * record they cannot see resolves to nothing.
 */
export function cleanEntities(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || !KINDS[e.type] || !isUuid(e.id)) continue;
    if (out.some((x) => x.id === e.id)) continue;
    out.push({
      type: e.type,
      id: e.id,
      label: String(e.label || '').slice(0, 120),
      turn: typeof e.turn === 'string' ? e.turn.slice(0, 64) : null,
    });
    if (out.length >= 10) break;
  }
  return out;
}
