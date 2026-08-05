-- ParentFirst — Migration 009: medicine schedules (days of week + specific times)
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/009_med_schedule.sql

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
