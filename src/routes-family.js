// ParentFirst — family / membership / invitation / care-relationship routes.
// Thin HTTP wrappers over src/family.js. All authorization is server-side.
import {
  createFamily, addPersonToFamily, addUserToFamily, addCareRelationship,
  createInvitation, acceptInvitation, resolveParentSignup, linkPersonToUser,
  familiesForUser, personsForUser, accessToPerson, DEFAULT_CAREGIVER_PERMS,
} from './family.js';

export default async function familyRoutes(app, { pool }) {
  const uid = (req) => req.user.id;

  // ── families the user belongs to (for the family switcher) ──
  app.get('/api/families', async (req) => ({ families: await familiesForUser(pool, uid(req)) }));

  // ── create a family (guarded: onboarding calls this once) ──
  app.post('/api/families', async (req, reply) => {
    const { name } = req.body || {};
    if (!name) return reply.code(400).send({ error: 'family name required' });
    const fam = await createFamily(pool, uid(req), name.trim());
    return fam;
  });

  // ── people in a family the user can see (care-recipient switcher) ──
  app.get('/api/families/:familyId/persons', async (req, reply) => {
    const member = await pool.query(
      `SELECT 1 FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND status='ACTIVE'`,
      [req.params.familyId, uid(req)]);
    if (!member.rows[0]) return reply.code(403).send({ error: 'not a member of this family' });
    const { rows } = await pool.query(
      `SELECT p.* FROM persons p JOIN persons_in_family pif ON pif.person_id=p.id
       WHERE pif.family_id=$1 ORDER BY p.name`, [req.params.familyId]);
    return { persons: rows };
  });

  // ── add a person (a parent) to a family + care relationship from the creator ──
  app.post('/api/families/:familyId/persons', async (req, reply) => {
    const { name, age, relation, city } = req.body || {};
    if (!name) return reply.code(400).send({ error: 'name required' });
    const owner = await pool.query(
      `SELECT role FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND status='ACTIVE'`,
      [req.params.familyId, uid(req)]);
    if (!owner.rows[0]) return reply.code(403).send({ error: 'not a member of this family' });
    const person = await addPersonToFamily(pool, {
      familyId: req.params.familyId, name, age, relation, city,
      createdBy: uid(req), caregiverUserId: uid(req),
    });
    return person;
  });

  // ── members of a family ──
  app.get('/api/families/:familyId/members', async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT fm.role, fm.status, u.id AS user_id, u.name, u.email
       FROM family_memberships fm JOIN users u ON u.id=fm.user_id
       WHERE fm.family_id=$1 ORDER BY fm.created_at`, [req.params.familyId]);
    return { members: rows };
  });

  // ── invite someone to the family (optionally bound to an existing person) ──
  app.post('/api/families/:familyId/invitations', async (req, reply) => {
    const { email, phone, person_id, role, intended_care } = req.body || {};
    const membership = await pool.query(
      `SELECT role FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND status='ACTIVE'`,
      [req.params.familyId, uid(req)]);
    if (!membership.rows[0]) return reply.code(403).send({ error: 'not a member of this family' });
    if (!email && !phone) return reply.code(400).send({ error: 'email or phone required' });
    const inv = await createInvitation(pool, {
      familyId: req.params.familyId, invitedPersonId: person_id || null,
      email, phone, byUserId: uid(req), role: role || 'FAMILY_MEMBER', intendedCare: !!intended_care,
    });
    // email the invite link so "enter their email" actually reaches them
    let emailed = false;
    if (email) {
      try {
        const { rows: [fam] } = await pool.query('SELECT name FROM families WHERE id=$1', [req.params.familyId]);
        const { rows: [inviter] } = await pool.query('SELECT name FROM users WHERE id=$1', [uid(req)]);
        const base = process.env.APP_URL || 'https://parentfirst.onrender.com';
        const link = base + '/?invite=' + inv.token;
        const { notifyPeople } = await import('./notify.js');
        await notifyPeople(app, [email.toLowerCase()],
          (inviter?.name || 'Your family') + ' invited you to ' + (fam?.name || 'their family') + ' on ParentFirst',
          [
            (inviter?.name || 'Someone') + ' is inviting you to join ' + (fam?.name || 'their family') + ' on ParentFirst,',
            'a private space where your family looks after each other\'s health together.',
            '',
            'Open this link, create your account, and you\'re in:',
            link,
            '',
            'The link works for 14 days. If this wasn\'t meant for you, just ignore it.',
          ]);
        emailed = true;
      } catch (e) { req.log.error('invite email: ' + e.message); }
    }
    return { invitation: { token: inv.token, status: inv.status, expires_at: inv.expires_at, emailed } };
  });

  // ── public: peek at an invitation (what family am I being asked to join?) ──
  app.get('/api/invitations/:token/peek', async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT i.status, i.intended_role, f.name AS family_name,
              p.name AS person_name, u.name AS invited_by
       FROM invitations i JOIN families f ON f.id=i.family_id
       LEFT JOIN persons p ON p.id=i.invited_person_id
       LEFT JOIN users u ON u.id=i.invited_by_user_id
       WHERE i.token=$1`, [req.params.token]);
    if (!rows[0]) return reply.code(404).send({ error: 'invitation not found' });
    return rows[0];
  });

  // ── accept an invitation (must be logged in) ──
  app.post('/api/invitations/:token/accept', { config: {}, }, async (req, reply) => {
    try {
      const inv = await acceptInvitation(pool, req.params.token, uid(req), { asMember: !!(req.body && req.body.as_member) });
      return { accepted: true, family_id: inv.family_id };
    } catch (e) {
      return reply.code(e.statusCode || 400).send({ error: e.message });
    }
  });

  // ── revoke an invitation (inviter/owner) ──
  app.post('/api/invitations/:token/revoke', async (req, reply) => {
    const { rows } = await pool.query(
      `UPDATE invitations SET status='REVOKED'
       WHERE token=$1 AND status='PENDING'
         AND family_id IN (SELECT family_id FROM family_memberships WHERE user_id=$2 AND role IN ('OWNER','CAREGIVER'))
       RETURNING id`, [req.params.token, uid(req)]);
    if (!rows[0]) return reply.code(404).send({ error: 'nothing to revoke' });
    return { revoked: true };
  });

  // ── establish/adjust a care relationship (owner action) ──
  app.post('/api/families/:familyId/care-relationships', async (req, reply) => {
    const { caregiver_user_id, person_id, relationship, permissions } = req.body || {};
    const owner = await pool.query(
      `SELECT 1 FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND role IN ('OWNER','CAREGIVER')`,
      [req.params.familyId, uid(req)]);
    if (!owner.rows[0]) return reply.code(403).send({ error: 'only owners/caregivers can assign care' });
    const cr = await addCareRelationship(pool, {
      familyId: req.params.familyId, caregiverUserId: caregiver_user_id, personId: person_id,
      relationship, permissions: permissions || DEFAULT_CAREGIVER_PERMS,
    });
    return cr;
  });

  // ── parent-signup resolution (called by the signup screen; no mutation) ──
  app.post('/api/families/resolve-signup', async (req) => {
    const { token, email } = req.body || {};
    return await resolveParentSignup(pool, { token, email });
  });

  // ── family events board (community) ──
  app.get('/api/families/:familyId/events', async (req, reply) => {
    const m = await pool.query(`SELECT 1 FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND status='ACTIVE'`, [req.params.familyId, uid(req)]);
    if (!m.rows[0]) return reply.code(403).send({ error: 'not a member' });
    const { rows } = await pool.query(
      `SELECT * FROM events WHERE family_id=$1 ORDER BY event_date`, [req.params.familyId]);
    return rows;
  });
  app.post('/api/families/:familyId/events', async (req, reply) => {
    const m = await pool.query(`SELECT 1 FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND status='ACTIVE'`, [req.params.familyId, uid(req)]);
    if (!m.rows[0]) return reply.code(403).send({ error: 'not a member' });
    const { title, event_date, event_time, place, notes } = req.body || {};
    if (!title || !event_date) return reply.code(400).send({ error: 'title and date required' });
    const { rows } = await pool.query(
      `INSERT INTO events (family_id, title, event_date, event_time, place, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.familyId, title, event_date, event_time || null, place || null, notes || null, uid(req)]);
    return rows[0];
  });
  app.delete('/api/families/:familyId/events/:id', async (req, reply) => {
    await pool.query(`DELETE FROM events WHERE id=$1 AND family_id=$2`, [req.params.id, req.params.familyId]);
    return { deleted: true };
  });

  // ── family status board: compact status for everyone in a family, one call ──
  // Powers the carer's Today dashboard. meds + check-in + open alerts + latest vital.
  app.get('/api/families/:familyId/status', async (req, reply) => {
    const fid = req.params.familyId;
    const m = await pool.query(`SELECT 1 FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND status='ACTIVE'`, [fid, uid(req)]);
    if (!m.rows[0]) return reply.code(403).send({ error: 'not a member' });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const { rows: persons } = await pool.query(
      `SELECT p.id, p.name, p.age, p.user_id FROM persons p
       JOIN persons_in_family pif ON pif.person_id=p.id
       WHERE pif.family_id=$1 ORDER BY p.name`, [fid]);
    const cards = [];
    for (const p of persons) {
      // meds due/done today
      const { rows: meds } = await pool.query(`SELECT * FROM medications WHERE parent_id=$1 AND active=true`, [p.id]);
      const { rows: mlogs } = await pool.query(
        `SELECT ml.medication_id, ml.slot FROM medication_log ml JOIN medications md ON md.id=ml.medication_id
         WHERE md.parent_id=$1 AND ml.log_date=$2 AND ml.taken=true`, [p.id, today]);
      const taken = new Set(mlogs.map(l => `${l.medication_id}:${l.slot}`));
      let due = 0, done = 0;
      for (const md of meds) for (const s of ['morning','afternoon','night'])
        if (md[`slot_${s}`]) { due++; if (taken.has(`${md.id}:${s}`)) done++; }
      // today's check-in
      const { rows: ci } = await pool.query(
        `SELECT feeling AS mood, created_at FROM checkins WHERE parent_id=$1 AND created_at::date=$2::date ORDER BY created_at DESC LIMIT 1`, [p.id, today]);
      // open alerts
      const { rows: al } = await pool.query(
        `SELECT count(*)::int AS c FROM alerts WHERE parent_id=$1 AND status='open'`, [p.id]);
      // latest vital
      const { rows: v } = await pool.query(
        `SELECT systolic, diastolic, sugar, pulse, weight_kg, taken_on FROM vitals WHERE parent_id=$1 ORDER BY taken_on DESC, id DESC LIMIT 1`, [p.id]);
      const vit = v[0] || null;
      // status colour: red if open alerts, amber if meds incomplete or no check-in, else green
      const alerts = al[0].c;
      let tone = 'green';
      if (alerts > 0) tone = 'red';
      else if ((due > 0 && done < due) || !ci[0]) tone = 'amber';
      cards.push({
        id: p.id, name: p.name, age: p.age, has_login: !!p.user_id,
        meds: { due, done }, checkin: ci[0] ? { mood: ci[0].mood, at: ci[0].created_at } : null,
        open_alerts: alerts,
        vital: vit ? {
          bp: vit.systolic ? `${vit.systolic}/${vit.diastolic}` : null,
          sugar: vit.sugar || null, pulse: vit.pulse || null, weight: vit.weight_kg || null,
          on: vit.taken_on,
        } : null,
        tone,
      });
    }
    return { family_id: fid, date: today, persons: cards };
  });

  // ── list invitations for a family (drives the "invite sent — waiting" state) ──
  app.get('/api/families/:familyId/invitations', async (req, reply) => {
    const m = await pool.query(`SELECT 1 FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND status='ACTIVE'`,
      [req.params.familyId, uid(req)]);
    if (!m.rows[0]) return reply.code(403).send({ error: 'not a member' });
    const { rows } = await pool.query(
      `SELECT i.id, i.token, i.status, i.invited_email, i.invited_person_id, i.intended_role,
              i.created_at, i.expires_at, p.name AS person_name, u.name AS invited_by
       FROM invitations i
       LEFT JOIN persons p ON p.id=i.invited_person_id
       LEFT JOIN users u ON u.id=i.invited_by_user_id
       WHERE i.family_id=$1 AND i.status='PENDING' AND i.expires_at > now()
       ORDER BY i.created_at DESC`, [req.params.familyId]);
    return { invitations: rows };
  });

  // ── owner removes a member (not themselves; fixes wrong-role/wrong-person joins) ──
  app.delete('/api/families/:familyId/members/:userId', async (req, reply) => {
    const owner = await pool.query(
      `SELECT 1 FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND role='OWNER'`,
      [req.params.familyId, uid(req)]);
    if (!owner.rows[0]) return reply.code(403).send({ error: 'only the owner can remove members' });
    if (req.params.userId === uid(req)) return reply.code(400).send({ error: 'the owner cannot remove themselves' });
    await pool.query(`DELETE FROM care_relationships WHERE family_id=$1 AND caregiver_user_id=$2`,
      [req.params.familyId, req.params.userId]);
    await pool.query(`DELETE FROM family_memberships WHERE family_id=$1 AND user_id=$2`,
      [req.params.familyId, req.params.userId]);
    // if they had claimed a person record in this family, release it
    await pool.query(
      `UPDATE parents SET user_id=NULL WHERE user_id=$1 AND id IN
         (SELECT person_id FROM persons_in_family WHERE family_id=$2)`,
      [req.params.userId, req.params.familyId]);
    return { removed: true };
  });

  // ── owner deletes a family that has no people in it (cleans up empty duplicates) ──
  app.delete('/api/families/:familyId', async (req, reply) => {
    const owner = await pool.query(
      `SELECT 1 FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND role='OWNER'`,
      [req.params.familyId, uid(req)]);
    if (!owner.rows[0]) return reply.code(403).send({ error: 'only the owner can delete a family' });
    const ppl = await pool.query(`SELECT count(*)::int c FROM persons_in_family WHERE family_id=$1`, [req.params.familyId]);
    if (ppl.rows[0].c > 0) return reply.code(400).send({ error: 'remove the people in this family first' });
    await pool.query(`DELETE FROM families WHERE id=$1`, [req.params.familyId]);
    return { deleted: true };
  });
}
