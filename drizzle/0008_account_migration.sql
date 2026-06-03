-- 0008_account_migration: migration_state column + reserved_keys
--
-- Two storage additions for cross-PDS account migration. The column on
-- `accounts` flags which side of a move an account is on so the firehose
-- can distinguish a migration commit from an ordinary write. The
-- `reserved_keys` table holds signing keys the destination PDS pre-generates
-- for accounts that haven't been created on it yet — the migrating user puts
-- the reserved pub key in their PLC rotate op.
--
-- See chapter 20 — Migration.

ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "migration_state" text NOT NULL DEFAULT 'none';

CREATE TABLE IF NOT EXISTS "reserved_keys" (
  "did"                text PRIMARY KEY,
  "signing_key_priv"   text NOT NULL,
  "signing_key_pub"    text NOT NULL,
  "reserved_at"        timestamptz NOT NULL DEFAULT now()
);
