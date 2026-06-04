-- 0018_ozone_comm_verification: Ozone's communication templates + verification index
--
-- Two more tables for the operator-side Ozone APIs:
--
--   ozone_comm_templates    canned operator-to-user email templates
--                          (used by modEventEmail; the upstream Ozone
--                          UI prompts moderators to pick a template
--                          before sending)
--   verifications_index    one row per verification "grant" issued by
--                          this labeler. The grant itself is also a
--                          record in the labeler's repo at
--                          app.bsky.graph.verification — this table
--                          mirrors the index dimensions
--                          (issuer_did, subject_did) for filtered
--                          listVerifications queries without forcing
--                          a repo scan.
--
-- See chapter 24 — Ozone-shaped moderation.

CREATE TABLE IF NOT EXISTS "ozone_comm_templates" (
  "id"               bigserial PRIMARY KEY,
  "name"             text NOT NULL UNIQUE,
  "subject"          text NOT NULL,
  "content_markdown" text NOT NULL,
  "lang"             text,
  "disabled"         boolean NOT NULL DEFAULT false,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now(),
  "last_updated_by"  text
);

CREATE TABLE IF NOT EXISTS "verifications_index" (
  -- The AT-URI of the verification record in the issuer's repo.
  "uri"          text PRIMARY KEY,
  "cid"          text NOT NULL,
  "issuer_did"   text NOT NULL,
  "subject_did"  text NOT NULL,
  "handle"       text NOT NULL,
  "display_name" text,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "verifications_index_subject_idx"
  ON "verifications_index" ("subject_did", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "verifications_index_issuer_idx"
  ON "verifications_index" ("issuer_did", "created_at" DESC);
