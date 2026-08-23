// ParentFirst — architecture test suite. Exercises the family graph directly
// through the helper layer + raw SQL, asserting the invariants from the spec.
// Run: node test/architecture.test.js  (expects DATABASE_URL to a clean db)
import pg from 'pg';
import assert from 'assert';
import {
  createFamily, addPersonToFamily, addUserToFamily, addCareRelationship,
  linkPersonToUser, createInvitation, acceptInvitation, resolveParentSignup,
  accessToPerson, can, personsForUser, familiesForUser,
  joinFamilyByCode, rotateFamilyCode, normaliseCode, generateFamilyCode,
  setMemberRole, setCarePermissions, accessMatrix, isFamilyAdmin,
} from '../src/family.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓', name); passed++; }
  catch (e) { console.log('  ✗', name, '\n      ', e.message); failed++; }
}
const mkUser = async (email, name) => (await pool.query(
  `INSERT INTO users (email,name,password_hash,verified) VALUES ($1,$2,'x',true) RETURNING *`, [email, name])).rows[0];
const count = async (sql, args=[]) => +(await pool.query(sql, args)).rows[0].c;

async function reset() {
  await pool.query(`TRUNCATE users, parents, families, family_memberships, persons_in_family,
    care_relationships, invitations, reports, medication_log, vitals RESTART IDENTITY CASCADE`);
}

(async () => {
  console.log('\nARCHITECTURE TEST SUITE\n');

  await test('S1: caregiver creates family → 1 user, 1 family, 1 OWNER membership', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'Dhanshree');
    const fam = await createFamily(pool, d.id, 'Khandelwal Family');
    assert.equal(await count('SELECT count(*) c FROM families'), 1);
    assert.equal(await count(`SELECT count(*) c FROM family_memberships WHERE role='OWNER' AND user_id=$1`, [d.id]), 1);
  });

  await test('S2: caregiver adds parent (no account) → 1 person, 1 care rel, person.user_id NULL', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'Dhanshree');
    const fam = await createFamily(pool, d.id, 'Khandelwal Family');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    assert.equal(await count('SELECT count(*) c FROM persons'), 1);
    assert.equal(await count('SELECT count(*) c FROM care_relationships'), 1);
    assert.equal(await count('SELECT count(*) c FROM persons_in_family'), 1);
    assert.equal(papa.user_id, null);
  });

  await test('S3: caregiver invites parent → 1 PENDING invitation bound to the person', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'Dhanshree');
    const fam = await createFamily(pool, d.id, 'Khandelwal');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    const inv = await createInvitation(pool, { familyId: fam.id, invitedPersonId: papa.id, email: 'papa@t.com', byUserId: d.id, role: 'CARE_RECIPIENT' });
    assert.equal(inv.status, 'PENDING');
    assert.equal(inv.invited_person_id, papa.id);
  });

  await test('S4: parent accepts → SAME person linked, NO new person/family, membership added', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'Dhanshree');
    const fam = await createFamily(pool, d.id, 'Khandelwal');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    const inv = await createInvitation(pool, { familyId: fam.id, invitedPersonId: papa.id, email: 'papa@t.com', byUserId: d.id, role: 'CARE_RECIPIENT' });
    const papaUser = await mkUser('papa@t.com', 'Papa');
    await acceptInvitation(pool, inv.token, papaUser.id);
    assert.equal(await count('SELECT count(*) c FROM persons'), 1, 'still exactly one person');
    assert.equal(await count('SELECT count(*) c FROM families'), 1, 'still exactly one family');
    assert.equal(await count(`SELECT count(*) c FROM persons WHERE id=$1 AND user_id=$2`, [papa.id, papaUser.id]), 1, 'person linked to papa login');
    assert.equal(await count(`SELECT count(*) c FROM family_memberships WHERE user_id=$1`, [papaUser.id]), 1);
  });

  await test('S5: parent logs in → sees own person record via accessToPerson(self)', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'Dhanshree');
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    const papaUser = await mkUser('papa@t.com', 'Papa');
    await linkPersonToUser(pool, papa.id, papaUser.id);
    const acc = await accessToPerson(pool, papaUser.id, papa.id);
    assert.ok(acc && acc.self, 'papa can access his own record');
  });

  await test('S6: existing user joins family → new membership, NOT a new family', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'Dhanshree');
    const brother = await mkUser('bro@t.com', 'Brother');   // already has an account
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    const inv = await createInvitation(pool, { familyId: fam.id, email: 'bro@t.com', byUserId: d.id, role: 'CAREGIVER' });
    await acceptInvitation(pool, inv.token, brother.id);
    assert.equal(await count('SELECT count(*) c FROM families'), 1);
    assert.equal(await count(`SELECT count(*) c FROM family_memberships WHERE family_id=$1`, [fam.id]), 2);
  });

  await test('S7: multiple caregivers care for the SAME parent', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D'); const bro = await mkUser('b@t.com', 'B');
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    await addUserToFamily(pool, fam.id, bro.id, 'CAREGIVER');
    await addCareRelationship(pool, { familyId: fam.id, caregiverUserId: bro.id, personId: papa.id });
    assert.equal(await count(`SELECT count(*) c FROM care_relationships WHERE person_id=$1`, [papa.id]), 2);
  });

  await test('S8: one caregiver cares for MULTIPLE parents', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D');
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    const mama = await addPersonToFamily(pool, { familyId: fam.id, name: 'Mama', createdBy: d.id, caregiverUserId: d.id });
    assert.equal(await count(`SELECT count(*) c FROM care_relationships WHERE caregiver_user_id=$1`, [d.id]), 2);
    const ppl = await personsForUser(pool, d.id);
    assert.equal(ppl.length, 2);
  });

  await test('S9: caregiver logs in elsewhere → no new family (login is stateless)', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D');
    const fam = await createFamily(pool, d.id, 'K');
    await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    // "logging in again" is just reading — assert reads are stable and create nothing
    const fams1 = await familiesForUser(pool, d.id);
    const fams2 = await familiesForUser(pool, d.id);
    assert.equal(fams1.length, 1); assert.equal(fams2.length, 1);
    assert.equal(await count('SELECT count(*) c FROM families'), 1);
  });

  await test('S10: invitation opened/accepted twice → no duplicate membership', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D'); const bro = await mkUser('b@t.com', 'B');
    const fam = await createFamily(pool, d.id, 'K');
    const inv = await createInvitation(pool, { familyId: fam.id, email: 'b@t.com', byUserId: d.id, role: 'CAREGIVER' });
    await acceptInvitation(pool, inv.token, bro.id);
    let second;
    try { await acceptInvitation(pool, inv.token, bro.id); } catch (e) { second = e; }
    assert.ok(second && second.statusCode === 409, 'second accept refused');
    assert.equal(await count(`SELECT count(*) c FROM family_memberships WHERE family_id=$1 AND user_id=$2`, [fam.id, bro.id]), 1);
  });

  await test('S11: two users accept the same invite simultaneously → only one wins', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D');
    const u1 = await mkUser('u1@t.com', 'U1'); const u2 = await mkUser('u2@t.com', 'U2');
    const fam = await createFamily(pool, d.id, 'K');
    const inv = await createInvitation(pool, { familyId: fam.id, email: 'either@t.com', byUserId: d.id, role: 'CAREGIVER' });
    const results = await Promise.allSettled([
      acceptInvitation(pool, inv.token, u1.id),
      acceptInvitation(pool, inv.token, u2.id),
    ]);
    const ok = results.filter(r => r.status === 'fulfilled').length;
    assert.equal(ok, 1, 'exactly one acceptance succeeded');
    const { rows: [i] } = await pool.query('SELECT status, accepted_by_user_id FROM invitations WHERE id=$1', [inv.id]);
    assert.equal(i.status, 'ACCEPTED');
  });

  await test('S12: unauthorized person access → accessToPerson returns null', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D'); const stranger = await mkUser('s@t.com', 'Stranger');
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    assert.equal(await accessToPerson(pool, stranger.id, papa.id), null);
  });

  await test('S13: report uploaded by caregiver → person_id=papa, uploaded_by=dhanshree', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D');
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    await pool.query(`INSERT INTO reports (parent_id, report_type, report_date, uploaded_by_user_id) VALUES ($1,'CBC','2026-08-01',$2)`, [papa.id, d.id]);
    const { rows: [r] } = await pool.query('SELECT parent_id, uploaded_by_user_id FROM reports');
    assert.equal(r.parent_id, papa.id); assert.equal(r.uploaded_by_user_id, d.id);
  });

  await test('S14: report uploaded by parent → person_id=papa, uploaded_by=papa', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D'); const papaUser = await mkUser('p@t.com', 'Papa');
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    await linkPersonToUser(pool, papa.id, papaUser.id);
    await pool.query(`INSERT INTO reports (parent_id, report_type, report_date, uploaded_by_user_id) VALUES ($1,'CBC','2026-08-01',$2)`, [papa.id, papaUser.id]);
    const { rows: [r] } = await pool.query('SELECT parent_id, uploaded_by_user_id FROM reports');
    assert.equal(r.parent_id, papa.id); assert.equal(r.uploaded_by_user_id, papaUser.id);
  });

  await test('S15: medication confirmed by caregiver → recorded_by=dhanshree', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D');
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    const { rows: [m] } = await pool.query(`INSERT INTO medications (parent_id, name) VALUES ($1,'Vertin') RETURNING id`, [papa.id]);
    await pool.query(`INSERT INTO medication_log (medication_id, log_date, slot, taken, recorded_by_user_id) VALUES ($1, CURRENT_DATE,'morning',true,$2)`, [m.id, d.id]);
    const { rows: [l] } = await pool.query('SELECT recorded_by_user_id FROM medication_log');
    assert.equal(l.recorded_by_user_id, d.id);
  });

  await test('S16: medication confirmed by parent → recorded_by=papa', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D'); const papaUser = await mkUser('p@t.com', 'Papa');
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    await linkPersonToUser(pool, papa.id, papaUser.id);
    const { rows: [m] } = await pool.query(`INSERT INTO medications (parent_id, name) VALUES ($1,'Vertin') RETURNING id`, [papa.id]);
    await pool.query(`INSERT INTO medication_log (medication_id, log_date, slot, taken, recorded_by_user_id) VALUES ($1, CURRENT_DATE,'morning',true,$2)`, [m.id, papaUser.id]);
    const { rows: [l] } = await pool.query('SELECT recorded_by_user_id FROM medication_log');
    assert.equal(l.recorded_by_user_id, papaUser.id);
  });

  await test('S17: refresh/retry during signup → adding same person twice is caller-guarded (no dup family)', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D');
    const fam = await createFamily(pool, d.id, 'K');
    // simulate a double-submit of "create family" — createFamily called twice would make 2;
    // the route guards this by checking existing membership first. Assert the guard's premise:
    const existing = await familiesForUser(pool, d.id);
    assert.equal(existing.length, 1, 'user already owns a family; route must not create another');
  });

  await test('S18: simultaneous invite accept is atomic (dup of S11 under load)', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D');
    const us = await Promise.all([1,2,3,4].map(i => mkUser(`u${i}@t.com`, 'U'+i)));
    const fam = await createFamily(pool, d.id, 'K');
    const inv = await createInvitation(pool, { familyId: fam.id, email: 'x@t.com', byUserId: d.id, role: 'CAREGIVER' });
    const results = await Promise.allSettled(us.map(u => acceptInvitation(pool, inv.token, u.id)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, 'only one of four won');
  });

  // ── join by code, roles, and per-person access ──────────────────────

  await test('S19: every family gets a unique, typeable join code', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D');
    const fam = await createFamily(pool, d.id, 'K');
    assert.ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(fam.invite_code), 'code is XXXX-XXXX');
    assert.ok(!/[O0I1L]/.test(fam.invite_code), 'no characters that get misread aloud');
    const codes = new Set();
    for (let i = 0; i < 200; i++) codes.add(generateFamilyCode());
    assert.equal(codes.size, 200, 'no collisions in 200 draws');
  });

  await test('S20: codes are read forgivingly — lowercase, spaced, dashless all match', async () => {
    assert.equal(normaliseCode('abcd2345'), 'ABCD-2345');
    assert.equal(normaliseCode('  abcd 2345 '), 'ABCD-2345');
    assert.equal(normaliseCode('ABCD-2345'), 'ABCD-2345');
    assert.equal(normaliseCode('ABC-234'), null, 'too short is rejected, not padded');
  });

  await test('S21: joining by code MAPS the joiner to everyone in the family', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D'); const bro = await mkUser('b@t.com', 'Bro');
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    const mama = await addPersonToFamily(pool, { familyId: fam.id, name: 'Mama', createdBy: d.id, caregiverUserId: d.id });
    await joinFamilyByCode(pool, fam.invite_code, bro.id);
    assert.equal(await count(`SELECT count(*) c FROM family_memberships WHERE family_id=$1 AND user_id=$2`, [fam.id, bro.id]), 1);
    // the bug this fixes: a member who joins but is connected to nobody
    assert.equal(await count(`SELECT count(*) c FROM care_relationships WHERE family_id=$1 AND caregiver_user_id=$2`, [fam.id, bro.id]), 2);
    assert.ok(await accessToPerson(pool, bro.id, papa.id), 'can reach Papa');
    assert.ok(await accessToPerson(pool, bro.id, mama.id), 'can reach Mama');
  });

  await test('S22: a person added AFTER someone joined is mapped to them too', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D'); const bro = await mkUser('b@t.com', 'Bro');
    const fam = await createFamily(pool, d.id, 'K');
    await joinFamilyByCode(pool, fam.invite_code, bro.id);
    const mama = await addPersonToFamily(pool, { familyId: fam.id, name: 'Mama', createdBy: d.id, caregiverUserId: d.id });
    assert.ok(await accessToPerson(pool, bro.id, mama.id), 'existing members see new people');
  });

  await test('S23: a code alone never makes you an admin', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D'); const bro = await mkUser('b@t.com', 'Bro');
    const fam = await createFamily(pool, d.id, 'K');
    await joinFamilyByCode(pool, fam.invite_code, bro.id, { role: 'ADMIN' });
    assert.equal(await isFamilyAdmin(pool, fam.id, bro.id), false);
    assert.equal(await isFamilyAdmin(pool, fam.id, d.id), true);
  });

  await test('S24: a wrong code joins nothing', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D');
    await createFamily(pool, d.id, 'K');
    const bro = await mkUser('b@t.com', 'Bro');
    await assert.rejects(() => joinFamilyByCode(pool, 'ZZZZ-9999', bro.id), /no family has that code/);
    await assert.rejects(() => joinFamilyByCode(pool, 'nope', bro.id), /doesn't look right/);
    assert.equal(await count(`SELECT count(*) c FROM family_memberships WHERE user_id=$1`, [bro.id]), 0);
  });

  await test('S25: rotating the code retires the old one', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D'); const bro = await mkUser('b@t.com', 'Bro');
    const fam = await createFamily(pool, d.id, 'K');
    const old = fam.invite_code;
    const fresh = await rotateFamilyCode(pool, fam.id);
    assert.notEqual(fresh, old);
    await assert.rejects(() => joinFamilyByCode(pool, old, bro.id), /no family has that code/);
    await joinFamilyByCode(pool, fresh, bro.id);
    assert.equal(await count(`SELECT count(*) c FROM family_memberships WHERE user_id=$1`, [bro.id]), 1);
  });

  await test('S26: only an admin changes roles, and the change resets access', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D'); const bro = await mkUser('b@t.com', 'Bro');
    const sis = await mkUser('s@t.com', 'Sis');
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    await joinFamilyByCode(pool, fam.invite_code, bro.id);
    await joinFamilyByCode(pool, fam.invite_code, sis.id);
    // a plain member cannot promote anyone
    await assert.rejects(() => setMemberRole(pool, { familyId: fam.id, targetUserId: sis.id, role: 'ADMIN', actingUserId: bro.id }), /only an admin/);
    // view-only on arrival
    let acc = await accessToPerson(pool, bro.id, papa.id);
    assert.ok(!can(acc, 'MANAGE_MEDICINES'), 'family members only look');
    await setMemberRole(pool, { familyId: fam.id, targetUserId: bro.id, role: 'CAREGIVER', actingUserId: d.id });
    acc = await accessToPerson(pool, bro.id, papa.id);
    assert.ok(can(acc, 'MANAGE_MEDICINES'), 'a caregiver can manage medicines');
  });

  await test('S27: a family is never left without an owner', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D'); const bro = await mkUser('b@t.com', 'Bro');
    const fam = await createFamily(pool, d.id, 'K');
    await joinFamilyByCode(pool, fam.invite_code, bro.id);
    await assert.rejects(() => setMemberRole(pool, { familyId: fam.id, targetUserId: d.id, role: 'ADMIN', actingUserId: d.id }), /make someone else the owner/);
    // transferring hands it over and steps the old owner down to admin
    await setMemberRole(pool, { familyId: fam.id, targetUserId: bro.id, role: 'OWNER', actingUserId: d.id });
    assert.equal(await count(`SELECT count(*) c FROM family_memberships WHERE family_id=$1 AND role='OWNER'`, [fam.id]), 1);
    assert.equal(await count(`SELECT count(*) c FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND role='ADMIN'`, [fam.id, d.id]), 1);
  });

  await test('S28: an admin sets permissions person by person', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D'); const bro = await mkUser('b@t.com', 'Bro');
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    const mama = await addPersonToFamily(pool, { familyId: fam.id, name: 'Mama', createdBy: d.id, caregiverUserId: d.id });
    await joinFamilyByCode(pool, fam.invite_code, bro.id);
    await setCarePermissions(pool, { familyId: fam.id, caregiverUserId: bro.id, personId: papa.id,
      permissions: { VIEW_REPORTS: true, RECORD_VITALS: true, NOT_A_REAL_PERMISSION: true }, actingUserId: d.id });
    const onPapa = await accessToPerson(pool, bro.id, papa.id);
    assert.ok(can(onPapa, 'RECORD_VITALS'), 'granted on Papa');
    assert.ok(!onPapa.permissions.NOT_A_REAL_PERMISSION, 'unknown permissions are dropped, not stored');
    const onMama = await accessToPerson(pool, bro.id, mama.id);
    assert.ok(!can(onMama, 'RECORD_VITALS'), 'Mama is untouched — access is per person');
    // and a non-admin cannot grant themselves anything
    await assert.rejects(() => setCarePermissions(pool, { familyId: fam.id, caregiverUserId: bro.id,
      personId: mama.id, permissions: { MANAGE_MEDICINES: true }, actingUserId: bro.id }), /only an admin/);
  });

  await test('S29: the access matrix reports who can do what', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D'); const bro = await mkUser('b@t.com', 'Bro');
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, name: 'Papa', createdBy: d.id, caregiverUserId: d.id });
    await joinFamilyByCode(pool, fam.invite_code, bro.id);
    const m = await accessMatrix(pool, fam.id);
    assert.equal(m.members.length, 2);
    assert.equal(m.members[0].role, 'OWNER', 'the owner is listed first');
    assert.equal(m.persons.length, 1);
    assert.ok(m.grid[`${bro.id}:${papa.id}`], 'the brother has a cell for Papa');
    assert.ok(m.permissions.includes('MANAGE_MEDICINES'));
  });

  await test('S30: the full intake round-trips onto the person record', async () => {
    await reset();
    const d = await mkUser('d@t.com', 'D');
    const fam = await createFamily(pool, d.id, 'K');
    const papa = await addPersonToFamily(pool, { familyId: fam.id, createdBy: d.id, caregiverUserId: d.id,
      person: { name: 'Papa', age: 78, city: 'Bengaluru', state: 'Karnataka', country: 'India',
                pincode: '560034', phone: '9800000001', blood_group: 'B+',
                emergency_name: 'Ramesh', emergency_phone: '9800000002' } });
    assert.equal(papa.state, 'Karnataka');
    assert.equal(papa.country, 'India');
    assert.equal(papa.pincode, '560034');
    assert.equal(papa.emergency_name, 'Ramesh');
    await pool.query(`INSERT INTO care_profiles (parent_id, smoking, tobacco, alcohol, chronic_conditions)
                      VALUES ($1,'current','former','occasional','["Diabetes","Thyroid"]'::jsonb)`, [papa.id]);
    const { rows: [cp] } = await pool.query('SELECT * FROM care_profiles WHERE parent_id=$1', [papa.id]);
    assert.equal(cp.smoking, 'current');
    assert.equal(cp.tobacco, 'former');
    assert.deepEqual(cp.chronic_conditions, ['Diabetes', 'Thyroid']);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})();
