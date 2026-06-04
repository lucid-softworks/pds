-- 0021_mod_event_extensions: side-effect columns + table for the next
-- batch of emitEvent types.
--
--   tags                       free-form string set per subject, set
--                              by modEventTag. Used by Ozone clients
--                              to categorise / filter.
--   priority_score             0..100 numeric priority assigned by
--                              modEventPriorityScore. Higher = look
--                              at this sooner.
--   appeal_state               'open' | 'resolved' | null — flips to
--                              'resolved' by modEventResolveAppeal.
--   mod_muted_reporters        DIDs whose reports are de-emphasised
--                              in the operator queue. Flipped by
--                              modEventMuteReporter / Unmute. No
--                              schema change to moderation_reports
--                              itself — consumers join against this
--                              table to filter.
--
-- See chapter 24 — Ozone-shaped moderation.

ALTER TABLE "mod_subject_status"
  ADD COLUMN IF NOT EXISTS "tags" text[],
  ADD COLUMN IF NOT EXISTS "priority_score" integer,
  ADD COLUMN IF NOT EXISTS "appeal_state" text;

CREATE TABLE IF NOT EXISTS "mod_muted_reporters" (
  "did"        text PRIMARY KEY,
  "muted_at"   timestamptz NOT NULL DEFAULT now(),
  "muted_by"   text,
  "comment"    text
);
