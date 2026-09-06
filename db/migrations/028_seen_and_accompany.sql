-- "Your family saw this": who looked at today's check-in, so the elder gets warmth back
CREATE TABLE IF NOT EXISTS checkin_views (
  checkin_id UUID NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (checkin_id, user_id)
);
-- who is taking the elder to the appointment
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS accompany_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
