import { supabaseAdmin } from '../supabaseAdmin.js';
import * as jobs from './jobs.js';

/**
 * public.buddy_workflows (0072) — follow-through that outlives a request.
 *
 * "Make sure Swetha follows up with the sponsor tomorrow" becomes a task
 * (written by whoever asked, with their own permissions) and one workflow row
 * that remembers: which task, who is responsible, who asked, the thresholds,
 * and what Buddy already said and when. Each checkpoint is a buddy_jobs row
 * (workflow_check_due) with a deterministic key — wf:<id>:<phase>:<deadline>:<gen>
 * — so a checkpoint happens once however often the worker wakes, and a moved
 * deadline naturally gets fresh checkpoints. The state machine that reads
 * the task and decides the next step is handlers.js (workflowCheck).
 *
 * Written with the service role, always scoped to the company it was created
 * in; the business data it looks at is read through the Buddy principal.
 */

const db = () => supabaseAdmin();
const LIVE = ['active', 'escalated'];

/** Starts (or restarts) following a task through. Returns { workflowId, jobIds, restarted }. */
export async function startFollowup({ orgId, taskId, assigneeId, initiator, goal = null, settings = {}, sourceActionId = null }, { client = db() } = {}) {
  const init = {
    initiator_kind: initiator?.kind || 'buddy',
    initiator_user_id: initiator?.kind === 'user' ? initiator.userId : null,
    initiator_employee_id: initiator?.kind === 'person' ? initiator.employeeId : initiator?.employeeId || null,
  };
  const { data: live, error: e1 } = await client.from('buddy_workflows').select('*')
    .eq('org_id', orgId).eq('kind', 'task_followup').eq('task_id', taskId).in('status', LIVE).maybeSingle();
  if (e1) throw new jobs.TransientError(`workflow lookup failed: ${e1.message}`, 'db');

  let wf;
  if (live) {
    // Asked again: the same follow-through, restarted with the new details.
    await jobs.cancel({ orgId, workflowId: live.id, reason: 'restarted' }, { client });
    const generation = (Number(live.state?.generation) || 0) + 1;
    const { data, error } = await client.from('buddy_workflows').update({
      ...init, assignee_employee_id: assigneeId, goal, policy: settings, status: 'active',
      state: { generation }, next_check_at: new Date().toISOString(), source_action_id: sourceActionId,
    }).eq('id', live.id).eq('org_id', orgId).select().single();
    if (error) throw new jobs.TransientError(`workflow restart failed: ${error.message}`, 'db');
    wf = data;
  } else {
    const { data, error } = await client.from('buddy_workflows').insert({
      org_id: orgId, kind: 'task_followup', status: 'active', task_id: taskId, assignee_employee_id: assigneeId,
      ...init, goal, policy: settings, state: { generation: 0 }, next_check_at: new Date().toISOString(), source_action_id: sourceActionId,
    }).select().single();
    if (error) throw new jobs.TransientError(`workflow create failed: ${error.message}`, 'db');
    wf = data;
  }
  const kickoff = await scheduleCheck(wf, { phase: 'kickoff', runAt: new Date(), deadline: 'start' }, { client });
  return { workflowId: wf.id, jobIds: kickoff.id ? [kickoff.id] : [], restarted: !!live };
}

/** The next checkpoint, idempotent on its key. */
export async function scheduleCheck(wf, { phase, runAt, deadline }, { client = db() } = {}) {
  const gen = Number(wf.state?.generation) || 0;
  const key = `wf:${wf.id}:${phase}:${deadline || 'none'}:${gen}`;
  const job = await jobs.enqueue({
    orgId: wf.org_id, kind: 'workflow_check_due', dedupeKey: key, runAt,
    workflowId: wf.id, payload: { workflow_id: wf.id, phase }, source: 'workflow',
  }, { client });
  const state = { ...(wf.state || {}), next: { phase, key, run_at: new Date(runAt).toISOString() } };
  await client.from('buddy_workflows').update({ next_check_at: new Date(runAt).toISOString(), state })
    .eq('id', wf.id).eq('org_id', wf.org_id);
  wf.state = state;
  return job;
}

export async function loadWorkflow(orgId, id, { client = db() } = {}) {
  const { data, error } = await client.from('buddy_workflows').select('*').eq('id', id).eq('org_id', orgId).maybeSingle();
  if (error) throw new jobs.TransientError(`workflow read failed: ${error.message}`, 'db');
  return data || null;
}

export async function saveWorkflow(wf, patch, { client = db() } = {}) {
  const { data, error } = await client.from('buddy_workflows').update(patch).eq('id', wf.id).eq('org_id', wf.org_id).select().maybeSingle();
  if (error) throw new jobs.TransientError(`workflow save failed: ${error.message}`, 'db');
  Object.assign(wf, data || patch);
  return wf;
}

/** Live workflows of a company, optionally for one task. */
export async function liveWorkflows(orgId, { taskId = null, client = db() } = {}) {
  let q = client.from('buddy_workflows').select('*').eq('org_id', orgId).in('status', LIVE);
  if (taskId) q = q.eq('task_id', taskId);
  const { data, error } = await q;
  if (error) throw new jobs.TransientError(`workflow list failed: ${error.message}`, 'db');
  return data || [];
}

/** Stops following through: the workflow and its pending checkpoints. */
export async function cancelWorkflow({ orgId, workflowId, reason = 'cancelled' }, { client = db() } = {}) {
  const { data, error } = await client.from('buddy_workflows')
    .update({ status: 'cancelled', completed_at: new Date().toISOString(), next_check_at: null })
    .eq('id', workflowId).eq('org_id', orgId).in('status', LIVE).select().maybeSingle();
  if (error) throw new jobs.TransientError(`workflow cancel failed: ${error.message}`, 'db');
  const cancelled = await jobs.cancel({ orgId, workflowId, reason }, { client });
  return { workflow: data || null, jobs: cancelled };
}

/**
 * Whether whoever asked for this still may: a user still a member, a person
 * still in the company. A follow-through never outlives the access of the
 * person it was for.
 */
export async function initiatorActive(wf, { client = db() } = {}) {
  if (wf.initiator_kind === 'user') {
    if (!wf.initiator_user_id) return false;
    const { data } = await client.from('memberships').select('id').eq('org_id', wf.org_id).eq('user_id', wf.initiator_user_id).maybeSingle();
    return !!data;
  }
  if (wf.initiator_kind === 'person') {
    if (!wf.initiator_employee_id) return false;
    const { data } = await client.from('employees').select('id, exited_at, access_revoked_at')
      .eq('id', wf.initiator_employee_id).eq('org_id', wf.org_id).maybeSingle();
    return !!data && !data.exited_at && !data.access_revoked_at;
  }
  return true;
}
