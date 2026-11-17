/**
 * Delivery of the one-time code a vendor uses to sign a rate contract or an
 * addendum (REQ-2026-0092).
 *
 * Before this, requestOtp created the code and only returned it outside
 * production (`dev_code`), so in production the vendor was told "sent to your
 * registered phone & email" and received nothing: no contract or addendum
 * could be signed. The code now goes by email. There is no SMS provider in the
 * backend, so email is the only channel.
 *
 * Recipients: the contracted vendor's registered email (the address the
 * signing screen shows), plus the person signing when that is someone else,
 * i.e. a vendor-network member acting for the vendor (req.user is the acting
 * vendor, req.user.network.actor_user_id the person).
 */
import db from '../config/dbConn.js';
import config from '../config/app.config.js';
import { sendMail } from '../helper/common.js';
import { generateEmailTemplate } from '../helper/notificationEmailLayout.js';

/** A vendor may ask for a new code at most once per this many seconds. */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

export const NO_EMAIL_MESSAGE =
  "Your account has no email address, so the signing code can't be sent. Add one to your profile and try again.";
export const SEND_FAILED_MESSAGE = "We couldn't email the signing code. Please try again.";

/** 429 for a code asked for again inside the cooldown. */
export function sendTooSoon(res, seconds) {
  return res.status(429).json({
    status: 0,
    message: `A code was sent less than a minute ago. You can ask for a new one in ${seconds} seconds.`,
    data: { retry_after_seconds: seconds },
  });
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** "purasst@phileeinhospitality.com" -> "pu*****@phileeinhospitality.com". */
export function maskEmail(email) {
  const s = String(email || '').trim();
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : null;
  const local = s.slice(0, at);
  const keep = local.slice(0, local.length <= 2 ? 1 : 2);
  return `${keep}${'*'.repeat(Math.max(3, local.length - keep.length))}${s.slice(at)}`;
}

/** [{ email, name }], case-insensitively de-duplicated, blanks dropped. */
export async function signingOtpRecipients({ vendorEmail, vendorName, user }, runner = db) {
  const out = [];
  const add = (email, name) => {
    const e = String(email || '').trim();
    if (e && !out.some((r) => r.email.toLowerCase() === e.toLowerCase())) out.push({ email: e, name: name || null });
  };
  add(vendorEmail, vendorName);
  const actorId = Number(user?.network?.actor_user_id);
  if (actorId && actorId !== Number(user?.id)) {
    const person = await runner.oneOrNone('SELECT name, email FROM tbl_users WHERE id = $1', [actorId]);
    if (person) add(person.email, person.name);
  }
  return out;
}

const istTime = (d) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(d));

/** The email body. `documentLabel` is e.g. "rate contract" or "addendum". */
export function renderSigningOtpEmail({ name, code, expiresAt, documentLabel, arcNumber, arcTitle }) {
  const minutes = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000));
  const what = [escapeHtml(documentLabel), arcNumber ? escapeHtml(arcNumber) : null].filter(Boolean).join(' ');
  const header = `<h2 style="margin: 0 0 8px; font-size: 20px; color: #1A5C7E;">Your code to sign ${what}</h2>`;
  const body = `
    <p style="font-size: 15px; margin: 0 0 16px; color: #333;">${String(name || '').trim() ? `Hello ${escapeHtml(String(name).trim())},` : 'Hello,'}</p>
    <p style="font-size: 15px; margin: 0 0 16px; color: #333;">
      Use this code to sign the ${what}${arcTitle ? ` (${escapeHtml(arcTitle)})` : ''} on Workwise:
    </p>
    <p style="font-size: 30px; font-weight: 700; letter-spacing: 8px; margin: 0 0 16px; color: #111;">${escapeHtml(code)}</p>
    <p style="font-size: 14px; margin: 0 0 8px; color: #555;">
      It works for ${minutes} minutes (until ${escapeHtml(istTime(expiresAt))} IST) and only once.
    </p>
    <p style="font-size: 14px; margin: 0; color: #555;">
      If you didn't ask for this code, ignore this email. Nobody from Workwise will ask you for it.
    </p>`;
  return generateEmailTemplate(header, body);
}

/**
 * Emails the code to every recipient. Resolves to the addresses it reached
 * (sendMail never throws; it resolves false on failure).
 */
export async function sendSigningOtp({ recipients, code, expiresAt, documentLabel, arcNumber, arcTitle }) {
  const subject = `Your code to sign ${documentLabel}${arcNumber ? ` ${arcNumber}` : ''}`;
  const results = await Promise.all(
    recipients.map((r) =>
      sendMail({
        from: config.webmasterMail,
        to: r.email,
        subject,
        html: renderSigningOtpEmail({ name: r.name, code, expiresAt, documentLabel, arcNumber, arcTitle }),
      })
    )
  );
  return recipients.filter((_, i) => results[i] === true).map((r) => r.email);
}
