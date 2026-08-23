-- ParentFirst — Migration 024: join-by-code, real admin roles, and a full intake.
--
-- Three things the family flow was missing:
--   1. a short human-typeable FAMILY CODE, so joining is "sign up, type the code"
--      instead of "hope the emailed link survived WhatsApp"
--   2. ADMIN as a first-class membership role, with per-person permissions the
--      admin actually controls
--   3. somewhere to PUT a proper intake — address (country/state/city as real
--      fields, not one free-text box), contacts, and the whole health picture
--      including the smoking/tobacco/alcohol questions
--
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/024_codes_roles_intake.sql

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. families gain a short join code
-- ─────────────────────────────────────────────────────────────
ALTER TABLE families ADD COLUMN IF NOT EXISTS invite_code TEXT;
ALTER TABLE families ADD COLUMN IF NOT EXISTS code_rotated_at TIMESTAMPTZ;

-- Unambiguous alphabet: no O/0, no I/1/L. Format XXXX-XXXX.
CREATE OR REPLACE FUNCTION pf_gen_family_code() RETURNS TEXT AS $fn$
DECLARE
  alphabet TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  out TEXT := '';
  i INT;
BEGIN
  FOR i IN 1..8 LOOP
    IF i = 5 THEN out := out || '-'; END IF;
    out := out || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  END LOOP;
  RETURN out;
END;
$fn$ LANGUAGE plpgsql;

-- backfill every existing family, retrying on the (vanishingly rare) collision
DO $$
DECLARE f RECORD; c TEXT; tries INT;
BEGIN
  FOR f IN SELECT id FROM families WHERE invite_code IS NULL LOOP
    tries := 0;
    LOOP
      c := pf_gen_family_code();
      EXIT WHEN NOT EXISTS (SELECT 1 FROM families WHERE invite_code = c);
      tries := tries + 1;
      IF tries > 20 THEN RAISE EXCEPTION 'could not allocate a family code'; END IF;
    END LOOP;
    UPDATE families SET invite_code = c WHERE id = f.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_families_code ON families(invite_code);

-- ─────────────────────────────────────────────────────────────
-- 2. people: a real address, real contact details, real identity
--    (city already existed as free text; it stays and is now one part
--     of country → state → city)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE parents ADD COLUMN IF NOT EXISTS country        TEXT;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS state          TEXT;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS address_line   TEXT;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS pincode        TEXT;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS phone          TEXT;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS email          TEXT;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS dob            DATE;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS emergency_name     TEXT;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS emergency_phone    TEXT;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS emergency_relation TEXT;

-- ─────────────────────────────────────────────────────────────
-- 3. care_profiles: the rest of the health picture.
--    smoking / alcohol already exist — these are what was missing around them.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS tobacco            TEXT;   -- 'never'|'former'|'current' (chewing / gutka / khaini)
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS smoking_years      INT;
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS alcohol_frequency  TEXT;   -- 'daily'|'weekly'|'monthly'|'rarely'
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS chronic_conditions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS surgeries          TEXT;
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS family_history     TEXT;
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS activity_level     TEXT;   -- 'sedentary'|'light'|'moderate'|'active'
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS sleep_hours        NUMERIC;
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS vaccinations       TEXT;
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS insurer            TEXT;
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS policy_number      TEXT;
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS intake_completed_at TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────
-- 4. ADMIN is a real role. The OWNER is simply the admin who made the family.
--    (family_memberships.role is free text; this documents + constrains it.)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE family_memberships DROP CONSTRAINT IF EXISTS family_memberships_role_chk;
ALTER TABLE family_memberships ADD CONSTRAINT family_memberships_role_chk
  CHECK (role IN ('OWNER','ADMIN','CAREGIVER','FAMILY_MEMBER','CARE_RECIPIENT','LOCAL_CAREGIVER','DOCTOR'));

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_role_chk;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_chk
  CHECK (intended_role IN ('OWNER','ADMIN','CAREGIVER','FAMILY_MEMBER','CARE_RECIPIENT','LOCAL_CAREGIVER','DOCTOR'));

-- who joined by typing a code (vs. an emailed invitation) — useful for support
ALTER TABLE family_memberships ADD COLUMN IF NOT EXISTS joined_via TEXT;

-- ─────────────────────────────────────────────────────────────
-- 5. the `persons` view must be re-expanded so the new parents columns
--    are visible/insertable through it (SELECT * is frozen at creation).
--    Appending columns is a legal CREATE OR REPLACE.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW persons AS SELECT * FROM parents;

-- ─────────────────────────────────────────────────────────────
-- 6. a code typed on the SIGNUP page is remembered until the email is
--    verified, then applied at first sign-in. Signing up and joining are
--    one action for the user, two steps for us.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_join_code TEXT;

COMMIT;
