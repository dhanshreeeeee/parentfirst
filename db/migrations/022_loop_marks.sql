-- ParentFirst — Migration 022: the care-loop ledger.
-- Every scheduled nudge/escalation records itself here exactly once, which is
-- what makes the loop safe to run every minute and safe to restart.

CREATE TABLE IF NOT EXISTS loop_marks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day        DATE NOT NULL,
  kind       TEXT NOT NULL,
  ref_id     UUID NOT NULL,
  slot       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (day, kind, ref_id, slot)
);
