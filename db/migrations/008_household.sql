-- ParentFirst — Migration 008: dependents, care profiles, check-ins, messages, documents
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/008_household.sql

-- ── users can be onboarded (filled their intake) ────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded BOOLEAN NOT NULL DEFAULT false;

-- ── a parent record can be linked to a login (the dependent) ────
ALTER TABLE parents ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_parents_user ON parents(user_id);

-- ── Care profile: the intake form ───────────────────────────────
CREATE TABLE IF NOT EXISTS care_profiles (
  parent_id      UUID PRIMARY KEY REFERENCES parents(id) ON DELETE CASCADE,
  gender         TEXT,
  height_cm      NUMERIC,
  weight_kg      NUMERIC,
  smoking        TEXT,     -- 'never' | 'former' | 'current'
  alcohol        TEXT,     -- 'never' | 'occasional' | 'regular'
  mobility       TEXT,     -- 'independent' | 'stick' | 'walker' | 'wheelchair' | 'bedbound'
  eyesight       TEXT,     -- 'good' | 'glasses' | 'poor' | 'blind'
  hearing        TEXT,     -- 'good' | 'aid' | 'poor' | 'deaf'
  speech         TEXT,     -- 'clear' | 'slurred' | 'limited' | 'nonverbal'
  memory         TEXT,     -- 'sharp' | 'forgetful' | 'confused'
  lives_alone    BOOLEAN,
  fall_history   TEXT,     -- 'none' | 'once' | 'multiple'
  diet           TEXT,     -- 'vegetarian' | 'non-vegetarian' | 'vegan' | 'jain'
  languages      TEXT,
  notes          TEXT,
  text_size      TEXT NOT NULL DEFAULT 'normal',   -- 'normal' | 'large' | 'xlarge'
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Daily check-in by the dependent themselves ──────────────────
CREATE TABLE IF NOT EXISTS checkins (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id    UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  checkin_date DATE NOT NULL,
  feeling      TEXT NOT NULL,          -- 'good' | 'okay' | 'not_well' | 'need_help'
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parent_id, checkin_date)
);
CREATE INDEX IF NOT EXISTS idx_checkin_parent ON checkins(parent_id, checkin_date DESC);

-- ── Two-way presence: notes from family to the dependent ────────
CREATE TABLE IF NOT EXISTS messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id    UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  from_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  direction    TEXT NOT NULL DEFAULT 'to_parent',  -- 'to_parent' | 'from_parent'
  body         TEXT NOT NULL,
  seen         BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_msg_parent ON messages(parent_id, created_at DESC);

-- ── Document vault (insurance, IDs, discharge summaries) ────────
CREATE TABLE IF NOT EXISTS documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'other',  -- 'insurance' | 'id' | 'hospital' | 'prescription' | 'other'
  file_name   TEXT,
  file_mime   TEXT,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_docs_parent ON documents(parent_id, created_at DESC);

-- existing single-user installs: mark them onboarded so they aren't re-prompted
UPDATE users SET onboarded = true WHERE onboarded = false;
