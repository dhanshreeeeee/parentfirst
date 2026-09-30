-- ParentFirst v2 — CONVERGENCE migration.
-- The live database may have been built from either code lineage, and its ledger
-- may not match its real tables. Everything below is idempotent: it brings ANY
-- prior state to the same v2 shape without touching existing data.

-- ═══════ re-applied from 024_codes_roles_intake.sql ═══════
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


-- ═══════ re-applied from 024_join_codes.sql ═══════
ALTER TABLE families ADD COLUMN IF NOT EXISTS join_code TEXT UNIQUE;
ALTER TABLE families ALTER COLUMN join_code SET DEFAULT upper(substr(md5(random()::text),1,6));
UPDATE families SET join_code = upper(substr(md5(random()::text),1,6)) WHERE join_code IS NULL;

-- ═══════ re-applied from 025_medicine_info.sql ═══════
CREATE TABLE IF NOT EXISTS medicine_info (
  name TEXT PRIMARY KEY, generic TEXT, purpose TEXT, side_effects JSONB, cautions TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════ re-applied from 026_private_own_vault.sql ═══════
ALTER TABLE parents ADD COLUMN IF NOT EXISTS shared_with_family BOOLEAN NOT NULL DEFAULT true;
CREATE OR REPLACE VIEW persons AS SELECT * FROM parents;

-- ═══════ re-applied from 027_todos_refills.sql ═══════
CREATE TABLE IF NOT EXISTS family_todos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  person_id UUID REFERENCES parents(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  due_date DATE, done_at TIMESTAMPTZ,
  done_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_todos_family ON family_todos(family_id, done_at);
ALTER TABLE medications ADD COLUMN IF NOT EXISTS stock_count INTEGER;
ALTER TABLE medications ADD COLUMN IF NOT EXISTS stock_updated_at TIMESTAMPTZ;

-- ═══════ re-applied from 028_seen_and_accompany.sql ═══════
-- "Your family saw this": who looked at today's check-in, so the elder gets warmth back
CREATE TABLE IF NOT EXISTS checkin_views (
  checkin_id UUID NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (checkin_id, user_id)
);
-- who is taking the elder to the appointment
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS accompany_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- ═══════ v2 additions ═══════

-- files live in the database (Render's disk is wiped on every deploy)
CREATE TABLE IF NOT EXISTS stored_files (
  owner_kind TEXT NOT NULL, owner_id UUID NOT NULL, mime TEXT NOT NULL, file_name TEXT,
  size INTEGER NOT NULL, bytes BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_kind, owner_id)
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION pf_drop_stored_file() RETURNS trigger AS $fn$
BEGIN DELETE FROM stored_files WHERE owner_kind = TG_ARGV[0] AND owner_id = OLD.id; RETURN OLD; END;
$fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_reports_file ON reports;
CREATE TRIGGER trg_reports_file AFTER DELETE ON reports FOR EACH ROW EXECUTE FUNCTION pf_drop_stored_file('report');
DROP TRIGGER IF EXISTS trg_documents_file ON documents;
CREATE TRIGGER trg_documents_file AFTER DELETE ON documents FOR EACH ROW EXECUTE FUNCTION pf_drop_stored_file('document');
DROP TRIGGER IF EXISTS trg_messages_file ON messages;
CREATE TRIGGER trg_messages_file AFTER DELETE ON messages FOR EACH ROW EXECUTE FUNCTION pf_drop_stored_file('media');

-- both family-code columns exist, whichever 024 ran first
ALTER TABLE families ADD COLUMN IF NOT EXISTS join_code TEXT;
ALTER TABLE families ADD COLUMN IF NOT EXISTS invite_code TEXT;
ALTER TABLE families ADD COLUMN IF NOT EXISTS code_rotated_at TIMESTAMPTZ;
UPDATE families SET join_code = upper(substr(md5(random()::text), 1, 6)) WHERE join_code IS NULL;
-- every family gets a canonical 8-character code (unambiguous alphabet, XXXX-XXXX)
DO $$
DECLARE f RECORD; c TEXT; alphabet TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; i INT;
BEGIN
  FOR f IN SELECT id FROM families WHERE invite_code IS NULL LOOP
    LOOP
      c := '';
      FOR i IN 1..8 LOOP
        IF i = 5 THEN c := c || '-'; END IF;
        c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM families WHERE invite_code = c);
    END LOOP;
    UPDATE families SET invite_code = c WHERE id = f.id;
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_families_code ON families(invite_code);

-- the persons view must carry every parents column (added by either lineage)
CREATE OR REPLACE VIEW persons AS SELECT * FROM parents;
