# What is a PDS?

A **Personal Data Server** is the piece of the AT Protocol that *holds your
stuff*. Your posts, your follows, your profile, your uploaded images — they
all live in a repository on some PDS, and your DID (your stable identity)
points at that PDS so the rest of the network knows where to find you.

That's the whole job. Everything else in this book is detail about how to do
that job well.

## The three-server pattern

The AT Protocol cleanly separates concerns across three kinds of server:

```
              writes (you)
                  │
                  ▼
       ┌────────────────────┐
       │        PDS         │  ← holds *your* repository
       │  (this project)    │
       └─────────┬──────────┘
                 │ firehose of every commit, in order
                 ▼
       ┌────────────────────┐
       │       Relay        │  ← fans the firehose out from many PDSes
       │   (a.k.a. BGS)     │
       └─────────┬──────────┘
                 │
                 ▼
       ┌────────────────────┐
       │      AppView       │  ← reads every repo, builds indexes, serves feeds
       │   (e.g. bsky.app)  │
       └────────────────────┘
                 ▲
                 │ reads (everyone)
```

- The **PDS** is the *write side*. Clients sign in here. Every change to your
  account — a post, a like, a profile edit — gets written to your repository
  on your PDS.
- The **Relay** subscribes to every PDS it knows about, fans their firehoses
  into a single ordered stream, and forwards.
- The **AppView** consumes the relay's stream, indexes everything into its
  own database, and serves the read-side queries: timelines, profiles,
  search.

This split is deliberate. The PDS only has to be fast at storing *your*
account; it never has to compute a global timeline. The AppView only has to
be fast at reading; it never has to authenticate users or own their data.
Either layer can be swapped or self-hosted without breaking the other.

> ⚠️ **Difference from upstream.** Bluesky's own PDS is one of *many* PDSes
> on the network. There's no "main" PDS. The network is the federation; the
> AppView is what gives it a unified experience.

## What "owning your data" actually means

Your repository is a content-addressed, signed data structure. The signing key
belongs to *your DID*, not your PDS. If your PDS goes down, you can:

1. Spin up a new PDS (this one, for example).
2. Re-export your repo from a backup CAR file, or migrate it from the old
   PDS via `com.atproto.server.requestAccountMigrate`.
3. Update your DID document to point at the new PDS.
4. Done — every relay and AppView re-resolves your DID and picks up the new
   location automatically.

This is the load-bearing claim of the AT Protocol's portability story. It's
also what makes this server interesting to build: the *server* is the
fungible part. The data and the identity outlive any particular host.

## What lives in a repository?

A repository is a tree of records. Records are grouped into **collections**
keyed by NSID (a reverse-DNS name). For a Bluesky-shaped account you'll see:

| Collection | Holds |
| --- | --- |
| `app.bsky.feed.post` | Posts |
| `app.bsky.feed.like` | Likes |
| `app.bsky.feed.repost` | Reposts |
| `app.bsky.graph.follow` | Follows |
| `app.bsky.actor.profile` | Your profile record (only one) |

But the PDS doesn't *know* about `app.bsky.*`. To the PDS, those are just
NSIDs. You could publish a record at `dev.acme.notes.note` and it would be
stored happily — the PDS doesn't care, the AppView is the one that decides
to ignore it. **This is the whole point of the lexicon system.** See
[Chapter 09](./09-lexicons.md).

## What lives outside a repository?

Three things, mostly:

1. **Blobs.** Images, videos. They're too big to inline into the MST, so the
   record stores a CID reference and the bytes live in a separate
   content-addressed store. See [Chapter 15](./15-blobs.md).
2. **The DID document.** Resolved from the PLC directory (for did:plc) or
   from a well-known endpoint (for did:web). See [Chapter 04](./04-data-model.md).
3. **The user's password / keys / tokens.** Authentication state. The PDS
   stores hashed credentials, but they're not part of the *protocol*; if you
   migrate to a new PDS, you get new credentials. See [Chapter 13](./13-authentication.md).

## What a client does, in order

Concretely, when someone opens a Bluesky-style app and posts a status, this is
the conversation:

1. `com.atproto.identity.resolveHandle` — turn `alice.bsky.social` into a DID.
2. `com.atproto.server.describeServer` — get capabilities and limits.
3. `com.atproto.server.createSession` — log in, get JWTs.
4. `com.atproto.repo.uploadBlob` (if there's an image attachment).
5. `com.atproto.repo.createRecord` with the `app.bsky.feed.post` payload.

Each of those is a chapter in this book. By the time we hit Part IV you'll
have implemented all of them.

## Up next

[Chapter 02 — The AT Protocol at a glance](./02-atproto-overview.md) zooms
out one more level, covering the protocol's primitives so the rest of the
book has a shared vocabulary.
