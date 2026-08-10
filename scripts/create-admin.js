// Create the first admin account on a live server (no default passwords).
// Usage:  node scripts/create-admin.js you@email.com "Your Name" 'a-strong-password'
import 'dotenv/config';
import pg from 'pg';
import crypto from 'node:crypto';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

const [, , email, name, password] = process.argv;
if (!email || !name || !password) {
  console.error('Usage: node scripts/create-admin.js you@email.com "Your Name" \'password\'');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Use at least 10 characters for a live server.');
  process.exit(1);
}

try {
  const { rows: exists } = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
  if (exists[0]) {
    await pool.query('UPDATE users SET password_hash=$2, name=$3 WHERE id=$1',
      [exists[0].id, hashPassword(password), name]);
    console.log(`\n✓ Updated the existing account for ${email}\n`);
  } else {
    await pool.query(
      'INSERT INTO users (email, name, password_hash, onboarded, verified) VALUES ($1,$2,$3,false,true)',
      [email.toLowerCase(), name, hashPassword(password)]);
    console.log(`\n✓ Created ${email}. Sign in and the intake will run.\n`);
  }
} catch (e) {
  console.error('Failed:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
