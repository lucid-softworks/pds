-- 0004_app_passwords: app_passwords
--
-- Alternate credentials per account. Same scrypt hash format as
-- accounts.password_hash; loginWithPassword tries the main hash first and
-- falls back to scanning this table.
--
-- See chapter 13 — Authentication.

CREATE TABLE IF NOT EXISTS "app_passwords" (
  "did"            text NOT NULL REFERENCES "accounts"("did") ON DELETE CASCADE,
  "name"           text NOT NULL,
  "password_hash"  text NOT NULL,
  "privileged"     boolean NOT NULL DEFAULT false,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("did", "name")
);
