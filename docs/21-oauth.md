# OAuth

Chapter 13 handed clients a pair of HS256 JWTs whenever they typed the
right password. That worked, it works today, every test in the suite still
exercises it. But the protocol is moving — and has been for a while — away
from "send your password to every app you trust" toward a proper OAuth
flow with browser-mediated consent, per-client keys, and DPoP-bound tokens
that are useless to anyone who steals them in transit.

This chapter is the back half of OAuth in this PDS. The user-facing pieces
(the consent screen, the login UI, `/oauth/authorize`, `/oauth/par`) are a
follow-on session of their own; everything they need to sit on *is* here.
Concretely, this chapter ships:

- The OAuth discovery documents at `/.well-known/oauth-authorization-server`
  and `/.well-known/oauth-protected-resource`.
- A JWKS endpoint at `/oauth/jwks`.
- The token endpoint at `/oauth/token`, implementing the `refresh_token`
  grant.
- The revocation endpoint at `/oauth/revoke`.
- DPoP proof verification per RFC 9449.
- A new PDS-wide OAuth signing key (separate from the per-account repo
  keys we've been carrying since chapter 7).
- An extended `refresh_tokens` table that holds both legacy session
  refreshes and OAuth refreshes side by side.
- Stub routes at `/oauth/authorize` and `/oauth/par` that return 501 and
  point at this chapter.

OAuth is *additive*. The password flow from chapter 13 continues to mint
HS256 access + refresh JWTs and works on every endpoint exactly as it did
before. OAuth is what we hand to a third-party client when the user wants
to grant the client narrower-than-password access without ever telling the
client what their password is.

## The three roles

OAuth is a vocabulary problem before it's a code problem. Three roles
collaborate on every flow:

- **The Authorization Server** is the thing that issues tokens. It owns the
  signing key, the consent UI, the user's identity. For atproto, the
  Authorization Server is *the user's PDS* — this one.
- **The Protected Resource** is the thing tokens grant access to. For
  atproto, every authenticated XRPC endpoint is a protected resource — so
  the Protected Resource is *also this PDS*.
- **The Client** is the third-party app that wants to act on the user's
  behalf. It's not us. It might be an iOS reader app, a CLI tool, a
  scheduled-poster bot. Each client identifies itself with a `client_id`
  URL that points at a JSON metadata document; the AS fetches that
  document the first time it sees the client and trusts it from there on.

The fact that the AS and the RS roles are the same machine, in this
deployment, is a convenience of the architecture. Conceptually they're
distinct — and the metadata documents announce them separately so a
client can confirm the AS is the one this RS trusts.

> 📖 **Why is the PDS its own AS?** Because the PDS is what holds the
> user's keys, their handle, their account state. Splitting the AS off
> would mean some other service holds the user's identity and the PDS
> trusts it, which is a totally different deployment shape. atproto's
> design keeps everything user-controllable on the same hop the user
> moves when they migrate. See chapter 20.

## What this session ships, and what it doesn't

The pieces in this chapter are sufficient to be a *resource server* with
DPoP-bound bearer tokens — once you have a refresh token in hand. They
are **not** sufficient to *issue* a brand-new refresh token through the
OAuth flow: that requires `/oauth/authorize` (the user actually clicks
"yes, this app can post on my behalf") and `/oauth/par` (the front
channel uses opaque request_uri handles, not raw query params), both of
which are 501-stubs here.

The bridge across the gap is intentional. Until the authorize endpoint
ships, the way to get an OAuth refresh token for a given account is to
*mint one cross-protocol*: the user logs in with their password through
the chapter-13 `createSession` endpoint, then we call
`signOauthRefreshToken` directly. That's a fixture path; real clients
will go through `/oauth/par` → `/oauth/authorize` once those land. The
"Try it" section at the end of this chapter walks through it.

Flagged as 🚧 below: what's still missing, item by item.

## DPoP — proof of possession

A bearer token is, by definition, useful to anyone who's bearing it.
That's the whole point and also the whole problem. A stolen access token
from chapter 13 is a 2-hour all-access pass to the account. The clock is
the only thing limiting damage.

OAuth's answer is **DPoP** (RFC 9449). Every OAuth token we mint is bound
to a public key the *client* generates and holds privately. The
binding is a `cnf.jkt` claim in the access token: the SHA-256 thumbprint
of the client's public JWK. To use the token, the client signs a *proof*
JWT with their private key — and we, the resource server, refuse the
request unless the proof's key thumbprint matches the token's `cnf.jkt`.

So a stolen access token by itself is useless. To present it, the
attacker would also need the client's private key, which never leaves
the device that minted it.

A DPoP proof is a tiny JWT in the `DPoP:` header on every request. It
carries:

```json
{
  "typ": "dpop+jwt",
  "alg": "ES256",
  "jwk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." }
}
.
{
  "htm": "POST",
  "htu": "https://pds.example.com/oauth/token",
  "iat": 1735689600,
  "jti": "5JZk2v..."
}
```

`htm` and `htu` bind the proof to *this exact request*. `iat` keeps the
proof fresh (we reject anything outside ±60 seconds). `jti` is a random
identifier we cache in memory for the same 60-second window — replay of
a previously-accepted proof fails. The signature confirms the client
holds the private half of the embedded `jwk`.

The atproto profile mandates ES256K (secp256k1, the same curve used for
repo signing) on every DPoP proof. We accept that and also accept ES256
(P-256) — they're cryptographically equivalent at the same security
level, and most existing OAuth client libraries default to ES256. The
verifier in `src/pds/oauth/dpop.ts` is alg-aware and dispatches to
`@noble/curves`'s secp256k1 or p256 accordingly. Real-world interop > spec
purity.

> ⚠️ **The replay cache is in-process.** A multi-process deployment shares
> nothing today — a proof accepted on process A can be replayed against
> process B within the 60-second window. Production needs the same cache
> in Redis or a shared store. Flagged on the roadmap.

## The PDS's OAuth signing key

The chapter-13 tokens were HS256: same key signs and verifies, no
third-party verification needed, no key-management story. That works when
the only thing reading our tokens is us.

OAuth tokens are read by clients — to figure out their expiry, to bind
them to their DPoP key, to know which scopes the user granted. So we
need an *asymmetric* key: we sign with the private half, anyone with the
public half can verify. The public half goes on `/oauth/jwks`.

The key lives in a single new env var:

```
PDS_OAUTH_SIGNING_KEY=<64 hex chars / 32 bytes>
```

Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

It's a k256 (secp256k1) private scalar, hex-encoded — *exactly* the same
shape as the per-account `signing_key_priv` column we've been writing
since chapter 12. That's not an accident: we already have all the
primitives. What's different is *whose* key it is. The account-level keys
sign Merkle-tree commits on the user's behalf. The OAuth signing key
signs JWTs on the *PDS's* behalf as an authorization server. One key per
deployment, lifetime = deployment lifetime; you don't rotate it casually
because every issued token has its `kid` baked into the header.

`src/pds/oauth/keys.ts` loads the hex scalar, derives the uncompressed
public key (`X` and `Y` separately), and builds the JWK:

```ts
{
  kty: 'EC',
  crv: 'secp256k1',
  x: <base64url(X)>,
  y: <base64url(Y)>,
  alg: 'ES256K',
  use: 'sig',
  kid: <RFC 7638 thumbprint>
}
```

`kid` is the RFC 7638 thumbprint of the canonical JWK (the SHA-256 of
the JSON with members sorted by name, encoded as base64url). Clients
that fetch our JWKS index entries by `kid`, so making it the
self-describing thumbprint means a client that already knows our key
doesn't even need to fetch the JWKS — they already know the kid will
match.

> 📖 **Why does it have to be ES256K?** It doesn't. The OAuth spec is
> alg-agnostic; ES256 would work just as well, and most generic OAuth
> libraries default to ES256. atproto's profile picks ES256K for
> consistency with the rest of the protocol (the user's repo key is
> secp256k1; the PLC operations are signed with secp256k1; using a
> different curve on a third surface would be a footgun). We follow the
> profile.

## Token shapes

### Access token

```json
{
  "iss": "https://pds.example.com",
  "aud": "did:web:pds.example.com",
  "sub": "did:plc:alice",
  "scope": "atproto transition:generic",
  "cnf": { "jkt": "uTuw...iWcA" },
  "iat": 1735689600,
  "exp": 1735691400,
  "jti": "BqMs..."
}
```

Header: `{ "alg": "ES256K", "typ": "at+jwt", "kid": "<our kid>" }`.

The load-bearing differences from a chapter-13 access token:

- `iss` is the public URL of the PDS, *not* the service DID. (Chapter 13
  used the DID. OAuth issuers are URLs.)
- `cnf.jkt` is the SHA-256 thumbprint of the client's DPoP key. The RS
  middleware on every authenticated request will require an accompanying
  DPoP proof whose key has the same thumbprint.
- `scope` is the OAuth scope string the user granted.
- The signature is ES256K with the PDS's OAuth signing key, not HS256
  with `PDS_JWT_SECRET`.

Default TTL: 30 minutes. Shorter than chapter 13's 2 hours, because the
DPoP binding limits the damage from an exposed token in flight, but the
issuance loop (refresh → access) is cheap enough that we trade off in
the safer direction.

### Refresh token

Same shape, with two differences in the body:

```json
{
  "iss": "https://pds.example.com",
  "aud": "did:web:pds.example.com",
  "sub": "did:plc:alice",
  "scope": "atproto transition:generic",
  "cnf": { "jkt": "uTuw...iWcA" },
  "token_kind": "refresh",
  "iat": 1735689600,
  "exp": 1740873600,
  "jti": "9pZL..."
}
```

- `token_kind: "refresh"` is our own claim. It's the same defense
  chapter 13's `scope: "com.atproto.refresh"` provides: the verifier
  refuses to honour a refresh token where the call is asking for an
  access token, and vice versa. Without it, a verifier that wasn't
  paying attention would treat the two as interchangeable.
- Header `typ` is `refresh+jwt` (mirroring chapter 13 style).
- TTL is 60 days, matching chapter 13.

The DPoP binding (`cnf.jkt`) is critical here too: a refresh token by
itself doesn't let the bearer mint access tokens. They also need to
present a DPoP proof signed by the bound key.

> 📖 **Why is `dpop_jkt` *also* stored in the database row?** Belt and
> suspenders. The JWT body carries it, so a forgery would need both a
> different `cnf.jkt` and a forged signature with our key — but the row
> is the canonical source of truth. If we ever issued a refresh token
> with the wrong cnf and tried to validate, the row check catches it.

## The refresh flow

A client with a valid refresh token in hand and the DPoP key it was
issued for in scope hits `POST /oauth/token` like this:

```
POST /oauth/token HTTP/1.1
Host: pds.example.com
Content-Type: application/x-www-form-urlencoded
DPoP: <compact DPoP proof JWT>

grant_type=refresh_token&refresh_token=<jwt>&client_id=https://app.example/client.json
```

Inside, in order:

1. **Verify the DPoP proof** against `POST` and `https://pds.example.com/oauth/token`.
   We don't yet know what `cnf.jkt` to expect, so we just compute the proof's
   key thumbprint and remember it.
2. **Validate the refresh token JWT**: signature with our OAuth public
   key, issuer, audience, expiry, `token_kind === 'refresh'`, and
   `cnf.jkt` matching the thumbprint from step 1.
3. **Look up the refresh row** by `jti`. Confirm `kind === 'oauth'` and
   `dpop_jkt === proof.jkt` (second cross-check — the row is authoritative).
4. **Delete the row.** This is the rotation step from chapter 13 applied
   to OAuth refreshes — one use, then dead.
5. **Optionally narrow `scope`.** RFC 6749 §6 lets the client downscope
   on refresh but never broaden. We intersect.
6. **Mint a new access token** with `signOauthAccessToken`. Its `cnf.jkt`
   matches the proof's key thumbprint, so the same DPoP key keeps working.
7. **Mint a new refresh token** with `signOauthRefreshToken`, which
   inserts the new row with `kind='oauth'` and the same `dpop_jkt`.
8. **Return the pair** as a JSON `{ access_token, token_type: 'DPoP',
   expires_in, refresh_token, scope, sub }`.

Steps 4 and 7 are *not* in a database transaction. A crash between them
leaves the user with a working access token but no refresh token —
they'd need to log in again the next time the access expired. We
accepted this for the teaching port; production would `BEGIN ... COMMIT`
around the rotation. Compare with chapter 13's same trade-off in
`rotateRefreshToken`.

## Revocation

`POST /oauth/revoke` is RFC 7009. The body is
`token=<jwt>&token_type_hint=refresh_token`, form-encoded. We decode the
JWT *without* verifying (we only need its `jti` claim to address a row),
delete the matching row, and return 200 with an empty body — even if the
token didn't exist, was malformed, or had already been revoked.

That last bit is mandated by the spec: a revocation endpoint must not
leak which tokens are valid. Returning different statuses based on
"was the token good" would let an attacker probe for which strings
correspond to live sessions. So we say "OK" to everything.

Access tokens aren't stored, so there's nothing to revoke for them; if
the client hints `token_type_hint=access_token` we still 200, just
without doing anything. Their natural expiry handles the rest.

DPoP on `/revoke` is *optional* per the spec. A logged-out user who lost
their key still needs a way to revoke the matching server-side row;
requiring DPoP would orphan the row. We accept calls with or without
the header.

## The refresh-token row, extended

The chapter-13 `refresh_tokens` table held the bare minimum for legacy
sessions: `jti`, `did`, `expires_at`, `created_at`, `app_password_name`.
OAuth refreshes need three more bits per row:

```sql
ALTER TABLE refresh_tokens ADD COLUMN kind text NOT NULL DEFAULT 'session';
ALTER TABLE refresh_tokens ADD COLUMN dpop_jkt text;       -- nullable
ALTER TABLE refresh_tokens ADD COLUMN scope text;          -- nullable
```

- `kind` distinguishes `'session'` (legacy) from `'oauth'` (new). The
  default `'session'` keeps every existing row valid without a backfill.
- `dpop_jkt` is the SHA-256 thumbprint of the client's DPoP key. NULL
  for session rows; set for oauth rows.
- `scope` is the OAuth scope string the row was issued for. NULL for
  session rows; set for oauth rows.

The session flow in `src/pds/auth/session.ts` doesn't touch the new
columns at all — its inserts leave them at their defaults (`kind` =
`'session'`, the rest NULL). The OAuth flow always populates all three.

A future "list all my sessions across both protocols" endpoint would
read both `kind`s together and render them in a unified view.

## What's still missing

🚧 **`/oauth/authorize`.** The user-facing consent screen. A real
implementation looks up the `request_uri` pushed via PAR, resolves the
client metadata, renders consent, then on approval mints an
authorization code bound to the client's DPoP key and PKCE challenge.

🚧 **`/oauth/par` (Pushed Authorization Requests).** Atproto OAuth
*requires* PAR — clients can't pass authorize parameters in the browser
URL. PAR is the back-channel handoff where the client POSTs the full
parameter set and gets an opaque `request_uri` short-TTL handle.

🚧 **Client metadata fetching and validation.** Every OAuth client
identifies itself with a `client_id` URL that points at a JSON metadata
document. The AS fetches that document, validates its shape (redirect
URIs, scopes, DPoP-required, ...), and only allows clients whose
metadata matches the request. Today we have nothing here.

🚧 **PKCE verification.** Authorization codes will be bound to a
`code_challenge` the client posts via PAR; redemption requires the
client to present the matching `code_verifier`. Code lives nowhere yet
because authorize is unimplemented.

🚧 **`requireOauthAccess` middleware.** The chapter-13 middleware in
`src/pds/auth/middleware.ts` validates HS256 access tokens. The parallel
`requireOauthAccess` would: verify the bearer token as an OAuth access
token (ES256K), require a DPoP proof on the same request whose key
thumbprint matches the token's `cnf.jkt`, and enforce the granted scope
against the called NSID. Today the OAuth tokens we mint are unrouted —
no XRPC handler accepts them. Adding the middleware is a follow-on
session.

🚧 **Production DPoP replay cache.** The in-process cache in
`src/pds/oauth/dpop.ts` works for a single PDS process. Multi-process
deploys need a shared cache (Redis) or accept the small replay window
across processes as a manageable risk.

🚧 **Authorization-code lifetime + rotation policy.** When authorize
ships, codes need a short TTL (30–60 seconds) and a one-use lifetime.
We'll re-use the same `refresh_tokens`-style row pattern.

## Try it

This walkthrough mints an OAuth refresh token *cross-protocol* — through
the chapter-13 password login — because `/oauth/authorize` isn't here
yet. Real clients will go through the OAuth front door once it ships.

You'll need `jq` and `openssl`.

```bash
# 0. Generate a PDS OAuth signing key, if you haven't already.
export PDS_OAUTH_SIGNING_KEY=$(openssl rand -hex 32)

# Restart `pnpm dev` so the new env var is picked up.

# 1. Inspect the discovery doc.
curl -s http://localhost:3000/.well-known/oauth-authorization-server | jq

# 2. Inspect the JWKS — there should be exactly one key, alg=ES256K.
curl -s http://localhost:3000/oauth/jwks | jq

# 3. Inspect the protected-resource metadata.
curl -s http://localhost:3000/.well-known/oauth-protected-resource | jq

# 4. Create a chapter-13 session (we'll bridge to OAuth from here).
curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createSession \
  -H 'content-type: application/json' \
  -d '{"identifier":"alice.test","password":"correcthorsebatterystaple"}' | jq

# 5. The fixture path: mint a DPoP keypair + an OAuth refresh token tied
#    to it. There's no XRPC endpoint for this — it's a fixture-only call
#    intended for use until /oauth/authorize ships.
#
#    See tests under `tests/oauth/` (added by the test-author session)
#    for a worked example that does steps 5–7 in one node script.
```

The end-to-end refresh exchange — DPoP keypair, signed proof, POST to
`/oauth/token` — is best done from a script rather than `curl`, because
the DPoP proof has to be re-signed for each call. The shape, roughly:

```ts
// Once.
import { generateKeyPair, exportJWK, SignJWT, calculateJwkThumbprint } from 'jose'
const { privateKey, publicKey } = await generateKeyPair('ES256')
const dpopJwk = await exportJWK(publicKey)

// Per request.
async function dpopProof(method: string, url: string): Promise<string> {
  return new SignJWT({
    htm: method,
    htu: url,
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: dpopJwk })
    .setIssuedAt()
    .sign(privateKey)
}

// And then:
const proof = await dpopProof('POST', 'http://localhost:3000/oauth/token')
const res = await fetch('http://localhost:3000/oauth/token', {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    DPoP: proof,
  },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshJwt,
    client_id: 'http://localhost:3000/dev-client.json',
  }),
})
const { access_token, refresh_token, expires_in } = await res.json()
```

On success: a fresh DPoP-bound access JWT and a rotated refresh JWT.
Decode the access token (the middle base64url segment) and you'll see
the `cnf.jkt` claim — that's the thumbprint of the DPoP key you just
generated.

## Exercises

1. The `/oauth/token` endpoint accepts `scope` on a refresh request and
   narrows the existing grant. Walk through what should happen if the
   client requests a scope that's *broader* than the granted scope.
   What's the spec answer? What does our implementation do today?

2. The DPoP replay cache holds `jti` values for 60 seconds in process
   memory. A malicious replay arriving 61 seconds after the original
   would be accepted. Why is that OK? What threat is the cache actually
   defending against — and what threat is the `iat` ±60s tolerance
   defending against?

3. Sketch the `requireOauthAccess` middleware. It needs to: parse the
   `Authorization: DPoP <jwt>` header, verify the access token, then
   verify a DPoP proof on the same request whose key thumbprint matches
   the token's `cnf.jkt`. Which existing helpers does it compose? Where
   should it live in the codebase? What error names does it raise
   (compare chapter 13's `Unauthorized` / `Forbidden` taxonomy)?

## Up next

This is the end of the back half of OAuth. The next session takes on the
front half: authorize, PAR, client metadata, PKCE, the consent UI.
Together they'll let real third-party clients onboard a Bluesky user
without ever touching the password.

← [20 — Migration](./20-migration.md) ·
[Table of contents](./README.md)
