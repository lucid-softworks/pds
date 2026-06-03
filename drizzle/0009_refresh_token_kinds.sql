-- 0009_refresh_token_kinds: extend refresh_tokens to also hold OAuth tokens.
--
-- We let the same table service both the legacy password-session refresh JWTs
-- (kind='session') and the new OAuth-flow refresh JWTs (kind='oauth'). OAuth
-- rows additionally pin a DPoP key thumbprint and a granted scope; the
-- session rows leave both NULL. See chapter 21 — OAuth.

ALTER TABLE "refresh_tokens"
  ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'session';

ALTER TABLE "refresh_tokens"
  ADD COLUMN IF NOT EXISTS "dpop_jkt" text;

ALTER TABLE "refresh_tokens"
  ADD COLUMN IF NOT EXISTS "scope" text;
