// ParentFirst — migration runner.
//
// SETUP.md used to be a list of psql commands to paste one at a time, which
// meant "which ones have I already run?" was answered from memory. This runs
// every migration in db/migrations in order, records what it applied, and
// skips those next time. Each file runs in its own transaction, so a failure
// leaves the database on the last good migration rather than half-way through
// a bad one.
//
//   npm run db:migrate          apply everything pending
//   npm run db:migrate -- --dry  show what would run, change nothing
//
// Reads DATABASE_URL from .env (same as the server), so no password is typed
// on a command line or left in shell history.
import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const DRY = process.argv.includes('--dry');

const pool = new pg.Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL,
        ssl: /neon|render|supabase|amazonaws/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false }
    : { database: 'parentfirst_vault' });

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const done = new Set(rows.map((r) => r.filename));

  // A database that predates this runner already has its early migrations
  // applied by hand — schema.sql created every table through 023 at once.
  // Re-running them fails (e.g. 004 tries to CREATE INDEX on family_members,
  // which is a view after 023). Mark them as done so only NEW files run.
  //
  // Gate the check on the LATE marker table 'families' existing, not on
  // schema_migrations being empty — a previous failed run may have written
  // a few rows before crashing, so the ledger is rarely empty on recovery.
  const { rows: [{ exists: hasFamilies }] } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='families') AS exists`);
  if (hasFamilies) {
    const backfilled = [];
    for (const f of files) {
      // stop at the first genuinely new file (024+) so it still runs
      if (/^02[4-9]_|^0[3-9][0-9]_|^[1-9][0-9]{2,}_/.test(f)) break;
      if (done.has(f)) continue;
      if (!DRY) await pool.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
      done.add(f);
      backfilled.push(f);
    }
    if (backfilled.length) {
      console.log(`  Existing database detected — ${backfilled.length} pre-024 migration(s) marked as applied.`);
      console.log('  (schema.sql already created those tables; re-running them would fail.)\n');
    }
  }

  const pending = files.filter((f) => !done.has(f));
  if (!pending.length) { console.log('\nNothing to apply — the database is up to date.\n'); }
  else console.log(`\n${pending.length} migration(s) to apply:\n`);

  for (const f of pending) {
    if (DRY) { console.log('  would run', f); continue; }
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    const c = await pool.connect();
    try {
      // Files that manage their own BEGIN/COMMIT are run as-is; the rest get
      // wrapped, so a mid-file failure never half-applies.
      const selfTx = /^\s*BEGIN\s*;/im.test(sql);
      if (!selfTx) await c.query('BEGIN');
      await c.query(sql);
      if (!selfTx) await c.query('COMMIT');
      await c.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
      console.log('  ✓', f);
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* already rolled back */ }
      console.error('  ✗', f, '\n\n   ', e.message, '\n');
      console.error('Stopped here. Nothing after this file was applied.\n');
      c.release();
      await pool.end();
      process.exit(1);
    } finally { c.release(); }
  }
  console.log('');
} catch (e) {
  // Name the actual problem — these three are what people hit, and the raw
  // driver message names none of them.
  const hint =
    /password|SASL|SCRAM|authentication/i.test(e.message)
      ? 'The password in DATABASE_URL is missing or wrong.\n    Your Postgres uses md5 auth, so it must be there:\n    postgres://USER:PASSWORD@localhost:5432/parentfirst_vault\n    If the password contains @ : / or #, percent-encode it (@ becomes %40).'
    : e.code === '3D000'
      ? 'That database does not exist yet. Create it, then load the schema:\n    createdb parentfirst_vault\n    npm run db:migrate'
    : /ECONNREFUSED/i.test(e.message)
      ? 'Postgres is not accepting connections. Start it:\n    brew services start postgresql@15'
      : 'Set DATABASE_URL in .env — see .env.example.';
  console.error('\nCould not reach the database.\n');
  console.error('   ', e.message, '\n');
  console.error('   ', hint, '\n');
  process.exit(1);
} finally {
  await pool.end();
}
