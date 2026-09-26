import { describe, it, expect } from 'vitest';
import { parseDate, todayIn, formatDate, formatDateShort, isIsoDate, endOfMonth } from './dates';

// Saturday 26 September 2026.
const TODAY = '2026-09-26';
const future = (s) => parseDate(s, TODAY, { prefer: 'future' })?.date;
const past = (s) => parseDate(s, TODAY, { prefer: 'past' })?.date;

describe('deadlines read forward', () => {
  it.each([
    ['rescheduled to 2nd October', '2026-10-02'],
    ['2 Oct', '2026-10-02'],
    ['October 2nd', '2026-10-02'],
    ['2/10', '2026-10-02'],
    ['tomorrow', '2026-09-27'],
    ['day after tomorrow', '2026-09-28'],
    ['next Friday', '2026-10-02'],
    ['friday', '2026-10-02'],
    ['this saturday', '2026-09-26'],
    ['on monday', '2026-09-28'],
    ['next week', '2026-09-28'],
    ['end of the week', '2026-10-02'],
    ['end of month', '2026-09-30'],
    ['end of next month', '2026-10-31'],
    ['in 3 days', '2026-09-29'],
    ['in two weeks', '2026-10-10'],
    ['the 5th', '2026-10-05'],
    ['5th', '2026-10-05'],
    ['by 30th', '2026-09-30'],
    ['5 Jan', '2027-01-05'],
    ['20 Sep', '2026-09-20'],
    ['2026-12-01', '2026-12-01'],
    ['15 March 2027', '2027-03-15'],
  ])('%s → %s', (said, iso) => {
    expect(future(said)).toBe(iso);
  });
});

describe('payments read backward', () => {
  it.each([
    ['yesterday', '2026-09-25'],
    ['3 days ago', '2026-09-23'],
    ['last friday', '2026-09-25'],
    ['friday', '2026-09-25'],
    ['12 Dec', '2025-12-12'],
    ['5 Oct', '2026-10-05'],
    ['the 5th', '2026-09-05'],
  ])('%s → %s', (said, iso) => {
    expect(past(said)).toBe(iso);
  });
});

describe('what is not a date', () => {
  it.each(['monthly report', 'saturation', 'wedding gift', 'we may pay later', '31 Feb'])('"%s"', (s) => {
    expect(future(s)).toBeUndefined();
  });
});

describe('today in the org timezone', () => {
  it('is already tomorrow in Kolkata at 20:00 UTC', () => {
    expect(todayIn('Asia/Kolkata', new Date('2026-09-26T20:00:00Z'))).toBe('2026-09-27');
    expect(todayIn('UTC', new Date('2026-09-26T20:00:00Z'))).toBe('2026-09-26');
  });
  it('falls back to Kolkata for an unknown zone', () => {
    expect(todayIn('Mars/Olympus', new Date('2026-09-26T20:00:00Z'))).toBe('2026-09-27');
  });
});

describe('formatting', () => {
  it('shows absolute dates', () => {
    expect(formatDate('2026-10-02')).toBe('2 Oct 2026');
    expect(formatDateShort('2026-09-25', TODAY)).toBe('25 Sep');
    expect(formatDateShort('2025-09-25', TODAY)).toBe('25 Sep 2025');
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
  });
});
