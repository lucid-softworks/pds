# `src/pds/`

The PDS itself. Everything in this tree is server code — none of it depends
on React, the router, or the docs UI. Each subdirectory matches a chapter in
[`/docs`](../../docs/README.md) and is small enough to read top-to-bottom.

| Subsystem | Lives in | Status | Chapter |
| --- | --- | --- | --- |
| Content-addressing & IPLD | [`codec/`](./codec/) | ✅ | [05](../../docs/05-cid-and-dagcbor.md) |
| Merkle Search Trees | [`repo/mst.ts`](./repo/mst.ts) | ✅ | [06](../../docs/06-merkle-search-tree.md) |
| Commits & signing | [`repo/commit.ts`](./repo/commit.ts), [`repo/keys.ts`](./repo/keys.ts) | ✅ | [07](../../docs/07-commits-and-signing.md) |
| CAR file encoding | [`car/`](./car/) | ✅ | [08](../../docs/08-car-files.md) |
| Lexicons | [`lexicon/`](./lexicon/) | 🚧 validator in flight | [09](../../docs/09-lexicons.md) |
| XRPC dispatcher | [`xrpc/server.ts`](./xrpc/server.ts) | ✅ | [10](../../docs/10-xrpc.md) |
| DIDs & identity | [`did/`](./did/) | ✅ (local-only PLC) | [12](../../docs/12-accounts.md) |
| Account creation | [`account/create.ts`](./account/create.ts) | ✅ | [12](../../docs/12-accounts.md) |
| Authentication | [`auth/`](./auth/) | ✅ + app-pw in flight | [13](../../docs/13-authentication.md) |
| Record writes | [`repo/writes.ts`](./repo/writes.ts) | ✅ | [14](../../docs/14-records.md) |
| Blob storage | [`blob/`](./blob/) | ✅ (filesystem + S3 stub) | [15](../../docs/15-blobs.md) |
| Event sequencer | [`sequencer/sequence.ts`](./sequencer/sequence.ts) | ✅ writer | [16](../../docs/16-firehose.md) |
| Firehose WebSocket | [`sequencer/firehose.ts`](./sequencer/) | 🚧 in flight | [16](../../docs/16-firehose.md) |
| Sync endpoints | [`repo/sync.ts`](./repo/sync.ts) + sync handlers | ✅ | [17](../../docs/17-pds-appview-relay.md) |

## XRPC endpoints

Every XRPC handler lives under [`xrpc/handlers/`](./xrpc/handlers/) as a
single file named after its NSID. The handler registry (one line per
endpoint) is in [`xrpc/handlers/index.ts`](./xrpc/handlers/index.ts).

Currently shipped (22):

```
com.atproto.server.createAccount     com.atproto.repo.createRecord
com.atproto.server.createSession     com.atproto.repo.putRecord
com.atproto.server.refreshSession    com.atproto.repo.deleteRecord
com.atproto.server.deleteSession     com.atproto.repo.getRecord
com.atproto.server.getSession        com.atproto.repo.listRecords
com.atproto.server.describeServer    com.atproto.repo.applyWrites
                                     com.atproto.repo.describeRepo
com.atproto.identity.resolveHandle   com.atproto.repo.uploadBlob

com.atproto.sync.getRepo             com.atproto.sync.getBlob
com.atproto.sync.getBlocks           com.atproto.sync.getRepoStatus
com.atproto.sync.getRecord           com.atproto.sync.listRepos
com.atproto.sync.getLatestCommit
```

## Dependency arrow

Higher modules import lower modules; lower modules know nothing about higher
ones:

```
┌────────────────────────────────────────────────────────────┐
│  src/routes/xrpc/$nsid.ts  +  src/routes/.well-known/*     │
│  (TanStack route shells)                                   │
└────────────────────────┬───────────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────┐
│  xrpc/handlers/* — one file per NSID                       │
└────────────────────────┬───────────────────────────────────┘
                         │
                  ┌──────┴──────┐
                  ▼             ▼
            ┌──────────┐  ┌──────────────┐
            │ account/ │  │ repo/writes  │
            └────┬─────┘  └──────┬───────┘
                 │               │
   ┌─────────────┼───────────────┼──────────────┐
   ▼             ▼               ▼              ▼
┌──────┐   ┌───────────┐   ┌─────────┐   ┌──────────────┐
│ did/ │   │   auth/   │   │  blob/  │   │  sequencer/  │
└──┬───┘   └─────┬─────┘   └────┬────┘   └──────┬───────┘
   │             │              │               │
   ▼             ▼              ▼               ▼
        ┌────────────────────────────────┐
        │       repo/{mst,commit}        │
        └────────────────┬───────────────┘
                         │
                ┌────────▼─────────┐
                │  repo/blockstore │
                │  +  car/         │
                └────────┬─────────┘
                         │
                ┌────────▼─────────┐
                │       codec      │
                └──────────────────┘
```

`lexicon/` is referenced by every handler eventually but doesn't import any
PDS code itself.

## Each subsystem's contract

See the README in each subdirectory:

- [`codec/README.md`](./codec/README.md)
- [`repo/README.md`](./repo/README.md)
- [`car/README.md`](./car/README.md)
- [`did/README.md`](./did/README.md)
- [`lexicon/README.md`](./lexicon/README.md)
- [`xrpc/README.md`](./xrpc/README.md)
- [`auth/README.md`](./auth/README.md)
- [`blob/README.md`](./blob/README.md)
- [`sequencer/README.md`](./sequencer/README.md)
