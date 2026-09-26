// dates.js — calendar dates as people say them, resolved against a known today.
//
// Shared by the browser and the serverless functions (src/shared/ is the one
// directory both may import, and it imports nothing outside itself — see
// sharedBoundary.test.js). The agent runs in UTC on Vercel while the company
// runs on Asia/Kolkata time, so "today" is never read off the machine clock
// here: every function takes it as an argument, and todayIn() computes it for
// a named timezone.
//
// All arithmetic is on UTC midnights, so no local offset or DST shift can
// move a date by one.

export const DEFAULT_TZ = 'Asia/Kolkata';

const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD for a Date, read in UTC (every Date here is a UTC midnight). */
const isoUtc = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

const at = (isoDate) => {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

/** Is this a real calendar date written as YYYY-MM-DD? (2026-02-30 is not.) */
export function isIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  return isoUtc(at(s)) === s;
}

/** Today in the browser's own timezone. The default for browser callers only. */
export function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Today's date in a named IANA timezone, e.g. the org's Asia/Kolkata. */
export function todayIn(tz = DEFAULT_TZ, now = new Date()) {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  }
}

/** A date `days` away from `isoDate`. */
export function shiftDays(isoDate, days) {
  const d = at(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return isoUtc(d);
}

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (isoDate) => at(isoDate).getUTCDay();

/** Last day of the month `isoDate` falls in. */
export function endOfMonth(isoDate) {
  const d = at(isoDate);
  return isoUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2 Oct 2026" — the absolute form every confirmation card shows. */
export function formatDate(isoDate) {
  if (!isIsoDate(isoDate)) return isoDate ? String(isoDate) : '—';
  const d = at(isoDate);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "25 Sep" when the year is the one in `today`, "25 Sep 2025" otherwise. */
export function formatDateShort(isoDate, today) {
  if (!isIsoDate(isoDate)) return isoDate ? String(isoDate) : '—';
  const d = at(isoDate);
  const sameYear = today && isIsoDate(today) && at(today).getUTCFullYear() === d.getUTCFullYear();
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}${sameYear ? '' : ` ${d.getUTCFullYear()}`}`;
}

/* ── parsing ──────────────────────────────────────────────────────────────── */

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH_RE = 'jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec';

const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const WEEKDAY_RE = '(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?';

// How far a year-less date may sit on the "wrong" side of today before it is
// read as belonging to the neighbouring year. A few weeks of slack, because
// "5 Oct" typed in late September for a payment is somebody writing it down
// early, not a payment from eleven months ago — and "20 Sep" typed on the 26th
// as a deadline is a deadline already missed, not one next September.
const YEAR_SLACK_DAYS = 45;

function build(year, month, day) {
  const d = new Date(Date.UTC(year, month, day));
  // Date.UTC rolls 31 Feb over into March; a date that rolled was never real.
  if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return isoUtc(d);
}

/**
 * A year-less date, placed in the year that makes sense for the kind of thing
 * being dated: the most recent one for something that happened (a payment),
 * the next one for something that will (a deadline).
 */
function placeYear(month, day, today, prefer) {
  const y = at(today).getUTCFullYear();
  const here = build(y, month, day);
  if (!here) return null;
  if (prefer === 'future') {
    if (here >= shiftDays(today, -YEAR_SLACK_DAYS)) return here;
    return build(y + 1, month, day);
  }
  if (here <= shiftDays(today, YEAR_SLACK_DAYS)) return here;
  return build(y - 1, month, day);
}

/** The weekday `target` relative to today, per the qualifier said with it. */
function resolveWeekday(target, qualifier, today, prefer) {
  const now = weekday(today);
  if (qualifier === 'next') {
    // "Next Friday" is the Friday of next week (weeks start on Monday) — on a
    // Saturday that is six days away, not thirteen, and on a Monday it is
    // eleven days away rather than four.
    const toMonday = ((8 - now) % 7) || 7;
    const nextMonday = shiftDays(today, toMonday);
    return shiftDays(nextMonday, (target + 6) % 7);
  }
  if (qualifier === 'last' || (qualifier !== 'this' && prefer === 'past')) {
    const back = (now - target + 7) % 7;
    // "last Friday" said on a Friday is a week ago; a bare "Friday" said about
    // a payment on a Friday is today.
    return shiftDays(today, -(qualifier === 'last' && back === 0 ? 7 : back));
  }
  // "this Friday", or a bare "Friday" about something upcoming: the soonest
  // one, today included.
  return shiftDays(today, (target - now + 7) % 7);
}

/**
 * When? Returns `{ date, match }` or null.
 *
 * `prefer` decides year-less and weekday-only dates: 'past' (the default, for
 * money that already moved) reads "12 Dec" in September as last December;
 * 'future' (for deadlines and leave) reads it as this December and "5 Jan" as
 * next January.
 *
 * `match` is the text that was read, so a caller parsing a whole sentence can
 * remove it before looking for an amount in what is left.
 */
export function parseDate(text, today = todayIso(), { prefer = 'past' } = {}) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return null;

  const rel = [
    [/\bday before yesterday\b/, -2],
    [/\bday after tomorrow\b/, 2],
    [/\byesterday\b/, -1],
    [/\btoday\b|\bjust now\b|\bright now\b|\bthis morning\b|\bthis afternoon\b|\bthis evening\b|\btonight\b/, 0],
    [/\btomorrow\b|\btmrw\b|\btmr\b/, 1],
  ];
  for (const [re, days] of rel) {
    const hit = s.match(re);
    if (hit) return { date: shiftDays(today, days), match: hit[0] };
  }

  const ago = s.match(/\b(\d{1,3})\s*(day|week)s?\s+ago\b/);
  if (ago) {
    const n = Number(ago[1]) * (ago[2] === 'week' ? 7 : 1);
    return { date: shiftDays(today, -n), match: ago[0] };
  }

  const inN = s.match(/\bin\s+(\d{1,3}|a|one|two|three)\s+(day|week)s?\b/);
  if (inN) {
    const words = { a: 1, one: 1, two: 2, three: 3 };
    const n = (words[inN[1]] ?? Number(inN[1])) * (inN[2] === 'week' ? 7 : 1);
    return { date: shiftDays(today, n), match: inN[0] };
  }

  const eom = s.match(/\b(?:by\s+)?(?:the\s+)?end\s+of\s+(?:the\s+|this\s+)?month\b/);
  if (eom) return { date: endOfMonth(today), match: eom[0] };

  const eonm = s.match(/\b(?:by\s+)?(?:the\s+)?end\s+of\s+next\s+month\b/);
  if (eonm) {
    const d = at(today);
    return { date: isoUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0))), match: eonm[0] };
  }

  // "next week" as a date is its Monday; "end of the week" is its Friday.
  const nw = s.match(/\bnext\s+week\b/);
  if (nw) return { date: resolveWeekday(1, 'next', today, prefer), match: nw[0] };
  const eow = s.match(/\b(?:by\s+)?(?:the\s+)?end\s+of\s+(?:the\s+|this\s+)?week\b/);
  if (eow) return { date: resolveWeekday(5, 'this', today, 'future'), match: eow[0] };

  const isoHit = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoHit && isIsoDate(isoHit[0])) return { date: isoHit[0], match: isoHit[0] };

  // dd/mm[/yy(yy)] — day first, as every date on these screens already is.
  // A dotted date needs its year (12.09.2026): "1.2" on its own is one point
  // two — of a lakh, usually — not the first of February.
  const dmy = s.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b(?!\.\d)/)
    || s.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]) - 1;
    if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
      let built;
      if (dmy[3]) {
        let year = Number(dmy[3]);
        if (year < 100) year += 2000;
        built = build(year, month, day);
      } else {
        built = placeYear(month, day, today, prefer);
      }
      if (built) return { date: built, match: dmy[0] };
    }
  }

  const dMon = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})[a-z]*\\.?(?:,?\\s+(\\d{4}))?`, 'i'));
  if (dMon) {
    const hit = monthDay(Number(dMon[1]), dMon[2], dMon[3], today, prefer);
    if (hit) return { date: hit, match: dMon[0] };
  }

  const monD = s.match(new RegExp(`\\b(${MONTH_RE})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'i'));
  if (monD) {
    const hit = monthDay(Number(monD[2]), monD[1], monD[3], today, prefer);
    if (hit) return { date: hit, match: monD[0] };
  }

  const wd = s.match(new RegExp(`\\b(?:(next|last|this|coming)\\s+)?${WEEKDAY_RE}\\b`, 'i'));
  if (wd) {
    const target = WEEKDAYS[wd[2].slice(0, 3)];
    const qualifier = wd[1] === 'coming' ? 'this' : wd[1];
    return { date: resolveWeekday(target, qualifier, today, prefer), match: wd[0] };
  }

  // "the 5th" — a day of the month on its own. A bare "5th" counts only when
  // it is the whole value (a tool argument), never inside a sentence, where
  // "the 18th birthday" is not a date.
  const dom = s.match(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/)
    || s.match(/^\s*(?:on\s+|by\s+)?(\d{1,2})(?:st|nd|rd|th)\s*$/);
  if (dom) {
    const day = Number(dom[1]);
    const d = at(today);
    const inMonth = (offset) => {
      const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + offset;
      return build(Math.floor(total / 12), total % 12, day);
    };
    const same = inMonth(0);
    const built = prefer === 'future'
      ? (same && same >= today ? same : inMonth(1))
      : (same && same <= today ? same : inMonth(-1));
    if (built) return { date: built, match: dom[0] };
  }

  return null;
}

function monthDay(day, monthWord, yearWord, today, prefer) {
  const month = MONTHS[String(monthWord).toLowerCase()];
  if (month === undefined || day < 1 || day > 31) return null;
  if (yearWord) return build(Number(yearWord), month, day);
  return placeYear(month, day, today, prefer);
}

export default {
  DEFAULT_TZ, isIsoDate, todayIso, todayIn, shiftDays, weekday, endOfMonth,
  formatDate, formatDateShort, parseDate,
};
