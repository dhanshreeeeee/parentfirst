// ParentFirst — outbound email.
//
// WHY THIS ORDER: Render's free tier blocks outbound SMTP (ports 25/465/587)
// at the firewall. No SMTP password can ever work there. HTTPS email APIs go
// out on port 443 and are not blocked, so they are tried first.
//
//   1. Resend   RESEND_API_KEY  (+ EMAIL_FROM, e.g. "ParentFirst <hello@parentfirst.app>")
//   2. Brevo    BREVO_API_KEY   (+ EMAIL_FROM)
//   3. SMTP     SMTP_HOST + SMTP_USER + SMTP_PASS  (local dev, or paid Render instances)
//   4. Console  always — the message is logged so nothing is silently lost
//
// Every send returns { sent, via, reason } so callers can tell the person the
// truth ("we couldn't email you") instead of pretending.
import nodemailer from 'nodemailer';

const env = () => process.env;

function fromAddress() {
  const e = env();
  return e.EMAIL_FROM || e.NOTIFY_FROM || (e.SMTP_USER ? `ParentFirst <${e.SMTP_USER}>` : 'ParentFirst <onboarding@resend.dev>');
}
function parseFrom(from) {
  const m = String(from).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1] || 'ParentFirst', email: m[2] } : { name: 'ParentFirst', email: String(from).trim() };
}

let smtp = null;
function smtpTransport() {
  const e = env();
  if (smtp || !(e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS)) return smtp;
  const port = +(e.SMTP_PORT || 587);
  smtp = nodemailer.createTransport({
    host: e.SMTP_HOST, port, secure: port === 465,
    auth: { user: e.SMTP_USER, pass: String(e.SMTP_PASS).replace(/\s+/g, '') }, // Gmail shows app passwords with spaces
    connectionTimeout: 10000, greetingTimeout: 10000,
  });
  return smtp;
}

export function emailTransport() {
  const e = env();
  if (e.RESEND_API_KEY) return 'resend';
  if (e.BREVO_API_KEY) return 'brevo';
  if (e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS) return 'smtp';
  return 'console';
}

// ── the one email template: plain, legible, works in every client ──
export function renderEmail({ heading, lines = [], code = null, button = null }) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const body = lines.filter((l) => l !== undefined).map((l) => (l === '' ? '<br>' : `<p style="margin:0 0 12px">${esc(l)}</p>`)).join('');
  const codeBlock = code
    ? `<div style="font-size:34px;letter-spacing:10px;font-weight:700;color:#1F2A5C;background:#F1F3F9;border-radius:10px;padding:18px 0;text-align:center;margin:8px 0 18px">${esc(code)}</div>`
    : '';
  const btn = button
    ? `<p style="margin:18px 0"><a href="${esc(button.url)}" style="background:#2E3F8F;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${esc(button.label)}</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#F7F8F5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1F2A5C">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
<div style="font-weight:700;font-size:17px;margin-bottom:20px">ParentFirst</div>
<div style="background:#fff;border:1px solid #E3E6EE;border-radius:12px;padding:26px 24px;font-size:15px;line-height:1.55">
<h1 style="font-size:20px;margin:0 0 14px">${esc(heading)}</h1>${codeBlock}${body}${btn}</div>
<p style="font-size:12px;color:#6B7390;margin:16px 4px">You're receiving this because someone used this address on ParentFirst. If that wasn't you, ignore this email.</p>
</div></body></html>`;
  const text = [heading, '', code ? `Code: ${code}` : null, ...lines, button ? `${button.label}: ${button.url}` : null]
    .filter((l) => l !== null).join('\n');
  return { html, text };
}

function banner(title, lines) {
  const bar = '─'.repeat(64);
  return ['\n┌' + bar + '┐', '  ' + title, bar, ...lines.map((l) => '  ' + l), '└' + bar + '┘\n'].join('\n');
}

async function postJSON(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!r.ok) {
    const t = (await r.text().catch(() => '')).slice(0, 300);
    throw new Error(`${r.status} ${t}`);
  }
  return r.json().catch(() => ({}));
}

/**
 * Send one email. Never throws.
 * @returns {Promise<{sent:boolean, via:string, reason?:string}>}
 */
export async function sendEmail(app, { to, subject, heading, lines = [], code = null, button = null }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  const log = (lvl, m) => { try { app.log[lvl](m); } catch { console.log(m); } };
  if (!recipients.length) return { sent: false, via: 'none', reason: 'no recipient' };
  const { html, text } = renderEmail({ heading: heading || subject, lines, code, button });
  const via = emailTransport();
  const e = env();
  const from = fromAddress();

  // the console always gets a copy — but never the code itself in production logs
  const safeLines = e.NODE_ENV === 'production' && code ? [...lines, '(code hidden in production logs)'] : [...(code ? [`Code: ${code}`] : []), ...lines];
  log('info', banner(`${subject} → ${recipients.join(', ')} [via ${via}]`, safeLines));

  try {
    if (via === 'resend') {
      await postJSON('https://api.resend.com/emails', { Authorization: `Bearer ${e.RESEND_API_KEY}` },
        { from, to: recipients, subject, html, text });
    } else if (via === 'brevo') {
      const f = parseFrom(from);
      await postJSON('https://api.brevo.com/v3/smtp/email', { 'api-key': e.BREVO_API_KEY },
        { sender: f, to: recipients.map((email) => ({ email })), subject, htmlContent: html, textContent: text });
    } else if (via === 'smtp') {
      await smtpTransport().sendMail({ from, to: recipients.join(', '), subject, html, text });
    } else {
      return { sent: false, via, reason: 'no email service configured (set RESEND_API_KEY)' };
    }
    return { sent: true, via };
  } catch (err) {
    const reason = /ETIMEDOUT|ECONNREFUSED|Greeting never received|Connection timeout/i.test(err.message) && via === 'smtp'
      ? `SMTP port blocked by the host (${err.message}). Use RESEND_API_KEY instead.`
      : err.message;
    log('error', `email via ${via} failed: ${reason}`);
    return { sent: false, via, reason };
  }
}

// ── backwards-compatible wrappers (existing callers keep working) ──
export async function notifyPeople(app, recipients, subject, lines) {
  const r = await sendEmail(app, { to: recipients && recipients.length ? recipients : env().NOTIFY_TO, subject, lines });
  return { ...r, to: (recipients || []).join(', ') };
}
export async function notifyOperator(app, subject, lines) {
  if (!env().NOTIFY_TO) { try { app.log.info(banner(subject, lines)); } catch { /* */ } return { sent: false, via: 'console', reason: 'NOTIFY_TO not set' }; }
  return sendEmail(app, { to: env().NOTIFY_TO, subject, lines });
}
export function notifyConfigured() { return emailTransport() !== 'console' && !!env().NOTIFY_TO; }

// ── WhatsApp via Meta Cloud API (parked; activates only when configured) ──
export async function sendWhatsApp(app, numbers, text) {
  const token = env().WHATSAPP_TOKEN;
  const phoneId = env().WHATSAPP_PHONE_ID;
  if (!token || !phoneId || !numbers?.length) return { skipped: true };
  for (const raw of numbers) {
    const to = String(raw).replace(/[^0-9]/g, '');
    if (!to) continue;
    try {
      const r = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
      });
      if (!r.ok) app.log.warn('whatsapp send failed: ' + (await r.text()).slice(0, 200));
    } catch (e) { app.log.warn('whatsapp send error: ' + e.message); }
  }
  return { sent: true };
}
