import 'dotenv/config';
import nodemailer from 'nodemailer';
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_FROM, NOTIFY_TO } = process.env;
console.log('\n-- What the app sees in .env --');
console.log('  SMTP_HOST :', SMTP_HOST || '(missing)');
console.log('  SMTP_USER :', SMTP_USER || '(missing)');
console.log('  SMTP_PASS :', SMTP_PASS ? SMTP_PASS.length + ' characters' : '(missing)');
console.log('  NOTIFY_TO :', NOTIFY_TO || '(missing)');
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !NOTIFY_TO) {
  console.log('\nMissing values above. Email is off; bookings still print in the server console.\n');
  process.exit(1);
}
if (SMTP_PASS.includes(' ')) console.log('\nWARNING: password has spaces. Remove them (should be 16 chars).');
try {
  const t = nodemailer.createTransport({ host: SMTP_HOST, port: +(SMTP_PORT||587), secure: +(SMTP_PORT||587)===465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
  await t.verify();
  console.log('\n  Connected and signed in OK');
  await t.sendMail({ from: NOTIFY_FROM||SMTP_USER, to: NOTIFY_TO, subject: '[ParentFirst] Test', text: 'Notifications are working.' });
  console.log('  Test email sent to ' + NOTIFY_TO + ' — check inbox and spam.\n');
} catch (e) {
  console.log('\n  FAILED: ' + e.message);
  if ((e.message||'').toLowerCase().includes('login') || (e.message||'').toLowerCase().includes('password'))
    console.log('  Gmail rejected it — you need an App Password (needs 2-Step Verification on).\n');
  else console.log('');
  process.exit(1);
}
