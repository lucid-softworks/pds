# How to read this book

This is a long-form, hands-on guide to building a Personal Data Server for the
AT Protocol — the same protocol that powers Bluesky. By the time you finish,
you'll have a working PDS in front of you, with every subsystem reimplemented
from scratch and explained in detail.

## What you'll build

A server that:

- Issues identities (did:plc and did:web).
- Stores each account's content as an authenticated, content-addressed
  repository — a Merkle Search Tree of records.
- Signs commits, exports them as CAR files, and serves them to relays and
  app views over a streaming firehose.
- Implements the canonical `com.atproto.*` XRPC procedures so a real Bluesky
  client can sign in, write posts, follow accounts, and upload images.
- Runs locally in dev with **zero external services** thanks to an
  in-process Postgres compiled to WASM.
- Deploys to any Postgres-compatible cloud in production.

## Who this is for

You should be comfortable with:

- TypeScript at a working level — types, generics, async/await.
- HTTP and REST-ish APIs — what JSON is, what a `Content-Type` is.
- The general shape of public-key cryptography — you don't need to know how
  ECDSA works internally, just that "signing" and "verifying" are a thing.

You do **not** need to know:

- IPLD, CIDs, CAR, or DAG-CBOR. Chapter 05 starts from zero.
- The internal design of git. (It will help, though — the analogies are
  good.)
- React. The docs site is React; the PDS itself is plain server code.

## What's in each chapter

Every chapter follows the same shape:

1. **The concept** — what this piece is and why it exists.
2. **The spec** — links to the canonical AT Protocol spec, with the
   normative bits called out.
3. **The implementation** — a walk through the code in
   [`src/pds/`](../src/pds/README.md), with the interesting parts inlined.
4. **Try it** — a curl invocation, a script, or a `pnpm` command you can run
   to see the chapter's subject in action.
5. **Exercises** — small extensions to deepen the understanding. Solutions
   are not included on purpose.

## How to use the code

Each subsystem lives in its own directory under
[`src/pds/`](../src/pds/README.md). The directory's `README.md` says what
chapter motivates it. If you're reading code and lost, jump to the chapter;
if you're reading a chapter and curious about a detail, jump to the code.

Local dev:

```bash
pnpm install
pnpm db:migrate     # set up the dev DB (PGlite, in-process)
pnpm dev            # runs the PDS + docs site at http://localhost:3000
```

## A note on fidelity

This is a *learning* port — readability and pedagogy come first. Where the
real reference PDS uses tricks for throughput (LRU caches, prepared-statement
pools, batched writes, custom CBOR encoders), we use the most obvious
implementation and explain what we *would* do under load. The protocol shape
itself is faithful: a Bluesky client should be able to use this PDS without
patching.

When we diverge from the reference PDS, the chapter calls it out in a
`> ⚠️ Difference from upstream` block.

Onward to [Chapter 01 — What is a PDS?](./01-what-is-a-pds.md).
