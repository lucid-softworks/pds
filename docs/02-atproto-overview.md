# The AT Protocol at a glance

Before we touch any code, we need shared vocabulary. The AT Protocol is built
from a handful of primitives that show up everywhere; learning them once now
saves repeated detours later.

## The four kinds of identifier

The protocol has *four* identifier types and you will trip over them
constantly until you internalize the differences.

| Identifier | Example | Stable? | Role |
| --- | --- | --- | --- |
| **DID** | `did:plc:abc123…` | Forever | The canonical identity. Never changes. |
| **Handle** | `alice.bsky.social` | Changeable | The human-readable alias. Resolves to a DID. |
| **AT-URI** | `at://did:plc:abc/app.bsky.feed.post/3jzfg…` | Forever (for the record) | A pointer to a specific record. |
| **CID** | `bafyrei…` | Forever (for the bytes) | A content-addressed pointer. |

The shape of the relationship is:

- A handle resolves to *exactly one* DID (forwardable but only via the user's
  control).
- A DID resolves to a DID document that pins a PDS.
- The PDS holds the repo, which contains records under NSID-keyed collections.
- Each record has an AT-URI (logical address) and a CID (the hash of its
  current bytes).

If you keep that picture in your head, every weird name you'll meet — TID,
NSID, rkey, MST, commit, blob ref — fits somewhere in it.

## NSIDs

A **Namespaced Identifier** is a reverse-DNS dotted name:
`com.atproto.repo.createRecord`, `app.bsky.feed.post`, `dev.acme.cool.thing`.
Used for two things:

1. Collection names inside a repository (`app.bsky.feed.post`).
2. XRPC procedure names (`com.atproto.repo.createRecord`).

There's no central registry. The TLD owner of the leftmost label "owns" the
namespace by convention — `app.bsky.*` is whatever Bluesky has shipped a
lexicon for. See [Chapter 09](./09-lexicons.md) for how those lexicons get
authored and validated.

## TIDs and rkeys

Records inside a collection are keyed by a **record key (rkey)**. Most rkeys
are **TIDs** — Timestamp IDentifiers — a 13-character base32 sortable string
representing microseconds since 1970 plus a tiebreaker:

```
3jzfgg5jfgs2k
```

TIDs sort lexicographically in chronological order, which is exactly what
the MST wants (see [Chapter 06](./06-merkle-search-tree.md)).

> The profile record is special: its rkey is the literal string `self`. You
> only get one profile.

## AT-URIs

An AT-URI looks like:

```
at://did:plc:7iza6de…/app.bsky.feed.post/3jzfgg5jfgs2k
       └──── DID ────┘ └──── NSID ─────┘ └── rkey ───┘
```

The four-part shape (`at://<did>/<collection>/<rkey>`) addresses *one record
in one repository*. You'll see AT-URIs as references in records ("this like
points at *that* post"), in firehose events, and in error messages.

## CIDs

A **Content IDentifier** is the hash of a block of bytes, wrapped with a
multihash code and a multicodec. We use one specific shape throughout:

```
CIDv1(codec=dag-cbor, hash=sha256)
```

So every CID you see in the PDS:

- Was computed from DAG-CBOR-encoded bytes.
- Hashed with SHA-256.
- Is base32-encoded with a `b` prefix when shown as text.

`bafyreig…` — that's a CIDv1 with dag-cbor + sha256. You can recognize it
without looking it up: `bafyrei` = `b` (base32) + `af` (CIDv1) + `yrei`
(roughly).

See [Chapter 05](./05-cid-and-dagcbor.md) for what DAG-CBOR is and why we
use it.

## Records

A **record** is a JSON-ish (well, DAG-CBOR; same data model) object stored in
a repository at a specific AT-URI. Every record:

- Has a `$type` field naming its lexicon (e.g. `app.bsky.feed.post`).
- May contain `cid-link` references to other records or blobs.
- Is encoded to DAG-CBOR, hashed to produce a CID, and inserted into the
  MST at the path `<collection>/<rkey>`.

## Commits

A **commit** is the signed root of a repository at a point in time. Concretely:

```ts
{
  did:      "did:plc:7iza6de…",
  version:  3,
  data:     <CID of MST root>,
  rev:      "3jzfgg5jfgs2k",  // a TID, monotonically increasing
  prev:     null,             // legacy field, always null in v3
  sig:      <bytes: signature over the unsigned commit>
}
```

The commit is DAG-CBOR-encoded *without* the `sig` field, signed with the
account's repo signing key, and then the signature is appended. The CID of
the signed commit is the repository's current root — what you publish to the
firehose, what shows up in `getRepo` responses.

See [Chapter 07](./07-commits-and-signing.md) for the gritty details.

## XRPC

**XRPC** is the protocol's RPC convention over HTTP:

- Procedures (writes): `POST /xrpc/<nsid>`
- Queries (reads): `GET /xrpc/<nsid>?param=value`
- Subscriptions: `WebSocket /xrpc/<nsid>` (only the firehose, in practice)

Every endpoint's request and response shapes are defined by a lexicon. The
PDS's job, mechanically, is to dispatch incoming requests to handlers,
validate input/output against the lexicon, and emit canonical error
envelopes when things go wrong.

See [Chapter 10](./10-xrpc.md).

## The firehose

The PDS publishes a stream — `com.atproto.sync.subscribeRepos` — of every
event that's ever happened on this server, in order. Each event is a CBOR-
encoded frame with a header (`#commit`, `#identity`, `#account`, …) and a
payload (for `#commit`: the new commit's CID + a CAR of the changed blocks).

This is the integration point for the rest of the network. The relay reads
this firehose, the AppView reads the relay, every search index and feed
algorithm downstream is ultimately watching the same stream.

See [Chapter 16](./16-firehose.md).

## Putting it together

A picture you'll see again and again:

```
                    ┌────────────────────────────────────┐
                    │  alice.bsky.social  (handle)       │
                    └────────────────┬───────────────────┘
                                     │ resolves to
                                     ▼
                    ┌────────────────────────────────────┐
                    │  did:plc:7iza6de…   (DID)          │
                    └────────────────┬───────────────────┘
                                     │ DID doc points at PDS
                                     ▼
                    ┌────────────────────────────────────┐
                    │  https://this-pds.example          │
                    └────────────────┬───────────────────┘
                                     │ holds repo
                                     ▼
                          ┌──────────────────────┐
                          │  signed commit CID   │
                          │       │              │
                          │       ▼              │
                          │  MST root            │
                          │   ├─ app.bsky.actor.profile/self
                          │   ├─ app.bsky.feed.post/3jzf…
                          │   ├─ app.bsky.feed.post/3jzg…
                          │   ├─ app.bsky.feed.like/3jzh…
                          │   └─ app.bsky.graph.follow/3jzi…
                          └──────────────────────┘
```

That's the protocol in one drawing. Next, we look at how this PDS's code is
organized to match it: [Chapter 03 — Architecture](./03-architecture.md).
