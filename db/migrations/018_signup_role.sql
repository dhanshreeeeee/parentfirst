-- ParentFirst — Migration 018: remember what someone signed up as,
-- so the admin doesn't have to re-declare it when adding them to a group.
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_role TEXT;
