# Blobs

A typical Bluesky post is a few hundred bytes of JSON. A single image
attached to that post is, let's be generous, 200 KB. If both lived in the
MST, the first image would balloon the repo by **a thousand times** the
size of a normal post. A few hundred posts later, the user's repo is
larger than the rest of the network combined for that account, and every
firehose subscriber pays the bandwidth cost of downloading the whole
thing on first sync.

So images don't live in the MST. They live in a separate
content-addressed store, and records reference them by CID. The MST
holds a tiny *blob ref* — the CID plus a mime type and size — and the
bytes live on a filesystem or in S3.

This chapter walks the upload, the storage, the serving, and the
garbage collection that keeps it all bounded.

## The blob ref shape

Every reference to a blob from inside a record uses the same shape:

```ts
{
  $type: 'blob',
  ref: CID,            // the bytes' content-addressed identity
  mimeType: string,    // 'image/jpeg' etc — stored, served unchanged
  size: number,        // bytes; clients use it to draw progress bars
}
```

The `$type: 'blob'` discriminator is the AT Protocol's way of saying
"this is a blob ref, not a record." In a CBOR-encoded record body, the
`ref` field is a [CID-link][cid-link] — CBOR tag 42, with the binary CID
inline. In JSON (e.g. the body of `uploadBlob`'s response or the JSON
view of a record), it serializes as `{ $link: '<cid-string>' }`:

```json
{
  "$type": "blob",
  "ref": { "$link": "bafkreieexample..." },
  "mimeType": "image/jpeg",
  "size": 184231
}
```

Both encodings round-trip to the same multibase CID string. The two
forms exist because CBOR can carry the binary CID natively (tag 42)
while JSON needs an envelope.

> 📖 **Why a discriminator at all?** A record's JSON is otherwise schema-
> free at the storage layer — the lexicon validator runs in the write
> path, but the database can't tell a CID-shaped string from any other
> string. `$type: 'blob'` lets the firehose decoder and any third-party
> tooling spot blob refs without consulting a lexicon.

[cid-link]: https://ipld.io/specs/codecs/dag-cbor/spec/#links

## Upload flow

The endpoint is `com.atproto.repo.uploadBlob`. It is unusual among XRPC
methods in two ways: the request body is not JSON, and the response
contains a blob ref the client will later embed in a record.

```http
POST /xrpc/com.atproto.repo.uploadBlob HTTP/1.1
Authorization: Bearer eyJhbGc…
Content-Type: image/jpeg
Content-Length: 184231

<raw image bytes>
```

```json
{
  "blob": {
    "$type": "blob",
    "ref": { "$link": "bafkreieexample…" },
    "mimeType": "image/jpeg",
    "size": 184231
  }
}
```

Internally the handler does three things, in order:

1. **Hash.** Compute the CIDv1 over the bytes. Blobs use the `raw`
   multicodec (0x55) rather than dag-cbor (0x71) — the bytes aren't
   structured, so there's nothing to decode. The hash is sha2-256 in
   both cases. See *The codec divergence* below.
2. **Store.** Hand the bytes to the configured backend (filesystem or
   S3) along with the creator's DID and mime type. The backend returns
   an opaque storage key — a filesystem path suffix or an S3 object
   key — that we'll later use to fetch the bytes back.
3. **Record metadata.** Insert a row into `blobs`:
   `(cid, creator, mime_type, size, store_key)`. The CID is the primary
   key, so re-uploading the same bytes by the same account is a no-op
   at the metadata layer.

The blob is now persisted and addressable, but it is **not attached to
any record**. The upload endpoint takes no record reference; it can't,
because the client typically uploads several blobs first and only then
constructs the record that names them all. Attachment happens later,
in `applyWrites`, when the record value carrying the blob's CID is
written — see the next section.

> ⚠️ **No resumable uploads.** Production PDSes accept multipart and TUS
> for blobs measured in tens of megabytes. We don't — the handler reads
> the whole body into memory and caps it at 5 MB. Real video uploads
> need chunked storage and progressive hashing; that's a chapter 18
> concern.

## Attachment

A blob alone is dead weight. It becomes *useful* when a record's body
references its CID — at that point the firehose carries the reference
to subscribers, the appview indexes it, and clients render it next to
the post.

We track those references in `record_blobs`:

```sql
record_blobs (
  repo_did     text,         -- which account owns the record
  record_uri   text,         -- at://did/collection/rkey
  blob_cid     text,         -- the blob's CID
  PRIMARY KEY (repo_did, record_uri, blob_cid)
)
```

The records subsystem populates this table at write time. `applyWrites`
calls `extractBlobCids(value)` from `src/pds/blob/refs.ts` for every
create and update, then emits a parallel stream of `blobOps` next to
the existing `indexOps`:

```ts
type BlobOp =
  | { kind: 'attach'; repoDid; recordUri; blobCid }
  | { kind: 'detach'; repoDid; recordUri }   // wipes all rows for a URI
```

`extractBlobCids` is a recursive walk that bottoms out on the leaf
shape `{ $type: 'blob', ref, ... }`. It handles both the JSON envelope
(`ref: { $link: '<cid>' }`) and the CBOR-decoded form (`ref` is a real
`CID` instance) by funnelling both through `CID.asCID` and falling back
to `$link` only when that returns null. A blob ref is a leaf — we don't
recurse into its `mimeType`/`size` siblings — and the walker is
idempotent: running it twice over the same value returns the same set.

The blobOps fire inside the same transaction as the records-table
updates, in `persistCommit`:

- **create** → one `attach` per unique CID in the value.
- **update** → a single `detach` for the URI, then one `attach` per
  unique CID in the new value. Order matters — detach-then-attach
  handles "added a ref," "removed a ref," and "unchanged ref" without
  a diff.
- **delete** → one `detach`. No attaches.

Because attaches and detaches commit atomically with the records-row
mutation, the join table never disagrees with the records index about
which (repo, URI) pairs exist. On `applyWrites` failure, both roll
back together.

The point of this table is **GC visibility**. Without it, "is this blob
still referenced by anything?" would require walking every record in
the repo on every sweep. With it, the question is a single index seek.

## Storage backends

Two backends ship in `src/pds/blob/store.ts` behind a common interface:

```ts
type BlobStore = {
  put(args: { cid; bytes; creator; mimeType }): Promise<string>
  get(storeKey): Promise<Uint8Array | null>
  getStream(storeKey): Promise<ReadableStream | null>
  delete(storeKey): Promise<void>
}
```

`FilesystemBlobStore` lays bytes out under `$BLOB_DIR` (default
`./.blobs`) as `<creator-did>/<cid>.bin`. The DID-per-directory split
keeps directory listings manageable on accounts with thousands of
uploads and makes per-account purge trivial. Reads use Node's
`createReadStream` wrapped into a Web `ReadableStream` so very large
blobs don't have to fit in memory.

`S3BlobStore` is a stub in this repo. The methods throw "not
implemented." In production it would use `@aws-sdk/client-s3` with the
same `<creator-did>/<cid>.bin` key layout. The big simplification of
content addressing is that **the bucket needs no metadata table of its
own** — object keys are derived from the bytes, so the only authoritative
mapping (creator, mime, size, key) lives in Postgres. Chapter 18 walks
the production wiring.

The choice between backends is one env var:

```bash
BLOB_STORE=s3        # uses S3BlobStore (currently throws)
BLOB_STORE=…anything # uses FilesystemBlobStore
BLOB_DIR=./.blobs    # filesystem root (optional)
```

## Serving

The endpoint is `com.atproto.sync.getBlob`. It is unauthenticated — a
PDS's blobs are publicly readable by design, because the records that
reference them are public.

```http
GET /xrpc/com.atproto.sync.getBlob?did=did:plc:…&cid=bafkrei… HTTP/1.1
```

The handler:

1. Looks up `(creator=did, cid)` in `blobs`. A 404 with error name
   `BlobNotFound` if the row is absent.
2. Opens a `ReadableStream` against the storage key from that row.
3. Returns a `Response` with the stored `Content-Type`,
   `Content-Length`, and a long `Cache-Control: immutable` — blob
   bytes are content-addressed, so a given CID's bytes are forever the
   same.

The XRPC dispatcher normally JSON-stringifies whatever a handler
returns; for binary responses we special-case `Response` instances and
pass them through unchanged. It's a three-line check in
`src/pds/xrpc/server.ts`.

> 📖 **Verifying clients should re-hash.** A careful client computes
> the sha2-256 of the bytes as they arrive and compares to the
> multihash in the CID it asked for. If they don't match, the response
> is corrupt or the server is misbehaving — refuse it. The PDS itself
> can't prove the bytes haven't been tampered with on disk; only the
> client, holding the CID, can.

## Garbage collection

Uploaded-but-never-referenced blobs are a footgun. A client that
uploads a draft image and never publishes the post leaves bytes
sitting on disk forever. The sweep lives in `src/pds/blob/gc.ts` and
is a single SQL query plus a per-row store delete:

```sql
SELECT cid, size, store_key FROM blobs
 WHERE created_at < now() - interval '24 hours'
   AND NOT EXISTS (
     SELECT 1 FROM record_blobs WHERE blob_cid = blobs.cid
   );
```

For each row returned, `gcBlobs` deletes the bytes from the store and
then the `blobs` metadata row. The 24-hour grace window is essential:
a typical client uploads the blob, **then** constructs and publishes
the record that references it, and those two requests are not atomic.
Without the grace, a slow phone could see its just-uploaded image
vanish before the post lands.

The grace is also why we do not delete bytes on the spot when a record
is deleted. Edits frequently re-attach the same blob to a successor
record; if the user reposts the same image five minutes later, we want
that to be a no-op rather than an upload-then-attach round trip. The
sweep eventually catches genuinely orphaned blobs without disturbing
the common case.

### The race window

Between the candidate `SELECT` and the per-row `DELETE`, a concurrent
`applyWrites` might attach one of our candidates to a brand-new
record. The race is real and worth naming explicitly. We run the
candidate query inside `db.transaction`, which gives the sweep a
consistent MVCC snapshot: a concurrent attach either commits before
our snapshot (visible in the EXISTS sub-select, sparing the blob) or
commits after our DELETE (against a non-existent blob, surfacing as a
dangling `record_blobs` row with no `blobs` partner — harmless and
caught by the next sweep).

The store bytes still get deleted **outside** the transaction, because
filesystem and S3 I/O can't be rolled back. That leaves one narrow
window: if the row-DELETE is rolled back by a concurrent attach of the
*same* CID, the bytes are gone but the new record's reference dangles.
The grace window plus blob refs being content-addressed bounds the
damage — a re-upload restores the same bytes — but the divergence is
worth flagging.

### Cadence

```ts
import { startBlobGc } from '~/pds/blob/gc'

const stop = startBlobGc({
  intervalMs: 60 * 60 * 1000,   // hourly
  graceMs: 24 * 60 * 60 * 1000, // grace = 1 day
})
```

`startBlobGc` is a `setInterval` wrapper that returns a stop function.
It's good enough for the dev loop. Production deployments should run
`gcBlobs()` from a real scheduler — cron via systemd timers, BullMQ,
Temporal — where retries, observability, and process restarts are
first-class. The setInterval handle is `unref`'d so it doesn't keep
the Node event loop alive on its own.

> 📖 **Divergence from upstream.** The reference PDS uses a more
> sophisticated reference-counting scheme: each blob carries a
> per-record refcount that the records writer increments and
> decrements transactionally, and bytes are deleted when the count
> hits zero (plus a grace window). The join-table-plus-sweep approach
> we ship here is simpler — one INSERT per attach, one DELETE per
> detach, one periodic SELECT — and adequate for a teaching port.

### Try it

Force an immediate sweep from a shell:

```bash
pnpm tsx -e "
import { gcBlobs } from './src/pds/blob/gc'
gcBlobs({ graceMs: 0 }).then((r) => {
  console.log('gc result:', r)
  process.exit(0)
})
"
```

`graceMs: 0` ignores the grace window and reaps everything that
currently has no record reference — handy for tests, dangerous in
production.

> ⚠️ **No cross-account deduplication.** Two users uploading the same
> image get two `blobs` rows and two copies of the bytes on disk. The
> right shape is one `blobs` row per (cid) with a many-to-many `creator`
> join, but the GC contract gets subtler — you can't drop a blob just
> because no record in *one* account references it. We punt that to a
> follow-up chapter.

## The codec divergence

Every other CID in the PDS uses the dag-cbor multicodec (0x71). Blobs
break that pattern: they use `raw` (0x55). The reason is straight-
forward — blob bytes are not structured CBOR. There's nothing to
decode, no DAG to traverse. Calling them dag-cbor would be a lie about
their content type that downstream tools could trip over.

The on-the-wire effect is a different prefix on the CID string:

```
bafkrei…   ← raw codec (blobs)
bafyrei…   ← dag-cbor codec (MST nodes, commits, records)
```

(The first byte after the multibase `b` encodes the codec; the
remainder is the multihash. See chapter 05.)

In code, the divergence lives entirely in `blob/upload.ts`. The shared
`cidForBytes` helper in `codec/index.ts` hard-codes dag-cbor — adding a
codec parameter to it would let one caller silently mis-tag bytes — so
upload.ts has its own three-line `cidForRawBytes` that calls
`CID.createV1(0x55, sha256.digest(bytes))` directly. Two helpers, one
each per content type, no shared mutable parameter.

## Try it

After `pnpm db:migrate && pnpm dev`, with an account already created
(chapter 12):

```bash
# Get an access JWT.
TOKEN=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createSession \
  -H 'content-type: application/json' \
  -d '{"identifier":"alice.test","password":"correcthorsebatterystaple"}' \
  | jq -r .accessJwt)

# Upload a JPEG.
curl -s -X POST http://localhost:3000/xrpc/com.atproto.repo.uploadBlob \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: image/jpeg' \
  --data-binary @cat.jpg | tee blob.json

CID=$(jq -r .blob.ref.\$link blob.json)
DID=$(jq -r .did <<< "$(curl -s -X GET \
  http://localhost:3000/xrpc/com.atproto.server.getSession \
  -H "Authorization: Bearer $TOKEN")")

# Fetch the bytes back and verify the hash.
curl -s "http://localhost:3000/xrpc/com.atproto.sync.getBlob?did=$DID&cid=$CID" \
  > out.jpg
cmp cat.jpg out.jpg && echo OK
```

You should see `OK`. Inspect on-disk state:

```bash
ls .blobs/$DID/
DATABASE_URL=pglite pnpm drizzle-kit studio   # browse `blobs`
```

## Exercises

1. The `getBlob` handler is unauthenticated. What attack would a
   *would-be* authenticated variant prevent, and why is it the wrong
   tradeoff for AT Protocol?
2. The 5 MB upload cap is hardcoded. Trace what would have to change
   to make it per-account configurable, and what new failure modes
   that introduces (think GC and quotas).
3. Implement cross-account deduplication: change `blobs` to a single
   row per CID and add a many-to-many `blob_creators` table. Rewrite
   the GC query and the upload upsert to match. Where does the analysis
   of "this blob is safe to delete" become more subtle?
4. The chapter says clients *should* re-hash the bytes as they
   arrive. Write a 20-line shell script around `curl` and `openssl
   dgst -sha256` that does exactly that and refuses non-matching
   responses. Bonus: explain why this is *only* useful against a
   tampering PDS and not against a malicious client author.

← [14 — Records](./14-records.md) · → [16 — Firehose](./16-firehose.md)
