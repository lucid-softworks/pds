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

Two more endpoints ride this rail when the consumer wants a narrower
inventory than the full CAR:

- `com.atproto.sync.listBlobs?did=<did>&limit=&cursor=` — paginated
  enumeration of every blob CID a repo has uploaded. Used by a backup
  tool checking blob coverage, or by a migration's destination PDS
  inventorying what the source actually still has. Same status-name
  discipline as `getLatestCommit`: takendown / deactivated accounts
  surface the matching lexicon error rather than a generic 404.
- `com.atproto.sync.getLatestCommit?did=<did>` — `{cid, rev}` pointer
  read so a consumer with a cached rev can decide "fetch nothing,
  fetch delta via getBlocks, or full re-pull via getRepo" without
  paying for the CAR every time. Auth-free; the response is a few bytes.

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

For a relay to actually start subscribing, the PDS asks it to. The
canonical knob is `com.atproto.sync.requestCrawl` — a single
unauthenticated POST with `{ hostname }`. The relay responds 200 (no
body), opens our firehose, and if it's the first time, runs the
backfill above. There's no allow-list; the relay decides which
submissions to honor by its own spam policy.

```sh
# Tell Bluesky's reference relay to start crawling our firehose.
curl -X POST 'https://bsky.network/xrpc/com.atproto.sync.requestCrawl' \
  -H 'content-type: application/json' \
  -d '{"hostname":"pds.example.com"}'
```

[`scripts/deploy.sh`](../scripts/deploy.sh) runs this on first
provision so a freshly-deployed PDS is reachable by `bsky.app` clients
out of the box — without it, your posts persist locally but never
appear in anyone's timeline because no AppView has indexed them. The
call is idempotent: re-runs are no-ops.

Other relays (a federated alternative, a private one inside a single
organization) take the same call. The hostname field lets one PDS
register itself with multiple relays from the same script.

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

## The PDS as a proxy

Sync endpoints are how an AppView ingests *everyone's* PDS. That
covers the *read* path into the AppView's index. But there's a second
edge that needs explaining: how does **the user's client** reach the
AppView in the first place?

A Bluesky client (the official iOS/Android app, bsky.app in the
browser, anything built on `@atproto/api`) calls *every* XRPC method
against its user's PDS. That's a deliberate convention — the client
only ever needs to know one URL, the user's PDS, and the PDS forwards
anything outside its namespace to the right downstream service.

So when bsky.app on `https://bsky.app` wants
`app.bsky.actor.getProfile`, it doesn't send the request to
`api.bsky.app`. It sends:

```http
GET /xrpc/app.bsky.actor.getProfile?actor=did:plc:abc HTTP/1.1
Host: pds.example.com
Authorization: Bearer <pds-access-jwt>
Atproto-Proxy: did:web:api.bsky.app#bsky_appview
```

…to **the user's PDS** (`pds.example.com`). The `Atproto-Proxy` header
tells the PDS: *forward this to the service identified by
`did:web:api.bsky.app`'s `#bsky_appview` entry, on my behalf.* The PDS
responds with whatever the AppView responded with.

### What the PDS does on the forward

[`src/pds/xrpc/proxy.ts`](../src/pds/xrpc/proxy.ts) is the whole
implementation. Lifecycle of one proxied request:

1. **Auth check.** The dispatcher runs `requireEitherAuth` on the
   incoming bearer — either a legacy session JWT or an OAuth
   DPoP-bound token. We need to know *who* is calling so we can sign
   for them.
2. **Header parse.** Split `did:web:api.bsky.app#bsky_appview` into
   `(did, serviceId)`. A leading-hash or missing-hash is a 400.
3. **Target resolution.** Resolve the target DID (`did:web:` is HTTP,
   `did:plc:` is plc.directory; chapter 4) and look up the `service`
   array entry whose `id` matches `#<serviceId>`. Reject if the
   `serviceEndpoint` isn't `http(s)://…`.
4. **Service-auth mint.** Load the caller's repo signing key (the
   same k256 key that signs MST commits — chapter 7), build a JWT:

   ```json
   {
     "alg": "ES256K",
     "typ": "JWT"
   }
   .
   {
     "iss": "did:plc:<caller>",
     "aud": "did:web:api.bsky.app",
     "lxm": "app.bsky.actor.getProfile",
     "iat": 1717512345,
     "exp": 1717512405,
     "jti": "<random>"
   }
   ```

   Signed ES256K with the caller's private signing key. The AppView
   resolves the caller's DID document and verifies the signature
   against the published public key — the same verification path it
   uses for repo commits, so no extra trust infrastructure.

5. **Forward.** New `fetch()` to `<serviceEndpoint>/xrpc/<nsid><query>`,
   with the original method, body, and most headers. The bearer token
   is replaced with the freshly-minted service-auth; `host`,
   `content-length`, `connection` (hop-by-hop), and `atproto-proxy`
   itself are stripped.
6. **Stream back.** The upstream response body, status, statusText,
   and non-hop-by-hop headers flow straight back to the client.

The whole thing takes ~10 lines of dispatcher integration in
`src/pds/xrpc/server.ts` — the proxy branch runs *before* the local
handler lookup, so when bsky.app sends an `app.bsky.*` call, we never
even look in our registry.

### Why service-auth and not just forwarding the bearer

The PDS's access JWT is HS256-signed with `PDS_JWT_SECRET`. The
AppView doesn't know that secret — it can't verify our access tokens.
Conversely, the AppView *can* verify the caller's repo signing key,
because that key is published in the caller's DID document, which is
public, content-addressed identity. So service-auth (ES256K JWT
signed by the caller) is the only authentication that works across
the PDS↔AppView boundary without a shared secret.

Short TTL (60s) is the protocol convention — the AppView never sees
a re-usable token, just a single-request capability.

### Other services that ride the same rail

Same shape, different DID:

- **Chat** — `chat.bsky.*` → `did:web:chat.bsky.app#bsky_chat`
- **Labelers** — `app.bsky.labeler.*` → labeler-specific DID
- **Ozone** moderation — `tools.ozone.*` → instance DID
- **AppView discovery** — `app.bsky.unspecced.getConfig` → AppView

The client decides which `Atproto-Proxy` to set per request. The PDS
doesn't care what NSID is being proxied; it just forwards anything
with the header and rejects (404 `XrpcProxyTargetNotFound`) when the
target DID has no matching service.

Result: bsky.app at `https://bsky.app`, an alternate client, your
own React Native app — all of them treat your PDS at `pds.example.com`
as the single entry point. Profile lookups, timeline fetches,
notifications, DMs, moderation reports — every one of them tunnels
through your PDS to the AppView/chat/Ozone service that knows the
answer. The PDS stays the small, federated piece of the puzzle while
clients enjoy the illusion of one URL.

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
