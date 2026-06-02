# Event sequencer and the firehose

> 🚧 The append-only event log ships in this chapter. The WebSocket endpoint
> that streams it (`com.atproto.sync.subscribeRepos`) lands in a follow-on
> session.

The firehose is the PDS's public stream. Every commit on every account on
this server emits an event, in order, forever. Relays subscribe. App views
subscribe. Archive sites subscribe. Anything that wants the *push* model
instead of polling.

Before there's a stream there has to be something *to* stream. That
something is a single Postgres table — `repo_seq` — and a tiny module that
writes to it on every account or repo change. That's what this chapter
covers.

## The five event types

The firehose multiplexes five kinds of frame, each a different DAG-CBOR
shape with its own type tag:

- **`#commit`** — a repo commit landed. Carries the new commit CID, the
  list of (path, action, cid) operations, and a CAR file containing the
  commit block plus every MST node and leaf that was added in the diff.
- **`#identity`** — the account's identity changed: handle rotation, a new
  DID document, anything that would make a consumer want to re-resolve.
- **`#account`** — the account's status changed: takedown, deactivation,
  reactivation, deletion.
- **`#sync`** — an out-of-band hint that consumers should re-sync the
  repo from scratch. Rare; we don't emit this yet and won't cover it
  further here.
- **`#tombstone`** — the account was deleted entirely. Even rarer.

In the source, these are TypeScript types in `src/pds/sequencer/sequence.ts`
and there's an `emit*` function per type. The function takes the rich
domain object (a `CommitEvent` with a CID, a CAR, a list of ops…) and
returns the assigned `seq` number once the row is on disk.

## The `repo_seq` table

```sql
repo_seq (
  seq           bigserial PRIMARY KEY,
  did           text       NOT NULL,
  event_type    text       NOT NULL,
  event         bytea      NOT NULL,
  invalidated   boolean    NOT NULL DEFAULT false,
  sequenced_at  timestamptz NOT NULL DEFAULT now()
)
INDEX (did, seq)
```

The choice of `bigserial` is load-bearing. We need every event on this PDS
to have a globally unique, strictly-increasing number that's safe to use as
a cursor — clients pass `?cursor=N` to resume reading from where they left
off. Postgres' `bigserial` is exactly that: a 64-bit sequence-backed
identity that's atomic to assign and guaranteed monotonic per generator.
We *don't* need it to be gap-free (it won't be — failed transactions burn
numbers), only ordered.

The `event` column holds the *raw DAG-CBOR encoding* of the firehose
payload. Not JSON, not the structured columns re-derived at read time —
the exact bytes the WebSocket handler will eventually slot into a frame
and ship out. Two reasons:

1. **The encoding is the contract.** The atproto sync spec is defined in
   terms of DAG-CBOR bytes; consumers verify CIDs that hash those bytes.
   If we stored the structured form and re-encoded on read, every
   downstream consumer would be at the mercy of our CBOR library matching
   theirs byte-for-byte forever.
2. **Read speed.** Replay-on-connect is the hot path. A WebSocket
   subscriber that disconnects and reconnects at cursor=12345 wants
   millions of events streamed out as fast as we can read disk. The less
   work we do per row, the better.

The `(did, seq)` index supports per-repo replay — "give me every event
that touched did:plc:alice ordered by seq" — which the future
`getRepoCheckout` and `listReposByCollection` endpoints will lean on. The
primary key already covers the global cursor case.

## The write-out path

Every successful repo write triggers an `emitCommit` call. Sketch of what
happens on a `createRecord`:

1. `applyWrites` builds the new MST, signs the new commit, persists every
   new block. (Chapter 14.)
2. `applyWrites` calls `emitCommit({ did, commitCid, rev, prevRev,
   carBytes, ops })`.
3. `emitCommit` inserts a row into `repo_seq` and gets back the assigned
   `seq`.
4. `emitCommit` builds the full DAG-CBOR payload — including that `seq`
   number — and updates the row's `event` column with the encoded bytes.

Account creation does the equivalent with `emitIdentity` and `emitAccount`
once the account row is in place.

## The two-step assign-then-encode trick

A subtle point: the firehose payload contains the `seq` number as a
top-level field. Consumers can extract it without decoding everything
else, and the spec requires it to be present. So we have a chicken-and-egg
problem:

- We can't encode the payload until we know its seq.
- We can't know its seq until Postgres has assigned one.
- And Postgres only assigns one on INSERT.

The cleanest fix is two writes per emit:

```ts
async function reserveSeq(did, eventType) {
  const inserted = await pg
    .insert(repoSeq)
    .values({ did, eventType, event: PLACEHOLDER })
    .returning({ seq: repoSeq.seq })
  return inserted[0].seq
}

async function writeEvent(seq, payload) {
  const block = await encode(payload)
  await pg.update(repoSeq).set({ event: block.bytes })
    .where(eq(repoSeq.seq, seq))
}
```

The placeholder is one byte of garbage. Nothing should ever read it; the
window between the INSERT and the UPDATE is brief and, in production,
will sit inside the same transaction as the repo write itself. Outside a
transaction the window is still safe because the WebSocket handler reads
rows ordered by `seq` and only catches up to the latest *committed* row
— the UPDATE follows the INSERT on the same connection.

> 📖 **Why not write the payload at INSERT time and `RETURNING seq` for
> a follow-up patch?** That'd still be two SQL statements; the only
> difference would be that the placeholder gets some other contents. The
> two-step form is the simplest version of the same thing.

## The outbox pattern, briefly

In the production wiring, both writes — the repo commit and the
`emit*` call — happen inside the same Postgres transaction. That's the
**outbox pattern**: instead of trying to publish events to the firehose
*at the moment of commit*, we write them to a table inside the same
transaction and let a tailer push them out asynchronously. The benefits
fall out of ACID:

- **Crash safety.** If the process dies between "commit landed" and "event
  sent," there's no event to send because the event row is in the same
  transaction as the commit. Either both are visible or neither is.
- **No "ghost events."** Conversely, we can't emit an event for a commit
  that rolled back, because the event row would have rolled back too.
- **At-most-once-then-tail.** The WebSocket handler reads from the table
  on connect (historical replay), then tails for new rows. No queue
  middleware. No retry semantics to get wrong.

`emitCommit` is wired into `applyWrites` by the coordinator at merge time
— that's the moment the records chapter and this chapter join. The
records chapter takes the write path up to "blocks persisted, MST root
updated"; this chapter picks it up at "now what does the rest of the
world hear about it."

## What's still missing

🚧 **The WebSocket endpoint.** `com.atproto.sync.subscribeRepos` is a
WebSocket subscription that streams from `repo_seq`. The framing protocol
is two DAG-CBOR objects back-to-back (a header naming the event type and
the payload itself), the cursor parameter resumes from a given seq, and
the server must keep up with a per-connection backpressure budget or
drop the laggard. None of that is built yet. It's a separate session
because the WebSocket plumbing in TanStack Start is its own rabbit hole.

🚧 **The `#info` event.** Producers occasionally need to tell consumers
"your cursor is older than what we still have on disk — you should
re-sync from scratch." That's an `#info` frame with `name: "OutdatedCursor"`.
Pairs with whatever retention policy we eventually adopt for `repo_seq`.

🚧 **Retention and compaction.** Right now `repo_seq` grows forever. The
real system needs a policy: keep the last N days, or the last M GB, then
trim. Consumers behind the cutoff get an `OutdatedCursor` and resync.

🚧 **`LISTEN`/`NOTIFY`.** The future WebSocket handler will use Postgres'
pub-sub to learn about new rows without polling. `emit*` will wake up
subscribers by emitting a `NOTIFY repo_seq` after the UPDATE.

## Try it

After `pnpm db:migrate && pnpm dev`, create an account (chapter 12) and
write a record (chapter 14), then peek at the log:

```bash
DATABASE_URL=pglite pnpm drizzle-kit studio
```

Or from psql:

```sql
SELECT seq, event_type, did, length(event) AS bytes
FROM repo_seq
ORDER BY seq DESC
LIMIT 10;
```

You should see one `#identity` and one `#account` row from account
creation, plus a `#commit` row for every record write. The `bytes`
column is dominated by the CAR-encoded block diff for `#commit` rows —
typically a few hundred bytes for a small post, more if the write touched
a lot of MST nodes.

## Exercises

1. Pull the `event` bytes for one of your `#commit` rows and DAG-CBOR
   decode them by hand (the `codec` module's `decode` does the work).
   What does the `blocks` field look like? Decode the CAR to confirm it
   contains the same commit CID as the `commit` field.
2. Why is the `seq` field inside the payload as well as in its own
   column? What would break if the `seq` column were the only copy?
3. Imagine a malicious consumer that subscribes with `?cursor=0` over and
   over. What's the cheapest way to cap the damage without breaking
   well-behaved replay clients?

## Up next

We've got a log of every firehose-shaped thing that happens on this PDS.
Next, we'll step back and look at the bigger picture: how the PDS, the
relay, and the AppView fit together in the atproto federation model.

← [15 — Blobs](./15-blobs.md) · → [17 — PDS vs AppView vs Relay](./17-pds-appview-relay.md)
