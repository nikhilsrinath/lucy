import { timingSafeEqual } from 'node:crypto';

/**
 * Whether a request carries the scheduler's secret: `Authorization: Bearer
 * <CRON_SECRET>`, which Vercel Cron sends automatically (and any other
 * scheduler — e.g. .github/workflows/buddy-worker.yml — must send). Constant
 * time; a missing or short secret refuses everything.
 */
export function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET || '';
  const got = String(req.headers?.authorization || '');
  const want = `Bearer ${secret}`;
  return secret.length >= 16 && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
