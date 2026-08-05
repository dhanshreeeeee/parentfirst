-- ParentFirst — Migration 014: make alerts actionable
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/014_alert_response.sql

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity        TEXT NOT NULL DEFAULT 'alert'; -- 'sos' | 'alert'
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_by UUID REFERENCES users(id);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_by     UUID REFERENCES users(id);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_at     TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolution      TEXT;

-- anything already raised from the emergency card counts as an SOS
UPDATE alerts SET severity='sos' WHERE severity='alert' AND message ILIKE '%SOS%';
