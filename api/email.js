import nodemailer from 'nodemailer';
import { supabaseAdmin } from './_lib/supabaseAdmin.js';
import { requireUser, requireOrgRole, sendError, methodIs, readJsonBody, HttpError } from './_lib/auth.js';
import { decryptSecret } from './_lib/crypto.js';

/**
 * POST /api/email
 * Headers: Authorization: Bearer <supabase access token>
 * Body: { org_id, to, subject, text?, html?, fromName? }
 *   or: { org_id, mode: 'test' }
 *
 * Previously this route took `gmailUser` and `appPassword` straight out of an
 * unauthenticated request body: anyone who found the URL could relay mail
 * through any Gmail account whose app password they had, and every caller in
 * the app shipped the org's SMTP password to the browser to get here.
 *
 * Now the caller proves they are a member of the org and the credentials are
 * read server-side from org_secrets and decrypted with a key the browser never
 * sees. mode:'test' mails the org's own stored address to prove the stored
 * credentials work; it accepts no credentials of its own, so the endpoint cannot
 * be used to check whether a Gmail address and password pair is valid.
 *
 * The remaining three guards, in order: the org's quota is claimed before the
 * upstream call (0024_email_rate_limit.sql), recipients are validated and capped
 * at 50, and every header value is rejected if it contains a line break.
 */
export default async function handler(req, res) {
  if (!methodIs(req, res, 'POST')) return;

  try {
    const user = await requireUser(req);
    const body = await readJsonBody(req);
    const { org_id: orgId, mode } = body || {};

    const isTest = mode === 'test';
    await requireOrgRole(user.id, orgId, isTest ? 'admin' : 'member');

    // Credentials are never read from the request, not even for a test. A test
    // that accepted them from the body was an oracle: any org admin — including
    // one who had just signed up for a free account — could post somebody else's
    // Gmail address and a guessed App Password and read the answer off the status
    // code. Testing now means testing what this org has stored, which is the only
    // thing an admin has a legitimate interest in testing.
    const { gmailUser, appPassword } = await loadOrgCredentials(orgId);

    const message = isTest
      ? buildTestMessage(gmailUser)
      : validateMessage(body);

    // Claimed before the upstream call, and counted per recipient: a send to 50
    // addresses is 50 messages as far as Gmail's quota is concerned, so counting
    // it as one would let a caller multiply their limit by the recipient cap.
    const remaining = await claimQuota(orgId, user.id, isTest ? 'test' : 'send', message.recipients.length);

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: gmailUser, pass: appPassword },
    });

    // verify() runs only for a test, where proving the credentials work IS the
    // operation. On a normal send it was a second round-trip that told a caller
    // whether an arbitrary Gmail address and password pair was valid — a
    // credential-checking oracle — and sendMail reports an auth failure anyway.
    if (isTest) {
      try {
        await transporter.verify();
      } catch (err) {
        console.error('[api/email] SMTP verify failed:', err?.message);
        return res.status(502).json({ success: false, error: smtpMessage(err) });
      }
    }

    let info;
    try {
      info = await transporter.sendMail({
        from: message.fromName ? `"${sanitizeFromName(message.fromName)}" <${gmailUser}>` : gmailUser,
        to: message.recipients,
        subject: message.subject,
        text: message.text || undefined,
        html: message.html || undefined,
      });
    } catch (err) {
      console.error('[api/email] send failed:', err?.message);
      return res.status(502).json({ success: false, error: smtpMessage(err) });
    }

    return res.status(200).json({
      success: true,
      messageId: info.messageId,
      accepted: info.accepted || [],
      rejected: info.rejected || [],
      quota_remaining: remaining,
    });
  } catch (err) {
    return sendError(res, err, 'api/email');
  }
}

/** Reads and decrypts the org's Gmail credentials. Service role only. */
async function loadOrgCredentials(orgId) {
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
async function claimQuota(orgId, userId, kind, units) {
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

// RFC 5321 is more permissive than this, but every address the app actually
// handles is a human mailbox typed into a form. Anything with whitespace,
// a comma, or a CR/LF cannot be one.
const ADDRESS = /^[^\s@,;:<>"'\\]+@[^\s@,;:<>"'\\]+\.[A-Za-z]{2,}$/;
const MAX_RECIPIENTS = 50;

/**
 * Returns the message as an explicit recipient array plus header-safe fields.
 *
 * Two things are being prevented here. The first is header injection: a newline
 * inside a subject or an address used to become the start of a new SMTP header,
 * which is how a Bcc gets added to somebody else's mail. The second is using an
 * authenticated org as a bulk relay — `to` arrived as an unbounded array and was
 * passed straight through.
 */
export function validateMessage(body) {
  const { to, subject, text, html, fromName } = body || {};
  if (!to || !subject || (!text && !html)) {
    throw new HttpError(400, 'Missing required fields: to, subject, and text or html.');
  }

  const recipients = (Array.isArray(to) ? to : String(to).split(','))
    .map((addr) => String(addr).trim())
    .filter(Boolean);

  if (!recipients.length) throw new HttpError(400, 'No recipient address given.');
  if (recipients.length > MAX_RECIPIENTS) {
    throw new HttpError(400, `Too many recipients: ${recipients.length} (max ${MAX_RECIPIENTS} per message).`);
  }

  const bad = recipients.filter((addr) => !ADDRESS.test(addr));
  if (bad.length) {
    throw new HttpError(400, `Not a valid email address: ${bad.slice(0, 3).join(', ')}`);
  }

  return {
    recipients,
    subject: headerSafe(subject, 'subject', 998),
    text,
    html,
    fromName,
  };
}

/** A header value cannot contain a line break, and nodemailer will not fix it. */
function headerSafe(value, field, maxLength) {
  const raw = String(value ?? '');
  if (/[\r\n]/.test(raw)) {
    throw new HttpError(400, `The ${field} may not contain line breaks.`);
  }
  if (raw.length > maxLength) {
    throw new HttpError(400, `The ${field} is too long (max ${maxLength} characters).`);
  }
  return raw;
}

/** The display name is interpolated inside quotes, so quotes cannot survive. */
export function sanitizeFromName(name) {
  return String(name ?? '').replace(/[\r\n"\\]/g, '').trim().slice(0, 100);
}

/**
 * One message for every SMTP failure shape, so the response cannot be used to
 * tell a wrong password from an unreachable server. The detail goes to the
 * server log, where only the operator sees it.
 */
function smtpMessage(err) {
  if (err?.code === 'EAUTH') {
    return 'Gmail rejected the saved credentials. Re-enter the App Password in '
      + 'Profile → Email Configuration (2-Step Verification must be on).';
  }
  return 'Could not reach Gmail. Check the saved email settings and try again.';
}

/** A test can only ever reach the org's own stored address — never an arbitrary recipient. */
function buildTestMessage(gmailUser) {
  return {
    recipients: [gmailUser],
    fromName: 'StartupBuddy',
    subject: 'StartupBuddy: email test',
    text: 'This is a test email from StartupBuddy. If you received this, your Gmail is connected correctly.',
    html: `
      <div style="font-family:'Segoe UI',sans-serif;max-width:500px;margin:0 auto;padding:24px;">
        <div style="background:linear-gradient(135deg,#10b981,#059669);padding:24px;border-radius:12px 12px 0 0;text-align:center;">
          <h2 style="color:#fff;margin:0;font-size:18px;">Gmail SMTP is Working</h2>
        </div>
        <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:24px;">
          <p style="margin:0 0 12px;font-size:14px;color:#374151;line-height:1.6;">
            This is a test email from <strong>StartupBuddy</strong>.
          </p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
            If you received this in your inbox, your setup is complete. You can now send offer letters, notifications, and follow-ups directly from StartupBuddy.
          </p>
        </div>
      </div>`,
  };
}
