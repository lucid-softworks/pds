-- 0010_oauth_par_codes: oauth_par + oauth_codes
--
-- Two short-lived stores backing the user-facing OAuth flow.
--
--   oauth_par   — RFC 9126 Pushed Authorization Requests. The client POSTs
--                  their authorize-request parameters to /oauth/par over the
--                  back channel, gets a `request_uri` opaque handle, and
--                  redirects the user to /oauth/authorize?request_uri=...
--                  The row holds the parameters the redirect URL no longer
--                  carries. TTL ~60s.
--
--   oauth_codes — the authorization codes minted at the bottom of the
--                  consent screen. Bound to the client's DPoP key and the
--                  PKCE challenge from PAR, single-use, TTL ~60s. The
--                  /oauth/token endpoint exchanges them for an access +
--                  refresh JWT pair.
--
-- Both tables hold transient state; we don't preserve them across rotations
-- (no FK from refresh_tokens), and a periodic cleanup of expired rows is a
-- follow-up (the rows are tiny and the surface low-traffic).
--
-- See chapter 21 — OAuth.

CREATE TABLE IF NOT EXISTS "oauth_par" (
  "request_uri"           text PRIMARY KEY,
  "client_id"             text NOT NULL,
  "redirect_uri"          text NOT NULL,
  "scope"                 text NOT NULL,
  "state"                 text NOT NULL,
  "code_challenge"        text NOT NULL,
  "code_challenge_method" text NOT NULL,
  "dpop_jkt"              text NOT NULL,
  "login_hint"            text,
  "expires_at"            timestamptz NOT NULL,
  "created_at"            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "oauth_par_expires_idx" ON "oauth_par" ("expires_at");

CREATE TABLE IF NOT EXISTS "oauth_codes" (
  "code"                  text PRIMARY KEY,
  "did"                   text NOT NULL REFERENCES "accounts"("did") ON DELETE CASCADE,
  "client_id"             text NOT NULL,
  "redirect_uri"          text NOT NULL,
  "scope"                 text NOT NULL,
  "code_challenge"        text NOT NULL,
  "code_challenge_method" text NOT NULL,
  "dpop_jkt"              text NOT NULL,
  "used"                  boolean NOT NULL DEFAULT false,
  "expires_at"            timestamptz NOT NULL,
  "created_at"            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "oauth_codes_did_idx" ON "oauth_codes" ("did");
CREATE INDEX IF NOT EXISTS "oauth_codes_expires_idx" ON "oauth_codes" ("expires_at");
