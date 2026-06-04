-- 0022_mod_scheduled_actions: deferred-execution moderation actions.
--
-- One row per action scheduled by tools.ozone.moderation.scheduleAction.
-- A background sweep (src/pds/sequencer/scheduled_actions.ts) polls
-- this table and fires due rows by calling applyEmitEvent. State
-- transitions:
--
--   'pending'  → 'completed' on successful fire
--   'pending'  → 'cancelled' on cancelScheduledActions call
--   'pending'  → 'failed'    on irrecoverable apply error
--
-- The full input payload is preserved as DAG-CBOR so the apply step
-- can reconstruct the exact emitEvent shape the operator intended.
--
-- See chapter 24 — Ozone-shaped moderation (Scheduled actions).

CREATE TABLE IF NOT EXISTS "mod_scheduled_actions" (
  "id"            bigserial PRIMARY KEY,
  "action_type"   text NOT NULL,
  "subject_did"   text NOT NULL,
  "fires_at"      timestamptz NOT NULL,
  "state"         text NOT NULL DEFAULT 'pending'
                    CHECK ("state" IN ('pending', 'completed', 'cancelled', 'failed')),
  "payload"       bytea NOT NULL,
  "created_by"    text NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "fired_at"      timestamptz,
  "failed_reason" text
);
CREATE INDEX IF NOT EXISTS "mod_scheduled_actions_due_idx"
  ON "mod_scheduled_actions" ("fires_at")
  WHERE "state" = 'pending';
CREATE INDEX IF NOT EXISTS "mod_scheduled_actions_subject_idx"
  ON "mod_scheduled_actions" ("subject_did");
