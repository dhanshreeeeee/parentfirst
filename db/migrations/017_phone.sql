-- ParentFirst — Migration 017: mobile number on the care profile
ALTER TABLE care_profiles ADD COLUMN IF NOT EXISTS phone TEXT;
