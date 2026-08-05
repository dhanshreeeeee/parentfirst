// Move the demo medicines/reports from the seeded "Ramesh Sharma" record
// onto the real parent (Harish), so a freshly seeded family has data to see.
// Usage: node scripts/move-demo-data.js
import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ||
  `postgres://${process.env.USER||'postgres'}@localhost:5432/parentfirst_vault` });
const q = (s,p)=>pool.query(s,p);
const { rows: to } = await q(`SELECT id,name FROM parents WHERE user_id IS NOT NULL ORDER BY created_at LIMIT 1`);
const { rows: from } = await q(`SELECT id,name FROM parents WHERE name ILIKE 'Ramesh%' LIMIT 1`);
if(!to[0]){ console.log('No dependent parent found — run scripts/seed-family.js first.'); process.exit(0); }
if(!from[0] || from[0].id===to[0].id){ console.log('Nothing to move.'); process.exit(0); }
for(const t of ['medications','reports','daily_logs','care_team','appointments','contacts','service_requests']){
  const r = await q(`UPDATE ${t} SET parent_id=$1 WHERE parent_id=$2`, [to[0].id, from[0].id]);
  console.log(`  ${t}: moved ${r.rowCount}`);
}
await q(`UPDATE parents SET blood_group=COALESCE(blood_group,(SELECT blood_group FROM parents WHERE id=$2)),
   allergies=COALESCE(allergies,(SELECT allergies FROM parents WHERE id=$2)),
   conditions=COALESCE(conditions,(SELECT conditions FROM parents WHERE id=$2)),
   primary_doctor=COALESCE(primary_doctor,(SELECT primary_doctor FROM parents WHERE id=$2)),
   doctor_phone=COALESCE(doctor_phone,(SELECT doctor_phone FROM parents WHERE id=$2)) WHERE id=$1`,[to[0].id, from[0].id]);
console.log(`\n✓ Demo data now belongs to ${to[0].name}.\n`);
await pool.end();
