import { requireUser, requireOrgRole, HttpError, sendError, readJsonBody } from '../auth.js';
import { bearerToken, userClient } from '../agent/db.js';
import * as bot from './bot.js';
import * as store from './store.js';
import { sendPulse } from './pulse.js';
import { appUrl } from './render.js';

/**
 * The app's side of Telegram — POST /api/telegram { mode, org_id, … } with the
 * signed-in user's bearer token. What Settings → Telegram shows and does.
 *
 *   status            everyone: is it set up, am I linked; admins also get
 *                     the groups and every member's link state
 *   link_token        everyone: a one-time deep link that links MY Telegram
 *                     (15 minutes)
 *   unlink            everyone for themselves; admins for anyone
 *   settings          admin: Telegram on/off, Daily Pulse on/off and hour
 *   invite_token      admin: a one-time deep link for a member (48 hours)
 *   group_token       admin: a one-time "add to group" link (30 minutes),
 *                     usable only by that admin's own linked Telegram
 *   disconnect_group  admin
 *   pulse_now         admin: today's check-in to everyone linked, now
 *
 * The bot token never leaves the server; the browser gets the bot's public
 * username and t.me links only. Tokens are shown once and stored hashed.
 */

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
const BUDDY_ROLES = new Set(['owner', 'admin', 'member', 'viewer']);
const ADMIN_MODES =new Set(['settings', 'invite_token', 'group_token', 'disconnect_group', 'pulse_now']);

async function botUsername() {
  if (!bot.isConfigured()) return null;
  try { return (await bot.getMe()).username || null; } catch (err) {
    console.warn('[telegram] getMe failed:', err?.message);
    return null;
  }
}

const deepLink = (username, param, token) => `https://t.me/${username}?${param}=${token}`;

const linkView = (l) => (l ? {
  telegram_username: l.telegram_username || null,
  telegram_name: l.telegram_name || null,
  linked_at: l.linked_at,
  linked_via: l.linked_via,
  last_seen_at: l.last_seen_at || null,
  pulse_opt_out: !!l.pulse_opt_out,
  has_dm: !!l.dm_chat_id,
} : null);

export async function manage(req, res) {
  try {
    const user = await requireUser(req);
    const body = await readJsonBody(req);
    const orgId = body.org_id;
    if (!isUuid(orgId)) throw new HttpError(400, 'Missing org_id');
    const mode = String(body.mode || '');
    const membership = await requireOrgRole(user.id, orgId, ADMIN_MODES.has(mode) ? 'admin' : 'viewer');
    const admin = membership.role === 'owner' || membership.role === 'admin';

    try {
      await store.orgSettings(orgId);
    } catch (err) {
      if (store.isMissingTable(err)) throw new HttpError(503, 'Telegram is not set up on this database yet (migration 0070).');
      throw err;
    }

    switch (mode) {
      case 'status': return res.status(200).json({ success: true, ...(await status({ user, orgId, admin, token: bearerToken(req) })) });

      case 'settings': {
        const saved = await store.saveOrgSettings(orgId, {
          enabled: body.enabled, pulse_enabled: body.pulse_enabled,
          pulse_hour: body.pulse_hour === undefined ? undefined : Number(body.pulse_hour),
        }, user.id);
        return res.status(200).json({ success: true, settings: { enabled: saved.enabled, pulse_enabled: saved.pulse_enabled, pulse_hour: saved.pulse_hour } });
      }

      case 'link_token':
      case 'invite_token':
      case 'group_token': {
        const username = await botUsername();
        if (!username) throw new HttpError(503, 'The Telegram bot is not configured on the server yet.');
        const settings = await store.orgSettings(orgId);
        if (!settings.enabled) throw new HttpError(409, 'Turn Telegram on for this company first.');
        if (mode === 'group_token') {
          const t = await store.createToken({ orgId, purpose: 'group', createdBy: user.id, ttlMs: store.GROUP_TOKEN_TTL_MS });
          return res.status(200).json({ success: true, url: deepLink(username, 'startgroup', t.token), expires_at: t.expires_at });
        }
        let target = user.id;
        if (mode === 'invite_token') {
          if (!isUuid(body.user_id)) throw new HttpError(400, 'Missing user_id');
          await requireOrgRole(body.user_id, orgId, 'viewer').catch(() => { throw new HttpError(404, 'That person is not a member of this company.'); });
          target = body.user_id;
        }
        const t = await store.createToken({
          orgId, purpose: 'link', userId: target, createdBy: user.id,
          ttlMs: mode === 'invite_token' && target !== user.id ? store.INVITE_TOKEN_TTL_MS : store.LINK_TOKEN_TTL_MS,
        });
        return res.status(200).json({ success: true, url: deepLink(username, 'start', t.token), expires_at: t.expires_at });
      }

      case 'unlink': {
        const target = body.user_id && body.user_id !== user.id ? body.user_id : user.id;
        if (target !== user.id && !admin) throw new HttpError(403, 'Requires admin access');
        const link = (await store.linksForOrg(orgId)).find((l) => l.user_id === target);
        if (link) {
          await store.revokeLink(link.id, target === user.id ? 'self_unlink' : 'admin_unlink');
          await store.clearConversationsFor(link.telegram_user_id, orgId);
        }
        return res.status(200).json({ success: true, unlinked: !!link });
      }

      case 'disconnect_group': {
        if (!isUuid(body.id)) throw new HttpError(400, 'Missing id');
        const gone = await store.disconnectChat({ id: body.id, orgId });
        for (const g of gone) {
          await bot.sendMessage(g.chat_id, 'An admin disconnected this group from StartupBuddy. I won\'t answer here anymore.').catch(() => null);
        }
        return res.status(200).json({ success: true, disconnected: gone.length });
      }

      case 'pulse_now': {
        if (!bot.isConfigured()) throw new HttpError(503, 'The Telegram bot is not configured on the server yet.');
        return res.status(200).json({ success: true, ...(await sendPulse({ orgId, force: true })) });
      }

      default:
        throw new HttpError(400, `Unknown mode: ${mode}`);
    }
  } catch (err) {
    return sendError(res, err, 'api/telegram');
  }
}

async function status({ user, orgId, admin, token }) {
  const [settings, username, links] = await Promise.all([store.orgSettings(orgId), botUsername(), store.linksForOrg(orgId)]);
  const mine = links.find((l) => l.user_id === user.id) || null;
  const out = {
    configured: bot.isConfigured(),
    bot_username: username,
    app_url: !!appUrl(),
    enabled: settings.enabled,
    pulse_enabled: settings.pulse_enabled,
    pulse_hour: settings.pulse_hour,
    admin,
    me: linkView(mine),
  };
  if (!admin) return out;

  const [groups, membersRes] = await Promise.all([
    store.chatsForOrg(orgId),
    userClient(token).rpc('org_members', { p_org: orgId }),
  ]);
  const byUser = new Map(links.map((l) => [l.user_id, l]));
  out.groups = groups.map((g) => ({ id: g.id, title: g.title || 'Untitled group', type: g.chat_type, connected_at: g.connected_at }));
  out.members = (membersRes.data || []).map((m) => ({
    user_id: m.user_id,
    email: m.email || null,
    role: m.role,
    // The web agent's own gate (requireOrgRole 'viewer'): other roles, such as
    // 'employee', are members without Buddy — on the web and on Telegram.
    buddy_access: BUDDY_ROLES.has(m.role),
    you: m.user_id === user.id,
    telegram: linkView(byUser.get(m.user_id)),
  }));
  return out;
}
