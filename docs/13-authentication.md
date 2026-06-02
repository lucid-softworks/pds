# Authentication

Account creation handed back two JWTs. This chapter is about what those
strings *are*, why there are two of them, how the rest of the session
lifecycle works, and how every other XRPC handler turns "an Authorization
header showed up" into "I know which account this is."

The pieces that ship in this chapter:

- `com.atproto.server.createSession` — log in with a password.
- `com.atproto.server.refreshSession` — trade a refresh JWT for a new pair.
- `com.atproto.server.deleteSession` — log out.
- `com.atproto.server.getSession` — "who am I?"
- `com.atproto.identity.resolveHandle` — handle → DID.
- `com.atproto.server.describeServer` — unauthenticated server discovery.
- `src/pds/auth/middleware.ts` — the `requireAccessAuth` contract.

App passwords and OAuth are mentioned but not implemented; they each get
their own follow-on chapter.

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

The PDS supports **app passwords** — alternate credentials a user can
generate from the official client for use in CLI tools, bots, and any
third-party app that hasn't moved to OAuth. They're scoped (full-access
vs. DM-only, etc.) and individually revocable.

We haven't built that yet. The hooks are in place — `refresh_tokens` has
an `app_password_name` column that's null today — and a future chapter will
wire up the `com.atproto.server.createAppPassword` and `listAppPasswords`
endpoints alongside an extra column on the issuance flow.

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
