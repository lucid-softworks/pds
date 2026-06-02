-- 0002_blobs: blob metadata + record↔blob join
--
-- Bytes themselves live in the configured BlobStore backend (filesystem in
-- dev, S3 in prod). This migration adds the metadata layer: one row per
-- uploaded blob, and one row per (record, blob) reference so we can GC blobs
-- that no record points at anymore.
--
-- See chapter 15 — Blobs.

CREATE TABLE IF NOT EXISTS "blobs" (
  "cid"        text PRIMARY KEY,
  "creator"    text NOT NULL REFERENCES "accounts"("did") ON DELETE CASCADE,
  "mime_type"  text NOT NULL,
  "size"       bigint NOT NULL,
  "store_key"  text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "blobs_creator_idx" ON "blobs" ("creator");

CREATE TABLE IF NOT EXISTS "record_blobs" (
  "repo_did"    text NOT NULL REFERENCES "accounts"("did") ON DELETE CASCADE,
  "record_uri"  text NOT NULL,
  "blob_cid"    text NOT NULL,
  PRIMARY KEY ("repo_did", "record_uri", "blob_cid")
);
CREATE INDEX IF NOT EXISTS "record_blobs_blob_cid_idx"
  ON "record_blobs" ("blob_cid");
