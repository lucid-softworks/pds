-- 0001_records: records index table
--
-- One row per (repo, collection, rkey). The MST holds the same mapping
-- (key → value CID) authoritatively; this is a flat read cache so getRecord
-- and listRecords don't have to walk the tree on every request.
--
-- See chapter 14 — Records.

CREATE TABLE IF NOT EXISTS "records" (
  "repo_did"   text NOT NULL REFERENCES "accounts"("did") ON DELETE CASCADE,
  "collection" text NOT NULL,
  "rkey"       text NOT NULL,
  "cid"        text NOT NULL,
  "indexed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("repo_did", "collection", "rkey")
);
CREATE INDEX IF NOT EXISTS "records_repo_collection_idx"
  ON "records" ("repo_did", "collection");
CREATE INDEX IF NOT EXISTS "records_cid_idx" ON "records" ("cid");
