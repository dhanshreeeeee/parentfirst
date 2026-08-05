-- ParentFirst — Migration 010: daily wellness & habit log
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/010_wellness.sql

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
