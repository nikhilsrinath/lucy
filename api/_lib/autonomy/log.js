/**
 * Structured logs for the autonomous engine: one JSON line per lifecycle
 * event, so a failure is diagnosable from the platform logs alone.
 *
 * Only these fields are ever written — ids, kinds, statuses, timings, error
 * summaries. Never a message body, a token, a secret, a Telegram id or
 * company data: the allowlist is the guarantee, not the callers' care.
 */

const FIELDS = new Set([
  'job_id', 'org_id', 'kind', 'status', 'attempt', 'max_attempts', 'action_id', 'workflow_id', 'tool', 'rule',
  'ms', 'code', 'error', 'worker', 'claimed', 'processed', 'enqueued', 'orgs', 'phase', 'reason', 'run_at', 'count',
]);

export function jlog(event, fields = {}) {
  const out = { src: 'buddy', event, at: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    if (!FIELDS.has(k) || v === undefined) continue;
    out[k] = typeof v === 'string' ? v.slice(0, k === 'error' ? 200 : 120) : v;
  }
  const line = JSON.stringify(out);
  if (/failed|error|refused|denied|lost/.test(event) || fields.status === 'failed') console.warn(line);
  else console.info(line);
}
