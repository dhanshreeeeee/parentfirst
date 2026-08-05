// Reset a user's password from the command line.
// Usage:  node scripts/reset-password.js you@email.com newpassword123
//         node scripts/reset-password.js --list          (show all accounts)
import 'dotenv/config';
import pg from 'pg';
import crypto from 'node:crypto';

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    `postgres://${process.env.USER || 'postgres'}@localhost:5432/parentfirst_vault`,
});

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const [, , arg1, arg2] = process.argv;

try {
  if (!arg1 || arg1 === '--list') {
    const { rows } = await pool.query('SELECT email, name, created_at FROM users ORDER BY created_at');
    if (!rows.length) {
      console.log('No accounts yet. Start the server once and it will create the default admin.');
    } else {
      console.log('\nAccounts in this database:\n');
      for (const u of rows) console.log(`  ${u.email}   (${u.name})`);
      console.log('\nTo reset one:\n  node scripts/reset-password.js <email> <new-password>\n');
    }
    process.exit(0);
  }

  const email = arg1.toLowerCase();
  const newPassword = arg2;
  if (!newPassword || newPassword.length < 8) {
    console.error('Password must be at least 8 characters.');
    console.error('Usage: node scripts/reset-password.js you@email.com newpassword123');
    process.exit(1);
  }

  const { rowCount } = await pool.query(
    'UPDATE users SET password_hash=$2 WHERE email=$1',
    [email, hashPassword(newPassword)]);

  if (!rowCount) {
    console.error(`No account found for ${email}.`);
    console.error('Run "node scripts/reset-password.js --list" to see the accounts that exist.');
    process.exit(1);
  }

  // sign out existing sessions for safety
  await pool.query(
    'DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email=$1)', [email]);

  console.log(`\n✓ Password updated for ${email}`);
  console.log('  All existing sessions were signed out. Log in with the new password.\n');
} catch (e) {
  console.error('Failed:', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
