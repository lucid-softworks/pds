# `sequencer/` — Event sequence and firehose

Every write to a repo on this PDS gets a monotonically increasing sequence
number. Subscribers (relays, app views, archival mirrors) read the firehose at
`com.atproto.sync.subscribeRepos` to receive every event in order, forever.

This module:

- `sequence.ts` — assign sequence numbers to commits, account events, and
  identity events, persisted in Postgres.
- `firehose.ts` — the WebSocket handler that streams events to subscribers,
  honoring `?cursor=N` for resume.
- `outbox.ts` — buffers events written within a transaction so they're
  emitted atomically when the transaction commits.

See **[Chapter 16 — Event sequencer and the firehose](../../../docs/16-firehose.md)**.
