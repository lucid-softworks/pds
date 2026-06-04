-- 0025_mod_report_activities: per-report activity log
--
-- The `tools.ozone.report.*` surface tracks every action taken on a
-- report as a typed activity row. The lexicon defines six activity
-- types: queue, assignment, escalation, close, reopen, note. Each row
-- captures who did it, when, an optional internal note (moderator-only),
-- an optional public note (visible to the reporter), and a free-form
-- meta payload for activity-specific metadata.
--
-- See chapter 24 — Ozone-shaped moderation (Reports).

CREATE TABLE IF NOT EXISTS "mod_report_activities" (
  "id" bigserial PRIMARY KEY,
  "report_id" bigint NOT NULL REFERENCES "moderation_reports" ("id") ON DELETE CASCADE,
  "activity_type" text NOT NULL,
  "previous_status" text,
  "internal_note" text,
  "public_note" text,
  "meta" jsonb,
  "is_automated" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "mod_report_activities_report_idx"
  ON "mod_report_activities" ("report_id", "id");
