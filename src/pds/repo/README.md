# `repo/` — Repositories, MSTs, and commits

Each account on a PDS owns a *repository*: an authenticated, content-addressed
collection of records grouped into collections like `app.bsky.feed.post`. The
repo's storage layout is a [Merkle Search Tree](https://hal.inria.fr/hal-02303490)
(MST) — an order-stable, hashed tree whose root commit fits in a single signed
block.

This module contains:

- `mst.ts` — the MST data structure: insert, delete, lookup, walk.
- `commit.ts` — building, signing, and verifying a `commit` block.
- `repo.ts` — the high-level "open a repo for a DID, apply a write" surface.
- `diff.ts` — diffing two MST roots to produce the block list a firehose needs.

The MST is the load-bearing piece — the docs for it are split into two
chapters:

- **[Chapter 06 — Merkle Search Trees](../../../docs/06-merkle-search-tree.md)**
  explains the data structure.
- **[Chapter 07 — Commits and signing](../../../docs/07-commits-and-signing.md)**
  explains how a repo gets sealed and verified.
