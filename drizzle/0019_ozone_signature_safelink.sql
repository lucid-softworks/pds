-- 0019_ozone_signature_safelink: Ozone's signature + safelink surfaces
--
-- Three tables for the two operator-side Ozone subsystems we hadn't
-- modelled yet:
--
--   account_signatures   per-(did, property, value) fingerprint store.
--                        Operators populate this manually (or via a
--                        future scraper); the signature.* endpoints
--                        query it to find sock-puppets / related
--                        accounts.
--   safelink_rules       current URL-safety policy per (url, pattern).
--                        AppViews query us to learn which links to
--                        block / warn on / whitelist.
--   safelink_events      append-only audit log of every rule change.
--                        Separate from mod_events because it's per-
--                        URL-rule scope.
--
-- See chapter 24 — Ozone-shaped moderation.

CREATE TABLE IF NOT EXISTS "account_signatures" (
  "id"        bigserial PRIMARY KEY,
  "did"       text NOT NULL,
  "property"  text NOT NULL,         -- e.g. 'email', 'ip', 'phone', 'device'
  "value"     text NOT NULL,
  "noted_at"  timestamptz NOT NULL DEFAULT now(),
  "noted_by"  text
);
CREATE INDEX IF NOT EXISTS "account_signatures_did_idx"
  ON "account_signatures" ("did");
CREATE INDEX IF NOT EXISTS "account_signatures_value_idx"
  ON "account_signatures" ("property", "value");
CREATE UNIQUE INDEX IF NOT EXISTS "account_signatures_unique"
  ON "account_signatures" ("did", "property", "value");

CREATE TABLE IF NOT EXISTS "safelink_rules" (
  "url"             text NOT NULL,
  -- 'domain' (url is a hostname) or 'url' (url is a full URL).
  "pattern"         text NOT NULL CHECK ("pattern" IN ('domain', 'url')),
  -- 'block', 'warn', or 'whitelist'.
  "action"          text NOT NULL CHECK ("action" IN ('block', 'warn', 'whitelist')),
  -- Lexicon-defined reason: 'csam' | 'spam' | 'phishing' | 'none' | ...
  "reason"          text NOT NULL,
  "comment"         text,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  "last_updated_by" text,
  PRIMARY KEY ("url", "pattern")
);

CREATE TABLE IF NOT EXISTS "safelink_events" (
  "id"          bigserial PRIMARY KEY,
  "event_type"  text NOT NULL,   -- 'addRule' | 'updateRule' | 'removeRule'
  "url"         text NOT NULL,
  "pattern"     text NOT NULL,
  "action"      text,
  "reason"      text,
  "comment"     text,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "created_by"  text
);
CREATE INDEX IF NOT EXISTS "safelink_events_created_at_idx"
  ON "safelink_events" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "safelink_events_url_idx"
  ON "safelink_events" ("url", "created_at" DESC);
