-- 0024_mod_queues_reports: Ozone-style queue + report-management surface
--
-- Adds the two pieces the bundled mod service was still missing vs. the
-- upstream Ozone reference:
--
--   1. `mod_queues` + `mod_queue_assignments` — operator-defined
--      moderation queues with per-moderator assignments. A queue is a
--      named bucket of (subject-type, report-type) routing rules; a
--      report whose (subject-type, reason-type) matches an enabled
--      queue is auto-routed to it on `routeReports`.
--
--   2. Routing + assignment columns on `moderation_reports` — `queue_id`
--      links a report to a queue (NULL = unrouted; the deleteQueue
--      lexicon also defines `-1` as a sentinel for "unassigned after
--      migration," but we model that as NULL); `assigned_to_did` +
--      `assigned_at` capture per-report moderator ownership.
--
-- See chapter 24 — Ozone-shaped moderation.

CREATE TABLE IF NOT EXISTS "mod_queues" (
  "id" bigserial PRIMARY KEY,
  "name" text NOT NULL UNIQUE,
  "description" text,
  "subject_types" text[] NOT NULL,
  "report_types" text[] NOT NULL,
  "collection" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "mod_queues_enabled_idx" ON "mod_queues" ("enabled");

CREATE TABLE IF NOT EXISTS "mod_queue_assignments" (
  "id" bigserial PRIMARY KEY,
  "queue_id" bigint NOT NULL REFERENCES "mod_queues" ("id") ON DELETE CASCADE,
  "did" text NOT NULL,
  "start_at" timestamptz NOT NULL DEFAULT now(),
  "end_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "mod_queue_assignments_queue_idx"
  ON "mod_queue_assignments" ("queue_id", "end_at");
CREATE INDEX IF NOT EXISTS "mod_queue_assignments_did_idx"
  ON "mod_queue_assignments" ("did", "end_at");

ALTER TABLE "moderation_reports"
  ADD COLUMN IF NOT EXISTS "queue_id" bigint REFERENCES "mod_queues" ("id"),
  ADD COLUMN IF NOT EXISTS "assigned_to_did" text,
  ADD COLUMN IF NOT EXISTS "assigned_at" timestamptz;
CREATE INDEX IF NOT EXISTS "moderation_reports_queue_idx"
  ON "moderation_reports" ("queue_id", "created_at");
CREATE INDEX IF NOT EXISTS "moderation_reports_assignee_idx"
  ON "moderation_reports" ("assigned_to_did", "created_at");
