import { todayIn, shiftDays, DEFAULT_TZ } from '../../../src/shared/dates.js';

/**
 * Clock arithmetic in the company's own time zone. The clock belongs to the
 * system, never to the model: whether something is due is decided here, from
 * the database's dates and the company's zone.
 */

function parts(tz, date) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || DEFAULT_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out = {};
  for (const p of f.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** Minutes the zone is ahead of UTC at this instant. */
export function offsetMinutes(tz, date = new Date()) {
  try {
    const p = parts(tz, date);
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  } catch {
    return 0;
  }
}

/** The UTC instant of `hh:mm` on `isoDate` in `tz`. */
export function atLocal(isoDate, hour = 9, minute = 0, tz = DEFAULT_TZ) {
  const guess = Date.UTC(+isoDate.slice(0, 4), +isoDate.slice(5, 7) - 1, +isoDate.slice(8, 10), hour, minute);
  // Two passes settle the offset across a DST change.
  let t = guess - offsetMinutes(tz, new Date(guess)) * 60000;
  t = guess - offsetMinutes(tz, new Date(t)) * 60000;
  return new Date(t).toISOString();
}

/** Today's date and the hour, where the company is. */
export function localNow(tz = DEFAULT_TZ, now = new Date()) {
  const p = parts(tz, now);
  return { date: todayIn(tz, now), hour: +p.hour % 24, minute: +p.minute };
}

/**
 * Whether `now` falls in the company's quiet hours (a window that may wrap
 * midnight, e.g. 21 → 8), and when it ends. Buddy sends nothing on its own
 * then; the job waits for the morning.
 */
export function quietUntil(settings, tz, now = new Date()) {
  const start = settings?.quiet_start;
  const end = settings?.quiet_end;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) return null;
  const { date, hour } = localNow(tz, now);
  const inside = start < end ? hour >= start && hour < end : hour >= start || hour < end;
  if (!inside) return null;
  const endDate = start < end || hour < end ? date : shiftDays(date, 1);
  return atLocal(endDate, end, 0, tz);
}

/** Whole days from `a` to `b` (ISO dates). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/**
 * "10", "10am", "10:30", "5 pm", "17:45", "noon" → "HH:MM", or null.
 */
export function readTime(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^noon|midday$/.test(s)) return '12:00';
  if (/^midnight$/.test(s)) return '00:00';
  if (/^morning$/.test(s)) return '09:00';
  if (/^(?:afternoon)$/.test(s)) return '14:00';
  if (/^(?:evening)$/.test(s)) return '18:00';
  const m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = (m[3] || '').replace(/\./g, '');
  if (min > 59 || h > 23) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (ap && Number(m[1]) > 12) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
