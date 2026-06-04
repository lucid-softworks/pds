-- 0020_mod_report_resolution: per-report close tracking
--
-- The /mod dashboard's "open reports" count was approximate: total -
-- (reports against currently-takendown subjects). That misses the
-- case of a moderator explicitly acknowledging a report without
-- taking the subject down. This table links each closing event to the
-- report it resolved, so the count becomes exact.
--
-- See chapter 24 — Ozone-shaped moderation (Operational gaps section).

CREATE TABLE IF NOT EXISTS "mod_report_resolution" (
  "report_id"     bigint NOT NULL
                  REFERENCES "moderation_reports"("id") ON DELETE CASCADE,
  "event_id"      bigint NOT NULL
                  REFERENCES "mod_events"("id") ON DELETE CASCADE,
  "resolved_at"   timestamptz NOT NULL DEFAULT now(),
  "resolved_by"   text,
  PRIMARY KEY ("report_id")
);
CREATE INDEX IF NOT EXISTS "mod_report_resolution_event_idx"
  ON "mod_report_resolution" ("event_id");
