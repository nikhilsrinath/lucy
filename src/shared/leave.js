// Leave arithmetic shared by the app (leaveService) and the server (Buddy's
// leave tools), so a request filed from chat counts days exactly as the form does.

/**
 * Calendar days in an inclusive range, optionally skipping weekends.
 *
 * Built from UTC midnights on purpose: a plain `new Date('2026-03-29')`
 * difference is short by an hour across a DST boundary, and `Math.round` on
 * 0.958 days still gives 1 — until a fortnight's range accumulates enough drift
 * to lose a day. Date.UTC has no DST.
 */
export function countLeaveDays(startDate, endDate, { halfDay = false, skipWeekends = false } = {}) {
  if (!startDate || !endDate) return 0;
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;

  const span = Math.floor((end - start) / 86400000) + 1;
  if (halfDay) return span === 1 ? 0.5 : span;   // a half day is only ever one day
  if (!skipWeekends) return span;

  let days = 0;
  for (let i = 0; i < span; i += 1) {
    const d = new Date(start.getTime() + i * 86400000);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}

/** True when two ranges touch at all — used to warn about a double booking. */
export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}
