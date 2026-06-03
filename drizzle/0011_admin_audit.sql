-- 0011_admin_audit: admin_audit
--
-- Append-only trail of admin mutations. Every successful (and every failed)
-- `com.atproto.admin.*` *mutation* gets a row; read endpoints don't, on
-- purpose — they fire on every console refresh and would drown the log.
--
-- `params` is the DAG-CBOR encoding of the handler input. Deterministic,
-- byte-safe (no JSON edge cases with bigints / Uint8Array), and trivially
-- decoded for display by the read endpoint. The two indexes back the two
-- expected query shapes:
--
--   - last N actions  ← (occurred_at DESC)
--   - per-account     ← (target_did, occurred_at DESC)
--
-- See chapter 19 — Moderation.

CREATE TABLE IF NOT EXISTS "admin_audit" (
  "id"             bigserial PRIMARY KEY,
  "actor"          text NOT NULL,
  "action"         text NOT NULL,
  "target_did"     text,
  "params"         bytea NOT NULL,
  "occurred_at"    timestamptz NOT NULL DEFAULT now(),
  "ip_addr"        text,
  "result"         text NOT NULL,
  "error_message"  text
);
CREATE INDEX IF NOT EXISTS "admin_audit_occurred_idx"
  ON "admin_audit" ("occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "admin_audit_target_occurred_idx"
  ON "admin_audit" ("target_did", "occurred_at" DESC);
