-- 0000_init: accounts, repos, repo_blocks, refresh_tokens, plc_operations
--
-- This migration sets up the storage needed for account creation. Later
-- chapters will add tables (records index, blobs, sequencer); each gets its
-- own numbered file.

CREATE TABLE IF NOT EXISTS "accounts" (
  "did"                 text PRIMARY KEY,
  "handle"              text NOT NULL,
  "email"               text NOT NULL,
  "password_hash"       text NOT NULL,
  "signing_key_priv"    text NOT NULL,
  "signing_key_pub"     text NOT NULL,
  "rotation_key_priv"   text NOT NULL,
  "rotation_key_pub"    text NOT NULL,
  "status"              text NOT NULL DEFAULT 'active',
  "created_at"          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_handle_idx" ON "accounts" ("handle");
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_email_idx" ON "accounts" ("email");

CREATE TABLE IF NOT EXISTS "repos" (
  "did"        text PRIMARY KEY REFERENCES "accounts"("did") ON DELETE CASCADE,
  "root_cid"   text NOT NULL,
  "rev"        text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "repo_blocks" (
  "repo_did"   text NOT NULL REFERENCES "accounts"("did") ON DELETE CASCADE,
  "cid"        text NOT NULL,
  "bytes"      bytea NOT NULL,
  "size"       integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("repo_did", "cid")
);
CREATE INDEX IF NOT EXISTS "repo_blocks_cid_idx" ON "repo_blocks" ("cid");

CREATE TABLE IF NOT EXISTS "refresh_tokens" (
  "jti"                 text PRIMARY KEY,
  "did"                 text NOT NULL REFERENCES "accounts"("did") ON DELETE CASCADE,
  "expires_at"          timestamptz NOT NULL,
  "app_password_name"   text,
  "created_at"          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "refresh_tokens_did_idx" ON "refresh_tokens" ("did");

CREATE TABLE IF NOT EXISTS "plc_operations" (
  "did"        text NOT NULL REFERENCES "accounts"("did") ON DELETE CASCADE,
  "cid"        text NOT NULL,
  "operation"  bytea NOT NULL,
  "seq"        bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("did", "seq")
);
CREATE INDEX IF NOT EXISTS "plc_operations_cid_idx" ON "plc_operations" ("cid");
