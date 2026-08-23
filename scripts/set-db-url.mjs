// ParentFirst — write DATABASE_URL into .env without the password ever
// appearing on a command line or in shell history.
//
// The password arrives in $PGPW (set by `read -s`, which does not echo and is
// a shell builtin, so nothing is recorded). We percent-encode it — a password
// containing @ : / ? # or % silently corrupts a connection URL otherwise, and
// the resulting error names the user, not the real cause.
//
// Then it connects, so you find out here whether the password is right rather
// than three commands later.
import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';

// Two ways in: a whole URL you already have written down ($PGURL), or just
// the password ($PGPW), which we encode into a URL ourselves. Either way the
// value arrives through the environment, never on the command line.
const pw  = process.env.PGPW;
const raw = process.env.PGURL;

if (!pw && !raw) {
  console.error('\nNothing given. Run it one of these two ways:\n');
  console.error('  read -rs "PGPW?Postgres password: " && PGPW="$PGPW" node scripts/set-db-url.mjs; unset PGPW');
  console.error('  PGURL="postgresql://user:pass@localhost:5432/parentfirst_vault" node scripts/set-db-url.mjs\n');
  process.exit(1);
}

const user = process.env.PGUSER || process.env.USER || 'postgres';
const db   = process.env.PGDATABASE || 'parentfirst_vault';
const url  = raw
  ? raw.trim().replace(/^["']|["']$/g, '')
  : `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pw)}@localhost:5432/${db}`;

// Check it BEFORE writing, so a wrong password never lands in the file.
process.stdout.write('Testing the connection… ');
const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
try {
  const { rows: [r] } = await pool.query('SELECT current_user, current_database()');
  console.log(`connected as ${r.current_user} to ${r.current_database}.`);
} catch (e) {
  console.log('failed.\n');
  if (/password|SASL|SCRAM|authentication/i.test(e.message)) {
    console.error('   That password was not accepted. Nothing was written.\n');
  } else if (e.code === '3D000') {
    console.error(`   The password is fine, but the database "${db}" does not exist yet.`);
    console.error('   Create it and run this again:\n');
    console.error('     createdb ' + db + '\n');
  } else if (/ECONNREFUSED/i.test(e.message)) {
    console.error('   Postgres is not running:\n\n     brew services start postgresql@15\n');
  } else {
    console.error('  ', e.message, '\n');
  }
  await pool.end();
  process.exit(1);
}
await pool.end();

// Replace the DATABASE_URL line in place, keeping every comment around it.
let env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
env = /^DATABASE_URL=.*$/m.test(env)
  ? env.replace(/^DATABASE_URL=.*$/m, 'DATABASE_URL=' + url)
  : (env.trimEnd() + '\nDATABASE_URL=' + url + '\n');
fs.writeFileSync('.env', env);
fs.chmodSync('.env', 0o600);   // the file now holds a password

// Deliberately not echoed — it contains the password.
console.log('\nDATABASE_URL written to .env (readable only by you).\n');
console.log('Next:\n\n  npm run db:migrate\n  npm start\n');
