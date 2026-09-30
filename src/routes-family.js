// ParentFirst — family / membership / invitation / care-relationship routes.
// Thin HTTP wrappers over src/family.js. All authorization is server-side.
import {
  createFamily, addPersonToFamily, addUserToFamily, addCareRelationship,
  createInvitation, acceptInvitation, resolveParentSignup, linkPersonToUser,
  familiesForUser, personsForUser, accessToPerson, DEFAULT_CAREGIVER_PERMS,
  joinFamilyByCode, rotateFamilyCode, normaliseCode, isFamilyAdmin, membershipOf,
  setMemberRole, setCarePermissions, accessMatrix, ROLES, ALL_PERMISSIONS, PERSON_COLS,
} from './family.js';
import { saveIntakeProfile } from './care-profile.js';

export default async function familyRoutes(app, { pool }) {
  const uid = (req) => req.user.id;

  // Every admin-only route starts here, so "who may do this" has one answer.
  const requireAdmin = async (req, reply) => {
    if (await isFamilyAdmin(pool, req.params.familyId, uid(req))) return true;
    reply.code(403).send({ error: 'only a family admin can do this' });
    return false;
  };
  const requireMember = async (req, reply) => {
    if (await membershipOf(pool, req.params.familyId, uid(req))) return true;
    reply.code(403).send({ error: 'not a member of this family' });
    return false;
  };

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
       WHERE pif.family_id=$1 AND (p.shared_with_family = true OR p.user_id = $2)
       ORDER BY p.name`, [req.params.familyId, uid(req)]);
    return { persons: rows };
  });

  // ── add a person to a family, with as much of their intake as the admin has.
  //    Accepts the full person record plus an optional `profile` block (the
  //    health & lifestyle answers) so the admin fills everything in one pass. ──
  app.post('/api/families/:familyId/persons', async (req, reply) => {
    const body = req.body || {};
    if (body.is_self) {
      const { name, age, city } = body;
      if (!name) return reply.code(400).send({ error: 'name required' });
      const member = await pool.query(
        `SELECT 1 FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND status='ACTIVE'`,
        [req.params.familyId, uid(req)]);
      if (!member.rows[0]) return reply.code(403).send({ error: 'not a member of this family' });
    // "is_self" = the caregiver's OWN health record: linked to their login,
    // private to them, and never listed for the rest of the family.
      const { rows: dupe } = await pool.query(
        `SELECT id FROM parents WHERE user_id=$1 AND relation='self' LIMIT 1`, [uid(req)]);
      if (dupe[0]) return reply.code(400).send({ error: 'You already have your own health record.' });
      const { rows: [p] } = await pool.query(
        `INSERT INTO parents (name, age, relation, city, created_by, user_id, shared_with_family)
         VALUES ($1,$2,'self',$3,$4,$4,false) RETURNING *`,
        [name, age || null, city || null, uid(req)]);
      await pool.query(
        `INSERT INTO persons_in_family (family_id, person_id) VALUES ($1,$2)
         ON CONFLICT (family_id, person_id) DO NOTHING`, [req.params.familyId, p.id]);
      return p;
    }
    if (!(await requireAdmin(req, reply))) return;
    if (!body.name) return reply.code(400).send({ error: 'name required' });
    const fields = {};
    for (const k of PERSON_COLS) if (body[k] !== undefined) fields[k] = body[k];
    let person;
    try {
      person = await addPersonToFamily(pool, {
        familyId: req.params.familyId, person: fields,
        createdBy: uid(req), caregiverUserId: uid(req),
      });
    } catch (e) {
      return reply.code(e.statusCode || 500).send({ error: e.message });
    }
    // the health picture, if the admin filled it in
    if (body.profile && Object.keys(body.profile).length) {
      try { await saveIntakeProfile(pool, person.id, body.profile); }
      catch (e) { req.log.error('intake profile: ' + e.message); }
    }
    return person;
  });

  // ── members of a family ──
  app.get('/api/families/:familyId/members', async (req, reply) => {
    if (!(await requireMember(req, reply))) return;
    const { rows } = await pool.query(
      `SELECT fm.role, fm.status, fm.joined_via, u.id AS user_id, u.name, u.email
       FROM family_memberships fm JOIN users u ON u.id=fm.user_id
       WHERE fm.family_id=$1 AND fm.status='ACTIVE'
       ORDER BY CASE fm.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END, fm.created_at`,
      [req.params.familyId]);
    return { members: rows, roles: ROLES };
  });

  // ═══════════ JOIN BY CODE ═══════════
  // The flow the family actually wants: everyone signs up for themselves,
  // then types the code the admin gave them. No stub records, no guessing
  // which invite belongs to whom.

  // public: what family is this code for? (so signup can say the name)
  app.get('/api/families/code/:code/peek', async (req, reply) => {
    const code = normaliseCode(req.params.code);
    if (!code) return reply.code(400).send({ error: 'that code doesn\'t look right' });
    const { rows } = await pool.query(
      `SELECT f.name AS family_name,
              (SELECT count(*) FROM family_memberships WHERE family_id=f.id AND status='ACTIVE') AS member_count,
              (SELECT u.name FROM users u WHERE u.id=f.created_by) AS created_by_name
       FROM families f WHERE f.invite_code=$1`, [code]);
    if (!rows[0]) return reply.code(404).send({ error: 'no family has that code' });
    return rows[0];
  });

  // join (must be signed in)
  app.post('/api/families/join', async (req, reply) => {
    const { code } = req.body || {};
    try {
      const r = await joinFamilyByCode(pool, code, uid(req));
      return { joined: true, already: r.already, family_id: r.family.id, family_name: r.family.name };
    } catch (e) {
      return reply.code(e.statusCode || 400).send({ error: e.message });
    }
  });

  // the admin reads the code to share it
  app.get('/api/families/:familyId/code', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { rows } = await pool.query('SELECT invite_code, code_rotated_at FROM families WHERE id=$1',
      [req.params.familyId]);
    if (!rows[0]) return reply.code(404).send({ error: 'family not found' });
    return rows[0];
  });

  // ...and rotates it when it has been shared too widely
  app.post('/api/families/:familyId/code/rotate', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const code = await rotateFamilyCode(pool, req.params.familyId);
    return { invite_code: code };
  });

  // ═══════════ ADMIN: ROLES & ACCESS ═══════════

  // the full picture: who is in the family, who they can see, and what they may do
  app.get('/api/families/:familyId/access', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return await accessMatrix(pool, req.params.familyId);
  });

  // change a member's role
  app.patch('/api/families/:familyId/members/:userId', async (req, reply) => {
    const { role } = req.body || {};
    try {
      const m = await setMemberRole(pool, {
        familyId: req.params.familyId, targetUserId: req.params.userId,
        role, actingUserId: uid(req),
      });
      return { member: m };
    } catch (e) {
      return reply.code(e.statusCode || 400).send({ error: e.message });
    }
  });

  // change what a member may do for ONE person
  app.put('/api/families/:familyId/access/:userId/:personId', async (req, reply) => {
    try {
      const cr = await setCarePermissions(pool, {
        familyId: req.params.familyId, caregiverUserId: req.params.userId,
        personId: req.params.personId, permissions: (req.body || {}).permissions || {},
        actingUserId: uid(req),
      });
      return { permissions: cr.permissions };
    } catch (e) {
      return reply.code(e.statusCode || 400).send({ error: e.message });
    }
  });

  // revoke a member's access to one person entirely
  app.delete('/api/families/:familyId/access/:userId/:personId', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    await pool.query(
      `DELETE FROM care_relationships WHERE family_id=$1 AND caregiver_user_id=$2 AND person_id=$3`,
      [req.params.familyId, req.params.userId, req.params.personId]);
    return { revoked: true };
  });

  // ── invite someone to the family (optionally bound to an existing person) ──
  app.post('/api/families/:familyId/invitations', async (req, reply) => {
    const { email, phone, person_id, role, intended_care } = req.body || {};
    if (!(await requireAdmin(req, reply))) return;
    if (!email && !phone) return reply.code(400).send({ error: 'email or phone required' });
    if (role && !ROLES.includes(role)) return reply.code(400).send({ error: 'unknown role' });
    if (role === 'OWNER') return reply.code(400).send({ error: 'ownership is transferred, not invited' });
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
        // Falling back to a hardcoded host silently sends every invite to the
        // wrong deployment. Warn rather than pretend.
        const base = process.env.APP_URL || (() => {
          req.log.warn('APP_URL is not set — invite links will point at parentfirst.onrender.com');
          return 'https://parentfirst.onrender.com';
        })();
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
         AND family_id IN (SELECT family_id FROM family_memberships WHERE user_id=$2 AND role IN ('OWNER','ADMIN'))
       RETURNING id`, [req.params.token, uid(req)]);
    if (!rows[0]) return reply.code(404).send({ error: 'nothing to revoke' });
    return { revoked: true };
  });

  // ── establish/adjust a care relationship (owner action) ──
  app.post('/api/families/:familyId/care-relationships', async (req, reply) => {
    const { caregiver_user_id, person_id, relationship, permissions } = req.body || {};
    if (!(await requireAdmin(req, reply))) return;
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
    if (!(await requireMember(req, reply))) return;
    const { rows } = await pool.query(
      `SELECT * FROM events WHERE family_id=$1 ORDER BY event_date`, [req.params.familyId]);
    return rows;
  });
  app.post('/api/families/:familyId/events', async (req, reply) => {
    if (!(await requireMember(req, reply))) return;
    const { title, event_date, event_time, place, notes } = req.body || {};
    if (!title || !event_date) return reply.code(400).send({ error: 'title and date required' });
    const { rows } = await pool.query(
      `INSERT INTO events (family_id, title, event_date, event_time, place, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.familyId, title, event_date, event_time || null, place || null, notes || null, uid(req)]);
    return rows[0];
  });
  app.delete('/api/families/:familyId/events/:id', async (req, reply) => {
    if (!(await requireMember(req, reply))) return;
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
    if (!(await requireAdmin(req, reply))) return;
    if (req.params.userId === uid(req)) return reply.code(400).send({ error: 'you cannot remove yourself' });
    const target = await membershipOf(pool, req.params.familyId, req.params.userId);
    if (!target) return reply.code(404).send({ error: 'that person is not in this family' });
    if (target.role === 'OWNER') return reply.code(400).send({ error: 'the owner cannot be removed — transfer ownership first' });
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
    const me = await membershipOf(pool, req.params.familyId, uid(req));
    if (!me || me.role !== 'OWNER') return reply.code(403).send({ error: 'only the owner can delete a family' });
    const ppl = await pool.query(`SELECT count(*)::int c FROM persons_in_family WHERE family_id=$1`, [req.params.familyId]);
    if (ppl.rows[0].c > 0) return reply.code(400).send({ error: 'remove the people in this family first' });
    await pool.query(`DELETE FROM families WHERE id=$1`, [req.params.familyId]);
    return { deleted: true };
  });

  // ── join with the family code (the simple signup path) ──
  // ═══════════ FAMILY TO-DOS — "who's doing what" for siblings ═══════════
  const memberOf = async (familyId, userId) => (await pool.query(
    `SELECT 1 FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND status='ACTIVE'`, [familyId, userId])).rows[0];

  app.get('/api/families/:familyId/todos', async (req, reply) => {
    if (!await memberOf(req.params.familyId, uid(req))) return reply.code(403).send({ error: 'not a member' });
    const { rows } = await pool.query(
      `SELECT t.*, a.name AS assigned_name, c.name AS created_name, d.name AS done_name, p.name AS person_name
       FROM family_todos t
       LEFT JOIN users a ON a.id=t.assigned_to LEFT JOIN users c ON c.id=t.created_by
       LEFT JOIN users d ON d.id=t.done_by LEFT JOIN parents p ON p.id=t.person_id
       WHERE t.family_id=$1 AND (t.done_at IS NULL OR t.done_at > now() - interval '7 days')
       ORDER BY t.done_at NULLS FIRST, t.due_date NULLS LAST, t.created_at`, [req.params.familyId]);
    return { todos: rows };
  });
  app.post('/api/families/:familyId/todos', async (req, reply) => {
    if (!await memberOf(req.params.familyId, uid(req))) return reply.code(403).send({ error: 'not a member' });
    const { title, assigned_to, due_date, person_id } = req.body || {};
    if (!title || !title.trim()) return reply.code(400).send({ error: 'what needs doing?' });
    const { rows: [t] } = await pool.query(
      `INSERT INTO family_todos (family_id, person_id, title, assigned_to, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.familyId, person_id || null, title.trim(), assigned_to || null, due_date || null, uid(req)]);
    return t;
  });
  app.patch('/api/families/:familyId/todos/:id', async (req, reply) => {
    if (!await memberOf(req.params.familyId, uid(req))) return reply.code(403).send({ error: 'not a member' });
    const { done, assigned_to, title, due_date } = req.body || {};
    const { rows: [t] } = await pool.query(
      `UPDATE family_todos SET
         done_at = CASE WHEN $3::boolean IS NULL THEN done_at WHEN $3 THEN now() ELSE NULL END,
         done_by = CASE WHEN $3::boolean IS NULL THEN done_by WHEN $3 THEN $4 ELSE NULL END,
         assigned_to = COALESCE($5, assigned_to), title = COALESCE($6, title), due_date = COALESCE($7, due_date)
       WHERE id=$1 AND family_id=$2 RETURNING *`,
      [req.params.id, req.params.familyId, done === undefined ? null : !!done, uid(req), assigned_to || null, title || null, due_date || null]);
    if (!t) return reply.code(404).send({ error: 'not found' });
    return t;
  });
  app.delete('/api/families/:familyId/todos/:id', async (req, reply) => {
    if (!await memberOf(req.params.familyId, uid(req))) return reply.code(403).send({ error: 'not a member' });
    await pool.query(`DELETE FROM family_todos WHERE id=$1 AND family_id=$2`, [req.params.id, req.params.familyId]);
    return { deleted: true };
  });
}
