import { supabase } from '../lib/supabase';

/**
 * The platform console's client. Every call is one POST to /api/admin with an
 * `action`, carrying the Supabase access token — the route verifies the
 * `platform_admin` claim and the allow-listed address before it answers.
 *
 * Nothing here queries Supabase directly. A cross-tenant read from the browser
 * would depend on the platform-admin SELECT policies staying correct forever;
 * routing it through the server keeps one place to audit.
 */

export const PLATFORM_ADMIN_EMAIL = 'nikhil@buddy.com';

async function call(action, args = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not signed in');

  const res = await fetch('/api/admin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, ...args }),
  });

  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON error page */ }

  if (!res.ok || payload?.success === false) {
    throw new Error(payload?.error || `Request failed (${res.status})`);
  }
  return payload;
}

export const adminService = {
  overview: () => call('overview'),
  listOrgs: () => call('list_orgs'),
  orgDetail: (orgId) => call('org_detail', { org_id: orgId }),
  setPlan: (orgId, plan, status, periodEnd) =>
    call('set_plan', { org_id: orgId, plan, status, period_end: periodEnd }),
  deleteOrg: (orgId) => call('delete_org', { org_id: orgId }),
  restoreOrg: (orgId) => call('restore_org', { org_id: orgId }),
  sendEmail: ({ to, subject, body }) => call('send_email', { to, subject, body }),
};

/**
 * Whether the signed-in session may open the console.
 *
 * Both halves matter. `platform_admin` is the authorization — the server checks
 * the same claim and no client assertion can forge it. The address check is so
 * the UI refuses the same account the server would refuse, rather than showing
 * a console whose every request comes back 403.
 */
export function isPlatformAdmin(user) {
  if (!user) return false;
  if (user.app_metadata?.platform_admin !== true) return false;
  return (user.email || '').toLowerCase() === PLATFORM_ADMIN_EMAIL;
}
