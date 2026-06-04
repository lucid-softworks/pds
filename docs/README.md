# How to build your own PDS

A chapter-by-chapter walk through a from-scratch reimplementation of the
[Bluesky PDS](https://github.com/bluesky-social/pds). The code lives in
[`src/pds/`](../src/pds/README.md); the chapters here explain what it does
and *why* the design is what it is.

## Part I — Setting the scene

- [00 — How to read this book](./00-introduction.md)
- [01 — What is a PDS?](./01-what-is-a-pds.md)
- [02 — The AT Protocol at a glance](./02-atproto-overview.md)
- [03 — Architecture of this PDS](./03-architecture.md)

## Part II — The data model

- [04 — DIDs, handles, and AT-URIs](./04-data-model.md)
- [05 — Content addressing and DAG-CBOR](./05-cid-and-dagcbor.md)
- [06 — Merkle Search Trees](./06-merkle-search-tree.md)
- [07 — Commits and signing](./07-commits-and-signing.md)
- [08 — CAR files](./08-car-files.md)

## Part III — The API surface

- [09 — Lexicons](./09-lexicons.md)
- [10 — XRPC: HTTP API conventions](./10-xrpc.md)
- [11 — The database schema](./11-database-schema.md)

## Part IV — Accounts and writes

- [12 — Account creation and did:plc](./12-accounts.md)
- [13 — Authentication](./13-authentication.md)
- [14 — Reading and writing records](./14-records.md)
- [15 — Blobs](./15-blobs.md)

## Part V — Federation

- [16 — Event sequencer and the firehose](./16-firehose.md)
- [17 — PDS vs AppView vs Relay](./17-pds-appview-relay.md)
- [18 — Running in production](./18-production.md)

## Part VI — Operating the PDS

- [19 — Moderation](./19-moderation.md)
- [20 — Migration](./20-migration.md)

## Part VII — OAuth

- [21 — OAuth](./21-oauth.md)

## Part VIII — A client for our PDS

- [22 — A minimal client UI](./22-client-ui.md)

## Part IX — Operations cookbook

- [23 — Backups](./23-backups.md)

## Part X — Bundled moderation

- [24 — Ozone-shaped moderation, bundled](./24-ozone-port.md)

---

## Reading order

Chapters build on each other. If you skip around, the dependency graph is:

```
00 → 01 → 02 → 03 ────────────────────────────────┐
                  ↓                                ↓
                  04 → 05 → 06 → 07 → 08          11
                                 ↓                 ↓
                                 09 → 10 ←─────────┘
                                       ↓
                                       12 → 13 → 14 → 15
                                                        ↓
                                                        16 → 17 → 18 → 19 → 20 → 21 → 22 → 23 → 24
```

The hardest cluster is 06–08 (MST, commits, CAR). If you're stuck there, keep
going — the rest of the book reads it as a black box ("the repo emits a
signed root CID") and you can come back.
