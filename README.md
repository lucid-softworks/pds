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
| Lexicons | [`src/pds/lexicon/`](./src/pds/lexicon/) — runtime validator, observe-only | [09](./docs/09-lexicons.md) |
| XRPC dispatcher | [`src/pds/xrpc/server.ts`](./src/pds/xrpc/server.ts) | [10](./docs/10-xrpc.md) |
| Database schema | [`src/lib/db/schema/`](./src/lib/db/schema/) | [11](./docs/11-database-schema.md) |
| Account creation | [`src/pds/account/create.ts`](./src/pds/account/create.ts) + DID layer | [12](./docs/12-accounts.md) |
| Sessions + auth | [`src/pds/auth/`](./src/pds/auth/) — sessions, app passwords, email, password reset, lifecycle | [13](./docs/13-authentication.md) |
| Records (CRUD) | [`src/pds/repo/writes.ts`](./src/pds/repo/writes.ts) | [14](./docs/14-records.md) |
| Blobs | [`src/pds/blob/`](./src/pds/blob/) — upload, attachment, GC | [15](./docs/15-blobs.md) |
| Sequencer + firehose | [`src/pds/sequencer/`](./src/pds/sequencer/) — write path + WebSocket subscribeRepos | [16](./docs/16-firehose.md) |
| Sync endpoints | [`src/pds/repo/sync.ts`](./src/pds/repo/sync.ts) + handlers | [17](./docs/17-pds-appview-relay.md) |
| Production guide | KeyWrapper, structured logging, `/metrics`, graceful shutdown | [18](./docs/18-production.md) |
| Moderation XRPC + audit | [`src/pds/admin/`](./src/pds/admin/) + `com.atproto.admin.*` handlers | [19](./docs/19-moderation.md) |
| Admin web UI | [`src/routes/admin/`](./src/routes/admin/) — handle-gated `/admin` | [19](./docs/19-moderation.md) |
| Account migration | self-custody PLC ops + `requestAccountMigrate` + `importRepo` | [20](./docs/20-migration.md) |
| OAuth (front half + JWT) | [`src/pds/oauth/`](./src/pds/oauth/) — PAR, authorize, token, revoke, JWKS, DPoP | [21](./docs/21-oauth.md) |
| Minimal client UI | [`src/routes/app/`](./src/routes/app/) — login, feed, compose, image upload | [22](./docs/22-client-ui.md) |
| Backups | `pds:export` / `pds:import` CLIs | [23](./docs/23-backups.md) |

**Implemented XRPC endpoints** (57 + 1 WebSocket subscription):

| Namespace | Endpoints |
| --- | --- |
| `com.atproto.server.*` (account) | createAccount, createSession, refreshSession, deleteSession, getSession, describeServer, checkAccountStatus, deactivateAccount, activateAccount, requestAccountDelete, deleteAccount |
| `com.atproto.server.*` (app pw) | createAppPassword, listAppPasswords, revokeAppPassword |
| `com.atproto.server.*` (email) | requestEmailConfirmation, confirmEmail, requestEmailUpdate, updateEmail, requestPasswordReset, resetPassword |
| `com.atproto.server.*` (invites) | createInviteCode, createInviteCodes, getAccountInviteCodes, checkSignupQueue |
| `com.atproto.server.*` (migration) | getServiceAuth, reserveSigningKey, requestAccountMigrate |
| `com.atproto.identity.*` | resolveHandle, updateHandle, requestPlcOperationSignature, signPlcOperation |
| `com.atproto.repo.*` | createRecord, putRecord, deleteRecord, getRecord, listRecords, applyWrites, describeRepo, uploadBlob, importRepo |
| `com.atproto.sync.*` (HTTP) | getRepo, getBlocks, getRecord, getLatestCommit, getRepoStatus, listRepos, getBlob, listMissingBlobs |
| `com.atproto.sync.*` (WS) | subscribeRepos |
| `com.atproto.admin.*` | getAccountInfo, getAccountInfos, updateAccountStatus, updateAccountHandle, updateAccountEmail, sendEmail, deleteAccount, getAuditLog |
| OAuth routes | `/oauth/par`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/jwks` |
| `/.well-known/*` | `did.json`, `oauth-authorization-server` (RFC 8414), `oauth-protected-resource` (RFC 9728) |
| Operations | `/metrics` (Prometheus), `/admin` (operator UI), `/app` (in-tree client) |

The PDS supports the full single-user flow a Bluesky client would put it
through, plus the operator surface for moderation and migration work.

## Status

- ✅ Foundation (app shell, docs UI, markdown pipeline, DB layer)
- ✅ Account creation end-to-end with did:plc (local-only in dev)
- ✅ Session lifecycle + identity + server discovery
- ✅ App passwords + email confirmation + password reset
- ✅ Full account lifecycle (deactivate/activate/delete with tombstone)
- ✅ Invite-code gate (on by default; opt out with `PDS_INVITE_REQUIRED=false`)
- ✅ Identity rotation (`updateHandle` via PLC chain)
- ✅ Full Merkle Search Tree + commits + CAR
- ✅ Records CRUD with MST commits + blob attachment tracking + GC
- ✅ Blob storage (filesystem dev, S3 stub)
- ✅ Sequencer + WebSocket firehose (subscribeRepos)
- ✅ Sync endpoints for federation
- ✅ Lexicon runtime validator (observe-only by default)
- ✅ Admin / moderation XRPC surface (HTTP Basic, env-var hash) + DAG-CBOR audit log
- ✅ Admin web UI at `/admin` (handle-gated via `PDS_ADMIN_HANDLE`)
- ✅ Account migration (self-custody PLC ops, `requestAccountMigrate`, `importRepo`)
- ✅ OAuth front half + JWT issuance (PAR, PKCE, DPoP with pluggable replay store, JWKS)
- ✅ Minimal client UI at `/app` (login, feed, compose, image upload)
- ✅ Production ergonomics: `KeyWrapper` for at-rest signing keys, structured logger, `/metrics`, graceful shutdown
- ✅ Backups (`pnpm pds:export` / `pds:import`) + benchmarking (`pds-bench`, `pds-stress`)

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

What's at `http://localhost:3000`:

- `/` — live stats dashboard for this PDS (accounts, records, blobs, firehose seq)
- `/docs` — the chapter book that pairs with the code
- `/app` — minimal in-tree client (login, feed, compose, image upload)
- `/admin` — operator console (gated by `PDS_ADMIN_HANDLE`)
- `/metrics` — Prometheus exposition (gated by `PDS_METRICS=true`)
- `/xrpc/*` — the lexicon-defined HTTP surface
- `/.well-known/did.json` — this PDS's identity document

End-to-end smoke test in another shell:

```bash
scripts/demo.sh
```

That registers a fresh account, logs in, posts, reads back, refreshes,
and logs out. Or do it by hand with `curl`:

```bash
curl -i -X POST http://localhost:3000/xrpc/com.atproto.server.createAccount \
  -H 'content-type: application/json' \
  -d '{"handle":"alice.test","email":"alice@example.com","password":"correcthorsebatterystaple","inviteCode":"..."}'
```

## Operate it

```bash
pnpm admin:hash 'your-admin-password'      # → scrypt hash for PDS_ADMIN_PASSWORD_HASH
pnpm pds-admin createInviteCode --uses 1   # mint a code (XRPC admin surface)
pnpm pds:export ./snapshot.car             # CAR-backed backup
pnpm pds:import ./snapshot.car             # restore
pnpm bench                                 # micro-benchmark the write path
pnpm stress                                # concurrent-write stress harness
```

For interactive operator work, set `PDS_ADMIN_HANDLE` to an account
handle and visit `/admin` — the operator logs in with that account's
password and gets a dashboard for signups and invite codes. The XRPC
admin surface (`com.atproto.admin.*`) stays HTTP-Basic-gated for
automation; both paths share the audit log (chapter 19).

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
├── docs/                          # tutorial chapters (00–23 + README index)
├── scripts/
│   ├── demo.sh                    # end-to-end smoke test
│   ├── admin-hash.ts              # scrypt password hasher
│   ├── pds-admin.ts               # CLI against the XRPC admin surface
│   ├── pds-export.ts              # CAR backup
│   ├── pds-import.ts              # restore from CAR
│   ├── pds-bench.ts               # micro-benchmark harness
│   └── pds-stress.ts              # concurrent-write stress test
├── drizzle/                       # 0000_init … 0011_admin_audit (12 migrations)
├── src/
│   ├── routes/                    # TanStack Start routes
│   │   ├── index.tsx              #   live stats dashboard
│   │   ├── docs/                  #   the chapter book
│   │   ├── app/                   #   minimal client UI (login, feed, compose)
│   │   ├── admin/                 #   handle-gated operator console
│   │   ├── oauth/                 #   par, authorize, token, revoke, jwks
│   │   ├── xrpc/                  #   lexicon-defined HTTP surface
│   │   ├── .well-known/           #   did.json + OAuth metadata
│   │   └── metrics.ts             #   Prometheus exposition
│   ├── pds/                       # the PDS itself
│   │   ├── codec/                 #   CIDs & DAG-CBOR
│   │   ├── repo/                  #   MST + commits + writes + sync
│   │   ├── car/                   #   CAR v1 encode/decode
│   │   ├── did/                   #   identity (PLC, web, handle, resolver)
│   │   ├── lexicon/               #   schema layer + runtime validator
│   │   ├── xrpc/                  #   dispatcher + per-NSID handlers + registry
│   │   ├── auth/                  #   JWTs, scrypt, sessions, middleware
│   │   ├── blob/                  #   blob storage (filesystem + S3 stub) + GC
│   │   ├── sequencer/             #   firehose event log writer
│   │   ├── account/               #   createAccount orchestrator + invites
│   │   ├── admin/                 #   admin audit log (DAG-CBOR params)
│   │   └── oauth/                 #   PAR, PKCE, DPoP, tokens, JWKS, metadata
│   ├── lib/
│   │   ├── db/                    #   schema barrel + factory + migrate runner
│   │   ├── admin-ui/              #   shared helpers for /admin (auth, csrf, render)
│   │   ├── client/                #   client-side bits shared by /app
│   │   ├── config.ts              #   env loader (PDS_PUBLIC_URL, ...)
│   │   ├── docs.ts                #   markdown → HTML pipeline
│   │   ├── logger.ts              #   structured logger (chapter 18)
│   │   ├── metrics.ts             #   Prometheus collectors
│   │   ├── shutdown.ts            #   graceful-shutdown coordinator
│   │   ├── stats.ts               #   homepage/dashboard types + formatters
│   │   └── stats.server.ts        #     ↳ DB-touching half
│   ├── components/                # React (docs UI + shared atoms)
│   └── styles/
```

Each `src/pds/<subsystem>/README.md` points at the chapter that motivates
the subsystem and notes the contract surface.

## What this isn't

- A drop-in production PDS. Most of the operational pieces ship (KeyWrapper
  for at-rest signing keys, structured logging, `/metrics`, graceful
  shutdown, backups). Read [chapter 18](./docs/18-production.md) for the
  swap matrix that gets you the rest: managed Postgres, S3 blob backend,
  real PLC publishing, TLS termination, email provider.
- A faithful copy of every Bluesky lexicon. We bundle the ones we
  validate against; everything else is stored opaquely.
- A relay or an AppView. Those are separate services; chapter 17 explains
  the split.

## License

[MIT](./LICENSE) — use it as a study aid, vendor pieces into your own PDS,
fork it, whatever. Attribution appreciated but not required.
