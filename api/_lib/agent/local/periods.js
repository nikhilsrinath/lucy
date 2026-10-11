import { shiftDays, weekday, endOfMonth, parseDate, formatDate, formatDateShort } from '../../../../src/shared/dates.js';

/**
 * Periods as people say them — "last month", "this week", "in September",
 * "the past 30 days", "since 1 Sep" — resolved against the company's today
 * (ctx.today is already in the org's timezone; nothing here reads a clock).
 *
 * Weeks run Monday to Sunday, as src/shared/dates.js has them. Quarters are
 * calendar quarters, which are also the Indian financial year's (Apr–Jun is a
 * quarter either way); "financial year" is April to March.
 *
 * Returns { from, to, label, match } with ISO dates (either bound may be null
 * for "all time"), or null. `match` is the text that was read, so the caller
 * can take it out of the sentence before looking at the rest.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NUM_WORDS = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, couple: 2, few: 3 };

const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const parts = (iso) => iso.split('-').map(Number);

function monthRange(y, m) {
  const total = y * 12 + m;
  const yy = Math.floor(total / 12);
  const mm = ((total % 12) + 12) % 12;
  const from = ymd(yy, mm, 1);
  return { from, to: endOfMonth(from) };
}

function weekRange(today, offset = 0) {
  const monday = shiftDays(today, -((weekday(today) + 6) % 7) + offset * 7);
  return { from: monday, to: shiftDays(monday, 6) };
}

function quarterRange(today, offset = 0) {
  const [y, m] = parts(today);
  const first = (Math.floor((m - 1) / 3) + offset) * 3;
  return { from: monthRange(y, first).from, to: monthRange(y, first + 2).to };
}

const span = (from, to, today) => (from === to ? formatDate(from) : `${formatDateShort(from, today)} – ${formatDate(to)}`);

export function extractPeriod(text, today, { prefer = 'past' } = {}) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return null;
  const [y, m] = parts(today);
  const hit = (re) => s.match(re);
  let x;

  if ((x = hit(/\b(?:all[- ]time|ever|overall|to date|till date|so far|since (?:the )?(?:start|beginning))\b/))) {
    return { from: null, to: null, label: 'all time', match: x[0] };
  }
  if ((x = hit(/\b(?:between|from)\s+(.+?)\s+(?:and|to|till|until|-)\s+(.+?)(?=$|[,.?])/))) {
    const a = parseDate(x[1], today, { prefer: 'past' });
    const b = parseDate(x[2], today, { prefer: 'past' });
    if (a && b && a.date <= b.date) return { from: a.date, to: b.date, label: span(a.date, b.date, today), match: x[0] };
  }
  if ((x = hit(/\b(?:in|over|during|for)?\s*(?:the\s+)?(?:last|past|previous)\s+(\d{1,3}|a|one|two|three|four|five|six|seven|ten|couple of|few)\s+(day|week|month)s?\b/))) {
    const n = NUM_WORDS[x[1].replace(' of', '')] ?? Number(x[1]);
    const days = x[2] === 'day' ? n : x[2] === 'week' ? n * 7 : n * 30;
    return { from: shiftDays(today, -days), to: today, label: `the last ${n} ${x[2]}${n === 1 ? '' : 's'}`, match: x[0].trim() };
  }
  if ((x = hit(/\bsince\s+(.+?)(?=$|[,.?])/))) {
    const a = parseDate(x[1], today, { prefer: 'past' });
    if (a && a.date <= today) return { from: a.date, to: today, label: `since ${formatDate(a.date)}`, match: x[0] };
  }

  const named = [
    [/\b(?:day before yesterday)\b/, () => { const d = shiftDays(today, -2); return [d, d, formatDate(d)]; }],
    [/\byesterday\b/, () => { const d = shiftDays(today, -1); return [d, d, 'yesterday']; }],
    [/\b(?:today|tonight|this morning|this afternoon|this evening|as of today|eod|end of day)\b/, () => [today, today, 'today']],
    [/\b(?:tomorrow|tmrw|tmr)\b/, () => { const d = shiftDays(today, 1); return [d, d, 'tomorrow']; }],
    [/\b(?:this|the current|current)\s+week\b|\bweekly\b|\bwtd\b|\bweek to date\b/, () => { const r = weekRange(today); return [r.from, r.to, 'this week']; }],
    [/\b(?:last|previous|the previous|past)\s+week\b/, () => { const r = weekRange(today, -1); return [r.from, r.to, 'last week']; }],
    [/\b(?:next|the coming|coming)\s+week\b/, () => { const r = weekRange(today, 1); return [r.from, r.to, 'next week']; }],
    [/\b(?:this|the current|current)\s+month\b|\bmonthly\b|\bmtd\b|\bmonth to date\b/, () => { const r = monthRange(y, m - 1); return [r.from, r.to, 'this month']; }],
    [/\b(?:last|previous|the previous|past)\s+month\b/, () => { const r = monthRange(y, m - 2); return [r.from, r.to, 'last month']; }],
    [/\b(?:next|the coming|coming)\s+month\b/, () => { const r = monthRange(y, m); return [r.from, r.to, 'next month']; }],
    [/\b(?:this|the current|current)\s+quarter\b|\bquarterly\b|\bqtd\b/, () => { const r = quarterRange(today); return [r.from, r.to, 'this quarter']; }],
    [/\b(?:last|previous|the previous|past)\s+quarter\b/, () => { const r = quarterRange(today, -1); return [r.from, r.to, 'last quarter']; }],
    [/\b(?:this|the current|current)\s+(?:financial|fiscal)\s+year\b|\bthis fy\b/, () => { const fy = m >= 4 ? y : y - 1; return [ymd(fy, 3, 1), ymd(fy + 1, 2, 31), 'this financial year']; }],
    [/\b(?:last|previous)\s+(?:financial|fiscal)\s+year\b|\blast fy\b/, () => { const fy = (m >= 4 ? y : y - 1) - 1; return [ymd(fy, 3, 1), ymd(fy + 1, 2, 31), 'last financial year']; }],
    [/\b(?:this|the current|current)\s+year\b|\bytd\b|\byear to date\b|\byearly\b|\bannual(?:ly)?\b/, () => [ymd(y, 0, 1), ymd(y, 11, 31), 'this year']],
    [/\b(?:last|previous)\s+year\b/, () => [ymd(y - 1, 0, 1), ymd(y - 1, 11, 31), 'last year']],
  ];
  for (const [re, make] of named) {
    const mm = hit(re);
    if (mm) { const [from, to, label] = make(); return { from, to, label, match: mm[0] }; }
  }

  // "in September", "for Aug 2025", "September" — a whole month. A day beside
  // it ("5 Sep", "Sep 5th") makes it a date, which is left to parseDate.
  const mon = s.match(new RegExp(`\\b(?:(in|for|during|of)\\s+)?(?:the month of\\s+)?${MONTH_RE}\\b(?:\\s+(\\d{4}))?`, 'i'));
  if (mon && mon.index !== undefined) {
    const [whole, prep, word, yearWord] = mon;
    const before = s.slice(0, mon.index).match(/(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s*)?$/);
    const after = s.slice(mon.index + whole.length).match(/^\s*(\d{1,2})(?:st|nd|rd|th)?\b(?!\d)/);
    // A short form ("Jan", "Mar", "May") is also a name and a verb: it is a
    // month only with a preposition or a year beside it.
    const short = word.length <= 4 && !/^(?:june|july)$/i.test(word);
    if (!before && !(after && !yearWord) && (!short || prep || yearWord)) {
      const idx = MONTHS.findIndex((name) => name.startsWith(word.slice(0, 3).toLowerCase()));
      // A month with no year is the most recent one that has started.
      const year = yearWord ? Number(yearWord) : (idx <= m - 1 ? y : y - 1);
      const r = monthRange(year, idx);
      return { from: r.from, to: r.to, label: `${MONTHS[idx][0].toUpperCase()}${MONTHS[idx].slice(1)} ${year}`, match: whole.trim() };
    }
  }

  // A single day said some other way: "on 5 Oct", "last Friday", "12/09".
  // A bare three-letter weekday ("sat", "sun", "wed") is as likely a word or a name.
  const day = parseDate(s, today, { prefer });
  if (day && !/^\s*(?:next week|end of)/.test(day.match) && !/^(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)$/.test(day.match.trim())) {
    return { from: day.date, to: day.date, label: day.date === today ? 'today' : formatDate(day.date), match: day.match };
  }
  return null;
}

/** Removes a period's words (and a dangling preposition before them) from a sentence. */
export function withoutPeriod(text, period) {
  if (!period?.match) return text;
  const at = text.toLowerCase().indexOf(period.match.toLowerCase());
  if (at < 0) return text;
  // The preposition before it ("due on Friday", "focus on today") is left in
  // place: it may belong to the words before, and it is a neutral word either way.
  return `${text.slice(0, at)} ${text.slice(at + period.match.length)}`.replace(/\s+/g, ' ').trim();
}
