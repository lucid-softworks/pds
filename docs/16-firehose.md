# Event sequencer and the firehose

> 🚧 This chapter ships with the `src/pds/sequencer/` session.

The firehose is the PDS's public stream. Every commit on every account on
this server emits an event, in order, forever. Relays subscribe. App views
subscribe. Archive sites subscribe. Anything that wants the *push* model
instead of polling.

## Outline

1. **Event kinds.**
   - `#commit` — a repo commit landed. Carries the new commit CID + a CAR
     of the changed blocks.
   - `#identity` — handle changed.
   - `#account` — account status changed (active, takendown, deactivated,
     deleted).
2. **Sequence numbers.** Monotonic per-PDS, never reused. Assigned at
   commit time inside the DB transaction so they're consistent with the
   committed state.
3. **The `repo_seq` table.** One row per event. The firehose handler reads
   this table on connect (for the historical replay), then tails it via
   `LISTEN`/`NOTIFY` for live events.
4. **Cursors.** Clients pass `?cursor=N` to resume. The server replays
   from `N+1`.
5. **Backpressure.** WebSocket writes can block. We bound the per-connection
   queue and drop laggards.
6. **The outbox pattern.** Why we write events to the DB inside the same
   transaction as the commit, instead of trying to publish to the firehose
   directly. (Spoiler: crash safety.)

## Where the code goes

- `src/pds/sequencer/sequence.ts`
- `src/pds/sequencer/firehose.ts`
- `src/pds/sequencer/outbox.ts`
- `src/pds/xrpc/handlers/com/atproto/sync/subscribeRepos.ts`

← [15 — Blobs](./15-blobs.md) · → [17 — PDS vs AppView vs Relay](./17-pds-appview-relay.md)
