import { describe, it, expect } from 'vitest';
import { validateMessage, sanitizeFromName } from '../../email.js';

/**
 * FIX_PLAN item 7's remaining guards: recipient validation, the 50-address cap,
 * and refusing CR/LF in anything that becomes an SMTP header.
 *
 * The endpoint itself needs a live Supabase and an SMTP server, so these cover
 * the pure functions — which is where the injection and relay risks live.
 */

const ok = { to: 'a@example.com', subject: 'Hi', text: 'body' };

describe('validateMessage', () => {
  it('accepts a normal single-recipient message', () => {
    const m = validateMessage(ok);
    expect(m.recipients).toEqual(['a@example.com']);
    expect(m.subject).toBe('Hi');
  });

  it('splits a comma-separated string into separate addresses', () => {
    const m = validateMessage({ ...ok, to: 'a@example.com, b@example.com' });
    expect(m.recipients).toEqual(['a@example.com', 'b@example.com']);
  });

  it('keeps an array as an array, trimmed', () => {
    const m = validateMessage({ ...ok, to: [' a@example.com ', 'b@example.com'] });
    expect(m.recipients).toEqual(['a@example.com', 'b@example.com']);
  });

  it('requires a recipient, a subject, and a body', () => {
    expect(() => validateMessage({ ...ok, to: '' })).toThrow(/Missing required/);
    expect(() => validateMessage({ ...ok, subject: '' })).toThrow(/Missing required/);
    expect(() => validateMessage({ to: 'a@example.com', subject: 'x' })).toThrow(/Missing required/);
  });

  it('accepts html with no text, and text with no html', () => {
    expect(validateMessage({ to: 'a@example.com', subject: 'x', html: '<p>x</p>' }).recipients).toHaveLength(1);
    expect(validateMessage({ to: 'a@example.com', subject: 'x', text: 'x' }).recipients).toHaveLength(1);
  });

  it('rejects an address carrying a CRLF header injection', () => {
    expect(() => validateMessage({ ...ok, to: 'a@example.com\r\nBcc: victim@example.com' }))
      .toThrow(/Not a valid email address/);
  });

  it('rejects an address with a display name or angle brackets', () => {
    expect(() => validateMessage({ ...ok, to: 'Bob <bob@example.com>' }))
      .toThrow(/Not a valid email address/);
  });

  it('rejects addresses that are not addresses', () => {
    for (const bad of ['not-an-email', 'a@b', 'a@b.c', '@example.com', 'a@@example.com']) {
      expect(() => validateMessage({ ...ok, to: bad }), bad).toThrow(/Not a valid email address/);
    }
  });

  it('caps the recipient list at 50', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `u${i}@example.com`);
    expect(validateMessage({ ...ok, to: fifty }).recipients).toHaveLength(50);
    expect(() => validateMessage({ ...ok, to: [...fifty, 'one-too-many@example.com'] }))
      .toThrow(/Too many recipients/);
  });

  it('refuses a newline in the subject', () => {
    expect(() => validateMessage({ ...ok, subject: 'Hi\r\nBcc: victim@example.com' }))
      .toThrow(/may not contain line breaks/);
    expect(() => validateMessage({ ...ok, subject: 'Hi\nX-Spoof: 1' }))
      .toThrow(/may not contain line breaks/);
  });

  it('refuses an absurdly long subject', () => {
    expect(() => validateMessage({ ...ok, subject: 'x'.repeat(999) })).toThrow(/too long/);
  });
});

describe('sanitizeFromName', () => {
  it('strips the quotes and backslashes that would break out of the From name', () => {
    expect(sanitizeFromName('Acme" <attacker@example.com>, "x')).toBe('Acme <attacker@example.com>, x');
  });

  it('strips newlines', () => {
    expect(sanitizeFromName('Acme\r\nBcc: victim@example.com')).toBe('AcmeBcc: victim@example.com');
  });

  it('leaves an ordinary company name alone', () => {
    expect(sanitizeFromName('Acme & Sons')).toBe('Acme & Sons');
  });

  it('caps the length and handles nullish', () => {
    expect(sanitizeFromName('x'.repeat(200))).toHaveLength(100);
    expect(sanitizeFromName(null)).toBe('');
  });
});
