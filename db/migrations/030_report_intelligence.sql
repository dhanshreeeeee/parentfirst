-- report intelligence: every row keeps its category, the lab's own flag, and how it was verified
ALTER TABLE report_params ADD COLUMN IF NOT EXISTS category   TEXT;
ALTER TABLE report_params ADD COLUMN IF NOT EXISTS lab_flag   TEXT;
ALTER TABLE report_params ADD COLUMN IF NOT EXISTS verified   TEXT;     -- document | model | corrected | unverified | unchecked
ALTER TABLE report_params ADD COLUMN IF NOT EXISTS first_read NUMERIC;  -- the first model's value, when a second read corrected it
ALTER TABLE reports ADD COLUMN IF NOT EXISTS patient_name TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS patient_age  TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS patient_sex  TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS qualitative  JSONB NOT NULL DEFAULT '[]';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS extraction_stats JSONB;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS analysis     JSONB;    -- cached narrative: opening a report again costs nothing
ALTER TABLE reports ADD COLUMN IF NOT EXISTS analysis_at  TIMESTAMPTZ;
-- a report whose name didn't match waits here, so "yes, continue" doesn't re-read the file
CREATE TABLE IF NOT EXISTS report_drafts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  obj JSONB NOT NULL, stats JSONB, method TEXT, mime TEXT, file_name TEXT, bytes BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_report_params_name ON report_params (lower(name));
