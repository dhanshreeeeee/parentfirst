-- ParentFirst — Migration 023: the family architecture refactor.
--
-- Establishes the canonical model:
--   users → family_memberships → families → care_relationships → persons → health
--   persons ↔ families is many-to-many (persons_in_family)
--   persons.user_id is the optional Person↔User link
--
-- Safe on an empty DB (tonight) and on a populated one (pilot families later):
-- every step is guarded, and existing `parents` rows become `persons` with their
-- family/care rows synthesised from `family_members`.

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. users gains the identity lifecycle columns as first-class
-- ─────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_role TEXT;   -- 'carer' | 'parent' (the human's self-description at signup)

-- ─────────────────────────────────────────────────────────────
-- 2. parents → persons (rename; health data already keys parent_id,
--    which remains valid — we keep the column name to avoid rewriting
--    every health table, but the TABLE is now 'persons')
-- ─────────────────────────────────────────────────────────────
-- (parents kept as physical table; persons is a view alias, added below)
ALTER TABLE parents ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
-- created_by may not exist on very old rows
ALTER TABLE parents ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_parents_user ON parents(user_id);

-- ─────────────────────────────────────────────────────────────
-- 3. families — the container / care space
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS families (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- 4. family_memberships — which USERS belong to a family
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS family_memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id  UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'CAREGIVER',  -- OWNER | CAREGIVER | FAMILY_MEMBER | CARE_RECIPIENT | LOCAL_CAREGIVER | DOCTOR
  status     TEXT NOT NULL DEFAULT 'ACTIVE',     -- ACTIVE | INVITED | REMOVED
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_fmem_user ON family_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_fmem_family ON family_memberships(family_id);

-- ─────────────────────────────────────────────────────────────
-- 5. persons_in_family — which PERSONS belong to a family (many-to-many)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS persons_in_family (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id  UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  person_id  UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_pif_family ON persons_in_family(family_id);
CREATE INDEX IF NOT EXISTS idx_pif_person ON persons_in_family(person_id);

-- ─────────────────────────────────────────────────────────────
-- 6. care_relationships — which USER cares for which PERSON, family-scoped
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS care_relationships (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  caregiver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id         UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  relationship      TEXT,                         -- 'daughter','son','spouse',...
  permissions       JSONB NOT NULL DEFAULT '{}',  -- {VIEW_REPORTS:true, MANAGE_MEDICINES:true, ...}
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family_id, caregiver_user_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_care_user ON care_relationships(caregiver_user_id);
CREATE INDEX IF NOT EXISTS idx_care_person ON care_relationships(person_id);

-- ─────────────────────────────────────────────────────────────
-- 7. invitations — join a family and/or link an existing person
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invitations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  invited_person_id UUID REFERENCES parents(id) ON DELETE SET NULL,  -- set when inviting an existing person (e.g. Papa)
  invited_email     TEXT,
  invited_phone     TEXT,
  invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  intended_role     TEXT NOT NULL DEFAULT 'FAMILY_MEMBER',
  intended_care     BOOLEAN NOT NULL DEFAULT false,  -- should accepting create a care_relationship to invited_person?
  token             TEXT UNIQUE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | ACCEPTED | EXPIRED | REVOKED
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
  accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_email ON invitations(lower(invited_email));
CREATE INDEX IF NOT EXISTS idx_inv_family ON invitations(family_id);

-- ─────────────────────────────────────────────────────────────
-- 8. audit fields on health writes: who entered this?
-- ─────────────────────────────────────────────────────────────
ALTER TABLE reports        ADD COLUMN IF NOT EXISTS uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE documents      ADD COLUMN IF NOT EXISTS uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE vitals         ADD COLUMN IF NOT EXISTS recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE medication_log ADD COLUMN IF NOT EXISTS recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE appointments   ADD COLUMN IF NOT EXISTS created_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE checkins       ADD COLUMN IF NOT EXISTS recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────
-- 9. MIGRATE existing data: synthesise families from family_members clusters.
--    Each distinct person becomes a member of a family owned by whoever had the
--    'admin' family_members row. Carers → care_relationships; the person's own
--    login (if any) → CARE_RECIPIENT membership. Idempotent via guards.
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  p RECORD;
  fam_id UUID;
  owner_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='family_members') THEN
    FOR p IN SELECT DISTINCT person_id FROM (SELECT parent_id AS person_id FROM family_members) x LOOP
      -- owner = the admin carer for this person, else any carer
      SELECT user_id INTO owner_id FROM family_members
        WHERE parent_id = p.person_id AND role IN ('admin') LIMIT 1;
      IF owner_id IS NULL THEN
        SELECT user_id INTO owner_id FROM family_members
          WHERE parent_id = p.person_id AND role <> 'dependent' LIMIT 1;
      END IF;

      -- one family per existing person-cluster (named from the person)
      INSERT INTO families (name, created_by)
        SELECT COALESCE(name,'Family') || '''s family', owner_id FROM parents WHERE id = p.person_id
        RETURNING id INTO fam_id;

      INSERT INTO persons_in_family (family_id, person_id)
        VALUES (fam_id, p.person_id) ON CONFLICT DO NOTHING;

      -- memberships + care relationships from the old rows
      INSERT INTO family_memberships (family_id, user_id, role)
        SELECT fam_id, fm.user_id,
               CASE WHEN fm.role='admin' THEN 'OWNER'
                    WHEN fm.role='dependent' THEN 'CARE_RECIPIENT'
                    ELSE 'CAREGIVER' END
        FROM family_members fm WHERE fm.parent_id = p.person_id
        ON CONFLICT (family_id, user_id) DO NOTHING;

      INSERT INTO care_relationships (family_id, caregiver_user_id, person_id, permissions)
        SELECT fam_id, fm.user_id, p.person_id, '{"VIEW_REPORTS":true,"MANAGE_MEDICINES":true,"RECORD_VITALS":true,"MANAGE_APPOINTMENTS":true,"EMERGENCY_ACCESS":true}'
        FROM family_members fm WHERE fm.parent_id = p.person_id AND fm.role <> 'dependent'
        ON CONFLICT (family_id, caregiver_user_id, person_id) DO NOTHING;
    END LOOP;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 10. retire the duplicate grouping system + the old link table
--     (empty tonight; the migration above has already drained any real rows)
-- ─────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS household_members CASCADE;
DROP TABLE IF EXISTS households CASCADE;
-- family_members is superseded by care_relationships + family_memberships.
-- Drop only after its data has been migrated above.
DROP TABLE IF EXISTS family_members CASCADE;

CREATE OR REPLACE VIEW persons AS SELECT * FROM parents;

CREATE OR REPLACE VIEW family_members AS
  SELECT cr.id, cr.caregiver_user_id AS user_id, cr.person_id AS parent_id,
         CASE WHEN (cr.permissions->>'MANAGE_MEDICINES')::boolean THEN 'admin' ELSE 'member' END AS role
  FROM care_relationships cr
  UNION
  SELECT p.id, p.user_id, p.id AS parent_id, 'dependent' AS role
  FROM persons p WHERE p.user_id IS NOT NULL;

COMMIT;
