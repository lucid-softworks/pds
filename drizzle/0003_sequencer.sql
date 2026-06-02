-- 0003_sequencer: repo_seq
--
-- The append-only event log behind `com.atproto.sync.subscribeRepos`. Each
-- row is one firehose event (#commit, #identity, #account, …). The `event`
-- column holds the raw DAG-CBOR bytes the WebSocket handler will eventually
-- write out verbatim.
--
-- See chapter 16 — Event sequencer and the firehose.

CREATE TABLE IF NOT EXISTS "repo_seq" (
  "seq"           bigserial PRIMARY KEY,
  "did"           text NOT NULL,
  "event_type"    text NOT NULL,
  "event"         bytea NOT NULL,
  "invalidated"   boolean NOT NULL DEFAULT false,
  "sequenced_at"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "repo_seq_did_seq_idx" ON "repo_seq" ("did", "seq");
