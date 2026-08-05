-- ParentFirst — Migration 002: care team, bookings, activities (Moh TV)
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/002_engagement.sql

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
