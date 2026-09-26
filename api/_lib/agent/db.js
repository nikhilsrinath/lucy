import { createClient } from '@supabase/supabase-js';

/**
 * The agent's database access, as the signed-in user.
 *
 * Every read a tool makes and every write an executor makes goes through a
 * client built from the caller's own access token, so PostgREST runs it as
 * `authenticated` with that user's auth.uid(): the same RLS policies, the same
 * app.* guards and the same permission matrix as the screen they would
 * otherwise have used. The agent cannot do anything the person could not do
 * by hand, because the database never learns it was the agent.
 *
 * Except for one header. A confirmed write carries `x-edgeos-agent-action:
 * <ai_actions.id>`, which PostgREST exposes to SQL as request.headers. 0068's
 * audit trigger reads it — and trusts it only if that id is a confirmed action
 * belonging to auth.uid() — to stamp the audit row `via = 'edgeai'`.
 *
 * The service role (supabaseAdmin) is used for the ai_actions log and the AI
 * meter only; see actions.js.
 */

export const AGENT_ACTION_HEADER = 'x-edgeos-agent-action';

function env() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('Server is missing SUPABASE_URL / SUPABASE_ANON_KEY');
  return { url, anon };
}

/** A Supabase client that acts as the user whose token this is. */
export function userClient(token, { actionId = null } = {}) {
  const { url, anon } = env();
  const headers = { Authorization: `Bearer ${token}` };
  if (actionId) headers[AGENT_ACTION_HEADER] = actionId;
  return createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers },
  });
}

/** The bearer token on a request, or ''. */
export function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/**
 * A database refusal, as a sentence for the person who asked.
 *
 * Guard functions (app.*_guard, the leave self-approval check) raise with
 * messages written for people, so those pass through. Everything else maps to
 * what it means for them; nothing reaches the chat as a stack trace, a
 * constraint name or an SQLSTATE.
 */
export function friendlyDbError(err) {
  if (!err) return 'Something went wrong.';
  const code = err.code || '';
  const msg = String(err.message || '');
  if (code === '42501' || /row-level security|permission denied/i.test(msg)) {
    return 'Your role does not allow that change.';
  }
  if (code === 'PGRST301' || /jwt expired/i.test(msg)) return 'Your session has expired. Refresh the page and try again.';
  if (code === '23505') return 'That would create a duplicate of something that already exists.';
  if (code === '23503') return 'Something it points to no longer exists, or is not in this organization.';
  if (code === '23514') return 'One of the values is outside what that field allows.';
  if (code === '22P02' || code === '22007' || code === '22008') return 'One of the values is not in a form the database accepts.';
  if (code === 'P0001' && msg) return msg.replace(/^ERROR:\s*/i, '');
  if (code === 'PGRST116') return 'That record could not be found — it may have been deleted.';
  return 'The change could not be saved.';
}

/** Thrown by executors; `message` is already safe to show. */
export class AgentError extends Error {
  constructor(message, { code = 'failed', detail = null } = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
