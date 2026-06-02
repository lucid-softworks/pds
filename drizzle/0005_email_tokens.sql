-- 0005_email_tokens: out-of-band action tokens
--
-- Backing storage for email confirmation, email change, and password reset.
-- One live token per (did, purpose); issuance deletes any older row for the
-- same pair, and consumption deletes on hit (single-use). The secondary
-- index on `token` supports password-reset submission, which arrives with no
-- authenticated DID.
--
-- See chapter 13 — Authentication.

CREATE TABLE IF NOT EXISTS "email_tokens" (
  "did"        text NOT NULL REFERENCES "accounts"("did") ON DELETE CASCADE,
  "purpose"    text NOT NULL,
  "token"      text NOT NULL,
  "new_email"  text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("did", "purpose", "token")
);
CREATE INDEX IF NOT EXISTS "email_tokens_token_idx" ON "email_tokens" ("token");
