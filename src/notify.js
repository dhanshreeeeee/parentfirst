// Operator notifications.
// While bookings are fulfilled by hand, the operator needs to KNOW the moment
// something comes in. Sends email if SMTP is configured in .env; always logs
// loudly to the server console as a fallback so nothing is silently missed.
import nodemailer from 'nodemailer';

const {
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
  NOTIFY_FROM, NOTIFY_TO,
} = process.env;

let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: +(SMTP_PORT || 587),
    secure: +(SMTP_PORT || 587) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

export function notifyConfigured() {
  return !!transporter && !!NOTIFY_TO;
}

function banner(title, lines) {
  const w = 64;
  const bar = '─'.repeat(w);
  return ['\n┌' + bar + '┐',
    '  ' + title,
    bar,
    ...lines.map((l) => '  ' + l),
    '└' + bar + '┘\n'].join('\n');
}

/**
 * Send to specific people (the family), falling back to the operator address.
 * @param {object} app
 * @param {string[]} recipients  email addresses
 * @param {string} subject
 * @param {string[]} lines
 */
export async function notifyPeople(app, recipients, subject, lines) {
  const to = (recipients || []).filter(Boolean).join(', ') || NOTIFY_TO;
  try { app.log.info(banner(subject + ' → ' + to, lines)); } catch { console.log(banner(subject, lines)); }
  if (!transporter || !to) return { sent: false, reason: 'SMTP not configured' };
  try {
    await transporter.sendMail({
      from: NOTIFY_FROM || SMTP_USER,
      to,
      subject: `[ParentFirst] ${subject}`,
      text: lines.join('\n') + '\n\n— ParentFirst',
    });
    return { sent: true, to };
  } catch (e) {
    try { app.log.error('notify email failed: ' + e.message); } catch { /* ignore */ }
    return { sent: false, reason: e.message };
  }
}

/**
 * @param {object} app    fastify instance (for logging)
 * @param {string} subject
 * @param {string[]} lines  plain-text detail lines
 */
export async function notifyOperator(app, subject, lines) {
  // always log — this is the guaranteed channel
  try { app.log.info(banner(subject, lines)); } catch { console.log(banner(subject, lines)); }

  if (!transporter || !NOTIFY_TO) return { sent: false, reason: 'SMTP not configured' };
  try {
    await transporter.sendMail({
      from: NOTIFY_FROM || SMTP_USER,
      to: NOTIFY_TO,
      subject: `[ParentFirst] ${subject}`,
      text: lines.join('\n') + '\n\n— ParentFirst',
    });
    return { sent: true };
  } catch (e) {
    try { app.log.error('notify email failed: ' + e.message); } catch { /* ignore */ }
    return { sent: false, reason: e.message };
  }
}

// ── WhatsApp via Meta Cloud API ──
// Activates only when WHATSAPP_TOKEN and WHATSAPP_PHONE_ID are in .env.
// Numbers must be E.164 without '+' (e.g. 9198xxxxxx01). Free-form text works
// inside the 24-hour session window; outside it Meta requires a template.
export async function sendWhatsApp(app, numbers, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
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
