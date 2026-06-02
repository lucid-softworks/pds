# pds — a teaching port of the Bluesky personal data server

A from-scratch reimplementation of [bluesky-social/pds][bsky-pds] in
[TanStack Start][tss], paired with a chapter-per-subsystem book that
explains how every piece works. The goal: someone who reads it end-to-end
can build their own PDS.

The docs site is part of the app. Run it locally and read at
`http://localhost:3000/docs`, or read the markdown directly in
[`docs/`](./docs/README.md).

[bsky-pds]: https://github.com/bluesky-social/pds
[tss]: https://tanstack.com/start

## What's in the box

**Implemented subsystems** (each pairs with a tutorial chapter):

| Subsystem | Code | Chapter |
| --- | --- | --- |
| CIDs + DAG-CBOR | [`src/pds/codec/`](./src/pds/codec/) | [05](./docs/05-cid-and-dagcbor.md) |
| Merkle Search Trees | [`src/pds/repo/mst.ts`](./src/pds/repo/mst.ts) | [06](./docs/06-merkle-search-tree.md) |
| Signed commits | [`src/pds/repo/commit.ts`](./src/pds/repo/commit.ts) | [07](./docs/07-commits-and-signing.md) |
| CAR encode/decode | [`src/pds/car/`](./src/pds/car/) | [08](./docs/08-car-files.md) |
| Lexicons | [`src/pds/lexicon/`](./src/pds/lexicon/) (validator landing in wave 3) | [09](./docs/09-lexicons.md) |
| XRPC dispatcher | [`src/pds/xrpc/server.ts`](./src/pds/xrpc/server.ts) | [10](./docs/10-xrpc.md) |
| Database schema | [`src/lib/db/schema/`](./src/lib/db/schema/) | [11](./docs/11-database-schema.md) |
| Account creation | [`src/pds/account/create.ts`](./src/pds/account/create.ts) + DID layer | [12](./docs/12-accounts.md) |
| Sessions + auth | [`src/pds/auth/`](./src/pds/auth/) | [13](./docs/13-authentication.md) |
| Records (CRUD) | [`src/pds/repo/writes.ts`](./src/pds/repo/writes.ts) | [14](./docs/14-records.md) |
| Blobs | [`src/pds/blob/`](./src/pds/blob/) | [15](./docs/15-blobs.md) |
| Sequencer | [`src/pds/sequencer/sequence.ts`](./src/pds/sequencer/sequence.ts) | [16](./docs/16-firehose.md) |
| Sync endpoints | [`src/pds/repo/sync.ts`](./src/pds/repo/sync.ts) + handlers | [17](./docs/17-pds-appview-relay.md) |
| Production guide | — | [18](./docs/18-production.md) |

**Implemented XRPC endpoints** (22):

| Namespace | Endpoints |
| --- | --- |
| `com.atproto.server.*` | createAccount, createSession, refreshSession, deleteSession, getSession, describeServer |
| `com.atproto.identity.*` | resolveHandle |
| `com.atproto.repo.*` | createRecord, putRecord, deleteRecord, getRecord, listRecords, applyWrites, describeRepo, uploadBlob |
| `com.atproto.sync.*` | getRepo, getBlocks, getRecord, getLatestCommit, getRepoStatus, listRepos, getBlob |
| `/.well-known/*` | did.json (service DID document) |

The PDS supports account creation, login, posting, reading, listing, blob
upload, repo export — the full "client can sign in and post" flow.

## Status (in progress)

- ✅ Foundation (app shell, docs UI, markdown pipeline, DB layer)
- ✅ Account creation end-to-end with did:plc (local-only in dev)
- ✅ Session lifecycle + identity + server discovery
- ✅ Full Merkle Search Tree + commits + CAR
- ✅ Records CRUD with MST commits
- ✅ Blob storage (filesystem dev, S3 stub)
- ✅ Sequencer (firehose write path)
- ✅ Sync endpoints for federation
- 🚧 WebSocket firehose (`subscribeRepos`)
- 🚧 Lexicon runtime validator
- 🚧 App passwords
- 🚧 Email confirmation + password reset
- 📝 OAuth, account migration, moderation surface — chapter 18 punts these to follow-ups

## Try it

Requirements:

- Node ≥ 20
- pnpm (`npm i -g pnpm`)

```bash
pnpm install
cp .env.example .env       # set PDS_JWT_SECRET to 64 random hex chars
pnpm db:migrate            # apply migrations to in-process PGlite
pnpm dev                   # docs site + XRPC at http://localhost:3000
```

In another shell — full end-to-end exercise:

```bash
scripts/demo.sh
```

That registers a fresh account, logs in, posts, reads back, refreshes,
and logs out. Or do it by hand with `curl`:

```bash
curl -i -X POST http://localhost:3000/xrpc/com.atproto.server.createAccount \
  -H 'content-type: application/json' \
  -d '{"handle":"alice.test","email":"alice@example.com","password":"correcthorsebatterystaple"}'
```

## Database

- **Dev:** [`@electric-sql/pglite`](https://github.com/electric-sql/pglite) — Postgres compiled to WASM, runs in the same process. Zero external services.
- **Prod:** any Postgres-compatible URL. Same Drizzle schema, same migrations.

Switch by setting `DATABASE_URL`:

```bash
DATABASE_URL=pglite                              # default, ./.pglite/
DATABASE_URL=pglite:./var/pds-data               # custom directory
DATABASE_URL=postgres://user:pw@host:5432/db     # external
```

The migration runner at `src/lib/db/migrate.ts` applies SQL files from
`drizzle/` in order, tracked by a `__migrations` journal table. No
`drizzle-kit` runtime dependency.

## Project layout

```
pds/
├── docs/                          # tutorial chapters (00–18 + README index)
├── scripts/
│   └── demo.sh                    # end-to-end smoke test
├── drizzle/
│   ├── 0000_init.sql              # accounts, repos, repo_blocks, refresh_tokens, plc_operations
│   ├── 0001_records.sql           # records index
│   ├── 0002_blobs.sql             # blobs, record_blobs
│   └── 0003_sequencer.sql         # repo_seq (firehose event log)
├── src/
│   ├── routes/                    # TanStack Start routes (docs UI + xrpc + .well-known)
│   ├── pds/                       # the PDS itself
│   │   ├── codec/                 #   CIDs & DAG-CBOR
│   │   ├── repo/                  #   MST + commits + writes + sync
│   │   ├── car/                   #   CAR v1 encode/decode
│   │   ├── did/                   #   identity (PLC, web, handle, resolver)
│   │   ├── lexicon/               #   schema layer (validator: in flight)
│   │   ├── xrpc/                  #   dispatcher + per-NSID handlers + registry
│   │   ├── auth/                  #   JWTs, scrypt, sessions, middleware
│   │   ├── blob/                  #   blob storage (filesystem + S3 stub)
│   │   ├── sequencer/             #   firehose event log writer
│   │   └── account/               #   the createAccount orchestrator
│   ├── lib/
│   │   ├── db/
│   │   │   ├── schema/            #   per-subsystem schema files (barrel: index.ts)
│   │   │   ├── index.ts           #   db factory (PGlite/postgres-js)
│   │   │   └── migrate.ts         #   SQL file runner
│   │   ├── config.ts              #   env loader (PDS_PUBLIC_URL, ...)
│   │   └── docs.ts                #   markdown → HTML pipeline
│   ├── components/                # React (docs UI only)
│   └── styles/
```

Each `src/pds/<subsystem>/README.md` points at the chapter that motivates
the subsystem and notes the contract surface.

## What this isn't

- A production-ready PDS. Read [chapter 18](./docs/18-production.md) for the
  swap matrix (KMS-wrapped keys, hosted Postgres, S3 blobs, real PLC
  publishing, TLS termination, email provider).
- A faithful copy of every Bluesky lexicon. We bundle the ones we
  validate against; everything else is stored opaquely.
- A relay or an AppView. Those are separate services; chapter 17 explains
  the split.

## License

Treat the code as a study aid; pick whatever license suits your downstream
project.
