-- ParentFirst — Migration 020: email OTP (verify + password reset) and web push.
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/020_otp_push.sql

-- email ownership is now proven with a 6-digit code
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT false;
-- everyone who already exists keeps working
UPDATE users SET verified = true WHERE verified = false;

CREATE TABLE IF NOT EXISTS email_otps (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  purpose    TEXT NOT NULL,              -- 'verify' | 'reset'
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otps_email ON email_otps(email, purpose);

-- browser push subscriptions (PWA notifications)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
