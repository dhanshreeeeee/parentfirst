// ParentFirst — the family graph. One place that every route uses, so the
// invariants (no duplicate persons/families, care is family-scoped, access is
// checked server-side) live in exactly one file.
//
// Vocabulary, kept deliberately distinct:
//   USER              a login              (users)
//   PERSON            a human              (persons; may have user_id or not)
//   FAMILY            a care space         (families)
//   FAMILY_MEMBERSHIP which users are in a family   (family_memberships)
//   PERSON_IN_FAMILY  which persons are in a family (persons_in_family, m:n)
//   CARE_RELATIONSHIP which user cares for which person, within a family
import crypto from 'crypto';

export const DEFAULT_CAREGIVER_PERMS = {
  VIEW_REPORTS: true, UPLOAD_REPORTS: true, VIEW_MEDICINES: true, MANAGE_MEDICINES: true,
  VIEW_VITALS: true, RECORD_VITALS: true, MANAGE_APPOINTMENTS: true, MANAGE_TASKS: true,
  VIEW_AI_INSIGHTS: true, SEND_MESSAGES: true, EMERGENCY_ACCESS: true,
};
export const LOCAL_CAREGIVER_PERMS = {
  VIEW_VITALS: true, RECORD_VITALS: true, CONFIRM_MEDICATION: true, MANAGE_APPOINTMENTS: false,
};

// ─────────────────────────────────────────────────────────────
// creation primitives — each does ONE thing, all idempotent-safe
// ─────────────────────────────────────────────────────────────

// create a family and make the creator its OWNER (one transaction)
export async function createFamily(pool, ownerUserId, name) {
  return withTx(pool, async (c) => {
    const { rows: [fam] } = await c.query(
      `INSERT INTO families (name, created_by) VALUES ($1,$2) RETURNING *`, [name, ownerUserId]);
    await c.query(
      `INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1,$2,'OWNER')
       ON CONFLICT (family_id, user_id) DO NOTHING`, [fam.id, ownerUserId]);
    return fam;
  });
}

// create a PERSON in a family, and (optionally) a care relationship from a user.
// Never creates a duplicate person: caller decides identity. Returns the person.
export async function addPersonToFamily(pool, { familyId, name, age, relation, city, createdBy, caregiverUserId, permissions }) {
  return withTx(pool, async (c) => {
    const { rows: [person] } = await c.query(
      `INSERT INTO persons (name, age, relation, city, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, age || null, relation || null, city || null, createdBy || null]);
    await c.query(
      `INSERT INTO persons_in_family (family_id, person_id) VALUES ($1,$2)
       ON CONFLICT (family_id, person_id) DO NOTHING`, [familyId, person.id]);
    if (caregiverUserId) {
      await c.query(
        `INSERT INTO care_relationships (family_id, caregiver_user_id, person_id, permissions)
         VALUES ($1,$2,$3,$4) ON CONFLICT (family_id, caregiver_user_id, person_id) DO NOTHING`,
        [familyId, caregiverUserId, person.id, JSON.stringify(permissions || DEFAULT_CAREGIVER_PERMS)]);
    }
    return person;
  });
}

// add an existing USER to a family (membership only). Idempotent.
export async function addUserToFamily(pool, familyId, userId, role = 'FAMILY_MEMBER') {
  const { rows: [m] } = await pool.query(
    `INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1,$2,$3)
     ON CONFLICT (family_id, user_id) DO UPDATE SET status='ACTIVE' RETURNING *`,
    [familyId, userId, role]);
  return m;
}

// establish a care relationship (user cares for person, family-scoped). Idempotent.
export async function addCareRelationship(pool, { familyId, caregiverUserId, personId, relationship, permissions }) {
  const { rows: [cr] } = await pool.query(
    `INSERT INTO care_relationships (family_id, caregiver_user_id, person_id, relationship, permissions)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (family_id, caregiver_user_id, person_id) DO UPDATE SET status='ACTIVE' RETURNING *`,
    [familyId, caregiverUserId, personId, relationship || null, JSON.stringify(permissions || DEFAULT_CAREGIVER_PERMS)]);
  return cr;
}

// link an existing PERSON to a USER login (Papa signs up → becomes his record).
// Never creates a second person. Returns the linked person.
export async function linkPersonToUser(pool, personId, userId) {
  const { rows: [p] } = await pool.query(
    `UPDATE persons SET user_id=$2 WHERE id=$1 AND (user_id IS NULL OR user_id=$2) RETURNING *`,
    [personId, userId]);
  return p; // null if the person was already linked to someone else
}

// ─────────────────────────────────────────────────────────────
// invitations
// ─────────────────────────────────────────────────────────────
export async function createInvitation(pool, { familyId, invitedPersonId, email, phone, byUserId, role = 'FAMILY_MEMBER', intendedCare = false }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const { rows: [inv] } = await pool.query(
    `INSERT INTO invitations (family_id, invited_person_id, invited_email, invited_phone, invited_by_user_id, intended_role, intended_care, token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [familyId, invitedPersonId || null, email ? email.toLowerCase() : null, phone || null, byUserId, role, intendedCare, token]);
  return inv;
}

// Accept an invitation for a given user — the whole linking happens atomically,
// with a row lock so two simultaneous accepts can't both win.
export async function acceptInvitation(pool, token, acceptingUserId, opts = {}) {
  const asMember = !!opts.asMember;   // "I'm not this person — add me as family instead"
  return withTx(pool, async (c) => {
    const { rows: [inv] } = await c.query(
      `SELECT * FROM invitations WHERE token=$1 FOR UPDATE`, [token]);
    if (!inv) throw httpErr(404, 'invitation not found');
    if (inv.status !== 'PENDING') throw httpErr(409, 'this invitation is no longer valid');
    if (new Date(inv.expires_at) < new Date()) {
      await c.query(`UPDATE invitations SET status='EXPIRED' WHERE id=$1`, [inv.id]);
      throw httpErr(409, 'this invitation has expired');
    }
    // 1. membership into the family (a person-bound invite used by someone
    //    else becomes a FAMILY_MEMBER, never a CARE_RECIPIENT)
    const role = asMember && inv.intended_role === 'CARE_RECIPIENT' ? 'FAMILY_MEMBER' : inv.intended_role;
    await c.query(
      `INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (family_id, user_id) DO NOTHING`, [inv.family_id, acceptingUserId, role]);
    // 2. link the invited person's record ONLY when the accepter confirms they ARE that person
    if (inv.invited_person_id && !asMember) {
      await c.query(
        `UPDATE persons SET user_id=$2 WHERE id=$1 AND user_id IS NULL`, [inv.invited_person_id, acceptingUserId]);
    }
    // 3. if the invite implies a care relationship from the accepter to the invited person
    if (inv.intended_care && inv.invited_person_id) {
      await c.query(
        `INSERT INTO care_relationships (family_id, caregiver_user_id, person_id, permissions)
         VALUES ($1,$2,$3,$4) ON CONFLICT (family_id, caregiver_user_id, person_id) DO NOTHING`,
        [inv.family_id, acceptingUserId, inv.invited_person_id, JSON.stringify(DEFAULT_CAREGIVER_PERMS)]);
    }
    await c.query(`UPDATE invitations SET status='ACCEPTED', accepted_by_user_id=$2 WHERE id=$1`, [inv.id, acceptingUserId]);
    // joining a family IS onboarding — never send an invited person through
    // the "create your family" wizard afterwards
    await c.query(`UPDATE users SET onboarded=true WHERE id=$1`, [acceptingUserId]);
    return inv;
  });
}

// ─────────────────────────────────────────────────────────────
// parent-signup resolution (never by name). Returns a plan, does not mutate.
// order: token → pending invite by email → unlinked person by email → none
// ─────────────────────────────────────────────────────────────
export async function resolveParentSignup(pool, { token, email }) {
  if (token) {
    const { rows: [inv] } = await pool.query(`SELECT * FROM invitations WHERE token=$1 AND status='PENDING'`, [token]);
    if (inv) return { kind: 'invitation', invitation: inv };
  }
  if (email) {
    const { rows: [inv] } = await pool.query(
      `SELECT * FROM invitations WHERE lower(invited_email)=lower($1) AND status='PENDING' ORDER BY created_at DESC LIMIT 1`, [email]);
    if (inv) return { kind: 'invitation', invitation: inv };
    // an existing unlinked person whose record was created with this email as a hint
    const { rows: [p] } = await pool.query(
      `SELECT pr.* FROM persons pr WHERE pr.user_id IS NULL AND lower(pr.name) <> '' AND pr.id IN
         (SELECT invited_person_id FROM invitations WHERE lower(invited_email)=lower($1) AND invited_person_id IS NOT NULL)
       LIMIT 1`, [email]);
    if (p) return { kind: 'link_person', person: p };
  }
  return { kind: 'new' };
}

// ─────────────────────────────────────────────────────────────
// AUTHORIZATION — the only gate. Never trust client-sent family/person/role.
// Returns the caregiver's permissions for this person, or null if no access.
// ─────────────────────────────────────────────────────────────
export async function accessToPerson(pool, userId, personId) {
  // a person always has access to their own record
  const { rows: [self] } = await pool.query(
    `SELECT 1 FROM persons WHERE id=$1 AND user_id=$2`, [personId, userId]);
  if (self) return { self: true, permissions: DEFAULT_CAREGIVER_PERMS };
  // otherwise, a care relationship in a shared family grants access
  const { rows: [cr] } = await pool.query(
    `SELECT permissions FROM care_relationships WHERE caregiver_user_id=$1 AND person_id=$2 AND status='ACTIVE' LIMIT 1`,
    [userId, personId]);
  if (cr) return { self: false, permissions: cr.permissions };
  // or family co-membership (a family member who isn't a direct caregiver can still view)
  const { rows: [fm] } = await pool.query(
    `SELECT 1 FROM family_memberships fm
     JOIN persons_in_family pif ON pif.family_id = fm.family_id
     WHERE fm.user_id=$1 AND pif.person_id=$2 AND fm.status='ACTIVE' LIMIT 1`, [userId, personId]);
  if (fm) return { self: false, permissions: { VIEW_REPORTS: true, VIEW_VITALS: true, VIEW_MEDICINES: true } };
  return null;
}

export function can(access, permission) {
  return !!(access && access.permissions && (access.permissions[permission] || access.self));
}

// people a user cares for / can see, across all their families
export async function personsForUser(pool, userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT p.*, f.id AS family_id, f.name AS family_name
     FROM persons p
     JOIN persons_in_family pif ON pif.person_id = p.id
     JOIN families f ON f.id = pif.family_id
     JOIN family_memberships fm ON fm.family_id = f.id AND fm.user_id = $1 AND fm.status='ACTIVE'
     ORDER BY p.name`, [userId]);
  return rows;
}

export async function familiesForUser(pool, userId) {
  const { rows } = await pool.query(
    `SELECT f.*, fm.role,
            (SELECT count(*) FROM persons_in_family WHERE family_id=f.id) AS person_count,
            (SELECT count(*) FROM family_memberships WHERE family_id=f.id AND status='ACTIVE') AS member_count
     FROM families f JOIN family_memberships fm ON fm.family_id=f.id
     WHERE fm.user_id=$1 AND fm.status='ACTIVE' ORDER BY f.created_at`, [userId]);
  return rows;
}

// ─────────────────────────────────────────────────────────────
// tiny helpers
// ─────────────────────────────────────────────────────────────
export async function withTx(pool, fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
export function httpErr(code, message) { const e = new Error(message); e.statusCode = code; return e; }
