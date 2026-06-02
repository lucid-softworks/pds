# Reading and writing records

Chapter 12 created the account and an empty repo. Chapter 13 made the
session machinery that proves "this request is from Alice." This chapter
fills the empty repo with data — posts, likes, follows, profile — and reads
that data back out.

The endpoints we ship here are the surface every Bluesky client uses
every time the user types a sentence:

- `com.atproto.repo.createRecord` — write a new record at a fresh rkey.
- `com.atproto.repo.putRecord` — write at a specific rkey, create or replace.
- `com.atproto.repo.deleteRecord` — remove at rkey.
- `com.atproto.repo.applyWrites` — atomic batch of any combination.
- `com.atproto.repo.getRecord` — read one record by URI.
- `com.atproto.repo.listRecords` — paginate a collection.
- `com.atproto.repo.describeRepo` — repo metadata.

By the time you finish this chapter you have a PDS a client can actually
post to.

## The shape of a record

A "record" is a small DAG-CBOR object. The wire shape is whatever the
record's lexicon says, but every record has the same three rules:

1. **It must include `$type`.** This is the NSID of the record's
   lexicon — e.g. `app.bsky.feed.post`. Without it we can't validate the
   record, and downstream tooling can't tell what kind of record they're
   looking at.
2. **Timestamps are ISO-8601 strings.** Always UTC, always `Z`-suffixed.
   `createdAt: "2026-06-02T18:14:33.000Z"`. DAG-CBOR has a tag for dates
   but the spec avoids it — strings are easier to debug, easier to log.
3. **Cross-record references are `at://` URIs plus a CID.** A like points
   at a post by both the URI (the *current* address) and the CID (a
   specific version). If the post is edited later, the like still
   references the *bytes* it was endorsing at the time, which is what
   matters for "did Alice actually like this thing or did she like
   something the author edited into it later."

A minimal `app.bsky.feed.post`:

```json
{
  "$type": "app.bsky.feed.post",
  "text": "good morning",
  "createdAt": "2026-06-02T08:00:00.000Z"
}
```

A like, which references another record by URI + CID:

```json
{
  "$type": "app.bsky.feed.like",
  "subject": {
    "uri": "at://did:plc:alice.../app.bsky.feed.post/3lhq...",
    "cid": "bafyreid..."
  },
  "createdAt": "2026-06-02T08:01:12.000Z"
}
```

That's it. There's nothing magic in a record. It's an arbitrary CBOR map
that the application layer (Bluesky's clients, appviews) interprets.

## rkeys

The MST is keyed by `<collection>/<rkey>`. The collection part is fixed by
the record type. The rkey is the per-collection identifier — and it's
*part of the URL the user sees in the address bar of their post*. So we
care a lot about its shape.

Three patterns show up in practice:

- **TID rkeys.** The default. A 13-character sortable timestamp, picked
  at write time. Most records — posts, likes, reposts, follows — use TIDs.
  The sortability matters because the MST already orders keys
  lexicographically; TID-keyed records come out in time order from a
  range scan with no extra index.
- **The literal string `"self"`.** Used for singletons: there is exactly
  one `app.bsky.actor.profile/self` per account. Any other rkey for a
  singleton record is a client bug.
- **Application-chosen rkeys.** Lists and feed generators use opaque
  ids. The spec restricts them to `[A-Za-z0-9._~:-]{1,512}` — basically
  URL-safe ASCII.

> 📖 **Why "self" and not a TID for the profile?** Because the profile is
> a singleton: there's exactly one for an account. Looking it up shouldn't
> require knowing when it was created. Picking the static rkey `"self"` is
> a convention that makes the URI predictable:
> `at://did:plc:alice.../app.bsky.actor.profile/self`.

Our `applyWrites` validator (`assertValidRkey` in `src/pds/repo/writes.ts`)
accepts any of the three. We never validate that a singleton record
*actually* used `"self"` — the lexicon is supposed to enforce that, and
lexicon-driven validation is a later chapter.

## The four-write surface

Every mutation to a repo goes through one of four endpoints:

| Endpoint | When a client uses it |
| --- | --- |
| `createRecord` | New post, new like, new follow — anything with a fresh, server-generated rkey. |
| `putRecord` | Editing the profile, replacing a feed generator. The rkey is known. |
| `deleteRecord` | Untrue, unlike, remove a list member. |
| `applyWrites` | Anything that needs *more than one* mutation in a single commit. |

There's structural overlap. `createRecord` is effectively `putRecord`
that refuses to overwrite. `putRecord` is `applyWrites` with a one-element
batch. The reason all four exist is ergonomic: a client posting a single
status update shouldn't have to construct a batch of one; a client
editing a profile shouldn't have to think about whether the record
exists yet (`putRecord` handles both cases). Under the hood, all four
roads lead to one function — `applyWrites()` in `src/pds/repo/writes.ts`.

## Single-write commit anatomy

When a client posts "good morning" the HTTP request reaches us looking
like:

```http
POST /xrpc/com.atproto.repo.createRecord HTTP/1.1
Authorization: Bearer eyJhbGciOi...   ← access JWT, chapter 13
Content-Type: application/json

{
  "repo": "did:plc:alice...",
  "collection": "app.bsky.feed.post",
  "record": {
    "$type": "app.bsky.feed.post",
    "text": "good morning",
    "createdAt": "2026-06-02T08:00:00.000Z"
  }
}
```

The handler in `src/pds/xrpc/handlers/com.atproto.repo.createRecord.ts`
does almost nothing on its own:

1. Parse + validate the input shape with zod.
2. `requireAccessAuth` — chapter 13's middleware. Returns the
   authenticated account.
3. Check that `repo` resolves to *this* account's DID. You can't write
   to someone else's repo.
4. Call `applyWrites({ did, writes: [...] })`.

Steps 1–3 are 30 lines; step 4 is where everything happens. Inside
`applyWrites`:

1. Load the account's signing key.
2. Load the current commit from the DB. The `repos.root_cid` column
   points at a *commit block*, not the MST root — the MST root is the
   commit's `data` field. We read and decode the commit to get the MST
   root CID.
3. `MST.load(currentMstRoot, blockStore)` brings up an in-memory view
   of the repo's tree. Subtrees fault in lazily.
4. Validate every write: NSID syntax, rkey shape, `$type` presence.
5. DAG-CBOR encode the record → `{cid, bytes}`. We collect the bytes for
   step 8 and use the CID as the value in step 6.
6. `mst.add('app.bsky.feed.post/3lhq...', recordCid)`. The MST returns
   a *new* MST (the original isn't mutated — see chapter 06). Internally
   it copies the path from root to the inserted leaf and leaves untouched
   subtrees pointed at the original CIDs (structural sharing).
7. `mst.getRoot()` serializes the new tree and returns
   `{ cid: newMstRoot, blocks: [<new MST node bytes>...] }`. We get back
   exactly the blocks that didn't already exist before this write.
8. `buildSignedCommit({ did, data: newMstRoot, rev: nextTid(), signingKeyPriv })`
   produces a new commit block. The signature is over the unsigned
   bytes; see chapter 07.
9. In a single DB transaction:
   - INSERT the new MST blocks + the record block + the new commit block
     into `repo_blocks` (ON CONFLICT DO NOTHING because blocks are
     content-addressed and shared subtrees are intentional duplicates).
   - UPDATE `repos` SET `root_cid` = new commit CID, `rev` = new TID.
   - UPSERT `records (repo_did, collection, rkey, cid)`.

Here's what's actually in the database after the write:

```
repos
─────────────────────────────────────────────────────────────────
did                       | root_cid         | rev
did:plc:alice...          | bafyreiCommit2.. | 3lhq7n4q5wp2c

repo_blocks (new rows since the genesis commit)
─────────────────────────────────────────────────────────────────
cid                       | bytes           | size
bafyreiPostRecord...      | <cbor of post>  | 78
bafyreiNewMstRoot...      | <cbor of node>  | 142
bafyreiCommit2...         | <cbor of cmt>   | 256

records
─────────────────────────────────────────────────────────────────
repo_did            | collection           | rkey          | cid
did:plc:alice...    | app.bsky.feed.post   | 3lhq7n4q5wp2c | bafyreiPostRecord...
```

Three new blocks, one updated row, one new row. The genesis blocks
(empty MST + genesis commit) are still in `repo_blocks` — they're
content-addressed, and pruning belongs to a separate GC pass that's
out of scope for this chapter.

> 📖 **Why is `root_cid` the *commit* CID and not the MST root?** Because
> the commit is what's signed. Anyone fetching the repo proves
> integrity by verifying the commit signature; the MST root is one of
> the things the commit attests to. If the column held the MST root,
> we'd have to chase a separate "current commit" index, and a tampered
> blockstore could lie about which commit we're on.

## The `records` index table

The MST tells us the cryptographic truth: "this repo, at this commit,
contains these records." But getting the same answer from the MST
requires walking the tree — fault in the root block, fault in some
subtrees, walk leaves. For `getRecord` of a single key that's roughly
O(log n) block reads; for `listRecords` of a paginated collection, it's
worse. We don't want to do that on every read.

So we keep a flat `records` table:

```sql
CREATE TABLE records (
  repo_did   text NOT NULL,
  collection text NOT NULL,
  rkey       text NOT NULL,
  cid        text NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_did, collection, rkey)
);
```

`getRecord` becomes `SELECT cid FROM records WHERE ... → SELECT bytes
FROM repo_blocks WHERE cid = ?`. Two indexed lookups, microseconds.
`listRecords` becomes `... WHERE repo_did = ? AND collection = ?
ORDER BY rkey LIMIT 50`. Same.

The table is, technically, a denormalization. The source of truth is
the MST inside `repo_blocks`. If the two ever disagree, the MST wins —
we could rebuild `records` from scratch by walking every repo's MST.

In practice they never disagree because we update both in the same
transaction (see step 9 above). But the *modeling* assumption is
important: the MST is what we ship over the firehose, the MST is what a
peer verifies. The records table is a cache.

> ⚠️ **Difference from upstream.** The reference Bluesky PDS keeps the
> records index table together with the MST inside SQLite blocks; the
> `record` table there is a denormalization for SQL convenience.
> Conceptually it's the same arrangement we use, but the level at which
> the two stores are coupled differs.

## swapCommit / swapRecord — optimistic concurrency

Two clients edit Alice's profile at the same time. Without coordination,
the second write silently overwrites the first. Bluesky doesn't lock
records on read — instead it uses **compare-and-swap** at write time.

Every write endpoint accepts two optional preconditions:

- `swapCommit: <commit-cid>` — "only apply if the repo's current root
  commit is this exact CID." If the repo has moved on (someone else
  committed since you fetched), the write fails with `InvalidSwap`.
- `swapRecord: <record-cid>` — on `putRecord` and `deleteRecord` only.
  "Only apply if the current record at this `(collection, rkey)` is
  this exact CID, or null for 'expect absent'." Lets you say "I want
  to replace v3 of this profile, fail if it's now v4."

Both are CAS primitives. The client's flow is:

1. `getRecord` → get the record + its CID.
2. Edit it client-side.
3. `putRecord` with `swapRecord = <the CID from step 1>`. If two clients
   raced, exactly one wins; the other gets `InvalidSwap` and can retry.

`swapCommit` is the bigger hammer: "fail if anything in the repo has
changed at all." Useful for tools like backup/migration that depend on
no concurrent writes happening.

The implementation is one line each in `applyWrites`:

```ts
if (args.swapCommit && args.swapCommit !== repoRow.rootCid) {
  throw Conflict(`swapCommit mismatch: ...`, 'InvalidSwap')
}
```

We check before reading the MST, so a stale write doesn't even pay the
deserialization cost.

## applyWrites — atomic batches

A like is two writes, not one: insert the like record, *and* (in some
clients) increment a local list of "things I've liked." A post with an
embedded gif is three writes: the post record, the embed-blob link
record, the conversation root. If each of those goes through a
separate commit, we get one of two pathologies:

- **Half the writes succeed, half fail.** The client now has an
  inconsistent repo and has to reconcile.
- **Three commits to the firehose for one user action.** Subscribers
  see them in arbitrary order; rendering glitches everywhere.

`applyWrites` exists to fix both. One HTTP request, one commit, one
firehose event. The body is:

```json
{
  "repo": "did:plc:alice...",
  "writes": [
    {
      "$type": "com.atproto.repo.applyWrites#create",
      "collection": "app.bsky.feed.post",
      "value": { "$type": "app.bsky.feed.post", "text": "...", ... }
    },
    {
      "$type": "com.atproto.repo.applyWrites#create",
      "collection": "app.bsky.feed.like",
      "value": { "$type": "app.bsky.feed.like", "subject": ... }
    }
  ]
}
```

Internally `applyWrites` walks the array, mutating the MST one write at
a time. Validation runs upfront for each write, so a malformed write
fails the *whole* batch before we've touched the tree. Both writes land
under the same new MST root, which the same single commit signs.

> 📖 **Why not just submit two `createRecord` calls back-to-back?**
> Atomicity. If the second `createRecord` fails (network blip,
> validation error), the first one has already been committed and
> emitted to the firehose. Now Alice's followers see a like to a post
> that hasn't been published yet. `applyWrites` gives us "both succeed
> or neither does."

## Reads: getRecord, listRecords, describeRepo

The three read endpoints don't touch the MST.

**`getRecord`** — `?repo=...&collection=...&rkey=...&cid=...`. Looks up
the current CID in `records`, fetches the block from `repo_blocks`,
decodes it. If a `cid` query param was supplied, we compare it against
the current CID: if they match, return the record; if not, return
`RecordNotFound`. We don't keep historical record bytes around — if you
ask for a past version, all we can say is "that's not the current one."

**`listRecords`** — `?repo=...&collection=...&limit=50&cursor=<rkey>&reverse=false`.
Straight SQL: `WHERE repo_did = ? AND collection = ? AND rkey > ?
ORDER BY rkey ASC LIMIT 50`. The cursor is the last rkey of the previous
page. If `reverse=true`, we flip the comparator and the order. One
round-trip to fetch the rows, one batched fetch to pull all the block
bytes in parallel, then decode.

**`describeRepo`** — `?repo=...`. Renders the DID document fresh from
the `accounts` row (so handle changes are reflected immediately) and
gathers the distinct collection list with `SELECT DISTINCT collection
FROM records WHERE repo_did = ?`. This is the one endpoint where a
naive O(repo-size) query would hurt — if we'd done it from the MST,
walking every key. The flat `records` table makes it free.

> ⚠️ **Difference from upstream.** Pinned reads (`getRecord` with a
> non-current `cid`) return the past version on the reference PDS,
> because that PDS keeps record bytes around as long as the firehose
> backlog needs them. We don't yet — record bytes for replaced records
> are not retrievable. Add this in a future chapter alongside block GC.

The MST does get walked for a few things — but they're not on the read
path:

- **CAR exports** (`com.atproto.sync.getRepo`, chapter 17): we stream
  every block reachable from the current commit, which requires the
  MST.
- **Repo verification:** if someone asks "is this rkey actually in this
  commit?" with a proof, we walk the MST to produce one. That's also a
  later chapter.

For today's read endpoints, the MST is sleeping in `repo_blocks` and
never woken up.

## Try it

After `pnpm db:migrate && pnpm dev`, in another shell:

```bash
# 1. Create account + log in (chapters 12 + 13)
SESSION=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createAccount \
  -H 'content-type: application/json' \
  -d '{
    "handle": "alice.test",
    "email": "alice@example.com",
    "password": "correcthorsebatterystaple"
  }')
ACCESS=$(echo "$SESSION" | jq -r .accessJwt)
DID=$(echo "$SESSION" | jq -r .did)

# 2. Post something
POST=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.repo.createRecord \
  -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d "{
    \"repo\": \"$DID\",
    \"collection\": \"app.bsky.feed.post\",
    \"record\": {
      \"\$type\": \"app.bsky.feed.post\",
      \"text\": \"good morning\",
      \"createdAt\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
    }
  }")
echo "$POST" | jq
POST_URI=$(echo "$POST" | jq -r .uri)
POST_RKEY=$(basename "$POST_URI")

# 3. List the posts
curl -s "http://localhost:3000/xrpc/com.atproto.repo.listRecords?repo=$DID&collection=app.bsky.feed.post" | jq

# 4. Read it back
curl -s "http://localhost:3000/xrpc/com.atproto.repo.getRecord?repo=$DID&collection=app.bsky.feed.post&rkey=$POST_RKEY" | jq

# 5. Describe the repo
curl -s "http://localhost:3000/xrpc/com.atproto.repo.describeRepo?repo=$DID" | jq

# 6. Delete it
curl -s -X POST http://localhost:3000/xrpc/com.atproto.repo.deleteRecord \
  -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d "{
    \"repo\": \"$DID\",
    \"collection\": \"app.bsky.feed.post\",
    \"rkey\": \"$POST_RKEY\"
  }" | jq
```

Inspect the database in between calls:

```bash
DATABASE_URL=pglite pnpm drizzle-kit studio
```

The `records` table should show the row appear after step 2 and
disappear after step 6. `repo_blocks` keeps growing — every commit
adds blocks, none get removed (block GC is a separate chapter).

## Exercises

1. The genesis commit ships with an empty MST node block already
   persisted (chapter 12). After your first `createRecord`, how many
   *new* blocks are in `repo_blocks`? Sketch them out: how many MST
   nodes, how many records, how many commits?
2. Build a small client that calls `putRecord` with a `swapRecord`
   precondition derived from the previous read. Race two of them.
   Confirm exactly one gets `InvalidSwap`. What error name does the
   other one not get?
3. Use `applyWrites` to create a post + a like to that post in one
   commit. (You won't know the post's CID before the write — what do
   you put in the like's `subject.cid`? Read the spec.)
4. Drop a row from `records` directly in the database
   (`DELETE FROM records WHERE rkey = '...'`). Call `getRecord` —
   what happens? Now call `describeRepo` — does it still list the
   collection? Now restart the server and call `listRecords` —
   are the rows back? (Spoiler: no. Make a note of what a "rebuild
   from MST" job would look like.)

## Up next

The MST holds records by URI + CID, but real records reference *blobs*:
images, videos, audio. Those live outside the MST in a content-addressed
blob store, and the next chapter is the round trip for getting them in
and out: [15 — Blobs](./15-blobs.md).

← [13 — Authentication](./13-authentication.md) · → [15 — Blobs](./15-blobs.md)
