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
export const VIEW_ONLY_PERMS = {
  VIEW_REPORTS: true, VIEW_MEDICINES: true, VIEW_VITALS: true,
};
export const DOCTOR_PERMS = {
  VIEW_REPORTS: true, VIEW_MEDICINES: true, VIEW_VITALS: true, VIEW_AI_INSIGHTS: true,
  MANAGE_APPOINTMENTS: true,
};

// Every permission the UI can grant, in the order it is shown.
export const ALL_PERMISSIONS = [
  'VIEW_REPORTS', 'UPLOAD_REPORTS', 'VIEW_MEDICINES', 'MANAGE_MEDICINES',
  'VIEW_VITALS', 'RECORD_VITALS', 'MANAGE_APPOINTMENTS', 'MANAGE_TASKS',
  'VIEW_AI_INSIGHTS', 'SEND_MESSAGES', 'EMERGENCY_ACCESS', 'CONFIRM_MEDICATION',
];

export const ROLES = ['OWNER', 'ADMIN', 'CAREGIVER', 'FAMILY_MEMBER', 'LOCAL_CAREGIVER', 'DOCTOR', 'CARE_RECIPIENT'];
const ADMIN_ROLES = ['OWNER', 'ADMIN'];

// What a role gets over each person in the family, unless the admin overrides it.
export function permsForRole(role) {
  switch (role) {
    case 'OWNER':
    case 'ADMIN':
    case 'CAREGIVER':       return { ...DEFAULT_CAREGIVER_PERMS };
    case 'LOCAL_CAREGIVER': return { ...LOCAL_CAREGIVER_PERMS };
    case 'DOCTOR':          return { ...DOCTOR_PERMS };
    case 'FAMILY_MEMBER':   return { ...VIEW_ONLY_PERMS };
    default:                return { ...VIEW_ONLY_PERMS };
  }
}

// Is this user an admin of this family? The single answer every route uses.
export async function isFamilyAdmin(pool, familyId, userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM family_memberships
     WHERE family_id=$1 AND user_id=$2 AND status='ACTIVE' AND role = ANY($3)`,
    [familyId, userId, ADMIN_ROLES]);
  return !!rows[0];
}

export async function membershipOf(pool, familyId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND status='ACTIVE'`,
    [familyId, userId]);
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────
// family join codes — short enough to read down a phone line
// ─────────────────────────────────────────────────────────────
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no O/0, no I/1/L

export function generateFamilyCode() {
  const pick = () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  const block = (n) => Array.from({ length: n }, pick).join('');
  return `${block(4)}-${block(4)}`;
}

// People type codes with stray spaces, lowercase, and no dash. Accept all of it.
export function normaliseCode(raw) {
  const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 8) return null;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

// allocate a code that isn't taken (collisions are ~1 in 850 billion, but still)
export async function allocateFamilyCode(c) {
  for (let i = 0; i < 25; i++) {
    const code = generateFamilyCode();
    const { rows } = await c.query('SELECT 1 FROM families WHERE invite_code=$1', [code]);
    if (!rows[0]) return code;
  }
  throw httpErr(500, 'could not allocate a family code');
}

export async function rotateFamilyCode(pool, familyId) {
  return withTx(pool, async (c) => {
    const code = await allocateFamilyCode(c);
    const { rows } = await c.query(
      `UPDATE families SET invite_code=$2, code_rotated_at=now() WHERE id=$1 RETURNING invite_code`,
      [familyId, code]);
    return rows[0] && rows[0].invite_code;
  });
}

// Join a family by typing its code. This is the flow that replaces
// "the admin creates a stub member and hopes it maps to a real person":
// the person signs up first, types the code, and lands in the family
// ALREADY CONNECTED to everyone being cared for.
export async function joinFamilyByCode(pool, rawCode, userId, opts = {}) {
  const code = normaliseCode(rawCode);
  if (!code) throw httpErr(400, 'that code doesn\'t look right — it\'s 8 letters and numbers, like ABCD-2345');
  return withTx(pool, async (c) => {
    const { rows: [fam] } = await c.query('SELECT * FROM families WHERE invite_code=$1', [code]);
    if (!fam) throw httpErr(404, 'no family has that code — check it with whoever invited you');

    const { rows: [existing] } = await c.query(
      'SELECT * FROM family_memberships WHERE family_id=$1 AND user_id=$2', [fam.id, userId]);
    if (existing && existing.status === 'ACTIVE') {
      return { family: fam, already: true };
    }

    // Someone joining by code is a family member until an admin says otherwise.
    // They never get admin rights from a code alone.
    const role = opts.role && opts.role !== 'OWNER' && opts.role !== 'ADMIN' ? opts.role : 'FAMILY_MEMBER';
    await c.query(
      `INSERT INTO family_memberships (family_id, user_id, role, status, joined_via)
       VALUES ($1,$2,$3,'ACTIVE','code')
       ON CONFLICT (family_id, user_id) DO UPDATE SET status='ACTIVE', joined_via='code'`,
      [fam.id, userId, role]);

    // THE MAPPING STEP. Give them a care relationship to every person already
    // in the family, so they are connected on arrival instead of floating.
    await c.query(
      `INSERT INTO care_relationships (family_id, caregiver_user_id, person_id, permissions)
       SELECT $1, $2, pif.person_id, $3::jsonb
       FROM persons_in_family pif
       WHERE pif.family_id = $1
         AND pif.person_id <> COALESCE((SELECT id FROM persons WHERE user_id=$2 LIMIT 1), '00000000-0000-0000-0000-000000000000'::uuid)
       ON CONFLICT (family_id, caregiver_user_id, person_id) DO NOTHING`,
      [fam.id, userId, JSON.stringify(permsForRole(role))]);

    // joining a family IS onboarding
    await c.query('UPDATE users SET onboarded=true WHERE id=$1', [userId]);
    return { family: fam, already: false };
  });
}

// When a new PERSON is added to a family, everyone already in it should be able
// to see them. Without this, members stay unmapped to anyone added after them.
export async function mapExistingMembersToPerson(c, familyId, personId) {
  await c.query(
    `INSERT INTO care_relationships (family_id, caregiver_user_id, person_id, permissions)
     SELECT fm.family_id, fm.user_id, $2,
            CASE fm.role
              WHEN 'FAMILY_MEMBER'   THEN $3::jsonb
              WHEN 'LOCAL_CAREGIVER' THEN $4::jsonb
              WHEN 'DOCTOR'          THEN $5::jsonb
              WHEN 'CARE_RECIPIENT'  THEN $3::jsonb
              ELSE $6::jsonb
            END
     FROM family_memberships fm
     WHERE fm.family_id=$1 AND fm.status='ACTIVE'
       AND fm.user_id <> COALESCE((SELECT user_id FROM persons WHERE id=$2), '00000000-0000-0000-0000-000000000000'::uuid)
     ON CONFLICT (family_id, caregiver_user_id, person_id) DO NOTHING`,
    [familyId, personId,
      JSON.stringify(VIEW_ONLY_PERMS), JSON.stringify(LOCAL_CAREGIVER_PERMS),
      JSON.stringify(DOCTOR_PERMS), JSON.stringify(DEFAULT_CAREGIVER_PERMS)]);
}

// ─────────────────────────────────────────────────────────────
// creation primitives — each does ONE thing, all idempotent-safe
// ─────────────────────────────────────────────────────────────

// create a family and make the creator its OWNER (one transaction)
export async function createFamily(pool, ownerUserId, name) {
  return withTx(pool, async (c) => {
    const code = await allocateFamilyCode(c);
    const { rows: [fam] } = await c.query(
      `INSERT INTO families (name, created_by, invite_code) VALUES ($1,$2,$3) RETURNING *`,
      [name, ownerUserId, code]);
    await c.query(
      `INSERT INTO family_memberships (family_id, user_id, role, joined_via)
       VALUES ($1,$2,'OWNER','created')
       ON CONFLICT (family_id, user_id) DO NOTHING`, [fam.id, ownerUserId]);
    return fam;
  });
}

// create a PERSON in a family, and (optionally) a care relationship from a user.
// Never creates a duplicate person: caller decides identity. Returns the person.
// Columns on the person record an admin may fill in during intake.
export const PERSON_COLS = [
  'name', 'age', 'dob', 'relation', 'city', 'state', 'country', 'address_line', 'pincode',
  'phone', 'email', 'blood_group', 'allergies', 'conditions', 'primary_doctor', 'doctor_phone',
  'emergency_name', 'emergency_phone', 'emergency_relation',
];

// Accepts either the full intake shape ({ person: {...} }) or the older
// flat one ({ name, age, relation, city }) that callers and tests still use.
export async function addPersonToFamily(pool, opts) {
  const { familyId, createdBy, caregiverUserId, permissions } = opts;
  const fields = { ...(opts.person || {}) };
  for (const k of PERSON_COLS) if (opts[k] !== undefined && fields[k] === undefined) fields[k] = opts[k];
  return withTx(pool, async (c) => {
    const cols = PERSON_COLS.filter((k) => fields[k] !== undefined && fields[k] !== null && fields[k] !== '');
    if (!cols.includes('name')) throw httpErr(400, 'name required');
    const vals = cols.map((k) => (k === 'age' ? parseInt(fields[k], 10) || null : fields[k]));
    const ph = cols.map((_, i) => `$${i + 1}`).join(',');
    const { rows: [person] } = await c.query(
      `INSERT INTO persons (${cols.join(',')}, created_by) VALUES (${ph}, $${cols.length + 1}) RETURNING *`,
      [...vals, createdBy || null]);
    await c.query(
      `INSERT INTO persons_in_family (family_id, person_id) VALUES ($1,$2)
       ON CONFLICT (family_id, person_id) DO NOTHING`, [familyId, person.id]);
    if (caregiverUserId) {
      await c.query(
        `INSERT INTO care_relationships (family_id, caregiver_user_id, person_id, permissions)
         VALUES ($1,$2,$3,$4) ON CONFLICT (family_id, caregiver_user_id, person_id) DO NOTHING`,
        [familyId, caregiverUserId, person.id, JSON.stringify(permissions || DEFAULT_CAREGIVER_PERMS)]);
    }
    // everyone already in the family gets mapped to the new person too
    await mapExistingMembersToPerson(c, familyId, person.id);
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
    // 3b. THE MAPPING STEP — connect them to everyone else in the family too,
    //     at whatever their role allows. Without this a new member joins into
    //     an empty-looking app.
    if (role !== 'CARE_RECIPIENT') {
      await c.query(
        `INSERT INTO care_relationships (family_id, caregiver_user_id, person_id, permissions)
         SELECT $1, $2, pif.person_id, $3::jsonb FROM persons_in_family pif
         WHERE pif.family_id=$1
           AND pif.person_id <> COALESCE((SELECT id FROM persons WHERE user_id=$2 LIMIT 1), '00000000-0000-0000-0000-000000000000'::uuid)
         ON CONFLICT (family_id, caregiver_user_id, person_id) DO NOTHING`,
        [inv.family_id, acceptingUserId, JSON.stringify(permsForRole(role))]);
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
    `SELECT f.id, f.name, f.created_by, f.created_at, fm.role,
            (fm.role IN ('OWNER','ADMIN')) AS is_admin,
            CASE WHEN fm.role IN ('OWNER','ADMIN') THEN f.invite_code ELSE NULL END AS invite_code,
            (SELECT count(*) FROM persons_in_family WHERE family_id=f.id) AS person_count,
            (SELECT count(*) FROM family_memberships WHERE family_id=f.id AND status='ACTIVE') AS member_count
     FROM families f JOIN family_memberships fm ON fm.family_id=f.id
     WHERE fm.user_id=$1 AND fm.status='ACTIVE' ORDER BY f.created_at`, [userId]);
  return rows;
}

// ─────────────────────────────────────────────────────────────
// ADMIN CONTROLS — role changes and per-person permissions
// ─────────────────────────────────────────────────────────────

// Change what someone is in the family. Re-applies that role's default
// permissions over every person, unless the admin has already customised them.
export async function setMemberRole(pool, { familyId, targetUserId, role, actingUserId }) {
  if (!ROLES.includes(role)) throw httpErr(400, 'unknown role');
  return withTx(pool, async (c) => {
    const { rows: [acting] } = await c.query(
      `SELECT role FROM family_memberships WHERE family_id=$1 AND user_id=$2 AND status='ACTIVE' FOR UPDATE`,
      [familyId, actingUserId]);
    if (!acting || !ADMIN_ROLES.includes(acting.role)) throw httpErr(403, 'only an admin can change roles');
    // Only the owner may hand out or take away OWNER.
    if (role === 'OWNER' && acting.role !== 'OWNER') throw httpErr(403, 'only the owner can transfer ownership');

    const { rows: [target] } = await c.query(
      `SELECT role FROM family_memberships WHERE family_id=$1 AND user_id=$2 FOR UPDATE`, [familyId, targetUserId]);
    if (!target) throw httpErr(404, 'that person is not in this family');
    if (target.role === 'OWNER' && acting.role !== 'OWNER') throw httpErr(403, 'only the owner can change their own role');

    // never leave a family without an owner
    if (target.role === 'OWNER' && role !== 'OWNER') {
      const { rows: [{ c: owners }] } = await c.query(
        `SELECT count(*)::int c FROM family_memberships WHERE family_id=$1 AND role='OWNER' AND status='ACTIVE'`, [familyId]);
      if (owners <= 1) throw httpErr(400, 'make someone else the owner first');
    }
    // transferring ownership: the old owner steps down to admin
    if (role === 'OWNER') {
      await c.query(
        `UPDATE family_memberships SET role='ADMIN' WHERE family_id=$1 AND role='OWNER' AND user_id<>$2`,
        [familyId, targetUserId]);
    }

    const { rows: [m] } = await c.query(
      `UPDATE family_memberships SET role=$3 WHERE family_id=$1 AND user_id=$2 RETURNING *`,
      [familyId, targetUserId, role]);

    if (role === 'CARE_RECIPIENT') {
      // they are cared for, not a carer — drop the care they held over others
      await c.query(
        `DELETE FROM care_relationships WHERE family_id=$1 AND caregiver_user_id=$2`, [familyId, targetUserId]);
    } else {
      await c.query(
        `INSERT INTO care_relationships (family_id, caregiver_user_id, person_id, permissions)
         SELECT $1, $2, pif.person_id, $3::jsonb FROM persons_in_family pif
         WHERE pif.family_id=$1
           AND pif.person_id <> COALESCE((SELECT id FROM persons WHERE user_id=$2 LIMIT 1), '00000000-0000-0000-0000-000000000000'::uuid)
         ON CONFLICT (family_id, caregiver_user_id, person_id)
         DO UPDATE SET permissions=EXCLUDED.permissions, status='ACTIVE'`,
        [familyId, targetUserId, JSON.stringify(permsForRole(role))]);
    }
    return m;
  });
}

// Fine-grained: what may this member do for THIS person?
export async function setCarePermissions(pool, { familyId, caregiverUserId, personId, permissions, actingUserId }) {
  if (!(await isFamilyAdmin(pool, familyId, actingUserId))) throw httpErr(403, 'only an admin can change access');
  const clean = {};
  for (const k of ALL_PERMISSIONS) if (permissions && permissions[k]) clean[k] = true;
  const { rows: [cr] } = await pool.query(
    `INSERT INTO care_relationships (family_id, caregiver_user_id, person_id, permissions)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (family_id, caregiver_user_id, person_id)
     DO UPDATE SET permissions=EXCLUDED.permissions, status='ACTIVE' RETURNING *`,
    [familyId, caregiverUserId, personId, JSON.stringify(clean)]);
  return cr;
}

// The whole access picture for one family: members × people × permissions.
// This is what the admin screen renders, and what makes "who can see what"
// answerable instead of guessed at.
export async function accessMatrix(pool, familyId) {
  const { rows: members } = await pool.query(
    `SELECT fm.user_id, fm.role, fm.status, fm.joined_via, fm.created_at,
            u.name, u.email,
            (SELECT p.id FROM persons p WHERE p.user_id=fm.user_id
               AND p.id IN (SELECT person_id FROM persons_in_family WHERE family_id=$1) LIMIT 1) AS own_person_id
     FROM family_memberships fm JOIN users u ON u.id=fm.user_id
     WHERE fm.family_id=$1 AND fm.status='ACTIVE'
     ORDER BY CASE fm.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END, fm.created_at`, [familyId]);
  const { rows: persons } = await pool.query(
    `SELECT p.id, p.name, p.age, p.relation, p.user_id
     FROM persons p JOIN persons_in_family pif ON pif.person_id=p.id
     WHERE pif.family_id=$1 ORDER BY p.name`, [familyId]);
  const { rows: rels } = await pool.query(
    `SELECT caregiver_user_id, person_id, permissions FROM care_relationships
     WHERE family_id=$1 AND status='ACTIVE'`, [familyId]);
  const grid = {};
  for (const r of rels) grid[`${r.caregiver_user_id}:${r.person_id}`] = r.permissions || {};
  return { members, persons, grid, permissions: ALL_PERMISSIONS };
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
