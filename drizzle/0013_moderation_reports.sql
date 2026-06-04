-- 0013_moderation_reports: moderation_reports
--
-- One row per user-submitted `com.atproto.moderation.createReport` call.
-- The PDS itself is not a moderation service — reports are normally
-- proxied to an upstream mod service (Bluesky's, or whatever the operator
-- has configured). We still persist them locally so:
--
--   1. The operator console has an audit trail of "what did people report
--      from this PDS?" without depending on the mod service being reachable.
--   2. Even when no upstream mod service is configured, the endpoint can
--      return a stable id and round-trip the lexicon shape.
--
-- The `subject_type` column carries the lexicon `$type` of the subject:
--
--   - 'com.atproto.admin.defs#repoRef'    → subject_did is set, subject_uri/cid null
--   - 'com.atproto.repo.strongRef'        → subject_uri + subject_cid set, subject_did null
--
-- See chapter 19 — Moderation.

CREATE TABLE IF NOT EXISTS "moderation_reports" (
  "id"               bigserial PRIMARY KEY,
  "reported_by_did"  text NOT NULL,
  "reason_type"      text NOT NULL,
  "reason"           text,
  "subject_type"     text NOT NULL,
  "subject_did"      text,
  "subject_uri"      text,
  "subject_cid"      text,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "moderation_reports_created_idx"
  ON "moderation_reports" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "moderation_reports_reporter_idx"
  ON "moderation_reports" ("reported_by_did", "created_at" DESC);
