-- ParentFirst — Migration 016: households
--
-- The mental model: a household is a family group, like a WhatsApp group.
-- Everyone in it is a real person with their OWN health vault. What differs is
-- their care role:
--   'elder'  — being cared for; their vault is visible to the carers
--   'carer'  — looking after the elders; their own vault stays private to them
--
-- Access is still enforced through family_members (unchanged, already wired into
-- every endpoint). Households are the organising layer that generates those rows.
--
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/016_households.sql

CREATE TABLE IF NOT EXISTS households (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS household_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  care_role    TEXT NOT NULL DEFAULT 'carer',   -- 'elder' | 'carer'
  is_owner     BOOLEAN NOT NULL DEFAULT false,  -- can rename, invite, set roles
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (household_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_hm_household ON household_members(household_id);
CREATE INDEX IF NOT EXISTS idx_hm_user ON household_members(user_id);

-- a person record can belong to a household
ALTER TABLE parents ADD COLUMN IF NOT EXISTS household_id UUID REFERENCES households(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_parents_household ON parents(household_id);
