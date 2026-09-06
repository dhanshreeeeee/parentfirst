CREATE TABLE IF NOT EXISTS family_todos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  person_id UUID REFERENCES parents(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  due_date DATE, done_at TIMESTAMPTZ,
  done_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_todos_family ON family_todos(family_id, done_at);
ALTER TABLE medications ADD COLUMN IF NOT EXISTS stock_count INTEGER;
ALTER TABLE medications ADD COLUMN IF NOT EXISTS stock_updated_at TIMESTAMPTZ;
