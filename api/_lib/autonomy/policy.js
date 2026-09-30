import { supabaseAdmin } from '../supabaseAdmin.js';
import { allowed, deletes, appApprovalOnly, getTool, isWrite, ALL_TOOLS } from '../agent/registry.js';

/**
 * The autonomy policy — which actions Buddy may carry out without a person's
 * tap. Decided HERE, by code, from the tool's own registry metadata and the
 * company's policy row; never by the model, the prompt or the channel.
 *
 * Every write tool has a class (tool.autonomy.class, else derived):
 *
 *   autonomous  routine, reversible, internal operational work. Buddy may do
 *               it on its own — a scheduled job, or right away when the person
 *               asked for exactly this in chat (tool.autonomy.interactive
 *               'auto'). A tool may add a condition (tool.autonomy.when) that
 *               sends one particular call back to approval.
 *   approval    the existing flow: a card a person confirms. Default for every
 *               tool that does not say otherwise, and always for high risk,
 *               money, anything leaving the company (email) and plans.
 *   forbidden   never, on anyone's behalf, autonomously: deletes, anything the
 *               actor's permissions do not allow, unknown tools.
 *
 * The company can switch autonomy off entirely (enabled = false — the
 * database then also refuses the Buddy principal), send any tool back to
 * approval, or widen a LOW-risk, non-deleting, internal, non-finance tool to
 * autonomous. It can never widen money, deletes, email or high-risk tools.
 *
 * decide() is a pure function: same inputs, same answer, recorded on the
 * action (policy_decision) so the audit can show which rule allowed it.
 * Permissions are still enforced afterwards by confirm() → executor → RLS;
 * autonomy only ever removes the human tap, never a permission check.
 */

export const DEFAULT_SETTINGS = Object.freeze({
  deadline_reminders: true,          // remind an assignee before a deadline
  remind_days_before: 1,
  overdue_followups: true,           // follow up with the assignee once it slips
  escalate: true,                    // tell the founder when it stays overdue
  escalate_after_days: 2,
  overdue_window_days: 14,           // older slippage is not chased out of the blue
  reminder_hour: 9,                  // local hour workflow checkpoints run at
  quiet_start: 21,                   // no autonomous messages from 21:00…
  quiet_end: 8,                      // …to 08:00 local; they wait for the morning
  max_messages_per_person_per_day: 4,
  notify_on_complete: true,          // tell whoever asked when it gets done
  approval_ttl_hours: 48,            // how long an approval request Buddy raised stays open
});

const INT_LIMITS = {
  remind_days_before: [0, 7],
  escalate_after_days: [1, 14],
  overdue_window_days: [1, 90],
  reminder_hour: [0, 23],
  quiet_start: [0, 23],
  quiet_end: [0, 23],
  max_messages_per_person_per_day: [1, 20],
  approval_ttl_hours: [1, 168],
};
const BOOLS = ['deadline_reminders', 'overdue_followups', 'escalate', 'notify_on_complete'];
const RULE_VALUES = new Set(['autonomous', 'approval']);
const NEVER_WIDEN_MODULES = new Set(['finance', 'cash', 'payments']);

/** Only known keys, clamped to their ranges. Anything else is dropped. */
export function cleanSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, [lo, hi]] of Object.entries(INT_LIMITS)) {
    const v = raw[k];
    if (Number.isInteger(v) && v >= lo && v <= hi) out[k] = v;
  }
  for (const k of BOOLS) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  return out;
}

/** Only real write tools, only autonomous|approval. */
export function cleanRules(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, v] of Object.entries(raw)) {
    const tool = getTool(name);
    // Deletes have no rule to set: they are never autonomous.
    if (tool && isWrite(tool) && !deletes(tool) && RULE_VALUES.has(v)) out[name] = v;
  }
  return out;
}

/** A policy row (or none) as the engine uses it. */
export function effectivePolicy(row) {
  return {
    orgId: row?.org_id || null,
    enabled: row ? row.enabled !== false : true,
    rules: cleanRules(row?.rules),
    settings: { ...DEFAULT_SETTINGS, ...cleanSettings(row?.settings) },
    version: row?.version || 0,
    source: row ? 'company' : 'default',
    ready: true,
  };
}

/**
 * The company's policy, read with the service role (the row is the company's
 * own governance data; the API writes it only after an owner/admin check).
 * A database without 0072 gets a policy that is not `ready`: the autonomy
 * tools are then not offered and no job runs.
 */
export async function loadPolicy(orgId, { db = supabaseAdmin() } = {}) {
  const { data, error } = await db.from('buddy_autonomy_policies').select('*').eq('org_id', orgId).maybeSingle();
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message || '')) {
      return { ...effectivePolicy(null), orgId, ready: false };
    }
    throw error;
  }
  return { ...effectivePolicy(data), orgId };
}

/** Writes a company's policy. The caller has checked owner/admin. */
export async function savePolicy(orgId, patch, userId, { db = supabaseAdmin() } = {}) {
  const current = await loadPolicy(orgId, { db });
  const row = {
    org_id: orgId,
    enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : current.enabled,
    rules: patch?.rules !== undefined ? cleanRules(patch.rules) : current.rules,
    settings: patch?.settings !== undefined ? { ...cleanSettings(current.settings), ...cleanSettings(patch.settings) } : cleanSettings(current.settings),
    version: (current.version || 0) + 1,
    updated_by: userId,
  };
  const { data, error } = await db.from('buddy_autonomy_policies').upsert(row, { onConflict: 'org_id' }).select().single();
  if (error) throw error;
  return effectivePolicy(data);
}

/** The class a tool has before any company rule. */
export function classOf(tool) {
  if (!tool || !isWrite(tool)) return 'forbidden';
  if (deletes(tool)) return 'forbidden';
  const c = tool.autonomy?.class;
  return c === 'autonomous' ? 'autonomous' : 'approval';
}

/** Whether a company may widen this tool to autonomous. */
export function widenable(tool) {
  return !!tool && isWrite(tool) && tool.risk === 'low' && !deletes(tool) && !appApprovalOnly(tool)
    && !NEVER_WIDEN_MODULES.has(tool.module) && tool.autonomy?.widen !== false;
}

const result = (decision, rule, extra = {}) => ({ decision, rule, ...extra });

/**
 * decide({ tool, args, ctx, policy, trigger }) →
 *   { decision: 'autonomous' | 'approval' | 'forbidden', rule, class, trigger, policy_version, policy_source }
 *
 * trigger 'job'          Buddy acting on a scheduled job / event, nobody there;
 *         'interactive'  the person is in the conversation: only tools built
 *                        for it (autonomy.interactive 'auto') skip the card —
 *                        everything else stays exactly as before.
 */
export function decide({ tool, args = {}, ctx, policy, trigger = 'job' }) {
  const base = { class: classOf(tool), trigger, policy_version: policy?.version ?? 0, policy_source: policy?.source || 'default' };
  if (!tool || !isWrite(tool)) return result('forbidden', 'not_an_action', base);
  if (deletes(tool)) return result('forbidden', 'deletion_restricted', base);
  if (!allowed(tool, ctx)) return result('forbidden', 'permission', base);
  if (!policy || policy.ready === false) return result('approval', 'no_policy', base);
  if (!policy.enabled) return result('approval', 'autonomy_disabled', base);
  if (trigger === 'interactive' && tool.autonomy?.interactive !== 'auto') return result('approval', 'interactive_review', base);

  const rule = policy.rules?.[tool.name];
  if (rule === 'approval') return result('approval', 'company_rule_approval', base);
  if (base.class !== 'autonomous') {
    if (rule === 'autonomous' && widenable(tool)) return result('autonomous', 'company_rule_autonomous', base);
    return result('approval', tool.risk === 'high' ? 'high_risk_requires_approval' : 'tool_requires_approval', base);
  }
  if (typeof tool.autonomy?.when === 'function') {
    const why = tool.autonomy.when(args, ctx, trigger);
    if (why) return result('approval', `condition:${why}`, base);
  }
  return result('autonomous', rule === 'autonomous' ? 'company_rule_autonomous' : 'tool_default_autonomous', base);
}

/** The whole catalogue as the policy sees it — for the settings API and docs. */
export function catalogue(policy) {
  return ALL_TOOLS.filter(isWrite).map((t) => ({
    tool: t.name,
    module: t.module,
    risk: t.risk,
    class: classOf(t),
    company_rule: policy?.rules?.[t.name] || null,
    widenable: classOf(t) === 'approval' && widenable(t),
    conditional: typeof t.autonomy?.when === 'function',
  }));
}
