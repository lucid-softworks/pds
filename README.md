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

## Status

This is a long-running project. Each session lands one subsystem of code
together with the chapter that explains it. See
[`docs/README.md`](./docs/README.md) for the full table of contents and
which chapters are filled in vs. still outlined.

So far:

- ✅ App skeleton, docs UI, markdown pipeline
- ✅ Database layer (PGlite in dev, hosted Postgres in prod)
- ✅ Schema + migration for accounts, repos, repo_blocks, refresh_tokens, plc_operations
- ✅ `src/pds/codec/` — CIDs + DAG-CBOR
- ✅ `src/pds/repo/{tid,keys,blockstore,commit,repo}.ts` — TIDs, k256 keypairs, content-addressed block storage, signed commits, genesis-repo construction
- ✅ `src/pds/repo/mst.ts` — minimal (empty MST only — full MST in next session)
- ✅ `src/pds/did/{plc,handle,document,resolver}.ts` — local PLC, handle validation, DID document construction, local resolution
- ✅ `src/pds/auth/{password,jwt,session}.ts` — scrypt password hashing, HS256 JWTs, session issuance
- ✅ `src/pds/xrpc/{errors,server}.ts` — minimal dispatcher
- ✅ `POST /xrpc/com.atproto.server.createAccount` — end-to-end registration
- ✅ Tutorial chapters 00–06, 11, 12
- 🚧 Chapters 07–10, 13–18

## Try it

```bash
pnpm install
cp .env.example .env       # set PDS_JWT_SECRET to 64 random hex chars
pnpm db:migrate
pnpm dev
```

In another terminal:

```bash
curl -i -X POST http://localhost:3000/xrpc/com.atproto.server.createAccount \
  -H 'content-type: application/json' \
  -d '{
    "handle": "alice.test",
    "email": "alice@example.com",
    "password": "correcthorsebatterystaple"
  }'
```

You should get a 200 with a DID, handle, two JWTs, and a DID document.
Replay the same request and you'll get a 409 `HandleNotAvailable`.

## Running it

Requirements:

- Node ≥ 20
- pnpm (`npm i -g pnpm`)

```bash
pnpm install
cp .env.example .env       # tweak as needed; defaults to in-process PGlite
pnpm db:migrate            # apply (currently empty) migrations
pnpm dev
```

Then open `http://localhost:3000`. The PDS API will eventually live at
`/xrpc/...`; the docs site is at `/docs`.

## Database

- **Dev:** `@electric-sql/pglite` — Postgres compiled to WASM, runs in the
  same process as the app. Zero external services to start.
- **Prod:** any Postgres-compatible URL. Same Drizzle schema, same
  migration files.

Switch by setting `DATABASE_URL`:

```bash
DATABASE_URL=pglite                              # default, ./.pglite/
DATABASE_URL=pglite:./var/pds-data               # custom dir
DATABASE_URL=postgres://user:pw@host:5432/db     # external
```

## Project layout

```
pds/
├── docs/                 # tutorial chapters (one per subsystem)
├── src/
│   ├── routes/           # TanStack Start routes (docs UI + xrpc endpoints)
│   ├── pds/              # the PDS itself
│   │   ├── codec/        #   CIDs & DAG-CBOR
│   │   ├── repo/         #   MST + commits
│   │   ├── car/          #   CAR encode/decode
│   │   ├── did/          #   identity
│   │   ├── lexicon/      #   schema layer
│   │   ├── xrpc/         #   dispatcher + handlers
│   │   ├── auth/         #   JWTs, app passwords
│   │   ├── blob/         #   blob storage
│   │   └── sequencer/    #   event sequence + firehose
│   ├── lib/
│   │   ├── db/           #   Drizzle, PGlite/Postgres factory
│   │   └── docs.ts       #   markdown → HTML pipeline
│   ├── components/
│   └── styles/
└── drizzle/              # generated SQL migrations
```

Each directory under `src/pds/` has its own README pointing at its
tutorial chapter.

## Contributing to your own copy

This is a learning project, not a production fork. If you're using it as a
starting point for a real PDS, you'll want to:

1. Read it cover-to-cover.
2. Audit the cryptography (we use battle-tested libs but the *use* of them
   is yours to verify).
3. Replace the in-process PGlite with a real Postgres before deploying.
4. Add operational concerns the book doesn't cover: rate limiting,
   abuse detection, the moderation surface.

The [reference PDS][bsky-pds] is what you should keep open in a second
tab.

## License

Treat the code as a study aid; pick whatever license suits your downstream
project.
