# Architecture of this PDS

This chapter is the map. It explains how the code under [`src/`](../src/) is
organized, what depends on what, and why we picked the boundaries we did.
Once you've read this, every later chapter has a place to file new files in
your head.

## The two halves

The codebase has two clean halves:

1. **The PDS server** — [`src/pds/`](../src/pds/README.md). Plain TypeScript.
   No React, no router, no Vite. Everything in here is the AT Protocol
   implementation.
2. **The TanStack Start app** — [`src/routes/`](../src/routes/), `__root.tsx`,
   the components. This serves three things in one process: the docs site
   you're reading right now, the XRPC endpoints (mounted under
   `/xrpc/*`), and a tiny admin UI (later chapters).

Keeping these halves separate matters: when you read `src/pds/repo/mst.ts`,
you're looking at the *implementation of a Merkle Search Tree*. There's no
HTTP, no React state, no env-var loading mixed in. If you wanted to lift the
PDS code into a Cloudflare Worker, or wrap it in a CLI, the seam is already
clean.

## The dependency arrow

Top to bottom — higher modules import lower modules, never the reverse:

```
┌────────────────────────────────────────────────────────────┐
│  src/routes/xrpc/**.ts                                     │
│  (HTTP layer; thin shells calling into PDS handlers)       │
└────────────────────────┬───────────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────┐
│  src/pds/xrpc/  +  src/pds/lexicon/                        │
│  (dispatcher, validation, per-NSID handlers)               │
└────────────────────────┬───────────────────────────────────┘
                         │
   ┌─────────────────────┼──────────────────────┐
   ▼                     ▼                      ▼
┌──────────┐      ┌─────────────┐        ┌──────────────┐
│ pds/auth │      │  pds/repo   │        │  pds/blob    │
│  (JWTs)  │      │ (MST, repo) │        │  (storage)   │
└────┬─────┘      └──────┬──────┘        └──────┬───────┘
     │                   │                      │
     │                   ▼                      │
     │            ┌─────────────┐               │
     │            │   pds/car   │               │
     │            └──────┬──────┘               │
     │                   │                      │
     ▼                   ▼                      ▼
            ┌─────────────────────┐
            │     pds/codec       │  (CIDs, DAG-CBOR)
            └──────────┬──────────┘
                       │
            ┌──────────▼──────────┐
            │     pds/did         │  (identity)
            └─────────────────────┘
```

`pds/sequencer` sits beside `pds/repo` — it observes commits as they're
written and assigns sequence numbers. We draw it as a sibling, not a
descendant, because the repo doesn't *know* the sequencer exists; the
sequencer subscribes.

`src/lib/db/` is the Drizzle/Postgres layer. Every PDS subsystem that needs
persistence imports from there.

## The route tree

The TanStack Start side is short:

```
src/routes/
├── __root.tsx                 # shared layout, header, head
├── index.tsx                  # landing page
├── docs/
│   ├── index.tsx              # chapter list
│   └── $slug.tsx              # one chapter
└── xrpc/                      # one file per XRPC endpoint
    ├── com.atproto.server.createSession.ts
    ├── com.atproto.repo.createRecord.ts
    ├── ...
    └── (added as chapters land)
```

The `xrpc/` files are mechanically the same: validate input, call into
`src/pds/xrpc/handlers/...`, format output. They're shells. Putting them in
the route tree means the framework owns request parsing, body limits,
streaming, and the rest of the HTTP plumbing for free.

## Why these boundaries

A few notes on the choices that aren't obvious:

**Why split `codec` out from `repo`?** Because CIDs and DAG-CBOR are useful
on their own — the firehose uses them, blobs use them, the CAR writer uses
them. Repo-specific logic stays in `repo/`.

**Why is `lexicon` separate from `xrpc`?** Because lexicons describe more
than endpoints — they also describe record shapes inside the MST. The
`repo` module validates incoming records against lexicons too. So lexicons
are a leaf that several callers reach into.

**Why a `sequencer` module instead of a column on the repo table?** Because
the firehose isn't just commits — it carries `#identity` (handle changes),
`#account` (suspension events), and tombstones, none of which involve a
repo write. Sequencing is its own concern.

**Why does `auth` live above `repo`?** It doesn't really; they're peers. But
the *XRPC handlers* on top need both, so we drew the arrow from xrpc-down.
Within `pds/`, `auth` and `repo` don't import each other.

## The TanStack Start glue

The framework gives us a few primitives we lean on:

- `createFileRoute` — file-based routing. Each `*.tsx` under `routes/`
  exports a `Route` whose path is inferred from the filename.
- `createServerFn` — a server-only function callable from a route loader.
  We use these to read markdown files for the docs route. (XRPC handlers
  use the API-route shape instead because they have specific HTTP needs.)
- `loader` — runs on the server during SSR, returns data the component
  uses. The chapter you're reading now was loaded by a server fn that read
  `docs/03-architecture.md` and ran it through unified + shiki.

If you've used Remix, Next App Router, or SolidStart, the shape will be
familiar. The novel bit is that TanStack Start integrates with TanStack
Router's typed-routes story, so route params are statically typed.

## Where everything is

A whirlwind tour of paths you'll touch:

| Path | What |
| --- | --- |
| `src/pds/codec/` | CID + DAG-CBOR helpers ([ch. 05](./05-cid-and-dagcbor.md)) |
| `src/pds/repo/mst.ts` | MST implementation ([ch. 06](./06-merkle-search-tree.md)) |
| `src/pds/repo/commit.ts` | Commit signing ([ch. 07](./07-commits-and-signing.md)) |
| `src/pds/car/` | CAR encode/decode ([ch. 08](./08-car-files.md)) |
| `src/pds/lexicon/` | Lexicon parsing + validation ([ch. 09](./09-lexicons.md)) |
| `src/pds/xrpc/server.ts` | Dispatcher ([ch. 10](./10-xrpc.md)) |
| `src/pds/xrpc/handlers/com/atproto/...` | One file per NSID |
| `src/pds/did/` | DID resolution ([ch. 04](./04-data-model.md), [ch. 12](./12-accounts.md)) |
| `src/pds/auth/` | Sessions, JWTs, app passwords ([ch. 13](./13-authentication.md)) |
| `src/pds/blob/` | Blob storage ([ch. 15](./15-blobs.md)) |
| `src/pds/sequencer/` | Sequence numbers + firehose ([ch. 16](./16-firehose.md)) |
| `src/lib/db/` | Drizzle schema + connection factory |
| `drizzle/` | Generated SQL migrations |
| `src/routes/xrpc/` | TanStack route shells that delegate to handlers |

## Run loop

```bash
pnpm install         # one-time
pnpm db:migrate      # apply migrations to PGlite
pnpm dev             # vite dev server, port 3000
```

In dev:
- The PDS API is at `http://localhost:3000/xrpc/...`
- The docs are at `http://localhost:3000/docs`
- The PGlite database is at `./.pglite/`

In prod, you set `DATABASE_URL=postgres://...` and the same code runs against
hosted Postgres. The migration files in `drizzle/` are dialect-portable.

## Up next

We've got the floor plan. Now we walk into the rooms one at a time. The next
chapter — [04 — DIDs, handles, and AT-URIs](./04-data-model.md) — picks up
identity, which everything else hangs off of.
