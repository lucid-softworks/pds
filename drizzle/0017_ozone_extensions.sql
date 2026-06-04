-- 0017_ozone_extensions: Ozone's set/setting surfaces
--
-- Three small tables for the operator-side Ozone APIs:
--
--   ozone_settings        key/value/scope operator config store
--   ozone_sets            named subject sets (groups of DIDs/URIs)
--   ozone_set_values      members of each set
--
-- The team table from migration 0016 (mod_team) already covers the
-- tools.ozone.team.* surface — no new table needed there.
--
-- See chapter 24 — Ozone-shaped moderation.

-- ─── ozone_settings ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ozone_settings" (
  "key"            text NOT NULL,
  -- 'instance' (operator-global) or 'personal' (per-moderator, keyed on
  -- managed_by_did). Mirrors Ozone's two scopes.
  "scope"          text NOT NULL CHECK ("scope" IN ('instance', 'personal')),
  -- For scope='personal', the moderator DID this setting belongs to.
  -- NULL for scope='instance'.
  "managed_by_did" text,
  "value"          bytea NOT NULL,         -- DAG-CBOR encoded JSON value
  "description"    text,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  "last_updated_by" text                   -- DID of the moderator who set it
);
CREATE UNIQUE INDEX IF NOT EXISTS "ozone_settings_unique_idx"
  ON "ozone_settings" ("key", "scope", COALESCE("managed_by_did", ''));

-- ─── ozone_sets ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ozone_sets" (
  "name"        text PRIMARY KEY,
  "description" text,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "ozone_set_values" (
  "set_name" text NOT NULL REFERENCES "ozone_sets"("name") ON DELETE CASCADE,
  -- Free-form string: a DID, an AT-URI, a domain, etc. The lexicon
  -- doesn't constrain it; consumer logic decides what it means.
  "value"    text NOT NULL,
  "added_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("set_name", "value")
);
CREATE INDEX IF NOT EXISTS "ozone_set_values_value_idx"
  ON "ozone_set_values" ("value");
