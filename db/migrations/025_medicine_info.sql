CREATE TABLE IF NOT EXISTS medicine_info (
  name TEXT PRIMARY KEY, generic TEXT, purpose TEXT, side_effects JSONB, cautions TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
