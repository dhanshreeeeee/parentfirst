-- ParentFirst — Migration 001: care modules
-- Safe to run multiple times (idempotent). Run:
--   psql -d parentfirst_vault -f db/migrations/001_care_modules.sql

-- ── Emergency info on the parent ───────────────────────────────
ALTER TABLE parents ADD COLUMN IF NOT EXISTS blood_group   TEXT;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS allergies     TEXT;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS conditions    TEXT;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS primary_doctor TEXT;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS doctor_phone  TEXT;

-- ── Family / emergency contacts ────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  relation    TEXT,
  phone       TEXT,
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contacts_parent ON contacts(parent_id);

-- ── Medications ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS medications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id       UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  dosage          TEXT,                 -- e.g. '500mg', '1 tablet'
  slot_morning    BOOLEAN NOT NULL DEFAULT false,
  slot_afternoon  BOOLEAN NOT NULL DEFAULT false,
  slot_night      BOOLEAN NOT NULL DEFAULT false,
  notes           TEXT,                 -- 'after food', etc.
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meds_parent ON medications(parent_id);

-- one tick per medicine per slot per day
CREATE TABLE IF NOT EXISTS medication_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medication_id UUID NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  log_date      DATE NOT NULL,
  slot          TEXT NOT NULL,          -- 'morning' | 'afternoon' | 'night'
  taken         BOOLEAN NOT NULL DEFAULT true,
  taken_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (medication_id, log_date, slot)
);
CREATE INDEX IF NOT EXISTS idx_medlog_med_date ON medication_log(medication_id, log_date);

-- ── Caregiver daily log (one per parent per day) ───────────────
CREATE TABLE IF NOT EXISTS daily_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id     UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  log_date      DATE NOT NULL,
  mood          TEXT,                   -- 'happy','calm','low','unwell'
  ate_well      TEXT,                   -- 'yes','partly','no'
  sleep_quality TEXT,                   -- 'good','ok','poor'
  bp            TEXT,                   -- free text e.g. '128/82'
  sugar         TEXT,                   -- free text e.g. '118'
  notes         TEXT,                   -- helper's free note
  family_update TEXT,                   -- AI/template generated for family feed
  created_by    TEXT DEFAULT 'caregiver',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parent_id, log_date)
);
CREATE INDEX IF NOT EXISTS idx_dailylog_parent_date ON daily_logs(parent_id, log_date DESC);

-- ── Seed demo data (only if the demo parent exists and has none) ─
DO $$
DECLARE v_parent UUID;
BEGIN
  SELECT id INTO v_parent FROM parents ORDER BY created_at LIMIT 1;
  IF v_parent IS NULL THEN RETURN; END IF;

  -- emergency info
  UPDATE parents SET
    blood_group   = COALESCE(blood_group, 'B+'),
    allergies     = COALESCE(allergies, 'Penicillin'),
    conditions    = COALESCE(conditions, 'Type 2 Diabetes, Hypertension'),
    primary_doctor= COALESCE(primary_doctor, 'Dr. A. Mehta'),
    doctor_phone  = COALESCE(doctor_phone, '+91 98xxxxxx01')
  WHERE id = v_parent;

  -- contacts
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE parent_id = v_parent) THEN
    INSERT INTO contacts (parent_id, name, relation, phone, is_primary) VALUES
      (v_parent, 'Dhanshree', 'Daughter', '+91 90xxxxxx45', true),
      (v_parent, 'Jenish', 'Son', '+91 90xxxxxx46', false);
  END IF;

  -- medications
  IF NOT EXISTS (SELECT 1 FROM medications WHERE parent_id = v_parent) THEN
    INSERT INTO medications (parent_id, name, dosage, slot_morning, slot_afternoon, slot_night, notes) VALUES
      (v_parent, 'Metformin',   '500mg', true,  true,  false, 'After food'),
      (v_parent, 'Telmisartan', '40mg',  true,  false, false, 'For BP'),
      (v_parent, 'Vitamin D3',  '60k IU',false, false, true,  'Weekly, Sunday'),
      (v_parent, 'Atorvastatin','10mg',  false, false, true,  'At bedtime');
  END IF;

  -- one daily log for today
  IF NOT EXISTS (SELECT 1 FROM daily_logs WHERE parent_id = v_parent AND log_date = CURRENT_DATE) THEN
    INSERT INTO daily_logs (parent_id, log_date, mood, ate_well, sleep_quality, bp, sugar, notes, family_update)
    VALUES (v_parent, CURRENT_DATE, 'happy', 'yes', 'good', '128/82', '118',
      'Had a good morning walk, ate full breakfast, watched the news and asked about the grandchildren.',
      'Papa had a lovely day today — a full breakfast, a morning walk, and he was in great spirits watching the news. His BP and sugar are both steady. He asked about the grandchildren. 💛');
  END IF;
END $$;
