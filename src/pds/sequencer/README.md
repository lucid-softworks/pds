# `sequencer/` — Event sequence and firehose

Every write to a repo on this PDS gets a monotonically increasing sequence
number. Subscribers (relays, app views, archival mirrors) read the firehose
at `com.atproto.sync.subscribeRepos` to receive every event in order.

## Files

- [`sequence.ts`](./sequence.ts) — the write-out path.
  - `emitCommit(event)` — record a `#commit` event after `applyWrites`.
  - `emitIdentity(event)` — record a `#identity` event when a handle
    changes (or at account creation).
  - `emitAccount(event)` — record an `#account` event for active/takedown/
    deactivated/deleted transitions.
  - `readEventsSince(cursor, limit)` — historical replay for cursor=N
    subscriber connections.
  - `latestSeq()` — current head of the log.
  - `invalidate(seq)` — rare, retract a misbehaving event.
- [`firehose.ts`](./firehose.ts) — the streaming layer (wave 3A).
  Connects to a Postgres-backed source and streams to a `FirehoseClient`
  (a WebSocket abstraction). Implements cursor-replay → tail-live with
  bounded backpressure.
- [`firehose-mount.ts`](./firehose-mount.ts) — Vite plugin that wires the
  WebSocket upgrade onto the underlying Node HTTP server for
  `/xrpc/com.atproto.sync.subscribeRepos`. TanStack Start file routes
  only return HTTP `Response`s, so we attach our handler one layer down.

## How emits get wired

Repo writes call `emitCommit` from [`repo/writes.ts`](../repo/writes.ts):
after persisting blocks and updating `repos`, the new commit + dirty
blocks are encoded as a CAR with the new commit as root and shipped to
`emitCommit`.

Account creation calls `emitIdentity` + `emitAccount` from
[`account/create.ts`](../account/create.ts), right after
`createGenesisRepo`.

## Storage

One table: `repo_seq`.

- `seq bigserial PRIMARY KEY` — the cursor space.
- `did text NOT NULL` — affected account.
- `event_type text NOT NULL` — `#commit` / `#identity` / `#account` / …
- `event bytea NOT NULL` — the pre-encoded DAG-CBOR payload, including
  its own `seq` field.
- `invalidated boolean DEFAULT false`.
- `sequenced_at timestamptz DEFAULT now()`.

We store **pre-encoded bytes** so the WebSocket handler can blit them
straight to consumers without re-encoding — and so consumer CID
verification ties to the exact bytes we shipped.

## Chapter

[**Chapter 16 — Event sequencer and the firehose**](../../../docs/16-firehose.md).
