// Check whether operator email notifications are set up correctly.
// Usage:  node scripts/test-email.js
import 'dotenv/config';
import nodemailer from 'nodemailer';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_FROM, NOTIFY_TO } = process.env;

console.log('\n── What the app can see in .env ──');
console.log('  SMTP_HOST :', SMTP_HOST || '(missing)');
console.log('  SMTP_PORT :', SMTP_PORT || '(missing)');
console.log('  SMTP_USER :', SMTP_USER || '(missing)');
console.log('  SMTP_PASS :', SMTP_PASS ? `set, ${SMTP_PASS.length} characters` : '(missing)');
console.log('  NOTIFY_TO :', NOTIFY_TO || '(missing)');

const missing = [];
if (!SMTP_HOST) missing.push('SMTP_HOST');
if (!SMTP_USER) missing.push('SMTP_USER');
if (!SMTP_PASS) missing.push('SMTP_PASS');
if (!NOTIFY_TO) missing.push('NOTIFY_TO');
if (missing.length) {
  console.log(`\n✗ Missing from .env: ${missing.join(', ')}`);
  console.log('  Email is off, so bookings only print a banner in the server console.');
  console.log('  Add the missing lines to .env and run this again.\n');
  process.exit(1);
}

if (SMTP_PASS.includes(' ')) {
  console.log('\n⚠ Your SMTP_PASS contains spaces. Google shows the app password as');
  console.log('  "abcd efgh ijkl mnop" — remove the spaces so it is 16 characters.\n');
}

console.log('\n── Sending a test email ──');
try {
  const t = nodemailer.createTransport({
    host: SMTP_HOST,
    port: +(SMTP_PORT || 587),
    secure: +(SMTP_PORT || 587) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await t.verify();
  console.log('  ✓ Connected and signed in to the mail server');
  await t.sendMail({
    from: NOTIFY_FROM || SMTP_USER,
    to: NOTIFY_TO,
    subject: '[ParentFirst] Test — notifications are working',
    text: 'If you are reading this, booking alerts will reach you.\n\n— ParentFirst',
  });
  console.log(`  ✓ Test email sent to ${NOTIFY_TO}`);
  console.log('\n  Check your inbox (and spam). You are all set.\n');
} catch (e) {
  console.log('  ✗ Failed:', e.message);
  const m = (e.message || '').toLowerCase();
  if (m.includes('invalid login') || m.includes('username and password')) {
    console.log('\n  Gmail rejected the login. Almost always one of these:');
    console.log('   • You used your normal Gmail password. You need an APP PASSWORD.');
    console.log('     Create one at https://myaccount.google.com/apppasswords');
    console.log('   • 2-Step Verification is off — turn it on first, then create the app password.');
    console.log('   • The password still has spaces in it — remove them.\n');
  } else if (m.includes('timeout') || m.includes('econnrefused') || m.includes('enotfound')) {
    console.log('\n  Could not reach the mail server. Check SMTP_HOST/SMTP_PORT,');
    console.log('  and whether your network blocks port 587.\n');
  } else {
    console.log('');
  }
  process.exit(1);
}
