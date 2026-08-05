-- ParentFirst — Migration 007: appointments & reminders
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/007_appointments.sql

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
