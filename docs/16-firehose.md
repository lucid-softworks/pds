# Event sequencer and the firehose

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

## The WebSocket: `com.atproto.sync.subscribeRepos`

Now that there's a log to read, the WebSocket endpoint exposes it. Clients
connect to:

```
wss://<host>/xrpc/com.atproto.sync.subscribeRepos?cursor=<N>
```

…and the server pushes every event with seq > N, in order, forever — first
from `repo_seq` (historical replay) and then in real time as new rows are
written.

## The framing protocol

Each WebSocket message is a single binary frame containing **two DAG-CBOR
objects back-to-back**: a small header, then the payload. There is no
length prefix between them — the consumer relies on DAG-CBOR being
self-delimiting. A frame on the wire looks like:

```
┌──────────────────────────┬───────────────────────────────────────┐
│ header CBOR              │ payload CBOR                          │
│ { op: 1, t: "#commit" }  │ { seq, repo, commit, blocks, ops, … } │
└──────────────────────────┴───────────────────────────────────────┘
  ~25 bytes                  hundreds of bytes to many KB
```

The header tells the reader what kind of event this is. `op` is a small
integer; `t` names the variant.

```ts
// op = 1: a message; `t` names which kind
{ op: 1, t: '#commit' }    // payload follows
{ op: 1, t: '#identity' }
{ op: 1, t: '#account' }
{ op: 1, t: '#info' }
{ op: 1, t: '#sync' }
{ op: 1, t: '#tombstone' }

// op = -1: an error; no further payload. The CBOR object is itself the body.
{ op: -1, error: 'FutureCursor', message: 'cursor 9001 > latest 42' }
```

Because the per-row `event` column already holds the canonical DAG-CBOR
bytes of the payload, the server never re-encodes payloads. It encodes
only the header, then concatenates `header.bytes + row.event` into a
single binary WebSocket message:

```ts
const header = await encode({ op: 1, t: row.eventType })
const frame = new Uint8Array(header.bytes.length + row.event.length)
frame.set(header.bytes, 0)
frame.set(row.event, header.bytes.length)
ws.send(frame)
```

That's the entire wire format. The structured payloads underneath are:

- **`#commit`** — `{ seq, rebase, tooBig, repo, commit, prev, rev, since,
  blocks, ops, blobs, time }`. `blocks` is the CAR with all new MST nodes
  and the commit block. `ops` is the array of `{ action, path, cid }`.
- **`#identity`** — `{ seq, did, time, handle? }`. Handle rotation, DID
  doc swap, anything that should cause a re-resolve.
- **`#account`** — `{ seq, did, time, active, status? }`. Account state
  change (takendown, deactivated, deleted, suspended).
- **`#info`** — `{ name, message }`. Out-of-band notes from the server,
  e.g. `OutdatedCursor`. No `seq`. 🚧 not yet emitted by our impl.
- **`#sync`** — full repo re-sync hint. Rare; we don't emit it yet.
- **`#tombstone`** — `{ seq, did, time }`. Account fully deleted.

## Cursor semantics

`cursor=N` resumes from the event with seq > N. `cursor=0` (or omitted)
replays from the very first row. Three outcomes:

| State | Server response |
| --- | --- |
| `cursor ≤ latestSeq` | Replay history, then tail. The happy path. |
| `cursor > latestSeq` | One `op: -1, error: "FutureCursor"` frame, then close. |
| Cursor older than what's still in `repo_seq` | 🚧 `op: 1, t: "#info", { name: "OutdatedCursor" }`, then close. Not implemented yet — we don't have retention. |

A well-behaved client persists the seq of the last event it processed and
reconnects with `cursor=<that-seq>`. Because `seq` is the source of truth
(not the wall-clock `time`), this gives at-least-once delivery semantics
across reconnects: every event the client missed will be replayed.

## Backpressure

The producer can outrun a slow consumer. If a relay's network or downstream
write throughput can't keep up, frames pile up in the server's per-socket
send buffer and the process leaks memory.

The cheap fix is to bound the send buffer and disconnect any client that
exceeds it. We watch `ws.bufferedAmount` (the number of bytes queued by
the OS / `ws` library but not yet flushed). When it crosses the
`backpressureLimit` (default 1024 framed events worth — generous enough
that a healthy client never trips it), we send:

```ts
{ op: -1, error: 'ConsumerTooSlow', message: '…' }
```

…and close the socket with code 1013 ("Try Again Later"). The client is
expected to reconnect with the cursor of the last event it processed. The
server burned no resources keeping a stalled subscriber alive.

This is the **drop-the-laggard** model. The alternative — buffer forever,
hope the consumer recovers — turns one slow consumer into a server outage.

## Polling vs `LISTEN`/`NOTIFY`

The tail phase needs to learn when new rows land in `repo_seq`. Production
Postgres offers `LISTEN`/`NOTIFY`: `emit*` would issue a `NOTIFY repo_seq`
after its UPDATE, and the WebSocket handler subscribed to the same channel
would wake instantly.

PGlite (our dev driver) doesn't surface `LISTEN`/`NOTIFY` cleanly, and the
code in this chapter targets both. So the tail uses a 500 ms poll loop:
every 500 ms it asks for events newer than the last-emitted `seq`. The
worst-case emit-to-consumer latency is therefore ~500 ms in dev. Fine for
a learning project.

When we eventually wire the production Postgres path, we keep the polling
loop as a fallback but add a `NOTIFY` wake-up channel that short-circuits
the sleep. The code in `streamFirehose` is already shaped for this — the
polling sleep is the only place to splice in a "wake up early" signal.

## Implementation walkthrough

Three files do the work:

- **`src/pds/sequencer/firehose.ts`** — the transport-agnostic streaming
  loop. `streamFirehose({ client, cursor, signal })` runs the replay-then-
  tail logic, frames each row, and pushes it to a `FirehoseClient`
  (anything with `send`, `close`, and `bufferedFrames`).
- **`src/pds/sequencer/firehose-mount.ts`** — the WebSocket transport. A
  thin adapter around the `ws` library: it owns the upgrade negotiation,
  builds a `FirehoseClient` over the `WebSocket` object, and hands off to
  `streamFirehose`.
- **`vite.config.ts`** — calls `firehoseVitePlugin()` so the dev server
  binds the upgrade handler to Vite's Node HTTP server at boot.

### Why a Vite plugin, not a server file route

TanStack Start's `createServerFileRoute().methods({ GET })` returns a
`Response` object. There is no `upgrade: 'websocket'` shorthand on the
web `Response` spec, and the underlying h3 v2 router doesn't surface a
WebSocket route from server file routes in the version we're pinned to.
The straightforward path is to attach to the underlying Node HTTP server
directly — which `vite.server.httpServer` exposes during dev. That's
exactly what `firehoseVitePlugin()` does:

```ts
configureServer(server) {
  if (server.httpServer) attachFirehose(server.httpServer)
}
```

`attachFirehose` opens a `WebSocketServer({ noServer: true })` and
listens on the HTTP server's `upgrade` event. It only consumes upgrades
whose URL path is `/xrpc/com.atproto.sync.subscribeRepos`; everything
else (Vite's HMR socket, future endpoints) flows through unmodified.

🚧 **Production wiring.** This plugin only covers `vite dev`. For
production we need an equivalent hook at the Nitro / Node entry the
build emits — chapter 17 will pick this up when we look at deployment.

## What's still missing

🚧 **The `#info` event.** Producers occasionally need to tell consumers
"your cursor is older than what we still have on disk — you should
re-sync from scratch." That's an `#info` frame with `name: "OutdatedCursor"`.
Pairs with whatever retention policy we eventually adopt for `repo_seq`.

🚧 **Graceful disconnect during replay.** If a client disconnects mid-
replay (small `bufferedAmount`, just gone), we notice on the next iteration
but might emit one more event into the closed socket. Harmless — `ws.send`
on a closed socket is a no-op — but the loop should check `ws.readyState`
on every iteration for a tighter shutdown.

🚧 **Structured logging.** Right now connect/disconnect/error are
console-noise. They want to land in the same logging shape as the rest of
the PDS so operators can grep for `ConsumerTooSlow`.

🚧 **Retention and compaction.** Right now `repo_seq` grows forever. The
real system needs a policy: keep the last N days, or the last M GB, then
trim. Consumers behind the cutoff get an `OutdatedCursor` and resync.

🚧 **`LISTEN`/`NOTIFY` wake-up.** See the "Polling vs LISTEN/NOTIFY"
section above. The poll loop works; it's just not how the production PDS
should run.

🚧 **Production WebSocket mount.** The Vite plugin only fires under
`vite dev`. The production build needs the equivalent attached to the
emitted Nitro / Node listener.

## Try it

Spin the dev server:

```bash
pnpm db:migrate && pnpm dev
```

Connect with [`wscat`](https://github.com/websockets/wscat):

```bash
wscat -c "ws://localhost:3000/xrpc/com.atproto.sync.subscribeRepos?cursor=0"
```

If `repo_seq` is empty the socket will stay open quietly — the tail loop
is polling every 500 ms. In another terminal, create an account (chapter
12) and write a record (chapter 14). Each emit should surface as a binary
frame in the `wscat` session within ~500 ms.

`wscat` won't decode CBOR for you. The frames look like garbled binary
in the terminal, which is exactly right — pipe them to a quick decoder
to verify:

```bash
node -e '
  const ws = new WebSocket("ws://localhost:3000/xrpc/com.atproto.sync.subscribeRepos?cursor=0");
  ws.binaryType = "arraybuffer";
  const cbor = await import("@ipld/dag-cbor");
  ws.onmessage = (e) => {
    const bytes = new Uint8Array(e.data);
    // The first CBOR object is the header; decoding a Uint8Array slice
    // only consumes the first object, so we decode twice to split.
    console.log(cbor.decode(bytes));
  };
'
```

(That snippet only shows the header — splitting at the right byte
boundary requires a streaming decoder. Exercise 3.)

Try `cursor=99999999` to provoke a `FutureCursor` error frame, then
inspect what comes back.

## Exercises

1. Pull the `event` bytes for one of your `#commit` rows and DAG-CBOR
   decode them by hand (the `codec` module's `decode` does the work).
   What does the `blocks` field look like? Decode the CAR to confirm it
   contains the same commit CID as the `commit` field.
2. Why is the `seq` field inside the payload as well as in its own
   column? What would break if the `seq` column were the only copy?
3. Write a tiny decoder that splits a firehose frame into its two CBOR
   objects. (Hint: `@ipld/dag-cbor`'s `decodeFirst` returns both the
   decoded value and the consumed byte length, so you can slice the
   remainder for the payload.) Use it to print live `#commit` payloads.

## Up next

We've got a log of every firehose-shaped thing that happens on this PDS.
Next, we'll step back and look at the bigger picture: how the PDS, the
relay, and the AppView fit together in the atproto federation model.

← [15 — Blobs](./15-blobs.md) · → [17 — PDS vs AppView vs Relay](./17-pds-appview-relay.md)
