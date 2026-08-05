// Households — the family group.
//
// Everyone in a household is a person with their own vault. Their care_role
// decides who can see whose records:
//   elder → their vault is shared with every carer in the household
//   carer → their own vault stays private to them; they can see the elders'
//
// family_members remains the single source of truth for access (every endpoint
// already checks it). syncHousehold() rewrites those rows from membership, so
// the household is just a friendlier way to manage the same thing.
import crypto from 'node:crypto';

export default async function householdRoutes(app, { pool }) {
  const code = () => crypto.randomBytes(4).toString('hex').toUpperCase();

  // Every user has exactly one personal record — their own vault.
  async function ensureSelfRecord(client, userId, householdId) {
    const { rows } = await client.query(
      'SELECT id FROM parents WHERE user_id=$1 ORDER BY created_at LIMIT 1', [userId]);
    if (rows[0]) {
      if (householdId) await client.query('UPDATE parents SET household_id=$2 WHERE id=$1', [rows[0].id, householdId]);
      return rows[0].id;
    }
    const { rows: u } = await client.query('SELECT name FROM users WHERE id=$1', [userId]);
    const { rows: p } = await client.query(
      `INSERT INTO parents (name, relation, created_by, user_id, household_id)
       VALUES ($1,'self',$2,$2,$3) RETURNING id`,
      [u[0]?.name || 'Me', userId, householdId || null]);
    await client.query(
      `INSERT INTO family_members (user_id, parent_id, role) VALUES ($1,$2,'dependent')
       ON CONFLICT (user_id, parent_id) DO NOTHING`, [userId, p[0].id]);
    return p[0].id;
  }

  // Rebuild access rows from household membership.
  async function syncHousehold(client, householdId) {
    const { rows: members } = await client.query(
      'SELECT user_id, care_role, is_owner FROM household_members WHERE household_id=$1', [householdId]);
    const selfRecord = {};
    for (const m of members) selfRecord[m.user_id] = await ensureSelfRecord(client, m.user_id, householdId);

    const elders = members.filter((m) => m.care_role === 'elder');
    const carers = members.filter((m) => m.care_role !== 'elder');

    for (const e of elders) {
      const pid = selfRecord[e.user_id];
      // the elder keeps control of their own record
      await client.query(
        `INSERT INTO family_members (user_id, parent_id, role) VALUES ($1,$2,'dependent')
         ON CONFLICT (user_id, parent_id) DO UPDATE SET role='dependent'`, [e.user_id, pid]);
      // every carer can see and help with it; owners get admin
      for (const c of carers) {
        await client.query(
          `INSERT INTO family_members (user_id, parent_id, role) VALUES ($1,$2,$3)
           ON CONFLICT (user_id, parent_id) DO UPDATE SET role=$3`,
          [c.user_id, pid, c.is_owner ? 'admin' : 'member']);
      }
    }
    // a carer's own vault stays theirs alone — no rows granted to anyone else
    for (const c of carers) {
      await client.query(
        `INSERT INTO family_members (user_id, parent_id, role) VALUES ($1,$2,'admin')
         ON CONFLICT (user_id, parent_id) DO UPDATE SET role='admin'`,
        [c.user_id, selfRecord[c.user_id]]);
    }
  }

  async function myMembership(userId, householdId) {
    const { rows } = await pool.query(
      'SELECT * FROM household_members WHERE user_id=$1 AND household_id=$2', [userId, householdId]);
    return rows[0] || null;
  }

  // ── my households ─────────────────────────────────────────────
  app.get('/api/households', async (req) => {
    const { rows } = await pool.query(
      `SELECT h.*, hm.care_role, hm.is_owner,
              (SELECT count(*)::int FROM household_members x WHERE x.household_id=h.id) AS member_count
       FROM household_members hm JOIN households h ON h.id = hm.household_id
       WHERE hm.user_id=$1 ORDER BY h.created_at`, [req.user.id]);
    return rows;
  });

  app.post('/api/households', async (req, reply) => {
    const { name, care_role } = req.body || {};
    if (!name) return reply.code(400).send({ error: 'a name for the group is required' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'INSERT INTO households (name, invite_code, created_by) VALUES ($1,$2,$3) RETURNING *',
        [name, code(), req.user.id]);
      await client.query(
        `INSERT INTO household_members (household_id, user_id, care_role, is_owner)
         VALUES ($1,$2,$3,true)`,
        [rows[0].id, req.user.id, care_role === 'elder' ? 'elder' : 'carer']);
      await syncHousehold(client, rows[0].id);
      await client.query('COMMIT');
      return rows[0];
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  });

  // ── join with a code ──────────────────────────────────────────
  app.post('/api/households/join', async (req, reply) => {
    const { invite_code, care_role } = req.body || {};
    if (!invite_code) return reply.code(400).send({ error: 'invite code required' });
    const { rows: h } = await pool.query(
      'SELECT * FROM households WHERE invite_code=$1', [String(invite_code).trim().toUpperCase()]);
    if (!h[0]) return reply.code(404).send({ error: 'no group found with that code' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO household_members (household_id, user_id, care_role)
         VALUES ($1,$2,$3) ON CONFLICT (household_id, user_id) DO NOTHING`,
        [h[0].id, req.user.id, care_role === 'elder' ? 'elder' : 'carer']);
      await syncHousehold(client, h[0].id);
      await client.query('COMMIT');
      return { joined: true, household: h[0] };
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  });

  // ── who's in it ───────────────────────────────────────────────
  app.get('/api/households/:id', async (req, reply) => {
    const me = await myMembership(req.user.id, req.params.id);
    if (!me) return reply.code(403).send({ error: 'not a member of this group' });
    const { rows: h } = await pool.query('SELECT * FROM households WHERE id=$1', [req.params.id]);
    const { rows: members } = await pool.query(
      `SELECT hm.user_id, hm.care_role, hm.is_owner, hm.joined_at,
              u.name, u.email,
              p.id AS person_id, p.age, p.city
       FROM household_members hm
       JOIN users u ON u.id = hm.user_id
       LEFT JOIN parents p ON p.user_id = hm.user_id AND p.household_id = hm.household_id
       WHERE hm.household_id=$1
       ORDER BY (hm.care_role='elder') DESC, u.name`, [req.params.id]);
    return {
      household: h[0],
      members,
      me: { care_role: me.care_role, is_owner: me.is_owner },
      // only owners should see the code — it grants access to the group
      invite_code: me.is_owner ? h[0].invite_code : null,
    };
  });

  // ── change someone's care role (owners only) ──────────────────
  app.post('/api/households/:id/members/:userId/role', async (req, reply) => {
    const me = await myMembership(req.user.id, req.params.id);
    if (!me || !me.is_owner) return reply.code(403).send({ error: 'only a group owner can change roles' });
    const { care_role } = req.body || {};
    if (!['elder', 'carer'].includes(care_role)) return reply.code(400).send({ error: 'care_role must be elder or carer' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE household_members SET care_role=$3 WHERE household_id=$1 AND user_id=$2',
        [req.params.id, req.params.userId, care_role]);
      await syncHousehold(client, req.params.id);
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  });

  app.post('/api/households/:id/regenerate-code', async (req, reply) => {
    const me = await myMembership(req.user.id, req.params.id);
    if (!me || !me.is_owner) return reply.code(403).send({ error: 'only a group owner can do that' });
    const { rows } = await pool.query(
      'UPDATE households SET invite_code=$2 WHERE id=$1 RETURNING invite_code', [req.params.id, code()]);
    return rows[0];
  });

  app.delete('/api/households/:id/members/:userId', async (req, reply) => {
    const me = await myMembership(req.user.id, req.params.id);
    const removingSelf = req.params.userId === req.user.id;
    if (!me || (!me.is_owner && !removingSelf)) return reply.code(403).send({ error: 'not allowed' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // drop their access to other people's records, keep their own vault intact
      await client.query(
        `DELETE FROM family_members fm USING parents p
         WHERE fm.parent_id = p.id AND fm.user_id=$2
           AND p.household_id=$1 AND p.user_id <> $2`, [req.params.id, req.params.userId]);
      await client.query(
        `DELETE FROM family_members fm USING parents p
         WHERE fm.parent_id = p.id AND p.user_id=$2 AND p.household_id=$1
           AND fm.user_id <> $2`, [req.params.id, req.params.userId]);
      await client.query('UPDATE parents SET household_id=NULL WHERE user_id=$2 AND household_id=$1',
        [req.params.id, req.params.userId]);
      await client.query('DELETE FROM household_members WHERE household_id=$1 AND user_id=$2',
        [req.params.id, req.params.userId]);
      await client.query('COMMIT');
      return { removed: true };
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  });

  // everyone who should be told when something urgent happens to this person
  app.get('/api/parents/:parentId/watchers', async (req) => {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.name, u.email, fm.role
       FROM family_members fm JOIN users u ON u.id = fm.user_id
       WHERE fm.parent_id=$1 AND fm.role IN ('admin','member')`, [req.params.parentId]);
    return rows;
  });
}
