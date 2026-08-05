-- ParentFirst — Migration 005: caregiver alerts (flag a problem to the family)
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/005_alerts.sql

CREATE TABLE IF NOT EXISTS alerts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'resolved'
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_parent ON alerts(parent_id, status, created_at DESC);
