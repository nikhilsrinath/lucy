import nodemailer from 'nodemailer';
import { supabaseAdmin } from './supabaseAdmin.js';
import { HttpError } from './auth.js';
import { decryptSecret } from './crypto.js';

/**
 * Sending mail as the organization — shared by /api/email (the app's own
 * sends) and the Buddy action layer (a reminder the person confirmed on a
 * card). One place reads the org's stored Gmail credentials, claims the
 * org's hourly quota and talks to SMTP, so every channel obeys the same
 * limits and there is no second, laxer way out.
 */

/** Reads and decrypts the org's Gmail credentials. Service role only. */
export async function loadOrgCredentials(orgId) {
  const { data, error } = await supabaseAdmin()
    .from('org_secrets')
    .select('gmail_user, gmail_cipher, gmail_iv, gmail_tag')
    .eq('org_id', orgId)
    .maybeSingle();

  if (error) throw new HttpError(500, error.message);
  if (!data?.gmail_user || !data?.gmail_cipher) {
    throw new HttpError(412, 'Email is not configured. Open Profile → Email Configuration to set up Gmail.');
  }

  let appPassword;
  try {
    appPassword = decryptSecret({ cipher: data.gmail_cipher, iv: data.gmail_iv, tag: data.gmail_tag });
  } catch (err) {
    console.error('[api/email] decrypt failed:', err?.message);
    throw new HttpError(500, 'Stored email credentials could not be decrypted. Re-save them in Profile → Email Configuration.');
  }

  return { gmailUser: data.gmail_user, appPassword };
}

/** Claims quota for `units` messages, or 429s. */
export async function claimQuota(orgId, userId, kind, units) {
  let remaining = null;
  for (let i = 0; i < units; i++) {
    const { data, error } = await supabaseAdmin()
      .rpc('claim_email_quota', { p_org: orgId, p_kind: kind, p_user: userId });

    if (error) {
      // 23514 is the check_violation the function raises at the limit. Anything
      // else is a real fault and must not be reported as a rate limit.
      if (error.code === '23514' || /rate limit reached/i.test(error.message || '')) {
        throw new HttpError(429, kind === 'test'
          ? 'Too many connection tests today. Try again tomorrow.'
          : 'This organization has reached its hourly email limit. Try again later.');
      }
      throw new HttpError(500, error.message);
    }
    remaining = data;
  }
  return remaining;
}

/** Whether the org has Gmail stored. Never throws. */
export async function emailConfigured(orgId) {
  try {
    const { data, error } = await supabaseAdmin().from('org_secrets')
      .select('gmail_user, gmail_cipher').eq('org_id', orgId).maybeSingle();
    return !error && !!data?.gmail_user && !!data?.gmail_cipher;
  } catch {
    return false;
  }
}

const ADDRESS = /^[^\s@,;:<>"'\\]+@[^\s@,;:<>"'\\]+\.[A-Za-z]{2,}$/;
export const isEmailAddress = (s) => ADDRESS.test(String(s || '').trim());

/**
 * One message to one recipient, as the org. The caller has already had the
 * person confirm it. Returns { messageId, accepted }; throws an HttpError whose
 * message is safe to show.
 */
export async function sendOrgMail({ orgId, userId, to, subject, text, fromName = null }) {
  if (!isEmailAddress(to)) throw new HttpError(400, `Not a valid email address: ${to}`);
  if (/[\r\n]/.test(String(subject || '')) || !String(subject || '').trim()) throw new HttpError(400, 'The subject must be one line.');
  if (!String(text || '').trim()) throw new HttpError(400, 'The message is empty.');
  const { gmailUser, appPassword } = await loadOrgCredentials(orgId);
  await claimQuota(orgId, userId, 'send', 1);
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: gmailUser, pass: appPassword },
  });
  const name = String(fromName || '').replace(/[\r\n"\\]/g, '').trim().slice(0, 100);
  try {
    const info = await transporter.sendMail({
      from: name ? `"${name}" <${gmailUser}>` : gmailUser,
      to: [String(to).trim()],
      subject: String(subject).slice(0, 998),
      text: String(text).slice(0, 20000),
    });
    return { messageId: info.messageId || null, accepted: info.accepted || [] };
  } catch (err) {
    console.error('[mailer] send failed:', err?.message);
    throw new HttpError(502, err?.code === 'EAUTH'
      ? 'Gmail rejected the saved credentials. Re-enter the App Password in Settings → Email.'
      : 'Could not reach Gmail. Check the saved email settings and try again.');
  }
}
