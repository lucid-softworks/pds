-- 0023_repo_blocks_rev: per-block creation rev for incremental getRepo
--
-- The atproto sync lexicon's `com.atproto.sync.getRepo` accepts a
-- `since=<rev>` parameter — when set, only blocks newer than that rev
-- should stream in the CAR. Each block in the upstream reference PDS
-- carries the commit rev (a TID) at which it was first written; the
-- streaming reader filters by `repoRev > since` to slice the diff.
--
-- We had been ignoring `since=` and returning the full repo every time.
-- This migration adds the column; the matching write-path edit (in
-- src/pds/repo/writes.ts) populates it on insert.
--
-- Existing rows have no rev recorded — they're treated as "before any
-- rev a client could have seen," so a `since=<any rev>` query
-- correctly skips them. The migration leaves the column nullable; new
-- rows always carry a value.
--
-- See chapter 17 — Sync (incremental getRepo).

ALTER TABLE "repo_blocks"
  ADD COLUMN IF NOT EXISTS "repo_rev" text;

CREATE INDEX IF NOT EXISTS "repo_blocks_repo_rev_idx"
  ON "repo_blocks" ("repo_did", "repo_rev");
