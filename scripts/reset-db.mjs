// ParentFirst — wipe all user data for a fresh start. IRREVERSIBLE.
//
//   node scripts/reset-db.mjs           show what is there, delete NOTHING
//   node scripts/reset-db.mjs --yes     actually wipe it
//
// Preserves the static catalogue (reference_ranges, activities) and the
// migration ledger (schema_migrations) — everything a person created goes.
//
// To target PRODUCTION, pass its URL inline so it never touches your shell
// default or this repo's .env:
//   DATABASE_URL="<Render External Connection String>" node scripts/reset-db.mjs
//   DATABASE_URL="<Render External Connection String>" node scripts/reset-db.mjs --yes
import 'dotenv/config';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('\nNo DATABASE_URL.\n'); process.exit(1); }
const CONFIRM = process.argv.includes('--yes');
const host = (url.match(/@([^/:]+)/) || [])[1] || '(unknown host)';
const isRemote = /render\.com|neon|supabase|amazonaws|railway/.test(url);

const PRESERVE = ['schema_migrations', 'reference_ranges', 'activities'];

const pool = new pg.Pool({
  connectionString: url,
  ssl: isRemote ? { rejectUnauthorized: false } : undefined,
});

try {
  // discover the real tables, so this works on any schema version
  const { rows: tbls } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
  const targets = tbls.map(r => r.tablename).filter(t => !PRESERVE.includes(t));

  console.log(`\n  Database host: ${host}`);
  console.log(`  ${isRemote ? '⚠  THIS LOOKS LIKE A REMOTE / PRODUCTION DATABASE' : 'local database'}\n`);
  console.log('  Rows that would be deleted:');
  let total = 0;
  for (const t of targets) {
    const { rows: [{ c }] } = await pool.query(`SELECT count(*)::int c FROM "${t}"`);
    if (c > 0) { console.log(`    ${String(c).padStart(5)}  ${t}`); total += c; }
  }
  console.log(`\n  Preserved untouched: ${PRESERVE.join(', ')}`);
  console.log(`  Total rows to delete: ${total}\n`);

  if (!CONFIRM) {
    console.log('  DRY RUN — nothing was deleted.');
    console.log('  Re-run with --yes to wipe.\n');
    process.exit(0);
  }
  if (total === 0) { console.log('  Already empty. Nothing to do.\n'); process.exit(0); }

  // one statement, CASCADE handles every dependent row and FK order
  const list = targets.map(t => `"${t}"`).join(', ');
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  console.log(`  ✓ Wiped ${total} rows across ${targets.length} tables. Fresh start.\n`);
} catch (e) {
  console.error('\n  Failed:', e.message, '\n');
  process.exit(1);
} finally {
  await pool.end();
}
