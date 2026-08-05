-- ParentFirst — Migration 004: accounts, sessions, family roles
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/004_accounts.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Users ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- scrypt: salt:hash (hex)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Sessions (token stored in an httpOnly cookie) ──────────────
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ── Family membership: which users can see which parent, and how ──
--   role: 'admin'  = full control (family owner)
--         'member' = view + book + chat (siblings/relatives)
--         'caregiver' = daily log + mark medicines only (the helper)
CREATE TABLE IF NOT EXISTS family_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, parent_id)
);
CREATE INDEX IF NOT EXISTS idx_fm_user ON family_members(user_id);
CREATE INDEX IF NOT EXISTS idx_fm_parent ON family_members(parent_id);

-- ── who created each parent (nullable, set when created via app) ─
ALTER TABLE parents ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);

-- Note: the default admin user + linking existing parents happens in code
-- (src/auth.js ensureSeed) so we can scrypt-hash the password.
