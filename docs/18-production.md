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
| Email | Logged to console (`ConsoleEmailBackend`) | HTTP-JSON to Resend / Postmark / Mailgun / a self-hosted relay (`HttpJsonEmailBackend`) |
| Backups | None | `pnpm pds:export` on a schedule, ch. 23 |
| Observability | `console.log` | Structured logs, metrics, alerts |
| Rate limiting | None in dev | `InMemoryRateLimitStore` + Redis swap for multi-replica |
| DPoP replay | in-process LRU | `InMemoryDpopReplayStore` + Redis stub for multi-replica |

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

For the teaching port we punt on serving handles under our own domain:
dev handles use the `.test` TLD which won't DNS-resolve. But we do
implement **resolution of *other* people's handles** —
`com.atproto.identity.resolveHandle` falls through to
`src/pds/did/handle_resolver.ts`, which races a `_atproto.<handle>` DNS
TXT lookup and a `https://<handle>/.well-known/atproto-did` HTTPS fetch,
then does the bidirectional check against the resolved DID document's
`alsoKnownAs`. That means clients can ask this PDS to resolve any
handle on the network, not just the ones it hosts.

## PLC: directory or self-hosted

The PDS in dev mode runs `PDS_LOCAL_PLC=true` and never talks to
plc.directory. To federate, you have to flip that:

```bash
PDS_LOCAL_PLC=false
```

The handful of places that need wiring, all of which now ship:

1. **Genesis publishing.** `src/pds/account/create.ts` (the fresh-account
   branch) calls `publishPlcOp` between `persistGenesisPlc` and the
   firehose emit. The op was signed earlier; we POST the JSON form of
   the *signed* op to `https://plc.directory/<did>`. The DID is the same
   hash either way (it's derived from the op's bytes), so existing local
   DIDs *can* be uploaded after the fact by re-publishing — but it's
   awkward; flip the flag *before* you create accounts you want
   federated. Migrating-in accounts deliberately skip publishing — the
   user's previous PDS already registered the DID, and the rotate op
   they brought authorises the swap.
2. **Handle-rotation publishing.** `rotatePlc` in `src/pds/did/plc.ts`
   calls `publishPlcOp` after appending the new op locally. plc.directory
   ingests the whole chain at the same `/<did>` endpoint.
3. **External DID resolution.** `src/pds/did/external_resolver.ts`
   exposes `resolveDid(did)` — it tries the local `accounts` table first
   (own DIDs short-circuit, no network call), then falls back to
   `https://plc.directory/<did>` for did:plc and
   `https://<host>/.well-known/did.json` for did:web. Results cache
   in-process for 5 minutes; misses negative-cache for 30 seconds so a
   flood of bad requests doesn't hammer the directory. Most XRPC
   handlers still call `resolveLocalDid` because they're only ever
   resolving their own accounts — cross-PDS resolution lands when the
   sync endpoints need it.
4. **Account migration** (chapter 20) needs the same rotation-key path
   to work end-to-end against plc.directory. If you stayed in local-PLC
   mode while testing migration, the rotation keys exist but nobody else
   can verify them.

> ⚠️ **Publishing is best-effort with one retry.** `publishPlcOp` retries
> once on network errors / 5xx with a 250 ms backoff, treats 409 as
> idempotent success, and surfaces 400 as a hard failure. For
> high-volume production, wrap account creation in a job queue so a
> directory outage doesn't break signups — the signed op is already
> durable in `plc_operations`, so a background worker can replay
> unpublished ops by re-decoding the bytes.

> 📖 **Running your own PLC mirror** is a serious commitment — the
> directory's job is to be a globally trusted append-only log, which
> means hosting all DID operations forever and serving them with high
> availability. Most self-hosters use plc.directory and trust Bluesky to
> run it. If you want independence, mirror the directory's data locally
> and serve from there; coordinate with the broader ecosystem.

### Overriding the directory URL

`PDS_PLC_DIRECTORY_URL` overrides the default `https://plc.directory`.
Useful for two scenarios:

1. **Pointing at a self-hosted PLC mirror.** Set it to your mirror's
   public URL once you've mirrored the directory's data and replicated
   the API surface.
2. **Testing the publish path end-to-end.** The CI suite runs
   `tests/integration/plc-directory.test.ts` against a tiny
   `http.createServer` mock that follows the directory's contract:
   POSTs to `/<did>` get a 200, and the test verifies the wire body
   includes the right `type`, `sig`, `verificationMethods`,
   `rotationKeys`, and `services.atproto_pds.endpoint`. The same test
   exercises the retry-on-5xx path, the 409-as-idempotent-success
   path, and the 400-surfaces-as-InvalidRequest path. That coverage
   means our publish wiring stays correct without depending on real
   plc.directory network access in CI.

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

Two things need to survive a complete loss of disk: the Postgres rows
and the blob bytes. The PDS ships two scripts for this — `pnpm pds:export`
dumps both into a portable directory, `pnpm pds:import` restores from
one. [Chapter 23](./23-backups.md) walks the format, the safety rails
(schema-hash gate, empty-target gate), the topological FK order the
import follows, and a suggested production cadence.

Pair the export with whatever your Postgres provider gives you (PITR,
WAL archive, point-in-time snapshots). The script is for portability
and disaster recovery; provider-native backups are for the
fifteen-minute-RPO case. Both are cheap; running them in parallel is
the cheapest insurance you'll buy this year.

## Observability

Three pieces ship in-process: a structured logger, an in-memory metrics
registry with a Prometheus `/metrics` endpoint, and a SIGTERM-driven
graceful-shutdown coordinator. None of them brings a new dependency —
stdout, stderr, and Node's signal handlers are the runtime primitives.

### Logger (`src/lib/logger.ts`)

One JSON object per line. The shape is

```json
{"time":"2026-06-01T15:42:11.103Z","level":"info","component":"xrpc",
 "nsid":"com.atproto.repo.createRecord","method":"POST","status":200,
 "durationMs":42.7,"msg":"xrpc-request"}
```

Levels are hierarchical (`trace < debug < info < warn < error < fatal`).
The minimum level is controlled by `PDS_LOG_LEVEL` (default `info`).
`warn` and above go to stderr; `info` and below go to stdout — so a log
shipper that splits streams (k8s log driver, journald, systemd) can
pre-filter without re-parsing.

If a log field's value is an `Error`, the logger hoists it onto `err`
with `name`, `message`, and `stack`. That keeps stack traces greppable
without flooding every line with stringified errors.

For local development, pretty mode (`PDS_LOG_PRETTY=true`, default-on
when `NODE_ENV !== 'production'`) swaps the JSON for a coloured single
line. In prod the env var is off and you get raw JSON — what every log
aggregator expects.

Child loggers carry parent fields. The dispatcher does

```ts
const reqLog = getLogger('xrpc').with({ nsid, method, did })
reqLog.info('xrpc-request', { status, durationMs })
```

so the call site stays a single line and downstream code never has to
re-thread context.

> No log-file rotation: stdout is the only sink. Whatever runs the
> process — `logrotate`, journald, the k8s log driver, ECS, your
> systemd unit — is responsible for retention.

### Metrics (`src/lib/metrics.ts` and `GET /metrics`)

In-process counters and histograms. Five collectors are pre-defined and
imported by the rest of the code:

| Metric | Type | Labels | Where it ticks |
| --- | --- | --- | --- |
| `pds_xrpc_requests_total` | counter | `nsid`, `method`, `status` | XRPC dispatcher (every response) |
| `pds_xrpc_request_duration_seconds` | histogram | `nsid`, `method` | XRPC dispatcher (every response) |
| `pds_firehose_events_total` | counter | `event_type` (commit / identity / account / tombstone) | `sequence.ts` after each successful write |
| `pds_blob_upload_bytes_total` | counter | — | `uploadBlob` (bytes accepted, including dedup hits) |
| `pds_blobs_total` | counter | — | `uploadBlob` (only on fresh insert; monotonic — GC sweeps are *not* decremented, query the `blobs` table for the true count) |

Custom metrics are a one-liner: `counter('my_metric', 'help', ['a','b'])`
or `histogram('my_metric', 'help', ['k'], DEFAULT_HTTP_BUCKETS)`. Both
auto-register so `renderProm()` picks them up.

The `/metrics` endpoint serves the Prometheus text exposition
(`Content-Type: text/plain; version=0.0.4`). It's off by default — scrape
endpoints can leak request volumes and label cardinalities to anyone who
can reach them, so opt in deliberately:

```bash
PDS_METRICS=true pnpm start
```

When disabled, GET /metrics returns 404 (not 403 — we don't want to
confirm the endpoint exists). When enabled, **wrap it behind a reverse
proxy ACL**: allow only your scraper's IP, or require a Bearer token at
the proxy layer. The teaching port intentionally omits in-process auth
because every realistic deployment fronts the PDS with Caddy / nginx /
an LB anyway and that's the right authority for scrape ACLs.

### Graceful shutdown (`src/lib/shutdown.ts`)

Subsystems register teardowns with `onShutdown(name, fn)`. On SIGTERM /
SIGINT the coordinator runs them in parallel, each in its own
`try/catch`, then calls `process.exit(0)`. Today's registrations:

- **firehose-ws**: close every live `subscribeRepos` WebSocket with code
  1001 (going away), then shut the listener.
- **db**: flush the postgres-js pool (or `client.close()` for pglite).

In **production** (`pnpm start`), the Node entry point owns the signals
and the coordinator runs normally — a rolling deploy can drain a
process before terminating it.

In **dev** (`pnpm dev`), Vite's own dev server owns SIGINT and tears
down its module graph synchronously, which short-circuits our handler.
That's by design: Vite needs to release its watchers, reload state, and
hand control back to the shell quickly enough for a developer's Ctrl-C
to feel snappy. Don't try to fix it — the production path is what
matters for graceful drain.

### Alerts to set

Page on:

- 5xx rate > 1% for 5 minutes
  (`sum(rate(pds_xrpc_requests_total{status=~"5.."}[5m])) /
   sum(rate(pds_xrpc_requests_total[5m]))`)
- p99 request duration above the bucket cap (10s) for 5 minutes
- DB pool saturation > 80% for 5 minutes
- disk space < 20%
- firehose lag > 10 seconds (means consumers are getting stale data)
- backup failure

### Not yet wired

- **OpenTelemetry tracing.** The natural next step is span propagation
  through the dispatcher → orchestrator → DB call chain. Out of scope
  here; the chapter on distributed systems will pick it up.

## Rate limiting

The XRPC dispatcher consults `rateLimitFor(nsid, method)` after lexicon
validation and before invoking the handler. A non-null result is then
checked against a process-wide store; a rejection short-circuits the
request with `429 RateLimitExceeded` and a `Retry-After: <seconds>`
header.

The defaults sit in a hardcoded table in `src/pds/xrpc/rate_limit.ts`,
roughly mirroring what the upstream PDS does today:

| NSID family | Capacity | Window |
| --- | --- | --- |
| `com.atproto.server.createAccount` | 100 | 1 day |
| `com.atproto.server.createSession` | 30 | 5 min |
| `com.atproto.server.refreshSession` | 50 | 5 min |
| `com.atproto.server.requestPasswordReset` | 5 | 5 min |
| `com.atproto.server.resetPassword` | 5 | 5 min |
| `com.atproto.server.requestEmailConfirmation` | 5 | 5 min |
| `com.atproto.server.requestEmailUpdate` | 5 | 5 min |
| `com.atproto.server.requestAccountDelete` | 5 | 5 min |
| `com.atproto.identity.updateHandle` | 10 | 5 min |
| `com.atproto.identity.requestPlcOperationSignature` | 5 | 5 min |
| `com.atproto.repo.uploadBlob` | 5000 | 1 hour |
| `com.atproto.repo.createRecord` / `putRecord` / `deleteRecord` / `applyWrites` | 7000 | 1 hour |
| everything else | — | no limit |

The key is `${ip}:${nsid}`. Bucketing on the IP alone would punish
shared NAT egress, and on the account alone would punish power users
who legitimately drive a lot of write traffic from one IP. Per-IP +
per-NSID is the middle ground: a credential-stuffing campaign against
`createSession` from one origin trips the 30-per-5-minute cap without
affecting that origin's record writes; a chatty cron writing records
doesn't accidentally lock its operator out of the password-reset flow.

### The store

The default is `InMemoryRateLimitStore`, a token bucket in a `Map<key,
Bucket>`. One process, one map, no network round-trip. If you run more
than one PDS process behind a load balancer each instance sees ~half
the per-IP traffic and the effective cap doubles — sometimes that's
fine, sometimes it isn't. For shared limits, swap in a Redis-backed
store. The teaching port ships `RedisRateLimitStore` as a documented
stub (we don't pull in `ioredis` for the same "no new deps" reason
the email backend skips `nodemailer`). The Lua sketch in the source
comment shows the SETEX+DECR pattern:

```lua
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SETEX', KEYS[1], ARGV[2], ARGV[1] - 1)
  return ARGV[1] - 1
end
if tonumber(current) <= 0 then
  return -redis.call('PTTL', KEYS[1])
end
redis.call('DECR', KEYS[1])
return current - 1
```

SETEX seeds the bucket with `capacity - 1` and sets the window TTL in
one round trip; DECR is atomic; PTTL on the empty path tells the
client exactly when the window resets, which is what we surface as
`Retry-After`.

### Client IP derivation

`callerIpFromRequest` prefers the first non-private hop of
`X-Forwarded-For`, then `X-Real-IP`, then falls back to the literal
string `'unknown'`. If the fallback fires in a non-localhost
deployment, every anonymous caller collapses into one bucket — fine
for a single developer hitting `http://localhost:3000`, very wrong
for production. The limiter logs a one-shot warning the first time it
hits the `'unknown'` path per process, on the assumption that a
misconfigured reverse proxy is the only realistic explanation.

The PDS doesn't validate that XFF came from a trusted hop. That's
deliberate: every realistic deployment fronts the PDS with Caddy /
nginx / a cloud LB that strips client-supplied XFF and re-sets a
trusted chain, and that's the right authority for trust decisions.

### Operator overrides

The policy table is hardcoded today. Plumbing it through env vars is
a follow-up — the natural shape is `PDS_RATE_LIMIT_<NSID_UNDERSCORE>`
plus a `PDS_RATE_LIMITS_DISABLED=true` master switch for local
debugging.

### Behaviour clients should implement

A 429 response carries a `Retry-After: <seconds>` header. Well-behaved
clients honour it: they back off for at least that long, then retry
with exponential jitter on top. Clients that hammer back immediately
turn a transient cap into a sustained one, because every premature
retry consumes the next refilled token the moment it arrives.

The rate-limit metric, `pds_rate_limit_rejected_total{nsid}`, is the
right signal to alert on. A non-zero sustained rate against an NSID
that's normally idle (e.g. `createSession`, `requestPasswordReset`)
almost always indicates an active credential-stuffing or
account-enumeration run.

## Benchmarking + load testing

Two scripts ship for sanity-checking performance, both running against the
same orchestrators the XRPC handlers wrap — no HTTP, no JSON parsing, no
auth middleware. They measure the work itself, not the dispatcher.

**`pnpm bench`** is a microbenchmark over four hot paths: `createAccount`,
`applyWrites` (single record), `listRecords` (one 50-row page), and
`getRepo` (full CAR export). Each runs N times (default 100) and the
script prints median, p99, min, and max in milliseconds. Use it
**before/after a perf-sensitive PR** — if you touched the MST, the commit
signer, or the records index, run it locally on `main` first, then on
your branch, and compare. Roll a fresh baseline at every release tag so
regressions are visible against a stable reference rather than against
whatever was on `main` last week.

**`pnpm stress`** drives N accounts × M posts (defaults: 100 × 10)
sequentially through `createAccount` + `applyWrites`. It prints total
elapsed, account- and post-creates per second, and the on-disk DB size
(via `pg_database_size(current_database())`, falling back to a recursive
directory stat). Use it for **capacity planning**: it surfaces
sequence-table back-pressure, MST node bloat, blockstore write
amplification, and — once you point it at a real Postgres via
`DATABASE_URL` — connection pool starvation and the difference between
the in-process driver path and one that goes over a socket.

What neither tells you: anything about a real deployment. Production
adds network round-trips between the client and the PDS, real disk
latency (the bench's tmpfs is unrepresentative), real concurrency
(neither script forks; the PDS itself serialises writes per repo today),
real auth contention (every request goes through password verify on the
first hit, JWT verify thereafter), and real plc.directory latency
(both scripts force `PDS_LOCAL_PLC=true`).

Both default to PGlite. For numbers that reflect what your operator
hardware will do, set `DATABASE_URL` to a hosted Postgres and re-run:

```bash
DATABASE_URL=postgres://... pnpm bench --iterations 200
DATABASE_URL=postgres://... pnpm stress --accounts 1000 --posts-per-account 50
```

If the hosted Postgres run is *slower* than PGlite for tiny benches,
that's expected — the network round-trip per query swamps the work. The
gap inverts at scale, where Postgres's buffer cache and parallelism
matter and PGlite's single-threaded WASM ceiling is the bottleneck.

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

## The production Node entry

In development, `pnpm dev` runs Vite, and Vite owns the HTTP server — it
dispatches every request through the TanStack Start middleware stack
and bolts the firehose WebSocket onto its own dev-server `upgrade`
event (see `src/pds/sequencer/firehose-mount.ts`). In production,
neither Vite nor the dev plugin is running. We need our own Node
process, which is what `server.ts` at the repo root is.

`pnpm build` does two things:

1. `vite build` — emits the SSR fetch handler at `dist/server/server.js`
   and the hashed client bundle under `dist/client/`. Per the TanStack
   Start hosting docs, the SSR bundle is *not* a runnable Node entry —
   it's a `{ fetch(request) → Response }` object you wrap in something
   that owns the Node http.Server.
2. `pnpm build:server` — runs esbuild on `server.ts` and inlines every
   `./src/*` TypeScript import into a single `dist/start.mjs`. npm
   packages stay external (loaded from `node_modules/` at runtime), so
   the bundle is small (~36 KB) and dependencies remain
   distro-installable.

`pnpm start` is then plain `node dist/start.mjs`. No `tsx`, no
`--experimental-strip-types`, no source files needed at runtime beyond
the dist tree and `node_modules/`.

### What `server.ts` composes

```
                     ┌─────────────────────┐
                     │   server.ts         │
                     │   (esbuild → mjs)   │
                     └─────────────────────┘
                              │
                     ┌────────┴────────┐
                     │                 │
              ┌──────▼──────┐   ┌──────▼───────────┐
              │  srvx       │   │  ws (firehose    │
              │  fetch +    │   │  upgrade handler)│
              │  static     │   └──────────────────┘
              └──────┬──────┘
                     │
        ┌────────────┴─────────────┐
        ▼                          ▼
   dist/client/*           dist/server/server.js
   (static, cached)        (.fetch handler)
```

- [`srvx`](https://srvx.h3.dev) is unjs's tiny Fetch→Node adapter. We
  hand it our composite `fetch(req)` and a hostname/port; it gives back
  an object that exposes the underlying `http.Server`. The fetch
  composite first tries to satisfy the request from `dist/client/` (with
  `Cache-Control: public, max-age=31536000, immutable` on `/_build/*`
  hashed assets) and falls through to the Vite-emitted SSR handler for
  everything else.
- The `ws` WebSocketServer attaches to the underlying Node server's
  `upgrade` event with the same `/xrpc/com.atproto.sync.subscribeRepos`
  path-match the dev plugin uses — `streamFirehose()` from chapter 16
  is the same in both worlds.
- The `onShutdown` coordinator from `src/lib/shutdown.ts` gets three
  registrations: drain the WS pool, close the DB pool, stop the HTTP
  listener. SIGTERM from systemd / Docker / Kubernetes flows through
  cleanly and the process exits 0 once every handler returns.

### CI catches the dev/prod gap

`scripts/ci-prod-smoke.sh` runs the full build, starts `dist/start.mjs`
against a fresh PGlite, and asserts seven canonical endpoints serve
200. The script exists because the unit tests run against the source
tree (Vitest, Vite) and don't notice when a bundle-time gap breaks the
prod artifact — like when `loadBundledLexicons()` was doing a runtime
`fs.readdir` against a source-only path, or when the `.well-known/`
directory was being silently dropped by the file-routing scanner.
Every failed assertion in that script corresponds to a class of bug
the test suite *can't* catch by definition; if you add another
subsystem with a build-time gotcha, add it to `SMOKE_PATHS`.

CI runs the smoke after `typecheck` + `test`. The runner uses Node 24
to match production.

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
- [ ] Postgres backups configured (`pnpm pds:export` cron + provider
      WAL archive; see [chapter 23](./23-backups.md)) and quarterly
      restore drill on the calendar
- [ ] S3 lifecycle + replication configured
- [ ] Logs + metrics + alerts flowing
- [ ] An email-verification flow exists (even if minimal)
- [ ] **Relay registration** — `curl -X POST
      https://bsky.network/xrpc/com.atproto.sync.requestCrawl
      -H 'content-type: application/json'
      -d '{"hostname":"<your-pds-host>"}'` returns 200. Without this,
      `bsky.network` won't subscribe to your firehose and posts your
      users make won't ever appear in `bsky.app`'s timeline — even
      though they're persisted in your repos and federated correctly
      otherwise. `scripts/deploy.sh` runs this for you on first deploy;
      re-running is idempotent. Chapter 17 explains the role of the
      Relay in detail.

When that's all green, register your first account, sign in from a
Bluesky-compatible client, and watch the bytes flow.

## Where to go from here

The teaching book ends here, but the protocol keeps moving. A few threads
this implementation deliberately left untouched:

- **OAuth.** The protocol is migrating from password-based sessions to a
  full OAuth flow. The shape is in
  [the OAuth spec](https://atproto.com/specs/oauth);
  [chapter 21](./21-oauth.md) implements the back half (metadata, JWKS,
  token endpoint, revocation, DPoP). The browser-facing pieces
  (`/oauth/authorize`, `/oauth/par`, consent UI, client metadata
  validation, PKCE) are deferred to a follow-on session, with stubs in
  place and gaps flagged in the chapter itself.
- **Account migration.** The cross-PDS handoff that lets a user pick up
  their DID and repo and move hosts. Implemented in
  [chapter 20](./20-migration.md) — the four new endpoints, the schema
  changes, and the gaps still open (notably `createAccount` accepting a
  pre-existing DID).
- **App passwords.** Headless clients (CLIs, bots, archival scripts)
  authenticate with credentials separate from the main password, with
  scope restrictions. The schema column exists; the flow doesn't yet.
- **Moderation.** Takedowns, label propagation, the moderation log.
  Label-and-hide rules are an AppView concern, but the operator-facing
  surface for managing accounts on *your* PDS — takedowns, force-renames,
  out-of-band emails, deletions — lives in
  [chapter 19](./19-moderation.md).

The codebase is small enough that any of these is a tractable addition.
Skim, pick one, and add it.

← [17 — PDS vs AppView vs Relay](./17-pds-appview-relay.md) ·
[19 — Moderation](./19-moderation.md) ·
[Table of contents](./README.md)
