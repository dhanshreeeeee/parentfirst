-- ParentFirst — Migration 019: medicine food-timing, structured prescriptions,
-- and community events.
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/019_meds_rx_events.sql

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
