-- 0015_subject_takedown: takedown_ref on records + blobs
--
-- Record-level and blob-level moderation. `takedown_ref` is the
-- operator-supplied identifier from `admin.updateSubjectStatus.takedown.ref`
-- — a free-form string the operator uses to link back to whatever ticket
-- system, court order, or moderation case prompted the action. NULL on
-- never-takendown rows; setting to a non-NULL string flags the row as
-- takendown. We don't store applied/createdAt separately — presence of
-- a ref is the takendown signal, and the audit log captures the timing.
--
-- See chapter 19 — Moderation (subject-level moderation section).

ALTER TABLE "records"
  ADD COLUMN IF NOT EXISTS "takedown_ref" text;

ALTER TABLE "blobs"
  ADD COLUMN IF NOT EXISTS "takedown_ref" text;
