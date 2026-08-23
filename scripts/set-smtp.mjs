// ParentFirst — set the Gmail app password, verify it, and tidy .env.
//
// Run as:
//   read -rs "SMTPPW?Gmail app password: " && SMTPPW="$SMTPPW" node scripts/set-smtp.mjs; unset SMTPPW
//
// Three things, in this order:
//   1. strip the spaces Google shows in the app password ("abcd efgh ijkl mnop")
//   2. LOG IN FIRST — a bad password never reaches the file
//   3. rewrite .env keeping the FIRST occurrence of every key (which is the one
//      dotenv already honours), so a duplicated block stops silently winning
import 'dotenv/config';
import fs from 'node:fs';
import nodemailer from 'nodemailer';

const raw = process.env.SMTPPW;
if (!raw) {
  console.error('\nNo password given. Run it as:\n');
  console.error('  read -rs "SMTPPW?Gmail app password: " && SMTPPW="$SMTPPW" node scripts/set-smtp.mjs; unset SMTPPW\n');
  process.exit(1);
}
const pass = raw.replace(/\s+/g, '');            // Google prints it in groups of four
if (pass.length !== 16) {
  console.error(`\nThat is ${pass.length} characters. A Google app password is 16.`);
  console.error('Create one at https://myaccount.google.com/apppasswords — it is NOT your normal Gmail password.\n');
  process.exit(1);
}

const user = process.env.SMTP_USER;
const host = process.env.SMTP_HOST || 'smtp.gmail.com';
if (!user) { console.error('\nSMTP_USER is missing from .env.\n'); process.exit(1); }

// The single most useful diagnostic: is this actually a NEW password? If it
// matches what .env already holds, no new one was generated and Gmail will
// keep saying the same thing.
const current = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
const isSame = current && current === pass;

// Gmail listens on 587 (STARTTLS) and 465 (implicit TLS). If one is blocked by
// a network, the error looks identical to a bad password — so try both before
// blaming the credentials.
async function attempt(port) {
  const t = nodemailer.createTransport({
    host, port, secure: port === 465, auth: { user, pass },
    connectionTimeout: 15000, greetingTimeout: 15000,
  });
  try { await t.verify(); return { ok: true, port, t }; }
  catch (e) { return { ok: false, port, msg: e.message.split('\n')[0], code: e.code, resp: e.responseCode }; }
}

console.log(`\nLogging in to ${host} as ${user}`);
let win = null; const tried = [];
for (const port of [+(process.env.SMTP_PORT || 587), 465, 587].filter((v, i, a) => a.indexOf(v) === i)) {
  process.stdout.write(`  port ${port}… `);
  const r = await attempt(port);
  console.log(r.ok ? 'accepted.' : 'rejected.');
  tried.push(r);
  if (r.ok) { win = r; break; }
}

if (!win) {
  const auth = tried.find(r => r.resp === 535 || /Username and Password not accepted|Invalid login/i.test(r.msg || ''));
  const net  = tried.find(r => /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ESOCKET/.test(r.code || ''));
  console.log('');
  if (auth) {
    console.error('  Google rejected the credentials on every port.\n');
    if (isSame) {
      console.error('  >> The password you just typed is THE SAME ONE already in .env. <<');
      console.error('     So no new app password was created — that is the whole problem.');
      console.error('     Go to https://myaccount.google.com/apppasswords while signed in');
      console.error(`     as ${user}, create a NEW one, and use that.\n`);
    } else {
      console.error('  It is a different password from the one in .env, so it did reach Google');
      console.error('  and Google said no. That leaves:');
      console.error(`    • it was created on a different account (must be ${user})`);
      console.error('    • 2-Step Verification is off, so it is not a real app password');
      console.error('    • the account is too new or restricted for SMTP');
      console.error('    • it is a Workspace account whose admin blocks app passwords\n');
    }
  } else if (net) {
    console.error(`  Could not reach ${host} at all (${net.code}). This is the network,`);
    console.error('  not the password — a firewall or VPN is blocking outbound SMTP.\n');
  } else {
    console.error('  ', tried.map(r => `port ${r.port}: ${r.msg}`).join('\n   '), '\n');
  }
  console.error('  Nothing was written. Email stays off; verification codes still work —');
  console.error('  they are logged by the server and stored in the database.\n');
  process.exit(1);
}
const t = win.t;
if (win.port !== +(process.env.SMTP_PORT || 587)) {
  console.log(`  (port ${win.port} worked — updating SMTP_PORT to match)`);
}

// Send one for real, so "accepted" means an email actually lands.
process.stdout.write('Sending a test message… ');
try {
  await t.sendMail({
    from: process.env.NOTIFY_FROM || user,
    to: process.env.NOTIFY_TO || user,
    subject: '[ParentFirst] Email is working',
    text: 'If you are reading this, verification codes and family invites will reach people.\n\n— ParentFirst',
  });
  console.log(`sent to ${process.env.NOTIFY_TO || user}.`);
} catch (e) { console.log('failed: ' + e.message); process.exit(1); }

// Rewrite .env: first occurrence of each key wins (matching dotenv), duplicates dropped.
const lines = fs.readFileSync('.env', 'utf8').split('\n');
const seen = new Set(); const out = []; let dropped = 0;
for (const line of lines) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (!m) { out.push(line); continue; }
  if (seen.has(m[1])) { dropped++; continue; }
  seen.add(m[1]);
  out.push(m[1] === 'SMTP_PASS' ? `SMTP_PASS=${pass}`
         : m[1] === 'SMTP_PORT' ? `SMTP_PORT=${win.port}` : line);
}
if (!seen.has('SMTP_PASS')) out.push(`SMTP_PASS=${pass}`);
fs.writeFileSync('.env', out.join('\n').replace(/\n{3,}/g, '\n\n'));
fs.chmodSync('.env', 0o600);
console.log(`\n.env updated${dropped ? ` — ${dropped} duplicate line(s) removed` : ''}.\n`);
console.log('Restart the server for it to take effect:\n\n  npm start\n');
