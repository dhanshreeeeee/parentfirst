-- ParentFirst — Migration 003: richer booking fields
-- Idempotent. The guided "log problem → solutions" triage is served in-code
-- (see src/routes-care.js CATALOGUE/CONCERNS); this only enriches bookings.

ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS service_slug   TEXT;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS preferred_time TEXT;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS contact_phone  TEXT;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS concern        TEXT;
