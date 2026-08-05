-- ParentFirst — Migration 012: daily vitals (BP, sugar, weight, pulse)
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/012_vitals.sql

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
