-- ParentFirst Health Vault — schema v0.1
-- Run: createdb parentfirst_vault && psql -d parentfirst_vault -f db/schema.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- for gen_random_uuid()

-- ── Parents (the elder whose reports we store) ─────────────────
CREATE TABLE IF NOT EXISTS parents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  age         INT,
  relation    TEXT,                      -- 'father', 'mother', 'dada', ...
  city        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Reports (one uploaded document) ────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id     UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  report_type   TEXT NOT NULL DEFAULT 'Uploaded Report',
  lab_name      TEXT,
  doctor_name   TEXT,
  report_date   DATE NOT NULL,
  source_file   TEXT,                    -- original filename
  raw_extraction JSONB,                  -- full JSON returned by the AI extractor
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reports_parent_date ON reports(parent_id, report_date DESC);

-- ── Parameters (one measured value inside a report) ────────────
CREATE TABLE IF NOT EXISTS report_params (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,             -- canonical name, e.g. 'HbA1c'
  value       NUMERIC NOT NULL,
  unit        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_params_report ON report_params(report_id);
CREATE INDEX IF NOT EXISTS idx_params_name ON report_params(name);

-- ── Reference ranges (healthy bands used for status flags) ─────
CREATE TABLE IF NOT EXISTS reference_ranges (
  name      TEXT PRIMARY KEY,
  min_value NUMERIC NOT NULL,
  max_value NUMERIC NOT NULL,
  unit      TEXT NOT NULL
);

INSERT INTO reference_ranges (name, min_value, max_value, unit) VALUES
  ('Hemoglobin',        13,   17,   'g/dL'),
  ('HbA1c',             4,    5.7,  '%'),
  ('Fasting Glucose',   70,   100,  'mg/dL'),
  ('Total Cholesterol', 0,    200,  'mg/dL'),
  ('LDL Cholesterol',   0,    100,  'mg/dL'),
  ('HDL Cholesterol',   40,   100,  'mg/dL'),
  ('Triglycerides',     0,    150,  'mg/dL'),
  ('Creatinine',        0.7,  1.3,  'mg/dL'),
  ('Vitamin D',         30,   100,  'ng/mL'),
  ('Vitamin B12',       200,  900,  'pg/mL'),
  ('TSH',               0.4,  4.0,  'mIU/L'),
  ('Platelets',         150,  410,  'k/uL'),
  ('WBC',               4,    11,   'k/uL')
ON CONFLICT (name) DO NOTHING;

-- ── Seed: demo parent + two sample reports (Jan vs Jun story) ──
DO $$
DECLARE
  v_parent UUID;
  v_r1 UUID;
  v_r2 UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM parents) THEN
    INSERT INTO parents (name, age, relation, city)
    VALUES ('Ramesh Sharma', 76, 'father', 'Delhi')
    RETURNING id INTO v_parent;

    INSERT INTO reports (parent_id, report_type, lab_name, doctor_name, report_date, source_file)
    VALUES (v_parent, 'Complete Blood + Metabolic Panel', 'Dr. Lal PathLabs', 'Dr. A. Mehta', '2026-01-12', 'sample-jan.pdf')
    RETURNING id INTO v_r1;

    INSERT INTO report_params (report_id, name, value, unit) VALUES
      (v_r1, 'Hemoglobin', 12.4, 'g/dL'),
      (v_r1, 'HbA1c', 8.1, '%'),
      (v_r1, 'Fasting Glucose', 156, 'mg/dL'),
      (v_r1, 'Total Cholesterol', 224, 'mg/dL'),
      (v_r1, 'LDL Cholesterol', 148, 'mg/dL'),
      (v_r1, 'HDL Cholesterol', 38, 'mg/dL'),
      (v_r1, 'Triglycerides', 198, 'mg/dL'),
      (v_r1, 'Creatinine', 1.1, 'mg/dL'),
      (v_r1, 'Vitamin D', 18, 'ng/mL'),
      (v_r1, 'TSH', 3.2, 'mIU/L');

    INSERT INTO reports (parent_id, report_type, lab_name, doctor_name, report_date, source_file)
    VALUES (v_parent, 'Complete Blood + Metabolic Panel', 'Dr. Lal PathLabs', 'Dr. A. Mehta', '2026-06-20', 'sample-jun.pdf')
    RETURNING id INTO v_r2;

    INSERT INTO report_params (report_id, name, value, unit) VALUES
      (v_r2, 'Hemoglobin', 13.6, 'g/dL'),
      (v_r2, 'HbA1c', 6.9, '%'),
      (v_r2, 'Fasting Glucose', 118, 'mg/dL'),
      (v_r2, 'Total Cholesterol', 186, 'mg/dL'),
      (v_r2, 'LDL Cholesterol', 104, 'mg/dL'),
      (v_r2, 'HDL Cholesterol', 44, 'mg/dL'),
      (v_r2, 'Triglycerides', 142, 'mg/dL'),
      (v_r2, 'Creatinine', 1.0, 'mg/dL'),
      (v_r2, 'Vitamin D', 34, 'ng/mL'),
      (v_r2, 'TSH', 2.8, 'mIU/L');
  END IF;
END $$;
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

-- ── Care team: the people looking after the parent ─────────────
CREATE TABLE IF NOT EXISTS care_team (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL,            -- 'caregiver' | 'nurse' | 'physiotherapist' | 'companion' | 'doctor'
  phone      TEXT,
  since      DATE,
  rating     NUMERIC,                  -- optional 0-5
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_careteam_parent ON care_team(parent_id);

-- ── Service requests: book a caretaker / nurse / physio / companion ──
CREATE TABLE IF NOT EXISTS service_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id      UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  service_type   TEXT NOT NULL,        -- 'caregiver' | 'nurse' | 'physiotherapist' | 'companion' | 'doctor visit' | 'lab test'
  frequency      TEXT,                 -- 'one-time' | 'daily' | 'weekly'
  preferred_date TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'confirmed' | 'done' | 'cancelled'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_svcreq_parent ON service_requests(parent_id, created_at DESC);

-- ── Activities: curated wellness / exercise videos (global) ────
CREATE TABLE IF NOT EXISTS activities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  category    TEXT NOT NULL,           -- 'Chair Yoga' | 'Mobility & Knees' | 'Balance & Strength' | 'Breathing' | 'Fun & Games'
  level       TEXT,                    -- 'Gentle' | 'Moderate'
  duration_min INT,
  youtube_id  TEXT NOT NULL,
  description TEXT,
  sort_order  INT DEFAULT 0
);

-- seed the video library (only if empty). Real, publicly available YouTube videos.
INSERT INTO activities (title, category, level, duration_min, youtube_id, description, sort_order)
SELECT * FROM (VALUES
  ('Gentle Chair Yoga for Beginners & Seniors', 'Chair Yoga', 'Gentle', 20, '1DYH5ud3zHo', 'A calm, fully seated session — great for stiff mornings and limited mobility.', 1),
  ('Energizing Chair Yoga — Dynamic Flow',       'Chair Yoga', 'Moderate', 25, '-rBDxFKJtlE', 'A livelier seated flow to feel energized yet relaxed.', 2),
  ('Chair Yoga — Energizing Seated Stretches',   'Chair Yoga', 'Gentle', 20, 'cgaDPZ8UdZY', 'Focus on breathing and gentle stretches through traditional yoga poses.', 3),
  ('Chair Yoga — 10 Easy Moves',                 'Chair Yoga', 'Gentle', 15, 'U_jdXFfegKE', 'Ten simple moves to improve flexibility and mobility, all seated.', 4),
  ('5 Exercises for Knee Pain (Ages 60+)',       'Mobility & Knees', 'Gentle', 12, '1iO9ZlyobXE', 'Physio-guided exercises to ease knee pain and rebuild strength.', 5),
  ('Exercises for Seniors with Knee Pain',       'Mobility & Knees', 'Gentle', 15, '01d29PK6Jb4', 'Strengthen the muscles that protect the knees — follow along with Jenny.', 6),
  ('Leg Strengthening for Seniors',              'Balance & Strength', 'Moderate', 18, 'l7L5KUIHnic', 'Physiotherapist-led leg strengthening to decrease knee pain and improve balance.', 7),
  ('25-min Full-Body Chair Yoga',                'Chair Yoga', 'Moderate', 25, 'pAbVFNl6zR8', 'A full-body seated stretch for seniors, beginners and limited mobility.', 8)
) AS v(title, category, level, duration_min, youtube_id, description, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM activities);

-- ── Seed care team + a sample booking (only if empty) ──────────
DO $$
DECLARE v_parent UUID;
BEGIN
  SELECT id INTO v_parent FROM parents ORDER BY created_at LIMIT 1;
  IF v_parent IS NULL THEN RETURN; END IF;

  IF NOT EXISTS (SELECT 1 FROM care_team WHERE parent_id = v_parent) THEN
    INSERT INTO care_team (parent_id, name, role, phone, since, rating) VALUES
      (v_parent, 'Ramu Kaka',      'caregiver',       '+91 90xxxxxx11', '2025-09-01', 4.9),
      (v_parent, 'Meena (Physio)', 'physiotherapist', '+91 90xxxxxx22', '2026-02-15', 4.8);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM service_requests WHERE parent_id = v_parent) THEN
    INSERT INTO service_requests (parent_id, service_type, frequency, preferred_date, notes, status) VALUES
      (v_parent, 'physiotherapist', 'weekly', 'Every Saturday, 10 AM', 'Knee strengthening follow-up', 'confirmed');
  END IF;
END $$;

-- richer booking fields (migration 003)
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS service_slug TEXT;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS preferred_time TEXT;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS concern TEXT;

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

CREATE TABLE IF NOT EXISTS alerts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'resolved'
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_parent ON alerts(parent_id, status, created_at DESC);

ALTER TABLE reports ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS file_mime TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS has_file  BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS appointments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'appointment',  -- 'appointment' | 'reminder'
  title      TEXT NOT NULL,
  with_whom  TEXT,                                  -- doctor / clinic
  appt_date  DATE NOT NULL,
  appt_time  TEXT,
  location   TEXT,
  notes      TEXT,
  status     TEXT NOT NULL DEFAULT 'upcoming',      -- 'upcoming' | 'done' | 'cancelled'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appt_parent_date ON appointments(parent_id, appt_date);

-- seed a couple for the demo parent
DO $$
DECLARE v_parent UUID;
BEGIN
  SELECT id INTO v_parent FROM parents ORDER BY created_at LIMIT 1;
  IF v_parent IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM appointments WHERE parent_id=v_parent) THEN
    INSERT INTO appointments (parent_id, kind, title, with_whom, appt_date, appt_time, location, notes) VALUES
      (v_parent, 'appointment', 'Diabetes follow-up', 'Dr. A. Mehta', CURRENT_DATE + 5, '11:30 AM', 'Apollo Clinic', 'Carry the June blood report'),
      (v_parent, 'reminder', 'Vitamin D recheck', 'Lab test', CURRENT_DATE + 20, NULL, 'At home collection', 'Was low in January, recheck due');
  END IF;
END $$;

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

-- days_of_week: array of 0-6 (0 = Sunday). Empty/NULL = every day.
ALTER TABLE medications ADD COLUMN IF NOT EXISTS days_of_week INT[];
-- times: array of 'HH:MM' strings, e.g. {'08:00','20:00'}
ALTER TABLE medications ADD COLUMN IF NOT EXISTS times TEXT[];
-- how often, for display: 'daily' | 'weekdays' | 'alternate' | 'weekly' | 'custom'
ALTER TABLE medications ADD COLUMN IF NOT EXISTS frequency TEXT NOT NULL DEFAULT 'daily';

-- give the seeded medicines sensible times so reminders work out of the box
UPDATE medications SET times = ARRAY['08:00','14:00']
  WHERE times IS NULL AND slot_morning AND slot_afternoon;
UPDATE medications SET times = ARRAY['08:00']
  WHERE times IS NULL AND slot_morning AND NOT slot_afternoon AND NOT slot_night;
UPDATE medications SET times = ARRAY['21:00']
  WHERE times IS NULL AND slot_night AND NOT slot_morning AND NOT slot_afternoon;
UPDATE medications SET times = ARRAY['08:00'] WHERE times IS NULL;

CREATE TABLE IF NOT EXISTS wellness_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id     UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  log_date      DATE NOT NULL,
  walked        BOOLEAN,
  exercise      BOOLEAN,      -- yoga / stretching / physio exercises
  meditation    BOOLEAN,
  ate_healthy   BOOLEAN,
  water_glasses INT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parent_id, log_date)
);
CREATE INDEX IF NOT EXISTS idx_wellness_parent ON wellness_logs(parent_id, log_date DESC);

ALTER TABLE wellness_logs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE wellness_logs ADD COLUMN IF NOT EXISTS saved_by   UUID REFERENCES users(id);

-- backfill so existing rows show something sensible
UPDATE wellness_logs SET updated_at = created_at WHERE updated_at IS NULL;

CREATE TABLE IF NOT EXISTS vitals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id    UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  taken_on     DATE NOT NULL,
  taken_time   TEXT,                    -- 'morning' | 'evening' | free text
  systolic     INT,
  diastolic    INT,
  pulse        INT,
  sugar        INT,                     -- mg/dL
  sugar_type   TEXT,                    -- 'fasting' | 'post-meal' | 'random'
  weight_kg    NUMERIC,
  notes        TEXT,
  logged_by    UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vitals_parent ON vitals(parent_id, taken_on DESC);

-- prescriptions get their own kind on reports so the timeline can tell them apart
ALTER TABLE reports ADD COLUMN IF NOT EXISTS doc_kind TEXT NOT NULL DEFAULT 'report';

ALTER TABLE report_params ADD COLUMN IF NOT EXISTS ref_low  NUMERIC;
ALTER TABLE report_params ADD COLUMN IF NOT EXISTS ref_high NUMERIC;
ALTER TABLE report_params ADD COLUMN IF NOT EXISTS ref_text TEXT;

-- widen the fallback table so common Indian panels aren't left blank
INSERT INTO reference_ranges (name, min_value, max_value, unit) VALUES
  ('Sodium',              137,  145,  'mmol/L'),
  ('Potassium',           3.5,  5.5,  'mmol/L'),
  ('Chloride',            98,   107,  'mmol/L'),
  ('Bilirubin Total',     0.2,  1.3,  'mg/dL'),
  ('Bilirubin Direct',    0,    0.3,  'mg/dL'),
  ('Bilirubin Indirect',  0.1,  1.1,  'mg/dL'),
  ('AST',                 17,   49,   'U/L'),
  ('ALT',                 0,    50,   'U/L'),
  ('ALP',                 38,   126,  'U/L'),
  ('GGT',                 15,   73,   'U/L'),
  ('Total Protein',       6,    8.3,  'g/dL'),
  ('Albumin',             3.5,  5,    'g/dL'),
  ('Globulin',            2.3,  3.5,  'g/dL'),
  ('Urea',                17,   43,   'mg/dL'),
  ('Uric Acid',           3.5,  7.2,  'mg/dL'),
  ('Calcium',             8.6,  10.2, 'mg/dL'),
  ('ESR',                 0,    20,   'mm/hr'),
  ('RBC',                 4.5,  5.9,  'mil/uL')
ON CONFLICT (name) DO NOTHING;


ALTER TABLE report_params ADD COLUMN IF NOT EXISTS ref_low  NUMERIC;
ALTER TABLE report_params ADD COLUMN IF NOT EXISTS ref_high NUMERIC;
ALTER TABLE report_params ADD COLUMN IF NOT EXISTS ref_text TEXT;

-- widen the fallback table so common Indian panels aren't left blank
INSERT INTO reference_ranges (name, min_value, max_value, unit) VALUES
  ('Sodium',              137,  145,  'mmol/L'),
  ('Potassium',           3.5,  5.5,  'mmol/L'),
  ('Chloride',            98,   107,  'mmol/L'),
  ('Bilirubin Total',     0.2,  1.3,  'mg/dL'),
  ('Bilirubin Direct',    0,    0.3,  'mg/dL'),
  ('Bilirubin Indirect',  0.1,  1.1,  'mg/dL'),
  ('AST',                 17,   49,   'U/L'),
  ('ALT',                 0,    50,   'U/L'),
  ('ALP',                 38,   126,  'U/L'),
  ('GGT',                 15,   73,   'U/L'),
  ('Total Protein',       6,    8.3,  'g/dL'),
  ('Albumin',             3.5,  5,    'g/dL'),
  ('Globulin',            2.3,  3.5,  'g/dL'),
  ('Urea',                17,   43,   'mg/dL'),
  ('Uric Acid',           3.5,  7.2,  'mg/dL'),
  ('Calcium',             8.6,  10.2, 'mg/dL'),
  ('ESR',                 0,    20,   'mm/hr'),
  ('RBC',                 4.5,  5.9,  'mil/uL'),
  ('Alkaline Phosphatase', 38,  126,  'U/L'),
  ('A/G Ratio',            0.8,  2,   'Ratio'),
  ('AST/ALT Ratio',        0.7,  1.4, 'Ratio'),
  ('Albumin/Globulin Ratio', 0.8, 2,  'Ratio'),
  ('SGPT',                 0,    50,  'U/L'),
  ('SGOT',                 17,   49,  'U/L'),
  ('Protein',              6,    8.3, 'g/dL')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity        TEXT NOT NULL DEFAULT 'alert'; -- 'sos' | 'alert'
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_by UUID REFERENCES users(id);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_by     UUID REFERENCES users(id);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_at     TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolution      TEXT;

-- anything already raised from the emergency card counts as an SOS
UPDATE alerts SET severity='sos' WHERE severity='alert' AND message ILIKE '%SOS%';

ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_kind TEXT;      -- 'audio' | 'image'
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_secs INT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS has_media  BOOLEAN NOT NULL DEFAULT false;
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
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_role TEXT;

-- when to take it relative to food — the detail families actually argue about
ALTER TABLE medications ADD COLUMN IF NOT EXISTS food_timing   TEXT;   -- 'before' | 'after' | 'with' | 'any'
ALTER TABLE medications ADD COLUMN IF NOT EXISTS duration_days INT;

-- a digitised prescription keeps the doctor's full picture, not just the pills
ALTER TABLE reports ADD COLUMN IF NOT EXISTS rx_meta JSONB;
-- rx_meta: { diagnosis, complaints[], tests_advised[], vitals:{bp,pulse}, doctor, clinic }

-- community: simple shared events for the household (satsang, walk, health camp)
CREATE TABLE IF NOT EXISTS events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  event_date   DATE NOT NULL,
  event_time   TEXT,
  place        TEXT,
  notes        TEXT,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_household ON events(household_id, event_date);

-- email ownership is now proven with a 6-digit code
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT false;
-- everyone who already exists keeps working
UPDATE users SET verified = true WHERE verified = false;

CREATE TABLE IF NOT EXISTS email_otps (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  purpose    TEXT NOT NULL,              -- 'verify' | 'reset'
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otps_email ON email_otps(email, purpose);

-- browser push subscriptions (PWA notifications)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
