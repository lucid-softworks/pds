# Authentication

Account creation handed back two JWTs. This chapter is about what those
strings *are*, why there are two of them, how the rest of the session
lifecycle works, and how every other XRPC handler turns "an Authorization
header showed up" into "I know which account this is."

The pieces that ship in this chapter:

- `com.atproto.server.createSession` — log in with a password (main or app).
- `com.atproto.server.refreshSession` — trade a refresh JWT for a new pair.
- `com.atproto.server.deleteSession` — log out.
- `com.atproto.server.getSession` — "who am I?"
- `com.atproto.server.createAppPassword` — mint a scoped alt credential.
- `com.atproto.server.listAppPasswords` — enumerate them.
- `com.atproto.server.revokeAppPassword` — delete one by name.
- `com.atproto.identity.resolveHandle` — handle → DID.
- `com.atproto.server.describeServer` — unauthenticated server discovery.
- `src/pds/auth/middleware.ts` — the `requireAccessAuth` contract.

OAuth is mentioned but not implemented; it gets its own follow-on chapter.

## The session pair

A "session" is just a pair of JWTs:

- **Access token.** Short-lived (2 hours). Sent on every authenticated XRPC
  call as `Authorization: Bearer <jwt>`. The PDS validates it with a
  signature check — no database lookup required.
- **Refresh token.** Long-lived (60 days). Used only against
  `refreshSession` to mint a new access + refresh pair. The PDS *does* hit
  the database when validating a refresh token: its `jti` claim must still
  exist in the `refresh_tokens` table.

Two tokens, not one, because the trade-off cuts opposite directions on the
two halves of the problem:

- Authenticating every XRPC call against the database would be a query per
  request, plus a cache layer to make it not awful. Stateless verification
  of a short-lived signed token is cheap and parallel-friendly.
- But stateless tokens can't be revoked. If a 30-day session token leaks,
  the attacker has it for 30 days. So we make the call-path token tiny — 2
  hours, no revocation needed because expiry handles it — and keep a
  longer-lived companion token that *is* revocable, which the client uses
  to bootstrap a fresh short token whenever it needs one.

In other words: the access token is fast because we can't revoke it, and
the refresh token is revocable because we don't use it on the hot path.

## JWT shape

Both tokens are HS256-signed with `PDS_JWT_SECRET`. The protected header
distinguishes them:

```
access:  { "alg": "HS256", "typ": "at+jwt" }
refresh: { "alg": "HS256", "typ": "refresh+jwt" }
```

The payload claims are standard JWT plus one extra:

```ts
{
  iss: "did:web:<hostname>",   // this PDS
  aud: "did:web:<hostname>",   // also this PDS — tokens aren't portable
  sub: "did:plc:<user>",        // the account
  iat: 1735689600,
  exp: 1735696800,              // iat + 2h or iat + 60d
  jti: "kQ8X3...",              // random per-token ID
  scope: "com.atproto.access"   // or "com.atproto.refresh"
}
```

The `scope` claim is the load-bearing one: `verifyAccessToken` rejects
anything that isn't `com.atproto.access`, and vice versa. This is the
defense against using a refresh token as an access token (or the other way
around). Without it, both kinds of token would look interchangeable to a
naive verifier.

> 📖 **Why HS256, not RS256?** Because the only thing that signs *and*
> verifies these tokens is this PDS. There's no third-party verifier we'd
> need to hand a public key to. Symmetric HMAC is simpler, faster, and
> doesn't require a key-management story. If we later needed to let an
> appview or relay verify our tokens without contacting us, we'd switch to
> ES256 and serve the public key from the DID document.

## The asymmetry: access tokens aren't stored, refresh tokens are

`createSessionTokens` mints both, but only writes one row:

```ts
await db.insert(refreshTokens).values({
  jti: refresh.jti,
  did,
  expiresAt: new Date(refresh.exp * 1000),
})
```

The access token's `jti` doesn't go anywhere. Verification is signature +
issuer + audience + scope + expiry — all derivable from the token alone.

This asymmetry is the *point* of having two tokens. If we stored both, the
access token's database hit would defeat the speed argument. If we stored
neither, the refresh token would be unrevokable, defeating the revocability
argument.

So: access tokens are stateless because the only way to "revoke" them is to
let them expire (2 hours is the upper bound on damage from a leaked one).
Refresh tokens have a server-side row because revocation is the entire
reason they exist.

## Refresh rotation

Every successful `refreshSession` does three things:

1. Verify the incoming refresh JWT — signature, expiry, scope, and that its
   `jti` is in the `refresh_tokens` table.
2. **Delete that `jti` row.**
3. Mint a brand-new access + refresh pair, insert the new refresh `jti`.

Step 2 is the rotation. The refresh token a client sends in is good for
exactly one use. The instant it's used, it stops working — even though it's
not yet expired by `exp`.

There are two reasons:

- **Limiting the blast radius of theft.** If an attacker steals a refresh
  token from a client's local storage, they can use it once. The moment
  they (or the legitimate client) does, the other party's next attempt
  fails. Now the legitimate client is forced to log in again, which alerts
  the user; the attacker has only the access token, which expires in two
  hours.
- **Detecting theft.** Servers that want to go further can record the
  *attempted* re-use of a rotated token and treat it as evidence of
  compromise — invalidate the entire account's sessions, force a password
  reset. We don't do that yet, but the table structure makes it trivial to
  add a "rotated_to" column and use it to detect the pattern.

> ⚠️ **Difference from upstream.** The reference Bluesky PDS rotates
> refresh tokens by default but also has a config flag to allow re-use for
> a grace period (to be friendly to clients with flaky network retries).
> We're strict: one use, then dead.

## Password hashing

Covered in detail in [chapter 12 — Account creation](./12-accounts.md#step-5-hash-the-password).
The short version:

- `scrypt` from `node:crypto`, params `N=2^15 r=8 p=1`.
- Versioned storage format: `scrypt:v1:32768:8:1:<salt-b64>:<hash-b64>`.
- `verifyPassword(input, stored)` uses `timingSafeEqual` for the
  comparison.
- We use scrypt, not argon2id, because argon2 requires a native or wasm
  build that complicates the teaching install. We get a flag day if/when
  we migrate by bumping the version prefix.

Login (`loginWithPassword`) calls `verifyPassword` and returns the same
`Unauthorized` error whether the identifier was missing or the password was
wrong. That's a deliberate enumeration defense — the response shouldn't
tell an attacker whether `alice.test` is registered.

## The middleware contract

Every authenticated XRPC handler imports one of three helpers from
`src/pds/auth/middleware.ts`:

```ts
requireAccessAuth(authorization)    // throws if missing/invalid; returns account
requireRefreshAuth(authorization)   // for refreshSession + deleteSession
optionalAccessAuth(authorization)   // returns null when header absent, throws on invalid
```

They share a small parsing layer:

- Authorization header is required to start with `Bearer ` (case
  insensitive). Missing → `Unauthorized` / `AuthMissing`. Wrong scheme →
  `Unauthorized` / `InvalidToken`.
- JWT verification failures map to canonical names: expired → `ExpiredToken`,
  anything else (bad signature, wrong scope, malformed) → `InvalidToken`.
- A valid JWT whose subject doesn't resolve to an account → `InvalidToken`
  (the account was deleted, the token is stale).
- An account whose status is anything other than `active` → `Forbidden`
  with a status-specific name: `AccountTakedown`, `AccountDeactivated`,
  `AccountDeleted`, or `AccountSuspended`.

For `requireRefreshAuth` we additionally hit the database to confirm the
`jti` is still on file. That's the revocation check; without it, a refresh
JWT that the user "logged out" with would still work until its 60-day
expiry.

Handler ergonomics look like the `getSession` handler:

```ts
const handler: Handler = async ({ authorization }) => {
  const me = await requireAccessAuth(authorization)
  // ... me.did, me.handle, me.email, me.status all populated ...
}
```

A handler that doesn't call one of these middleware functions is, by
construction, unauthenticated. There's no "auth required" decorator at the
registry level — every handler opts in explicitly. This matches the way
the upstream lexicon spec works: each method's JSON schema declares its
own `auth` shape.

## App passwords

The PDS supports **app passwords** — alternate credentials a user can mint
from the official client for use in CLI tools, bots, archival scripts, and
any third-party app that hasn't moved to OAuth. They exist so that handing
your password to a CLI never has to mean handing over the keys to the
account; lose track of one, revoke it, the main login is untouched.

### Format

The plaintext is `xxxx-xxxx-xxxx-xxxx`: four groups of four lowercase chars
separated by dashes. The alphabet is 32 characters wide — a–z minus the
look-alikes `l` and `o`, plus the digits 2–9 (we drop 0 and 1 for the same
reason). 16 alphabet characters at 5 bits each gives ~80 bits of entropy,
which is well clear of any practical brute-force budget against a scrypt
hash. The dashes are pure UX — they make the string easier to read off a
sticky note or paste from a password manager.

### Server-generated, shown once

Crucially, **the user does not choose the plaintext**. We generate it from
`crypto.randomBytes` and return it in the `createAppPassword` response.
After that, the only thing on disk is a `scrypt:v1:` hash, identical in
format to the main password column — `verifyPassword` doesn't know or care
which kind of credential it's checking. The client UX that wraps this MUST
display the plaintext exactly once and tell the user to copy it now; we
cannot recover it later, by design.

This is the inverse of how a normal password works: there, the user picks
something memorable and we hope it's strong. Here, we pick something strong
and accept that nobody will memorise it.

### The `privileged` flag

Each app password carries a boolean: `privileged: true` means "this can do
anything the account can do," and `false` means "no email-flow operations"
— change email, request a password reset, that sort of thing. The
upstream Bluesky PDS enforces this gate on the relevant handlers. **Our
implementation records the flag but does not yet enforce it** — every email
flow chapter is still to come, and we'll wire the check in when the
endpoints land. Flagged as an upstream divergence.

### Lifecycle

1. **Create.** `com.atproto.server.createAppPassword` with an
   authenticated access JWT and a `name` matching `/^[a-zA-Z0-9._-]{4,32}$/`.
   The response includes the plaintext `password` — this is your one
   chance. Name collisions per account return `Conflict` /
   `AppPasswordNameExists`.
2. **Use.** Pass it as `password` to `com.atproto.server.createSession`
   exactly like the main password. The login flow tries the main hash
   first, then walks the account's app-password rows. On a match, the new
   refresh row is tagged with the app password's `name` in
   `refresh_tokens.app_password_name`, and that tag is preserved across
   every subsequent rotation — a session that logged in narrow stays
   narrow.
3. **List.** `com.atproto.server.listAppPasswords` returns
   `{ name, createdAt, privileged }` for every row. The plaintext is
   gone forever; this view is metadata only.
4. **Revoke.** `com.atproto.server.revokeAppPassword` with `{ name }`
   deletes the row. The endpoint is idempotent — re-revoking a name that's
   already gone still returns 200. Existing refresh tokens minted under the
   revoked name are left alone; they'll naturally die on next rotation
   attempt only if you also drop them, which we don't yet do (TODO: cascade
   revoke).

### Try it

```bash
# Assume $ACCESS is a valid main-password access JWT from above.

# Mint an app password
NEW=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createAppPassword \
  -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"name": "cli-tool"}')
APP_PASSWORD=$(echo "$NEW" | jq -r .password)
echo "save this, it won't be shown again: $APP_PASSWORD"

# List
curl -s http://localhost:3000/xrpc/com.atproto.server.listAppPasswords \
  -H "authorization: Bearer $ACCESS" | jq

# Log in with it (note: same endpoint as the main password)
curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createSession \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg pw "$APP_PASSWORD" '{identifier: "alice.test", password: $pw}')" | jq

# Revoke (idempotent)
curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.revokeAppPassword \
  -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"name": "cli-tool"}' -i
```

After the revoke, the same `createSession` call will return
`AuthenticationRequired`.

## OAuth

The atproto OAuth profile is a relatively recent addition and is the
endgame for first-class third-party clients. It also introduces DPoP,
PAR, and a discovery doc — none of which we have today. We'll land it
in its own chapter after records.

For this chapter's purposes, all you need to know is: every API call still
comes down to `Authorization: Bearer <jwt>`, but the JWT's `iss` is the
PDS, the `sub` is the user, and the verification path is the same one
already in `middleware.ts`. We just add a second JWT scope alongside
`com.atproto.access`.

## Email confirmation

The AT Protocol expects a PDS to know whether an account's email address
has actually been *reached* — separate from whether one was supplied. The
spec doesn't make confirmation a hard prerequisite for everything, but it
gates a few flows (password reset notifications, takedown appeals) and
surfaces in `getSession` as the `emailConfirmed` boolean. We persist that
bit as a nullable `email_confirmed_at` timestamp on `accounts`: NULL means
unconfirmed; a date means it was confirmed at that moment.

> ⚠️ **Difference from upstream.** The reference Bluesky PDS makes some
> flows error out for unconfirmed accounts; ours doesn't, and
> `createAccount` still happily mints a session without a verification
> round-trip. We're divergent here on purpose — chapter 12 was supposed to
> be about minting a first DID, not about email lifecycle — and we'll
> close the gap when the takedown / appeals chapter lands. The plumbing
> is all here; only the enforcement is missing.

Two endpoints drive the flow:

- `com.atproto.server.requestEmailConfirmation` — authenticated. Mints a
  32-character token, writes it to `email_tokens` keyed by
  `(did, 'confirm-email', token)`, and "sends" it to the account's current
  address. Returns 200 with empty body if the address is already confirmed
  — retries shouldn't be errors.
- `com.atproto.server.confirmEmail` — authenticated. Takes `{ token }`,
  looks it up by `(did, 'confirm-email', token)`, deletes the row on hit,
  and sets `accounts.email_confirmed_at = now()`. Returns `InvalidToken`
  (401) on miss or expiry.

Tokens are 160 bits from `randomBytes(20)` rendered as RFC 4648 base32 (no
padding). That's short enough to read aloud from an email, long enough
that guessing is infeasible. Issuing a fresh token wipes any prior live
token for the same (did, purpose) — only the newest is valid.

## Email updates

Changing an account's email address is the same machinery with a twist:
the verification email goes to the *new* address, not the old one. That's
the point. We can't trust that the user actually owns the address they
typed in until they prove it by clicking through; sending the code to the
address they currently have on file would only prove they still control
the *old* one. Reversing direction proves the *new* one and is the same
property OAuth attestation buys, just slower.

- `com.atproto.server.requestEmailUpdate` — authenticated. Input
  `{ email }`. We validate syntax, issue a token with `new_email`
  populated on the row, and email the code to the new address.
- `com.atproto.server.updateEmail` — authenticated. Input `{ token }`
  (the lexicon also accepts the new email here; we trust the token row).
  On match we set `accounts.email = new_email` and *clear*
  `email_confirmed_at` back to NULL. The new address starts unconfirmed
  by definition — the user has just demonstrated they own it, but a
  follow-up `requestEmailConfirmation` cycle is what flips the bit
  downstream consumers check.

If the new address is already in use, the `UNIQUE` constraint on
`accounts.email` fires and we surface a `Conflict` / `EmailNotAvailable`.

## Password reset

Forgotten-password flows can't require an authenticated caller — the whole
point is the user lost the ability to authenticate. Two unauthenticated
endpoints carry it:

- `com.atproto.server.requestPasswordReset` — input `{ email }`. We look
  the account up by email; if it exists we issue a one-hour reset token
  and email it. **If it doesn't exist, we return 200 anyway.** Returning
  a different status (or even a different latency profile) for "no
  account" vs. "sent" would let an unauthenticated caller enumerate
  accounts. The same defense-in-depth principle that makes login return
  the same error for "no such handle" and "wrong password" applies here.
- `com.atproto.server.resetPassword` — input `{ token, password }`. The
  user is still unauthenticated, so we can't scope the lookup by DID; we
  look the token up by `(purpose='reset-password', token)` instead — the
  secondary index on `email_tokens.token` is there exactly for this. On
  match we hash the new password and update `accounts.password_hash`.
  Returns `InvalidToken` (400) on miss/expiry, `InvalidPassword` if the
  new password is under eight characters.

The reset TTL is one hour, much shorter than the 24-hour confirmation
window. The threat model is different: a reset token in a phished inbox
is a full account takeover, whereas a confirmation token only proves
email reachability. The short window limits damage if the link is
intercepted.

Note what reset *doesn't* do: it doesn't invalidate the user's existing
sessions. Refresh tokens stay on file, access tokens stay valid until
they expire. A user who suspects their account was compromised needs to
revoke sessions separately (`deleteSession` per device, or the
all-sessions revocation we'll build alongside fuller app-password
controls). This is the same trade-off the upstream PDS makes, and we
may revisit it once we have a clearer notion of "rotate all credentials"
as one user-facing operation.

## The dev email sender

`src/pds/auth/email_sender.ts` is a stub:

```ts
export async function sendEmail({ to, subject, body }): Promise<void> {
  console.log(... structured banner with the body inline ...)
}
```

It logs every "send" to the terminal with a clear divider so you can
scroll back, find the token, and paste it into the next `curl`. There is
no SMTP, no DKIM, no bounce handling. That's a feature for the dev loop
— you don't need a mailserver to test the flow end to end — and a problem
we deliberately defer to chapter 18, where we'll swap the body of this
one function for a transactional provider call and the rest of the
codebase won't notice. The function signature is the abstraction
boundary.

## Account lifecycle

Creating an account isn't the end of the story. A real user wants to be
able to pause an account, come back to it, and — eventually, deliberately
— destroy it. Five endpoints round out that lifecycle, and they're all
driven by a single column we've been quietly carrying since chapter 12:
`accounts.status`. It's the state machine.

```
            createAccount
                 │
                 ▼
              active ───── takendown (admin only, ch 18)
              ▲   │
   activateAccount │ deactivateAccount
              │   ▼
            deactivated
                 │
                 ▼ (delete flow)
              deleted
```

Four values, three user-driven transitions, one admin-driven one. Every
authenticated endpoint runs through `requireAccessAuth`, and the
middleware enforces the only useful invariant: by default it rejects any
status other than `active`. `takendown` and `deleted` are server-side
disabled, never reachable. `deactivated` is the interesting case — a user
who deactivated themselves still needs a path back, and they need to be
able to see their own state to decide what to do. We added an
`AuthOptions.allowDeactivated` flag for those two specific endpoints:

```ts
const me = await requireAccessAuth(authorization, { allowDeactivated: true })
```

That's the only relaxation. Takedown and deleted remain unconditional 403s.

### checkAccountStatus and the deactivate/activate pair

`com.atproto.server.checkAccountStatus` is the read side of the state
machine. It opts into `allowDeactivated`, looks the row up, and returns
`{ did, handle, email, emailConfirmed, status, active }`. The upstream
lexicon allows expensive informational fields (`expectedRecords`,
`expectedBlocks`, …) for migration tooling; we deliberately omit them —
they'd cost a repo scan per call and we don't have a migration story yet.

`com.atproto.server.deactivateAccount` flips `status` to `'deactivated'`
and emits an `#account { active: false, status: 'deactivated' }` event on
the firehose. Refresh tokens stay alive on purpose: the user is going to
need them when they come back. The lexicon also accepts a `deleteAfter`
ISO timestamp for a "schedule a delete in N days unless I reactivate"
workflow; we accept the field for shape compatibility but ignore it for
now — there's no scheduler in the teaching surface.

`com.atproto.server.activateAccount` is the inverse: `status` back to
`'active'`, `#account { active: true }` event. Re-activating an
already-active account is a no-op (200, empty body) rather than an
error — clients hitting this on retry shouldn't trip a hard failure.

### The delete flow

Account deletion is the only XRPC operation in this codebase that's truly
irreversible, so it takes the only two-step path of any endpoint here:

1. **`com.atproto.server.requestAccountDelete`** — authenticated. Mints a
   `delete-account` token in `email_tokens` and emails it to the
   account's address. The TTL is one hour, the same threat-model
   reasoning as password reset: a token in a phished inbox is full
   account loss, so the window is tight.
2. **`com.atproto.server.deleteAccount`** — authenticated. Input is
   `{ did, password, token }`. Three independent proofs converge:
   - The access JWT (middleware).
   - `input.did === me.did` — a leaked access JWT can't be retargeted
     by lying in the body.
   - A fresh `verifyPassword` against the stored main-password hash.
     App passwords don't open this door; only the main credential does.
   - `consumeEmailToken({ purpose: 'delete-account', token })`.

Belt, braces, and a third belt. Compare with `deactivateAccount`, which
needs only the access JWT — the two endpoints are deliberately
asymmetric, because deactivation is reversible and deletion is not.

On success, we **mark** the account as `'deleted'` rather than running a
hard `DELETE FROM accounts`. Doing a hard delete would cascade through
every `ON DELETE CASCADE` FK pointing at `accounts.did` (repos,
repo_blocks, refresh_tokens, plc_operations, records, record_blobs,
blobs, app_passwords, email_tokens) and there'd be no path back. Marking
preserves the DID/handle pair, keeps the PLC log queryable, and matches
the protocol's "account deleted, DID survives" semantic — which is
exactly what other PDSes and the upstream relay expect to see on the
firehose.

Two firehose events go out: an `#account { active: false, status:
'deleted' }` so downstream consumers update their cached state, and a
`#tombstone { did }` that tells them to drop any data they were holding
for this DID. `emitTombstone` lives in `src/pds/sequencer/sequence.ts`
next to the other emit helpers.

A note on what delete *doesn't* do today: it doesn't revoke outstanding
refresh tokens or pre-mint a forwarding pointer to a new PDS. The first
is a defensible omission (the next call to `requireAccessAuth` will 403
on the deleted status anyway, before the JWT even gets checked against
its DID's row); the second is the entire account-migration chapter and
lives further out.

## Try it

After `pnpm db:migrate && pnpm dev`, in another shell:

```bash
# 1. Create an account (chapter 12)
curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createAccount \
  -H 'content-type: application/json' \
  -d '{
    "handle": "alice.test",
    "email": "alice@example.com",
    "password": "correcthorsebatterystaple"
  }' | jq

# 2. Log in with password (this chapter)
SESSION=$(curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createSession \
  -H 'content-type: application/json' \
  -d '{
    "identifier": "alice.test",
    "password": "correcthorsebatterystaple"
  }')
ACCESS=$(echo "$SESSION" | jq -r .accessJwt)
REFRESH=$(echo "$SESSION" | jq -r .refreshJwt)

# 3. Who am I? — access JWT in Authorization
curl -s http://localhost:3000/xrpc/com.atproto.server.getSession \
  -H "authorization: Bearer $ACCESS" | jq

# 4. Trade the refresh JWT for a new pair — refresh JWT in Authorization
curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.refreshSession \
  -H "authorization: Bearer $REFRESH" | jq

# 5. Log out — the *current* refresh JWT
curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.deleteSession \
  -H "authorization: Bearer $REFRESH" -i
```

Bonus, no auth needed:

```bash
curl -s http://localhost:3000/xrpc/com.atproto.server.describeServer | jq
curl -s 'http://localhost:3000/xrpc/com.atproto.identity.resolveHandle?handle=alice.test' | jq
```

After step 4, the old `$REFRESH` is dead — try step 5 with it and you'll
get `ExpiredToken`. That's rotation working as designed.

## Exercises

1. Decode an access JWT by hand (the middle base64-url segment is JSON).
   What does the `scope` claim look like? What happens if you swap a
   refresh JWT into a call to `getSession`?
2. Refresh a session three times in a row. Check the `refresh_tokens`
   table after each call — there should be exactly one row, and the `jti`
   changes each time. What would happen if step 2 of the rotation failed
   between the `DELETE` and the `INSERT`?
3. Change `ACCESS_TTL_SECONDS` to 10. Log in, wait 15 seconds, call
   `getSession`. What error name comes back? Now write a small client that
   catches that specific name and transparently calls `refreshSession`.
4. Why does the middleware return the *same* `Unauthorized` /
   `AuthenticationRequired` for "no such handle" and "wrong password," but
   a *different* error (`AccountTakedown` etc.) when the account exists
   but is disabled? What attack surface does each choice trade off?

## Up next

We've got an authenticated session and the verification machinery for
every other handler in the codebase. Next: [14 — Records](./14-records.md),
where we finally put data into the empty repo we built in chapter 12.

← [12 — Account creation](./12-accounts.md) · → [14 — Records](./14-records.md)
