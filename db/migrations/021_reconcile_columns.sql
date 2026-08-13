-- ParentFirst — Migration 021: reconcile columns on databases that were
-- created before later columns were folded into schema.sql.
-- Every statement is IF NOT EXISTS — safe to run on any database, any number
-- of times. This is the catch-up for servers that pre-date recent features.

-- vitals: weight, notes, who logged it
ALTER TABLE vitals ADD COLUMN IF NOT EXISTS weight_kg NUMERIC;
ALTER TABLE vitals ADD COLUMN IF NOT EXISTS notes     TEXT;
ALTER TABLE vitals ADD COLUMN IF NOT EXISTS logged_by UUID REFERENCES users(id);

-- medications: food timing + course length
ALTER TABLE medications ADD COLUMN IF NOT EXISTS food_timing   TEXT;
ALTER TABLE medications ADD COLUMN IF NOT EXISTS duration_days INT;

-- reports: prescription structure + document kind
ALTER TABLE reports ADD COLUMN IF NOT EXISTS rx_meta  JSONB;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS doc_kind TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS has_file BOOLEAN DEFAULT false;

-- care_profiles: phone
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS phone TEXT;

-- users: signup role + verification
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_role TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified    BOOLEAN NOT NULL DEFAULT true;

-- appointments: the columns the timeline reads
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS with_whom TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS kind      TEXT;
