import { supabase } from '../lib/supabase';

/**
 * The browser's side of EdgeAI's agent (api/agent.js).
 *
 * `streamAgent` sends one message and reads back a stream of events — words,
 * proposed-change cards, choices, questions, page changes. Nothing it
 * receives has changed any data: a card is only a proposal until
 * `confirmAction` is called from the card's own button.
 */

async function token() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('You are signed out. Sign in again to talk to your cofounder.');
  return session.access_token;
}

async function post(body, { signal } = {}) {
  return fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
    body: JSON.stringify(body),
    signal,
  });
}

async function json(body) {
  const res = await post(body);
  let out = null;
  try { out = await res.json(); } catch { /* fall through */ }
  if (!res.ok || out?.success === false) {
    throw new Error(out?.error || `Request failed (${res.status})`);
  }
  return out;
}

/** Splits an SSE byte stream into { event, data } frames. */
export function sseParser(onFrame) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let at = buffer.indexOf('\n\n');
    while (at !== -1) {
      const raw = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      let event = 'message';
      const data = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) {
        try { onFrame(event, JSON.parse(data.join('\n'))); } catch { /* a torn frame is dropped */ }
      }
      at = buffer.indexOf('\n\n');
    }
  };
}

/**
 * One turn. `onEvent(event, data)` is called for every frame as it arrives;
 * resolves when the server sends `done` or closes the stream.
 */
export async function streamAgent(body, onEvent, { signal } = {}) {
  const res = await post({ mode: 'chat', ...body }, { signal });
  if (!res.ok || !res.body) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* keep the status */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const feed = sseParser(onEvent);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    feed(decoder.decode(value, { stream: true }));
  }
}

export const confirmAction = (orgId, actionId, { selected, edits } = {}) =>
  json({ mode: 'confirm', org_id: orgId, action_id: actionId, selected, edits });

export const cancelAction = (orgId, actionId) => json({ mode: 'cancel', org_id: orgId, action_id: actionId });

export const undoAction = (orgId, actionId) => json({ mode: 'undo', org_id: orgId, action_id: actionId });

/** The latest state of these cards — for a thread reopened after a reload. */
export const actionStatus = (orgId, ids) => json({ mode: 'status', org_id: orgId, ids });

/** A failed action (or a plan's failed steps) proposed again, as a new card. Nothing runs until it is confirmed. */
export const retryAction = (orgId, actionId) => json({ mode: 'retry', org_id: orgId, action_id: actionId });

/** "Buddy noticed": situations found in the company's data. No model call, not metered. */
export const getInsights = (orgId, { skip = [], limit = 5 } = {}) => json({ mode: 'insights', org_id: orgId, skip, limit });

/** What Buddy proposed and did for this person, newest first. */
export const getActivity = (orgId, { limit = 20 } = {}) => json({ mode: 'activity', org_id: orgId, limit });
