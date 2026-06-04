-- 0026_records_rev: per-record commit rev for read-after-write
--
-- The PDS-as-proxy needs to know which local records are newer than the
-- AppView's snapshot. The AppView returns its high-water mark in the
-- `atproto-repo-rev` response header; we then query our `records` table
-- for rows whose `rev > <that rev>` and merge them into the response
-- (the lexicon's "read-after-write" semantics — chapter 17).
--
-- `repo_blocks.repo_rev` already carries the rev per *block*; we add
-- the same column to `records` so the lookup is a single direct
-- query without a CID join. Populated on insert by the write path
-- (`src/pds/repo/writes.ts`).
--
-- See chapter 17 — PDS vs AppView vs Relay (Read-after-write).

ALTER TABLE "records"
  ADD COLUMN IF NOT EXISTS "rev" text;

CREATE INDEX IF NOT EXISTS "records_repo_rev_idx"
  ON "records" ("repo_did", "rev");
