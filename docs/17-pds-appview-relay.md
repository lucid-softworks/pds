# PDS vs AppView vs Relay

You've built a PDS. By chapter 16 it owns repositories, signs commits,
serves an XRPC surface, and (soon) emits a firehose. The right question
at this point is *where it sits in the bigger picture* — because the
"Bluesky experience" most people interact with isn't running on a PDS at
all. It's a Pinterest of glued-together services, each owning one job.

This chapter is the federation surface our sync endpoints just exposed
made literal: three server roles, two kinds of traffic between them, and
one identity layer underneath it all.

## The three-server model

```
                     ┌─────────────┐
                     │   plc.dir   │   ← identity / DID lookup
                     └─────┬───────┘
                           │
        firehose           ▼          XRPC reads
   ┌──────────┐      ┌──────────┐    ┌──────────┐
   │   PDS    │ ───► │  Relay   │ ──►│ AppView  │ ◄── clients
   │  (you)   │      │ (BGS)    │    │ (bsky)   │
   └──────────┘      └──────────┘    └──────────┘
        ▲                                  │
        │                                  │
        └────── writes from clients ◄──────┘
                       (proxied)
```

Three roles, three flavors of state, three operators that can be
different parties.

1. **The PDS** — what you've built. Owns repositories. Signs commits.
   Holds the user's signing key. Authoritative for everything a user
   *writes*: posts, follows, profile edits, blob uploads. Tiny: one PDS
   only needs to know about its own accounts (tens of thousands, maybe).
2. **The Relay** — also called a BGS (Big Graph Service). A fan-in
   service: it subscribes to many PDSes' firehoses and merges them into
   one global ordered stream. *Stateless* in the sense that it doesn't
   interpret records; it stores them content-addressed and rebroadcasts
   them in commit order. Bluesky operates the canonical reference relay
   at `bsky.network`.
3. **The AppView** — the "Bluesky" experience most users actually see.
   Subscribes to the relay's firehose, decodes every record by lexicon,
   indexes posts, computes timelines, runs moderation. `bsky.app` is one
   AppView; `bsky.social` shares its index. Other AppViews (a
   Mastodon-style frontend, a search-only one, a specialized client) can
   coexist.

The split is the same Unix-pipe instinct the rest of the protocol uses.
Writes flow one direction; reads flow the other; nobody needs to be
omniscient. A PDS doesn't know who follows whom. An AppView doesn't sign
anything. A relay doesn't decide what a "post" is.

## What our sync endpoints expose

The PDS we just built lets the relay (and any other interested consumer)
pull repository state without depending on the firehose. That matters
during *backfill*: when a relay sees a PDS for the first time, the
firehose is empty (or fast-forwarded past the events the relay missed).
It has to recover history from somewhere.

Our sync endpoints are that somewhere. A backfilling relay does roughly:

```
1. GET /.well-known/did.json
     → confirm this is a real PDS, learn its serviceEndpoint
2. GET /xrpc/com.atproto.sync.listRepos
     → page through every (did, head, rev, active) on this PDS
3. for each repo not yet known:
       GET /xrpc/com.atproto.sync.getRepo?did=<did>
       → stream the whole CAR, hash-verify, store
4. GET /xrpc/com.atproto.server.describeServer
     → optional: learn policy info (handle domains, contact)
5. open the firehose, start tailing from the sequence number we now know
```

Steps 1 and 2 are tiny; step 3 is where the bytes are. The relay walks
the response with our streaming `decodeCar`, verifies each block as it
arrives, and inserts blocks into its own (much larger) block store keyed
by CID. By the time it's done it has a byte-identical copy of every
repo's tree, signed by each user's repo key — the same trust model that
makes a `getRepo` response self-sufficient applies to the relay's whole
view of the world.

An AppView's needs are narrower. It usually doesn't backfill *whole*
repos: it follows the firehose and asks for individual records when a
later record references one it hasn't seen yet (a like pointing at a
post from an unrelated user, say). That's what `getRecord` is for — one
record plus the Merkle path proving the commit signed it. Six or seven
blocks, deterministically the same for every consumer asking the same
question. Easy to cache.

## The federation handshake (or lack thereof)

There is no central registry of PDSes. The protocol is allergic to
hubs, and discovery is intentionally lossy.

Three things can introduce a new PDS to the network:

- **The user.** Account creation tells `plc.directory` (or another DID
  registry) which PDS hosts the account. Resolvers find the PDS by
  looking up the user's DID document, which names the PDS endpoint.
- **A handle.** Someone resolves `alice.example.com` to a DID via DNS
  TXT, then resolves the DID document, then sees the PDS endpoint.
- **An incoming `requestCrawl`.** When a PDS comes online it can call
  `com.atproto.sync.requestCrawl` on a relay it wants to be heard by.
  The relay responds by opening that PDS's firehose and (if it's the
  first time) running the backfill above. No authentication, no
  allow-list — the relay decides which submissions to honor by its own
  spam policy.

Our PDS does *not* currently call `requestCrawl` on anyone, because the
firehose endpoint ships in a later chapter. When it does, the call is a
single POST: `{ hostname }`, sent to whatever relay this operator has
chosen to register with. Until then, our PDS is a happily reachable
island. A relay that learned about us via a DID resolution would still
be able to backfill via the sync endpoints we've built.

The DID we serve at `/.well-known/did.json` is the service identity:

```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:web:pds.example.com",
  "service": [{
    "id": "#atproto_pds",
    "type": "AtprotoPersonalDataServer",
    "serviceEndpoint": "https://pds.example.com"
  }]
}
```

This is a `did:web` document: the DID is derived from the hostname, and
the document lives at a well-known URL on that hostname. No registry,
no fees — if you control the domain you control the identity. (Users'
DIDs are different: they're `did:plc:…` so they can survive a domain
move.)

## Why split the roles

Every split costs an extra hop and a coordination problem. The reasons
are worth being honest about:

- **Different scale curves.** A PDS holds a few tens of thousands of
  repos at most; a relay holds *every* repo on the network, but each as
  cheap content-addressed blocks; an AppView holds a relational index of
  every interesting field of every record — which is the most expensive
  storage of the three. The cost shapes don't compose well, and the
  layer with the worst storage shape benefits most from being able to
  shard horizontally without touching the write side.
- **Different trust requirements.** A PDS must be trusted by its users
  (it holds their signing keys). A relay must be trusted by AppViews
  (its ordering must be honest). An AppView must be trusted by
  *clients* (its index must be honest about who said what). Splitting
  the roles means each operator only carries the trust they can
  actually carry.
- **Different upgrade paths.** A new lexicon doesn't change the PDS —
  the PDS doesn't validate against lexicons; it just stores bytes. The
  AppView ingests every new record under a new lexicon by adding an
  indexer. So the lexicon-defined "Bluesky" can evolve without a
  protocol-coordinated upgrade across every PDS.
- **Different parties can run them.** This is the political point. If
  Bluesky-the-company runs the only AppView, they have de-facto control
  of the experience even if the data lives elsewhere. If running an
  AppView is technically tractable (and it is — the protocol's whole
  point is that the index is reproducible from the firehose), other
  parties can offer alternatives. The PDS's job is to make that
  possible by being uniformly accessible.

## Hosted vs self-hosted

The PDS you've built can be either a personal server (one user, one
account, your own hostname) or a hosted multi-tenant service (many
accounts under the same domain). The code is the same. The differences
are operational: backups, monitoring, abuse handling, certificates,
disk.

Migration between PDSes is a first-class protocol operation. A user can:

1. Stand up (or pick) a new PDS.
2. Export their repo from the old one via `getRepo`.
3. Import it to the new one (lexicon: `com.atproto.repo.importRepo`).
4. Rotate the PDS endpoint in their DID document (a signed PLC op).

The DID stays the same. The relay's firehose stream from the old PDS
ends; a new stream from the new PDS begins. The AppView sees the same
identity continue posting from a different `serviceEndpoint`. The
user's followers don't notice unless they look at the URL bar.

This is the property "personal" data servers gain you. The data isn't
locked to the operator; the operator is a configurable detail of the
identity.

## Try it

Once the sync endpoints are live, you can poke them directly. Spin up
the PDS, create an account, then:

```sh
# The service DID document
curl -s http://localhost:3000/.well-known/did.json | jq

# Enumerate every repo
curl -s 'http://localhost:3000/xrpc/com.atproto.sync.listRepos?limit=10' | jq

# The repo's current commit
curl -s 'http://localhost:3000/xrpc/com.atproto.sync.getLatestCommit?did=did:plc:…' | jq

# The repo's state-flag (active/takendown/…)
curl -s 'http://localhost:3000/xrpc/com.atproto.sync.getRepoStatus?did=did:plc:…' | jq

# The repo itself, as a CAR
curl -s 'http://localhost:3000/xrpc/com.atproto.sync.getRepo?did=did:plc:…' \
  | xxd | head -5
```

The `xxd` is the point. The first byte is the varint of the header
length; if the repo has any content, byte zero is `0x1f` or `0x20` (the
header is ~31 bytes). Then the DAG-CBOR header (`a2 65 72 6f 6f 74 73…`
= `{"roots":…,"version":1}`), then a `0x30`-ish varint, then the first
36 bytes are the commit's CID, then the commit body. The whole format
is on screen by the second line of output.

If you have a second machine, point `decodeCarChunks` at the response
body — every block is hash-verified as it arrives, and once the stream
ends you have a complete, signed, content-addressed copy of the repo.
That's federation, mechanically.

## Exercises

1. **Backfill without the firehose.** Sketch what a one-shot
   archiver — a process that wants a daily snapshot of every repo on a
   PDS — would do using only the sync endpoints. Which calls does it
   make, in what order, and what does it persist? Where would
   `getRepoStatus` save it from wasted work?
2. **A second AppView.** You want to build a search-only AppView that
   indexes every post and never serves a profile page. It only needs
   one collection (`app.bsky.feed.post`). Could it use `getRecord` to
   fetch only the posts and skip the rest? What does that save vs
   subscribing to the firehose? What does it cost?
3. **PLC rotation as service identity.** Our `/.well-known/did.json`
   document has no `verificationMethod`. That's fine for advertising a
   `serviceEndpoint`, but it means nothing signs anything as the *PDS*
   — only as accounts. What would change if we added a service-level
   signing key, and what would a relay do with the signatures? (Hint:
   look at how `com.atproto.sync.requestCrawl` authenticates incoming
   submissions today.)

## Up next

The protocol topology is the last conceptual chapter; everything left
is operational. [18 — Production](./18-production.md) covers deployment,
backups, key rotation, abuse handling, and the things you need to think
about before letting other people's accounts live on your server.

← [16 — Firehose](./16-firehose.md) · → [18 — Production](./18-production.md)
