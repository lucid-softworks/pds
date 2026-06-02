# Running in production

You've reached the end of the book with a working PDS. It signs commits,
stores records, serves them, issues sessions, accepts uploads. Locally,
it runs entirely in one process — PGlite, the filesystem blob store,
synthetic local-only PLC operations, no external services to deploy.

This chapter is about going from there to a self-hosted PDS that other
people can actually use. The protocol part is portable; the *operations*
part is where you make production-vs-development choices deliberately.

## What changes when you turn the deployment knob

A handful of dev-mode shortcuts that worked great for learning have to be
swapped for production equivalents:

| Subsystem | Dev shortcut | Production swap |
| --- | --- | --- |
| Database | PGlite (WASM) | Hosted Postgres (Neon, Supabase, RDS, Crunchy, self-managed) |
| PLC | Local-only synthetic DIDs | Real plc.directory (or a self-hosted PLC mirror) |
| Blob storage | Filesystem in `./.blobs/` | S3-compatible object storage |
| TLS | None (HTTP on :3000) | Terminating proxy or cloud LB |
| Handle wildcards | `alice.test` | `*.<your-domain>` with DNS + TLS cert |
| Signing keys | Plaintext hex in `accounts.signing_key_priv` | KMS-wrapped or age-encrypted |
| Email | Logged to console | Transactional provider |
| Backups | None | Daily Postgres dumps + S3 versioning |
| Observability | `console.log` | Structured logs, metrics, alerts |

We'll take each in turn.

## Postgres

Pick one. The PDS doesn't care about the provider — anything that speaks
the Postgres wire protocol and supports `BYTEA`, `bigserial`, and `JSON`
columns works.

Sizing rules of thumb:

- **Connection limits.** The PDS uses up to 10 concurrent connections per
  process by default (see `postgres-js` config in `src/lib/db/index.ts`).
  Multiply by your process count. Most managed Postgres providers cap
  connections far below what direct connections need at scale — use a
  pooler (PgBouncer in transaction mode, or Neon's built-in pooler) and
  reduce the per-process pool size accordingly.
- **Storage.** Repo blocks dominate. A Bluesky-shaped active account is
  ~500 KB of MST + ~1–5 MB of post records over a year. Plan ~10 MB per
  active account per year as a conservative starting point.
- **WAL retention.** Keep the WAL window wide enough that you can rebuild
  a replica from a base backup + WAL replay if Postgres goes down.

Migrations:

```bash
DATABASE_URL=postgres://... pnpm db:migrate
```

The same `drizzle/*.sql` files run against PGlite in dev and your hosted
Postgres in prod. The `__migrations` journal table tracks applied files
so re-running is safe.

> ⚠️ **Don't expose `pgvector` or other extensions** unless you've audited
> them. PDS doesn't use them, so install nothing you don't understand.

## TLS

The AT Protocol does not work over plain HTTP for production. Every
client expects HTTPS. Three reasonable setups:

1. **Cloud load balancer.** AWS ALB, Google Cloud Load Balancing, Cloudflare
   in front of the PDS — terminates TLS, forwards HTTP to the PDS over a
   private network. Simplest at scale.
2. **Caddy or nginx in front.** A single VM running Caddy with automatic
   Let's Encrypt is the smallest-setup option. The PDS listens on
   `127.0.0.1:3000`; Caddy listens on `:443`.
3. **Direct from the app.** Possible (Bun and Deno make TLS-from-the-app
   easy; Node needs more config) but you give up the operational
   ergonomics of a separate proxy.

Whichever you pick: ensure the public URL the PDS knows about
(`PDS_PUBLIC_URL`) matches what clients connect to, including the protocol.

## Handle wildcards

If your PDS issues handles like `alice.yourdomain.com`, the resolver step
(`https://alice.yourdomain.com/.well-known/atproto-did`) needs to reach
the PDS. Two options:

1. **Wildcard DNS + wildcard TLS.** Point `*.yourdomain.com` at the PDS's
   IP, issue a wildcard certificate (Let's Encrypt supports it via DNS-01
   challenges). The PDS reads the `Host` header to figure out which
   handle is being asked about and responds.
2. **`_atproto` DNS TXT records.** For users who own their own domain,
   skip the wildcard entirely and let them publish
   `_atproto.theirdomain.com TXT "did=did:plc:..."`. The PDS doesn't need
   to be reachable on `theirdomain.com`. This is how high-end accounts
   typically work (`pfrazee.com`, `bsky.app` itself, etc.).

For the teaching port we punt: handles use reserved TLDs like `.test` that
won't ever DNS-resolve. Real production picks one of the above.

## PLC: directory or self-hosted

The PDS in dev mode runs `PDS_LOCAL_PLC=true` and never talks to
plc.directory. To federate, you have to flip that:

```bash
PDS_LOCAL_PLC=false
```

The handful of places that need wiring:

1. **`createLocalPlc` in `src/pds/did/plc.ts`** publishes the signed op
   to `https://plc.directory/<did>` via POST. The DID is the same hash
   either way (it's derived from the op's bytes), so existing local DIDs
   *can* be uploaded after the fact, but it's awkward; better to flip
   the flag *before* you create any accounts you want federated.
2. **DID resolution** in `src/pds/did/resolver.ts` for *external* DIDs
   currently only looks at the local `accounts` table. Add a fallback
   that fetches `https://plc.directory/<did>` for did:plc and
   `https://<host>/.well-known/did.json` for did:web. Cache aggressively
   (TTLs of 5–60 minutes are standard; the document changes rarely).
3. **Account migration** (`com.atproto.server.requestAccountMigrate` —
   we haven't implemented it) needs to rotate the PLC op via the user's
   rotation key. If you stayed in local-PLC mode, those rotation keys
   exist but nobody else can verify them.

> 📖 **Running your own PLC mirror** is a serious commitment — the
> directory's job is to be a globally trusted append-only log, which
> means hosting all DID operations forever and serving them with high
> availability. Most self-hosters use plc.directory and trust Bluesky to
> run it. If you want independence, mirror the directory's data locally
> and serve from there; coordinate with the broader ecosystem.

## Blob storage

`BLOB_STORE=s3` (when implemented) plus standard AWS env vars and a
bucket name. The bucket layout in `src/pds/blob/store.ts` is:

```
<bucket>/<creator-did>/<cid>.bin
```

Bucket configuration:

- **Lifecycle policy** to delete keys older than 30 days that don't have a
  matching reference in `record_blobs` (run the PDS's GC alongside this
  as a belt-and-suspenders approach).
- **CORS** allowing GETs from your AppView origins, if you let clients
  fetch blobs directly from the bucket (not the default — `getBlob` is
  PDS-mediated).
- **Versioning** off (we don't overwrite blobs; content addressing makes
  versions meaningless).
- **Encryption at rest** on (SSE-S3 or SSE-KMS — both transparent to
  the PDS).

## Signing keys

`accounts.signing_key_priv` and `accounts.rotation_key_priv` are hex
strings in plain Postgres rows. In production:

- **KMS-wrap.** Encrypt the private scalar at write time using a KMS key
  (AWS KMS, Google Cloud KMS, HashiCorp Vault). Store the ciphertext in
  the column. Decrypt on demand when signing. The KMS audit log gives
  you a record of every signature attempt.
- **age-encrypted column.** Lighter weight: a single age recipient holds
  the unwrap key, decrypts on PDS startup, keeps the plaintext keys in
  process memory. Simpler than KMS, but loses the per-signature audit
  trail.

The teaching port's signing keys are deliberately readable so you can
inspect them, run `verifyCommit` by hand, etc. Don't ship that bit.

## The firehose connection budget

When the WebSocket firehose lands (a later session), every connected
consumer is a long-running socket. Each holds onto:

- A cursor (a single integer).
- A bounded outgoing buffer (we'll cap it at ~10 MB to bound memory).
- A goroutine-equivalent in the Node event loop.

Modern Node handles ~10k concurrent WebSockets per process without
sweating. Beyond that, scale horizontally — every consumer pulls from
the same `repo_seq` table, so multiple PDS processes can each serve
firehose subscribers independently. The `LISTEN/NOTIFY` channel coalesces
new-event notifications cheaply.

A reasonable production limit: 1000 concurrent firehose consumers per
process; alarm at 800; cap subscriber count or scale out at 1000.

## Backups

Two things need to survive a complete loss of disk:

1. **Postgres.** Daily logical backup (`pg_dump`) plus continuous WAL
   archive. Restore drill quarterly. Most managed Postgres providers
   automate this; if you're self-hosting, `barman` or `pgBackRest` is
   the standard.
2. **The blob bucket.** `aws s3 sync` to a second bucket in a different
   region weekly, or rely on S3's cross-region replication. The blobs
   are content-addressed so partial restores work — a missing blob just
   means `getBlob` returns 404 for that one CID; the rest of the system
   keeps working.

You **do not** need to back up `repo_blocks`. The blocks are
reconstructible from the MST given any commit, *and* they're already in
Postgres backed up above. Restoring is just bringing Postgres back.

## Observability

Three categories worth instrumenting:

**Logs**: structured JSON, one line per request, including the NSID, the
account DID, the response status, the duration. Skip the request body
unless you're debugging — it might contain blob bytes.

**Metrics**: at minimum,

- request count + duration histogram, labeled by NSID and status code
- DB pool wait time
- blob upload bytes
- firehose connection count
- `repo_seq` lag (now() − latest sequencedAt) — should always be sub-second

**Alerts**: page on

- 5xx rate > 1% for 5 minutes
- DB pool saturation > 80% for 5 minutes
- disk space < 20%
- firehose lag > 10 seconds (means consumers are getting stale data)
- backup failure

## Email

`createAccount` currently doesn't send a verification email. Production
should require it. Two reasonable approaches:

1. **Transactional provider** (Postmark, SendGrid, Resend) — POST a
   templated email at signup, store the verification token in a
   `email_tokens` table, expose `com.atproto.server.confirmEmail`.
2. **AWS SES + a simple template.** Cheaper at scale, more setup.

Either way: don't send the verification email synchronously from
`createAccount`'s critical path. Queue it (or fire-and-forget with
retries) so a slow email provider doesn't make signup feel slow.

## The deploy itself

A representative production layout:

```
┌────────────────────────────┐
│   Caddy (TLS + handle)     │
│   :443                     │
└─────────────┬──────────────┘
              │
   ┌──────────▼──────────┐
   │   PDS (Node)        │
   │   :3000 internal    │
   │   N processes       │
   └─┬──────────┬──────┬─┘
     │          │      │
     ▼          ▼      ▼
  Postgres   S3-      plc.directory
             bucket
```

Three external dependencies (Postgres, S3, plc.directory) plus the
fronting proxy. The PDS itself is stateless — kill any process at any
time, all state survives in the dependencies.

For zero-downtime deploys: rolling restart, draining each process for
~30 seconds (long enough for in-flight requests to complete; the
firehose drops to other processes on disconnect).

## A short pre-launch checklist

- [ ] `pnpm db:migrate` ran against prod Postgres
- [ ] `PDS_JWT_SECRET` is unique and stored in your secret manager, not
      in git
- [ ] `PDS_PUBLIC_URL` matches the public hostname exactly
- [ ] `PDS_LOCAL_PLC=false`
- [ ] Signing-key encryption is in place (KMS or age)
- [ ] TLS cert is issued and renewing
- [ ] `https://<host>/.well-known/did.json` returns the service DID doc
- [ ] `curl -sI https://<host>/xrpc/com.atproto.server.describeServer`
      returns 200
- [ ] Postgres backups configured + restore drill scheduled
- [ ] S3 lifecycle + replication configured
- [ ] Logs + metrics + alerts flowing
- [ ] An email-verification flow exists (even if minimal)

When that's all green, register your first account, sign in from a
Bluesky-compatible client, and watch the bytes flow.

## Where to go from here

The teaching book ends here, but the protocol keeps moving. A few threads
this implementation deliberately left untouched:

- **OAuth.** The protocol is migrating from password-based sessions to a
  full OAuth flow. The shape is in
  [the OAuth spec](https://atproto.com/specs/oauth); the implementation
  is a chapter of its own.
- **Account migration.** `requestAccountMigrate` plus the matching PLC op
  rotation lets a user move from one PDS to another without losing their
  identity. The pieces are in this codebase; the gluing-together is a
  future session.
- **App passwords.** Headless clients (CLIs, bots, archival scripts)
  authenticate with credentials separate from the main password, with
  scope restrictions. The schema column exists; the flow doesn't yet.
- **Moderation.** Takedowns, label propagation, the moderation log.
  Adjacent to the PDS rather than inside it, mostly handled by the
  AppView, but the PDS exposes the takedown status on `getRepoStatus`.

The codebase is small enough that any of these is a tractable addition.
Skim, pick one, and add it.

← [17 — PDS vs AppView vs Relay](./17-pds-appview-relay.md) ·
[Table of contents](./README.md)
