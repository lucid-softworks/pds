# Moderation

Chapter 18 ended the main book with a working production PDS and a list of
threads left dangling. This chapter picks up the one most operators reach
for first: the buttons that an admin presses when something has gone wrong.

A user's account is hosted on a PDS. Eventually somebody — the user, an
abuse complaint, a court order, a fat-fingered handle migration — asks the
operator to *do something* about that account. The protocol's answer is a
small XRPC surface, `com.atproto.admin.*`, that the PDS speaks to nobody
but its own operator. This chapter is that surface.

What ships here:

- `com.atproto.admin.getAccountInfo` — read one account.
- `com.atproto.admin.getAccountInfos` — bulk read.
- `com.atproto.admin.updateAccountStatus` — flip active / takendown /
  deactivated / deleted.
- `com.atproto.admin.updateAccountHandle` — force-rename.
- `com.atproto.admin.updateAccountEmail` — out-of-band email change.
- `com.atproto.admin.sendEmail` — operator-to-user message.
- `com.atproto.admin.deleteAccount` — admin-driven destroy.
- `com.atproto.admin.getAuditLog` — read back the audit trail (see below).
- `requireAdmin` in `src/pds/auth/middleware.ts` — HTTP Basic check.
- `scripts/admin-hash.ts` (`pnpm admin:hash`) — generate the password
  digest you store in env.
- `admin_audit` table + `withAdminAudit` wrapper in `src/pds/admin/audit.ts`
  — every mutation in the surface above leaves a row.

## What moderation IS, here

The first thing to be honest about is what a PDS *can* moderate. A PDS
owns user **state**: which accounts exist, whether they're active, what
handle they answer to, what email is on file. It doesn't own the social
graph. It doesn't run a hide-list. It doesn't decide that a particular
post is harmful — that's the AppView's job, layered on top of the
indexed firehose with its own label system.

So when we talk about "moderation on the PDS," we mean exactly four
levers:

1. **Status changes**. Active ⇄ takendown, active ⇄ deactivated, → deleted.
2. **Identity changes**. Force a new handle. Force a new email.
3. **Direct contact**. Email the user out-of-band.
4. **Visibility**. Read the account record for an audit.

Everything else — what the network *does* with a takendown account, what
gets indexed, what labels appear next to a post, who can see whose
follows — is downstream. We tell the firehose; downstream consumers
honor the signal or they don't. That's federation working as designed.

## Admin auth: HTTP Basic with a scrypt-hashed password

The admin surface deliberately does *not* use the regular JWT-issuance
flow. Three reasons:

- **Admin isn't an account.** There's no row in `accounts` for the
  operator. They don't have a DID, a repo, a handle, an email.
- **Admin sessions sitting in `refresh_tokens` is the wrong storage.**
  Refresh rows are rotated on every use; long-lived admin tooling would
  trip the rotation logic constantly.
- **The hot path is small.** A handful of admin requests per week, made
  from a shell session. We don't need stateless auth's throughput.

So `requireAdmin` (in `src/pds/auth/middleware.ts`) takes a
straightforward HTTP Basic header. The username is conventionally
`admin` and we ignore it. The password is compared against a stored
hash:

```ts
const ok = stored.startsWith('plain:')
  ? timingSafeEqualStr(password, stored.slice('plain:'.length))
  : await verifyPassword(password, stored)
```

Two env vars feed the hash:

- `PDS_ADMIN_PASSWORD_HASH` — a `scrypt:v1:...` digest produced once by
  `pnpm admin:hash`. **Recommended** for any deployment you can reach.
- `PDS_ADMIN_PASSWORD` — a plaintext fallback. The middleware prefixes
  it with `plain:` internally so the storage path is obviously dev-only.
  Useful for the local-curl flow, not for production.

Neither set means the admin surface is disabled. Every endpoint then
returns `403 AdminDisabled`. That is the default on a fresh clone, on
purpose: no operator credential = no operator surface.

Generating the hash is a one-liner:

```bash
pnpm admin:hash 'correct-horse-battery-staple-with-extras'
# → scrypt:v1:32768:8:1:abc...:def...
```

Paste the result into your secret manager / `.env` / orchestration system
and never write the plaintext down again.

## The web UI: `/admin` (handle-gated)

The Basic-auth flow above is the right shape for scripts, the CLI, and any
machine-to-machine ops. It's *not* a great fit for "I want to glance at
the signup table from my phone." For interactive use there's a small
web UI at `/admin`, gated by **handle**, not by the operator password.

Set the env knob:

```bash
PDS_ADMIN_HANDLE=alice.test
```

…and `/admin` is reachable. Leave it unset (the default) and the routes
404, so a misconfigured deploy doesn't accidentally expose the surface.

The flow:

1. Operator visits `/admin` (or any sub-route). If they're not logged in,
   they get a small form prompting for handle + password.
2. The form's POST handler calls the same `loginWithPassword` the XRPC
   `createSession` uses. App passwords work here too.
3. Before minting a session, the handler asserts the supplied handle
   equals `PDS_ADMIN_HANDLE`. The error on mismatch is generic ("invalid
   credentials") so a curious attacker can't probe which handle is
   admin.
4. On success, an HttpOnly+SameSite=Strict cookie carries a 1-hour JWT
   scoped to `admin-ui`. Every subsequent `/admin/*` request re-checks
   that the account's *current* handle still matches the env value —
   so if the admin rotates their handle via `updateHandle`, UI access
   revokes itself immediately, even before the JWT expires.

Pages today:

- **`/admin`** — dashboard. Same stats as the public `/` plus the five
  newest signups and the five newest invite codes.
- **`/admin/signups`** — every account, newest first, paginated by
  `createdAt` cursor. Shows handle, DID, email, status, email-confirmed
  marker, migration state.
- **`/admin/invites`** — list of every invite code + a form to mint a
  new one (`useCount`, optional `forAccount`) + per-row "disable"
  buttons.

POST mutations are protected by double-submit CSRF: a `pds_admin_csrf`
non-HttpOnly cookie + a matching hidden form field, compared
timing-safely. A cross-site form post can't read the cookie value, so it
can't forge the hidden field — even though the browser will still
attach the session cookie.

> ⚠️ **Two parallel admin paths.** The XRPC `com.atproto.admin.*`
> surface (HTTP Basic + `PDS_ADMIN_PASSWORD_HASH`) and the web UI
> (handle + `PDS_ADMIN_HANDLE`) coexist by design. The XRPC surface is
> for automation, audit logs, and tooling — it never needs a real
> account row. The web UI is for an operator who happens to *also* be a
> user of their own PDS, and it stays minimal: no moderation actions
> yet, just signup visibility + invite-code management. If you want
> takedown / activate / handle-rename through a UI, build them as
> CLI commands or extend the web UI in a follow-up.

> 📖 **Why handle, not DID?** The env var asks for a handle because
> that's the identity the operator types when logging in. The session
> cookie does carry the DID internally; the handle-equality check on
> every request is just the policy gate.

## The state machine

`accounts.status` is the single source of truth. Four states, with these
transitions:

```
        ┌─────────┐         ┌──────────────┐
        │ active  │ ◄────► │  takendown   │
        └────┬────┘         └──────────────┘
             │      ▲
             ▼      │
        ┌──────────────┐
        │ deactivated  │
        └──────┬───────┘
               │
               ▼
        ┌──────────┐
        │ deleted  │   ← terminal
        └──────────┘
```

The reversible transitions (active ↔ takendown, active ↔ deactivated)
correspond to "user can sign in" toggling on and off. The terminal one
(→ deleted) emits a `#tombstone` event; downstream consumers drop their
state for the DID. Nothing un-tombstones an account once tombstoned.

`updateAccountStatus` enforces this. If the account is already
`deleted`, it 403s with `InvalidAccountState`. If the target status
matches the current one, it's a no-op rather than an error (idempotent —
admins retry too).

Every status change emits one firehose event:

- `active` → `#account { active: true }`
- otherwise → `#account { active: false, status: <new> }`
- `deleted` additionally → `#tombstone`

That's the same wire shape the user-side `deactivate`/`activate`/`delete`
flows emit. From the federation side, an admin takedown is
indistinguishable from a user-initiated deactivation; both are just
"this DID went quiet."

## getAccountInfo / getAccountInfos

Read one or many. The minimum useful payload:

```ts
{
  did: string
  handle: string
  email: string
  emailConfirmedAt?: string
  indexedAt: string  // = accounts.created_at
  status: string
}
```

The upstream lexicon adds `relatedRecords` (recent records the account
posted) and a `repo` summary (root CID, rev, active). We leave those out
for the teaching surface — both are derivable from existing endpoints
(`com.atproto.sync.getLatestCommit`, `com.atproto.repo.listRecords`) and
including them here would duplicate that work.

`getAccountInfos` takes repeated `?dids=` query params. The XRPC
dispatcher folds repeated keys into the last value when it builds the
`params` object, so the handler reaches into `request.url`:

```ts
const dids = new URL(request.url).searchParams.getAll('dids')
```

That pattern only appears in this handler today; if a third endpoint
needs it we'll factor it into the dispatcher.

## updateAccountHandle

Validates handle syntax via the shared `assertValidHandle` (chapter 04).
Checks availability — the `accounts_handle_idx` unique index makes that
free; we just translate the `23505` Postgres error code into a
`HandleNotAvailable` 409. Then swaps the row and emits `#identity`:

```ts
await emitIdentity({ did, handle })
```

> ⚠️ **Divergence from upstream.** A real PDS *also* rotates the user's
> PLC operation so the DID document reflects the new handle. We don't,
> for two reasons. First, rotation logic is being implemented in a
> separate session and isn't on `main` yet. Second, including it here
> would mean an admin operation has to read the user's rotation key,
> which has its own access-control story this chapter isn't ready to
> open up. The follow-up that combines admin rename + PLC rotation will
> land alongside the rotation work.

Until then: the firehose `#identity` event tells consumers the new handle
exists; the DID document still claims the old one until the rotation
catches up. That's wrong, and the chapter calling it out is the fix
until the code does.

## updateAccountEmail

Resolves `account` (DID *or* handle, via `findAccountByIdentifier` from
the session module — same lookup the login flow uses), then:

```ts
await db
  .update(accounts)
  .set({ email: parsed.data.email, emailConfirmedAt: null })
  .where(eq(accounts.did, target.did))
```

Clearing `emailConfirmedAt` is intentional. An admin can set the
address, but they can't *vouch* for it; the user still has to confirm
through `com.atproto.server.confirmEmail` before any flow that requires
confirmation (password reset, account delete) will use it. This matches
how the user-side `updateEmail` works (chapter 13).

A unique-violation surfaces as `EmailNotAvailable` 409. Same translation
as the handle path.

## sendEmail

Lookup the target's email by DID, hand it to `sendEmail` from
`auth/email_sender.ts` (the same shim chapter 13 uses for reset codes —
production swaps it for a transactional provider, chapter 18 walked
that). The handler returns `{ sent: true }` so the operator gets a
positive confirmation even when the underlying transport is fire-and-
forget.

Subject defaults to `"Message from your PDS operator"`. `comment` is
accepted for shape compatibility with the upstream lexicon (where it's
an audit-trail field); the audit log captures it as part of the
`params` snapshot below, so passing a non-empty `comment` is the
documented place to leave a free-text note on why a particular send was
made.

## deleteAccount

The admin-driven counterpart to the user-side delete (chapter 13). The
user flow demands password + email-token + JWT; the admin flow trusts
the operator and skips both. Same outcome: status flips to `deleted`,
the row stays, the firehose gets `#account { status: 'deleted' }` plus
`#tombstone`.

Why the soft delete? Same reasoning as the user-side path in chapter 13:

- The DID stays bound to this PDS forever. If we deleted the row, the
  DID could (in principle) be re-bound by a future operator running a
  different PDS at the same `did:web` host, and the AT-URIs that ever
  pointed at it would silently start meaning something different.
- The PLC log is append-only. We can't retract operations.
- An admin who hard-deletes by mistake has no path back. Soft-delete
  keeps reversibility cheap: in production you can build a "restore"
  flow on top of the existing row by flipping status back, if you trust
  the operator with that lever.

## Audit log

Every admin **mutation** writes one row to `admin_audit` — successful or
not. The five verbs in scope:

- `updateAccountStatus`
- `updateAccountHandle`
- `updateAccountEmail`
- `sendEmail`
- `deleteAccount`

The two read verbs (`getAccountInfo`, `getAccountInfos`) deliberately
do **not** write. They fire on every console refresh; if we logged
them, an operator skimming a list of accounts would generate dozens of
audit rows for nothing. The audit trail is for things that *changed*
state.

The table shape:

```ts
admin_audit {
  id            bigserial PRIMARY KEY
  actor         text NOT NULL              // 'admin' for HTTP Basic
  action        text NOT NULL              // e.g. 'updateAccountStatus'
  targetDid     text                       // the DID affected
  params        bytea NOT NULL             // DAG-CBOR snapshot of input
  occurredAt    timestamptz DEFAULT now()
  ipAddr        text                       // x-forwarded-for / x-real-ip
  result        text NOT NULL              // 'ok' | 'error'
  errorMessage  text                       // present when result='error'
}
```

Two indexes:

- `(occurred_at DESC)` — "the last N actions", the default console view.
- `(target_did, occurred_at DESC)` — per-account history.

`actor` is the string `'admin'` today: HTTP Basic doesn't carry an
operator identity. A future surface that ships per-operator credentials
would populate this column with whatever identifier the credentials
expose; the column is text rather than enum so the migration path is
free.

### Why DAG-CBOR for `params`?

The audit table is the *only* place we still hold what the admin
actually told the endpoint. If the input is `{ did: 'did:plc:abc',
status: 'takendown' }` we want to read that back later, byte-faithfully.
JSON would do for plain objects, but it punts on `Uint8Array` (silently
turns into `{ "0": …, "1": … }`) and bigint (throws). We already use
DAG-CBOR everywhere else in the PDS — blocks, commits, firehose events
— and it's deterministic, so the on-disk form for the same input is
the same bytes every time. The read endpoint decodes back and
re-stringifies into JSON-safe shapes (CIDs → strings, Uint8Array → `{
$bytes: <base64> }`) so the console sees readable values.

### `withAdminAudit` wrapper

To avoid open-coding the same try/finally pattern in seven handlers,
each mutation handler wraps its body once:

```ts
const handler: Handler = withAdminAudit({
  action: 'updateAccountStatus',
  targetDidFrom: (input) => (input as { did?: unknown })?.did as string,
}, async ({ input, authorization }) => {
  await requireAdmin(authorization)
  // ... existing handler body
})
```

The wrapper:

1. Pulls the client IP from `x-forwarded-for` / `x-real-ip` headers.
2. Calls the body.
3. Writes a `result='ok'` row on success — or `result='error'` (with
   `errorMessage`) on a thrown XrpcError or anything else — and
   re-throws so the dispatcher renders the canonical envelope unchanged.

It never throws on its own. An audit-side failure is logged and
swallowed; if the rows are mission-critical you'd page on those, but
the audit log going down must not take the admin surface down with it.

### Reading it back: `getAuditLog`

```
GET /xrpc/com.atproto.admin.getAuditLog
  ?limit=50&cursor=<id>&targetDid=<did>&action=<actionName>
```

`requireAdmin` like the rest of the surface. Returns rows newest-first
with cursor pagination on `id` (the cursor is the smallest `id` from
the previous page). The handler decodes `params` back from CBOR and
JSON-safe-converts it; the response is a plain JSON envelope:

```json
{
  "cursor": "12",
  "entries": [
    {
      "id": "15",
      "actor": "admin",
      "action": "sendEmail",
      "targetDid": "did:plc:nobody",
      "params": {
        "recipientDid": "did:plc:nobody",
        "subject": "hi",
        "content": "hello"
      },
      "occurredAt": "2026-01-01T12:00:00.000Z",
      "ipAddr": "10.0.0.1",
      "result": "error",
      "errorMessage": "account not found: did:plc:nobody"
    }
  ]
}
```

### Retention

Rows are **never auto-deleted**. The PDS doesn't ship a sweeper for the
audit table — that's an operator concern, and the right policy depends
on your retention contract. A `DELETE FROM admin_audit WHERE
occurred_at < now() - interval '1 year'` cron is the simple version;
exporting to cold storage first is the responsible version. Either way,
the PDS itself takes no opinion.

## What changes for the user

Two of these endpoints touch a user's identity. Worth being explicit:

- **Handle change.** The user's existing sessions still work (no token
  invalidation); the access JWT identifies the DID, not the handle.
  The next `getSession` call returns the new handle. Their clients
  notice on next session check and update the UI. Any client that
  cached the old handle on disk is out of date until it re-resolves —
  which is fine because handle-to-DID lookup happens at login time, not
  per-request.
- **Email change.** Same: their existing sessions stay valid. The next
  password-reset request is sent to the *new* address. If the operator
  changes the email to one the user doesn't control, the operator has
  effectively locked the user out of password recovery. This is a
  feature (court-ordered handover) and a footgun (don't typo the
  address); the chapter flags it because the API surface is otherwise
  reversible-feeling.

Neither operation invalidates refresh tokens. If a takedown is what you
want, use `updateAccountStatus` — *that* one's caught by every
authenticated handler's `requireAccessAuth` and forbids the account from
making more requests.

## User-submitted reports: `com.atproto.moderation.createReport`

Code: `src/pds/xrpc/handlers/com.atproto.moderation.createReport.ts`.

This is the *user-facing* edge of moderation — the endpoint a Bluesky
client hits when someone taps "Report this post". Anyone with an access
token can submit one. The body carries a reason and a subject:

```json
{
  "reasonType": "com.atproto.moderation.defs#reasonSpam",
  "reason": "free-text, optional, up to 20 000 chars",
  "subject": {
    "$type": "com.atproto.repo.strongRef",
    "uri": "at://did:plc:.../app.bsky.feed.post/abc",
    "cid": "bafyre..."
  }
}
```

`subject` is one of:

- `com.atproto.admin.defs#repoRef` — `{ did }`. Report a whole account.
- `com.atproto.repo.strongRef` — `{ uri, cid }`. Report a specific record.

The PDS is *not* a moderation authority. The reference PDS proxies
every report to an upstream mod service via service-auth — the operator
configures the service DID, the report-flow lands in a queue staffed
by humans. We do the persist half locally (`moderation_reports`
table) so:

1. The operator console has a trail of what was reported from this PDS,
   even when the upstream mod service is unreachable or unconfigured.
2. The endpoint can mint a stable `id` and round-trip the lexicon's
   reply shape (id, reasonType, reason, subject, reportedBy, createdAt)
   on every call.

The proxy half — forwarding to an upstream service via the existing
`pds/auth/service_auth.ts` ES256K helper — isn't wired in this chapter.
The shape is in place; an operator can add a `PDS_MOD_SERVICE_DID` env
var and a few lines in the handler to fan out to it. See the exercises.

`moderation_reports` schema (`drizzle/0013_moderation_reports.sql`):

```
id               bigserial PK
reported_by_did  text NOT NULL
reason_type      text NOT NULL
reason           text
subject_type     text NOT NULL
subject_did      text       -- set for repoRef, null for strongRef
subject_uri      text       -- set for strongRef, null for repoRef
subject_cid      text       -- set for strongRef, null for repoRef
created_at       timestamptz NOT NULL DEFAULT now()
```

Indexes: `created_at DESC` (operator console "recent reports") and
`(reported_by_did, created_at DESC)` (per-reporter history — useful if
the same account is filing many reports).

## Try it

Set up the admin surface:

```bash
# Generate the hash once
pnpm admin:hash 'a-good-password-please' > .admin-hash
export PDS_ADMIN_PASSWORD_HASH="$(cat .admin-hash)"
pnpm dev
```

In another terminal:

```bash
ADMIN="admin:a-good-password-please"
PDS="http://localhost:3000"

# List one account
curl -u "$ADMIN" \
  "$PDS/xrpc/com.atproto.admin.getAccountInfo?did=did:plc:abc123" | jq

# Bulk
curl -u "$ADMIN" \
  "$PDS/xrpc/com.atproto.admin.getAccountInfos?dids=did:plc:abc&dids=did:plc:def" | jq

# Takedown
curl -u "$ADMIN" -X POST \
  -H 'content-type: application/json' \
  -d '{"did":"did:plc:abc123","status":"takendown"}' \
  "$PDS/xrpc/com.atproto.admin.updateAccountStatus"

# Reverse it
curl -u "$ADMIN" -X POST \
  -H 'content-type: application/json' \
  -d '{"did":"did:plc:abc123","status":"active"}' \
  "$PDS/xrpc/com.atproto.admin.updateAccountStatus"

# Send a message
curl -u "$ADMIN" -X POST \
  -H 'content-type: application/json' \
  -d '{"recipientDid":"did:plc:abc123","subject":"hello","content":"Just checking in."}' \
  "$PDS/xrpc/com.atproto.admin.sendEmail"
```

Each request prints the dev email shim's structured log in the PDS
process; the `sendEmail` call will show the operator's message there.

## Production hardening

The admin surface is a power tool. A few things you should bolt on
before exposing it to a public network:

- **IP allowlist.** Front the PDS with a proxy (Caddy, nginx, AWS ALB)
  and restrict `/xrpc/com.atproto.admin.*` to your office / VPN / bastion
  IPs. There's no reason an admin endpoint should answer to the public
  internet.
- **Audit log retention.** The `admin_audit` table fills up forever by
  design — see the *Audit log* section above. Pick a retention window
  (90 days, a year, whatever your contract says), schedule a `DELETE`
  job that respects it, and consider exporting older rows to cold
  storage before they drop. The PDS ships the trail; what you keep is
  yours to decide.
- **Separate infrastructure from user traffic.** Even with an IP
  allowlist, running admin on the same port as user XRPC means a bug in
  one accidentally exposes the other. A separate `:3001` listener bound
  to localhost, fronted only by the admin proxy, is a small change and a
  big posture improvement.
- **Per-action confirmation.** Status changes to `deleted` are
  irreversible; for those, build a confirmation flow into your tooling
  (a `--yes-i-really-mean-it` flag, a two-step CLI wrapper) rather than
  trusting that whoever has the password can be trusted with every
  combination of arguments.

## Exercises

1. Add `deactivated` as a valid input to `updateAccountStatus` even when
   the account is `takendown`. Right now the handler updates the row and
   emits the event without protest, but the firehose order is
   `takendown` → `deactivated` → `active`. Is that meaningful? Why or
   why not — and what does an AppView do with the sequence?

2. `admin_audit` ships with `actor='admin'` for every row because HTTP
   Basic doesn't carry operator identity. Sketch the smallest credential
   change that would let you populate `actor` with a real name — without
   inventing a full per-operator account system. (Hint: the Basic
   username field is currently *ignored*; what changes if you start
   trusting it, and what extra check does that demand?)

3. The PLC-rotation divergence for `updateAccountHandle` is open. What
   subset of the rotation logic do you need to wire in to make the DID
   document reflect the new handle? Where does the rotation key come
   from for an admin-initiated change — the user's `rotation_key_priv`
   column, or somewhere else?

← [18 — Production](./18-production.md) ·
[20 — Migration](./20-migration.md) ·
[Table of contents](./README.md)
