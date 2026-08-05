// Create the family's accounts in one go.
// Usage:  node scripts/seed-family.js
//
// Creates 5 logins, all with password "parentfirst123" (change them after!):
//   dhanshree@family.local  admin      — full control
//   harsheeta@family.local  admin      — full control
//   jyoti@family.local      member     — view, book, message
//   harish@family.local     dependent  — the elder: his own "My Day" screen
//   ramu@family.local       caregiver  — marks medicines, logs the day
import 'dotenv/config';
import pg from 'pg';
import crypto from 'node:crypto';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ||
    `postgres://${process.env.USER || 'postgres'}@localhost:5432/parentfirst_vault`,
});

const PASSWORD = 'parentfirst123';
function hash(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(p, salt, 64).toString('hex')}`;
}

const PEOPLE = [
  { email: 'dhanshree@family.local', name: 'Dhanshree', role: 'admin' },
  { email: 'harsheeta@family.local', name: 'Harsheeta', role: 'admin' },
  { email: 'jyoti@family.local',     name: 'Jyoti',     role: 'member' },
  { email: 'harish@family.local',    name: 'Harish',    role: 'dependent' },
  { email: 'ramu@family.local',      name: 'Ramu Kaka', role: 'caregiver' },
];

async function upsertUser(client, p) {
  const { rows } = await client.query('SELECT id FROM users WHERE email=$1', [p.email]);
  if (rows[0]) {
    await client.query('UPDATE users SET password_hash=$2, name=$3, onboarded=true WHERE id=$1',
      [rows[0].id, hash(PASSWORD), p.name]);
    return rows[0].id;
  }
  const { rows: n } = await client.query(
    'INSERT INTO users (email, name, password_hash, onboarded) VALUES ($1,$2,$3,true) RETURNING id',
    [p.email, p.name, hash(PASSWORD)]);
  return n[0].id;
}

const client = await pool.connect();
try {
  await client.query('BEGIN');

  const ids = {};
  for (const p of PEOPLE) ids[p.role === 'admin' ? p.name : p.role] = await upsertUser(client, p);
  const dhanshreeId = ids['Dhanshree'];
  const harshetaId = ids['Harsheeta'];
  const jyotiId = ids['member'];
  const harishId = ids['dependent'];
  const ramuId = ids['caregiver'];

  // The cared-for person: Harish. He also logs in himself (user_id).
  let { rows: pr } = await client.query(
    `SELECT id FROM parents WHERE name ILIKE 'Harish%' ORDER BY created_at LIMIT 1`);
  let parentId;
  if (pr[0]) {
    parentId = pr[0].id;
    await client.query('UPDATE parents SET user_id=$2 WHERE id=$1', [parentId, harishId]);
  } else {
    const { rows } = await client.query(
      `INSERT INTO parents (name, age, relation, city, created_by, user_id)
       VALUES ('Harish Khandelwal', 85, 'father', 'Bengaluru', $1, $2) RETURNING id`,
      [dhanshreeId, harishId]);
    parentId = rows[0].id;
  }
  await client.query(
    `INSERT INTO care_profiles (parent_id, mobility, eyesight, hearing, text_size)
     VALUES ($1,'stick','glasses','aid','large') ON CONFLICT (parent_id) DO NOTHING`, [parentId]);

  const links = [
    [dhanshreeId, 'admin'], [harshetaId, 'admin'], [jyotiId, 'member'],
    [harishId, 'dependent'], [ramuId, 'caregiver'],
  ];
  for (const [uid, role] of links) {
    await client.query(
      `INSERT INTO family_members (user_id, parent_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, parent_id) DO UPDATE SET role=$3`, [uid, parentId, role]);
  }

  await client.query('COMMIT');

  console.log('\n✓ Family accounts ready. Password for all: ' + PASSWORD + '\n');
  console.log('  ADMIN      dhanshree@family.local   full control');
  console.log('  ADMIN      harsheeta@family.local   full control');
  console.log('  MEMBER     jyoti@family.local       view, book, message');
  console.log('  DEPENDENT  harish@family.local      his own "My Day" screen');
  console.log('  CAREGIVER  ramu@family.local        marks medicines, logs the day');
  console.log('\n  All five are linked to: Harish Khandelwal\n');
  console.log('  Change these passwords with:');
  console.log('    node scripts/reset-password.js <email> <new-password>\n');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('Failed:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
