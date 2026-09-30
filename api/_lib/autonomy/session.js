import * as buddy from '../agent/buddy.js';
import {
  verifyPerson, userToken, verifyLinkedPerson, personToken, openBuddySession, ChannelAccessError,
} from '../agent/channelSession.js';
import * as store from '../telegram/store.js';
import { PermanentError, TransientError } from './jobs.js';

/**
 * The session a job acts in — always a real identity of the job's company,
 * re-verified at the moment it runs, never an anonymous global admin:
 *
 *   actor 'user'    a StartupBuddy user who asked (their membership and
 *                   login re-checked; their own token, their permissions)
 *   actor 'person'  a linked company person who asked (their live link and
 *                   employment re-checked; the person principal)
 *   actor 'buddy'   no human asked for this run (a deadline sweep, a
 *                   follow-through checkpoint): the company's Buddy principal
 *
 * Every session carries the company's autonomy policy and the job, so
 * pipeline.propose() decides on this job's behalf what may happen without a
 * tap. RLS, the permission matrix and every guard apply as for anyone.
 */

function ended(err) {
  if (err instanceof ChannelAccessError) {
    if (err.reason === 'config') return new TransientError('Buddy cannot open a session: SUPABASE_JWT_SECRET is missing or not accepted.', 'config');
    return new PermanentError(`the job's actor can no longer act here (${err.reason})`, 'actor_access_ended');
  }
  if (err?.status === 503) return new TransientError(err.message, 'config');
  if (err?.status === 403 || err?.status === 401) return new PermanentError(`the job's actor can no longer act here (${err.message})`, 'actor_access_ended');
  return err;
}

export async function sessionFor(job, { as = null, policy } = {}) {
  const actor = as || { kind: job.actor_kind || 'buddy', userId: job.actor_user_id || null, employeeId: job.actor_employee_id || null };
  const orgId = job.org_id;
  const autonomy = { trigger: 'job', policy, job };
  try {
    if (actor.kind === 'buddy') {
      const ctx = await openBuddySession({ orgId });
      ctx.autonomy = { ...autonomy, ready: true };
      return ctx;
    }
    if (actor.kind === 'user') {
      const { user } = await verifyPerson({ userId: actor.userId, orgId });
      const token = await userToken(user);
      return await buddy.openSession({ user, token, orgId, channel: 'autonomous', channelActor: 'buddy:job', autonomy });
    }
    if (actor.kind === 'person') {
      const link = await store.personLinkFor(orgId, actor.employeeId);
      if (!link) throw new ChannelAccessError('unlinked');
      const { link: live, person } = await verifyLinkedPerson({ linkId: link.id, orgId });
      const token = await personToken({ link: live, person });
      return await buddy.openSession({ person, linkId: live.id, token, orgId, channel: 'autonomous', channelActor: 'buddy:job', autonomy });
    }
  } catch (err) {
    throw ended(err);
  }
  throw new PermanentError(`unknown actor kind ${actor.kind}`, 'invalid');
}
