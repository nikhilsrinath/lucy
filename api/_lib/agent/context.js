import { requireOrgRole, HttpError } from '../auth.js';
import { supabaseAdmin } from '../supabaseAdmin.js';
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

/**
 * Where the reply will be read. 'private' is the person alone (the web app, a
 * call, a Telegram DM). 'shared' is a space other people read too — a team's
 * Telegram group, later a Slack channel — so Buddy there sees only what is
 * fine for the whole room: the permission map is narrowed to these resources
 * before any tool is offered, and tools marked `privateOnly` are withheld.
 * Narrowing only ever removes access; RLS still decides the rest.
 */
export const SHARED_RESOURCES = new Set([
  'tasks', 'projects', 'project_milestones', 'project_members', 'employees', 'announcements',
]);

/**
 * The role a company person acting through a linked channel identity holds
 * for Buddy (0071, app.person_permission): the admin role's operational
 * rights, never delete, never governance. Not a membership role.
 */
export const PERSON_ROLE = 'teammate';

/**
 * The role of the company's Buddy principal (0072, app.buddy_permission):
 * Buddy acting on its own for a scheduled job with no human actor — view
 * tasks, people and projects, create and edit tasks and notifications, as far
 * as the company's admin role allows. Never delete. Not a membership role.
 */
export const BUDDY_ROLE = 'buddy';

export async function buildAgentContext({ user = null, person = null, buddy = false, linkId = null, token, orgId, body = {}, actionId = null, channelActor = null }) {
  if (!orgId) throw new HttpError(400, 'Missing org_id');
  if (!user && !person && !buddy) throw new HttpError(401, 'No verified identity');
  // A user's membership is checked here; a person's link was verified by the
  // channel (channelSession.verifyLinkedPerson) and is re-checked by the
  // database on every query their token makes. The Buddy principal is checked
  // by the database on every query too (app.buddy_principal: this company,
  // autonomy switched on).
  const membership = buddy ? { role: BUDDY_ROLE } : person ? { role: PERSON_ROLE } : await requireOrgRole(user.id, orgId, 'viewer');
  const db = userClient(token);
  // Buddy is not a member: the company's name, zone and plan are metadata it
  // needs to word a reminder, read with the service role. Everything else it
  // reads goes through its own token.
  const meta = buddy ? supabaseAdmin() : db;

  const [permsRes, planRes, orgRes, meRes] = await Promise.all([
    db.rpc('my_permissions', { p_org: orgId }),
    meta.from('subscriptions').select('plan').eq('org_id', orgId).maybeSingle(),
    meta.from('organizations').select('*').eq('id', orgId).maybeSingle(),
    buddy
      ? Promise.resolve({ data: null })
      : person
        ? Promise.resolve({ data: { id: person.id, full_name: person.full_name } })
        : db.from('employees').select('id, full_name').eq('org_id', orgId).eq('user_id', user.id).maybeSingle(),
  ]);

  let permRows = permsRes.data;
  if (buddy && (permsRes.error || !permRows?.length)) {
    throw new HttpError(503, 'Buddy cannot act on its own here: the database refused its session (is 0072 applied, autonomy on, and SUPABASE_JWT_SECRET accepted?).');
  }
  if (permsRes.error) {
    if (person) throw new HttpError(503, 'Buddy is not available for linked people on this database yet (migration 0071).');
    // A database without 0062: the role's matrix alone.
    const fb = await db.from('role_permissions').select('resource, can_view, can_create, can_edit, can_delete')
      .eq('org_id', orgId).eq('role', membership.role);
    permRows = fb.data || [];
  }
  const audience = body.audience === 'shared' ? 'shared' : 'private';
  const perms = {};
  for (const r of permRows || []) {
    if (audience === 'shared' && !SHARED_RESOURCES.has(r.resource)) continue;
    // A person never deletes: the database says so too (app.person_permission).
    perms[r.resource] = { view: !!r.can_view, create: !!r.can_create, edit: !!r.can_edit, delete: !person && !buddy && !!r.can_delete };
  }

  const plan = PLANS[planRes.data?.plan] ? planRes.data.plan : DEFAULT_PLAN;
  const org = orgRes.data || {};
  const tz = org.timezone || org.time_zone || DEFAULT_TZ;

  const ctx = {
    user: buddy
      ? { id: null, email: null, name: 'Buddy' }
      : person
        ? { id: null, email: person.email || null, name: person.full_name || 'you' }
        : { id: user.id, email: user.email || null, name: meRes.data?.full_name || user.user_metadata?.full_name || user.email || 'you' },
    // Who is acting, as resolved server-side before Buddy runs. Everything
    // that owns or attributes an action reads this, never the model.
    actor: buddy
      ? { kind: 'buddy', channelActor: 'buddy:system' }
      : person
        ? { kind: 'person', employeeId: person.id, linkId, title: person.role || null, via: 'telegram_link', channelActor: cleanActor(channelActor) }
        : { kind: 'user', userId: user.id, channelActor: cleanActor(channelActor) },
    // Deleting is for users whose role allows it; a linked person never
    // does, and neither does Buddy acting on its own.
    canDelete: !person && !buddy,
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
    // Which surface asked (chat, voice, insight, api, telegram, autonomous —
    // Buddy's own scheduled work — later email).
    // Recorded on every action; it changes nothing about what is allowed.
    channel: cleanChannel(body.channel, body.voice === true),
    // private | shared — see SHARED_RESOURCES. Only ever narrows.
    audience,
    // What prompted this message: a tapped "Buddy noticed" card, or a reply
    // to a Daily Pulse check-in (pulse.js).
    source: typeof body.context?.source === 'string' && /^(?:insight|pulse):[\w:.-]{1,150}$/.test(body.context.source) ? body.context.source : null,
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

/** "telegram:123456" — which channel account asked. Never a message body. */
function cleanActor(a) {
  return typeof a === 'string' && /^[a-z]{2,16}:[\w.-]{1,64}$/.test(a) ? a : null;
}

const CHANNELS = new Set(['chat', 'voice', 'insight', 'api', 'telegram', 'autonomous']);
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
