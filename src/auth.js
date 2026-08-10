// Authentication & authorization for ParentFirst.
// - passwords hashed with Node's built-in scrypt (no native deps)
// - sessions are random tokens in an httpOnly cookie, stored in `sessions`
// - family_members maps a user to a parent with a role
import crypto from 'node:crypto';
import fp from 'fastify-plugin';

const COOKIE = 'pf_session';
const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function createSession(pool, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await pool.query(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)',
    [token, userId, expires]);
  return token;
}

// roles ranked; a user "has" a role if their rank >= required
// dependent = the elder themselves. They get member-level rights over their OWN
// record (book care, upload, edit details) but never admin rights (inviting family,
// changing roles). Medicines are special-cased so they can manage their own.
const RANK = { caregiver: 1, dependent: 2, member: 2, admin: 3 };
export function roleAtLeast(role, needed) {
  return (RANK[role] || 0) >= (RANK[needed] || 99);
}

// Create a default admin + link existing parents, so first run has a login.
export async function ensureSeed(pool) {
  // A printed default password is fine on a laptop, dangerous on the internet.
  if (process.env.NODE_ENV === 'production') return null;
  const { rows } = await pool.query('SELECT count(*)::int AS c FROM users');
  if (rows[0].c > 0) return null;
  const email = 'dhanshree@parentfirst.local';
  const name = 'Dhanshree';
  const password = 'changeme123';
  const ph = hashPassword(password);
  const { rows: u } = await pool.query(
    'INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id',
    [email, name, ph]);
  const userId = u[0].id;
  // link every existing parent to this user as admin
  const { rows: parents } = await pool.query('SELECT id FROM parents');
  for (const p of parents) {
    await pool.query(
      `INSERT INTO family_members (user_id, parent_id, role) VALUES ($1,$2,'admin')
       ON CONFLICT (user_id, parent_id) DO NOTHING`, [userId, p.id]);
  }
  return { email, password };
}

async function authPluginImpl(app, { pool }) {
  app.decorateRequest('user', null);
  app.decorateRequest('parentRole', null);

  // load session user for every request; enforce auth on protected /api routes
  app.addHook('preHandler', async (req, reply) => {
    const url = req.url.split('?')[0];

    // public: static files, health, auth endpoints, activities catalogue
    const isApi = url.startsWith('/api/');
    const isPublic =
      !isApi ||
      url === '/api/health' ||
      url.startsWith('/api/auth/') ||
      url.startsWith('/api/households/peek/') ||
      url === '/api/push/vapid-key' ||
      url === '/api/activities';

    // resolve user from cookie (if any)
    const token = req.cookies?.[COOKIE];
    if (token) {
      const { rows } = await pool.query(
        `SELECT u.id, u.email, u.name FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token=$1 AND s.expires_at > now()`, [token]);
      if (rows[0]) req.user = rows[0];
    }

    if (isPublic) return;

    if (!req.user) return reply.code(401).send({ error: 'not authenticated' });

    // if the route targets a specific parent, enforce membership + capture role
    const parentId = req.params?.parentId;
    if (parentId) {
      const { rows } = await pool.query(
        'SELECT role FROM family_members WHERE user_id=$1 AND parent_id=$2',
        [req.user.id, parentId]);
      if (!rows[0]) return reply.code(403).send({ error: 'no access to this parent' });
      req.parentRole = rows[0].role;
    }
  });

  // ── signup: creates a user (owner or dependent) ──
  app.post('/api/auth/signup', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const { email, name, password, account_type } = req.body || {};
    if (!email || !name || !password) return reply.code(400).send({ error: 'email, name, password required' });
    if (password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' });
    const exists = await pool.query('SELECT 1 FROM users WHERE email=$1', [email.toLowerCase()]);
    if (exists.rows[0]) return reply.code(409).send({ error: 'an account with this email already exists' });
    const { rows } = await pool.query(
      'INSERT INTO users (email, name, password_hash, verified) VALUES ($1,$2,$3,false) RETURNING id, email, name',
      [email.toLowerCase(), name, hashPassword(password)]);
    try { await sendOtp(email.toLowerCase(), 'verify'); } catch (e) { app.log.error('otp send: ' + e.message); }
    return { needs_verify: true, email: rows[0].email };
  });

  // ── email OTP: prove the address is theirs ──
  const OTP_TTL_MIN = 10;
  const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

  async function sendOtp(email, purpose) {
    const code = genCode();
    await pool.query('DELETE FROM email_otps WHERE email=$1 AND purpose=$2', [email, purpose]);
    await pool.query(
      `INSERT INTO email_otps (email, code, purpose, expires_at)
       VALUES ($1,$2,$3, now() + interval '${OTP_TTL_MIN} minutes')`, [email, code, purpose]);
    const subject = purpose === 'reset' ? 'Your password reset code' : 'Confirm your email';
    const { notifyPeople } = await import('./notify.js');
    await notifyPeople(app, [email], subject, [
      `Your ParentFirst code is: ${code}`,
      '',
      `It works for ${OTP_TTL_MIN} minutes. If you didn't ask for this, ignore it.`,
    ]);
  }

  async function checkOtp(email, purpose, code) {
    const { rows } = await pool.query(
      'SELECT * FROM email_otps WHERE email=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1',
      [email, purpose]);
    const otp = rows[0];
    if (!otp) return { ok: false, error: 'No code was requested. Ask for a new one.' };
    if (new Date(otp.expires_at) < new Date()) return { ok: false, error: 'That code has expired. Ask for a new one.' };
    if (otp.attempts >= 5) return { ok: false, error: 'Too many wrong tries. Ask for a new code.' };
    if (otp.code !== String(code).trim()) {
      await pool.query('UPDATE email_otps SET attempts=attempts+1 WHERE id=$1', [otp.id]);
      return { ok: false, error: 'That code is not right.' };
    }
    await pool.query('DELETE FROM email_otps WHERE id=$1', [otp.id]);
    return { ok: true };
  }

  // verify a fresh signup
  app.post('/api/auth/verify', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const { email, code } = req.body || {};
    if (!email || !code) return reply.code(400).send({ error: 'email and code required' });
    const r = await checkOtp(email.toLowerCase(), 'verify', code);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    await pool.query('UPDATE users SET verified=true WHERE email=$1', [email.toLowerCase()]);
    return { verified: true };
  });

  app.post('/api/auth/resend', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const { email, purpose } = req.body || {};
    if (!email) return reply.code(400).send({ error: 'email required' });
    const { rows } = await pool.query('SELECT verified FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!rows[0]) return { sent: true };   // don't reveal which emails exist
    if (purpose !== 'reset' && rows[0].verified) return { sent: true };
    await sendOtp(email.toLowerCase(), purpose === 'reset' ? 'reset' : 'verify');
    return { sent: true };
  });

  // forgot password → OTP → set a new one
  app.post('/api/auth/forgot', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const { email } = req.body || {};
    if (!email) return reply.code(400).send({ error: 'email required' });
    const { rows } = await pool.query('SELECT 1 FROM users WHERE email=$1', [email.toLowerCase()]);
    if (rows[0]) await sendOtp(email.toLowerCase(), 'reset');
    return { sent: true };   // same answer either way
  });

  app.post('/api/auth/reset', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const { email, code, new_password } = req.body || {};
    if (!email || !code || !new_password) return reply.code(400).send({ error: 'email, code and new password required' });
    if (new_password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' });
    const r = await checkOtp(email.toLowerCase(), 'reset', code);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    await pool.query('UPDATE users SET password_hash=$2, verified=true WHERE email=$1',
      [email.toLowerCase(), hashPassword(new_password)]);
    await pool.query('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE email=$1)', [email.toLowerCase()]);
    return { reset: true };
  });

  // ── login ──
  app.post('/api/auth/login', {
    config: { rateLimit: { max: 40, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const { email, password } = req.body || {};
    if (!email || !password) return reply.code(400).send({ error: 'email and password required' });
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (rows[0] && !rows[0].verified) {
      // right password or not, the address isn't proven yet
      if (verifyPassword(password, rows[0].password_hash)) {
        try { await sendOtp(email.toLowerCase(), 'verify'); } catch { /* ignore */ }
        return reply.code(403).send({ needs_verify: true, email: email.toLowerCase(),
          error: 'Confirm your email first — we\'ve sent you a fresh code.' });
      }
    }
    const u = rows[0];
    if (!u || !verifyPassword(password, u.password_hash)) {
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    const token = await createSession(pool, u.id);
    setCookie(reply, token);
    return { user: { id: u.id, email: u.email, name: u.name } };
  });

  // ── logout ──
  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[COOKIE];
    if (token) await pool.query('DELETE FROM sessions WHERE token=$1', [token]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // ── me: current user + the parents they can access (with role) ──
  app.get('/api/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'not authenticated' });
    const { rows: u } = await pool.query('SELECT onboarded FROM users WHERE id=$1', [req.user.id]);
    const { rows: parents } = await pool.query(
      `SELECT p.*, fm.role FROM family_members fm
       JOIN parents p ON p.id = fm.parent_id
       WHERE fm.user_id=$1 ORDER BY p.created_at`, [req.user.id]);
    // is this user themselves a dependent? (their own parent record)
    const selfRow = parents.find((p) => p.user_id === req.user.id);
    return {
      user: { ...req.user, onboarded: !!u[0]?.onboarded },
      parents,
      is_dependent: !!selfRow,
      self_parent_id: selfRow ? selfRow.id : null,
    };
  });

  app.post('/api/auth/change-password', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'not authenticated' });
    const { current, next } = req.body || {};
    if (!current || !next) return reply.code(400).send({ error: 'current and next password required' });
    if (next.length < 8) return reply.code(400).send({ error: 'new password must be at least 8 characters' });
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!rows[0] || !verifyPassword(current, rows[0].password_hash)) {
      return reply.code(401).send({ error: 'current password is not right' });
    }
    await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, hashPassword(next)]);
    // sign out other devices, keep this one
    const token = req.cookies?.[COOKIE];
    await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token <> $2', [req.user.id, token || '']);
    return { ok: true };
  });

  function setCookie(reply, token) {
    reply.setCookie(COOKIE, token, {
      path: '/', httpOnly: true, sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' && !process.env.ALLOW_INSECURE_COOKIE,
      maxAge: SESSION_DAYS * 86400,
    });
  }
}

export default fp(authPluginImpl, { name: 'auth' });
