# OAuth

Chapter 13 handed clients a pair of HS256 JWTs whenever they typed the
right password. That worked, it works today, every test in the suite still
exercises it. But the protocol is moving — and has been for a while — away
from "send your password to every app you trust" toward a proper OAuth
flow with browser-mediated consent, per-client keys, and DPoP-bound tokens
that are useless to anyone who steals them in transit.

This chapter walks through both halves of OAuth on this PDS. The original
session shipped the back half (the surface that lets us *be* a resource
server once a refresh token is in hand); a follow-on session shipped the
front half (the surface that *mints* the first refresh token through a
real browser-mediated consent flow). Concretely:

- The OAuth discovery documents at `/.well-known/oauth-authorization-server`
  and `/.well-known/oauth-protected-resource`.
- A JWKS endpoint at `/oauth/jwks`.
- The PAR endpoint at `/oauth/par` (RFC 9126) — clients push their full
  authorize-request parameters over the back channel and get a short-lived
  `request_uri` opaque handle in return.
- The user-facing authorization endpoint at `/oauth/authorize` — looks up
  the PAR row, renders a login + consent screen, verifies the user's
  password, mints a one-shot authorization code, and 302s back to the
  client's `redirect_uri` with the code.
- The token endpoint at `/oauth/token`, implementing both the
  `authorization_code` grant (first-issue) and the `refresh_token` grant
  (rotation).
- The revocation endpoint at `/oauth/revoke`.
- DPoP proof verification per RFC 9449.
- Client-metadata fetching + validation (`src/pds/oauth/clients.ts`).
- PKCE verifier ↔ challenge check (`src/pds/oauth/pkce.ts`).
- A new PDS-wide OAuth signing key (separate from the per-account repo
  keys we've been carrying since chapter 7).
- An extended `refresh_tokens` table that holds both legacy session
  refreshes and OAuth refreshes side by side, plus two new short-lived
  stores: `oauth_par` (PAR handles) and `oauth_codes` (authorization codes).

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

## What's shipped, and what's still missing

The full first-issue → rotation loop now works end-to-end: a client can
push parameters via PAR, redirect the user through `/oauth/authorize`,
exchange the returned code at `/oauth/token` for a DPoP-bound access +
refresh pair, then keep rotating that pair via the `refresh_token` grant.
The integration test at `tests/integration/oauth-front-half.test.ts`
exercises exactly that path.

One piece remains on the roadmap, 🚧:

- **Shared DPoP replay store.** The in-process `jti` cache works for
  single-process deploys but a multi-process PDS shares nothing. A Redis
  (or pglite-shared-row) cache is a small follow-up.

Everything else in the original 🚧 list shipped, including the
resource-server enforcement (`requireOauthAccess` + `requireEitherAuth`,
covered below in *Plumbing OAuth tokens into XRPC handlers*):

- ~~`/oauth/authorize` — login + consent UI~~ ✅
- ~~`/oauth/par` — Pushed Authorization Requests~~ ✅
- ~~Client metadata fetching and validation~~ ✅
- ~~PKCE verification (S256-only)~~ ✅
- ~~Authorization-code lifetime + rotation policy~~ ✅ (60 s,
  single-use, marked `used` atomically)

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

## The full authorization flow

With both halves in place, here's what an OAuth client does end-to-end
to get its first access token. Each step names the spec it's
implementing so you can cross-reference.

1. **Discover** the AS by fetching
   `/.well-known/oauth-authorization-server` (RFC 8414). The client
   reads our PAR endpoint, token endpoint, scopes, supported DPoP algs.

2. **Generate** a fresh DPoP keypair (per-session, per-app — never
   reused across clients). Compute its RFC 7638 thumbprint; that's the
   `jkt` it'll bind tokens to.

3. **Generate** a PKCE pair — 32 random bytes base64url'd is the
   `code_verifier`; `base64url(sha256(verifier))` is the
   `code_challenge`. Pick `state` (random) the same way.

4. **PAR push** — POST `/oauth/par` with the parameters:
   ```
   client_id              https://app.example.com/client-metadata.json
   response_type          code
   redirect_uri           https://app.example.com/cb
   scope                  atproto transition:generic
   state                  <random>
   code_challenge         <base64url sha256 of the verifier>
   code_challenge_method  S256
   dpop_jkt               <thumbprint of the DPoP key>
   login_hint             alice.example.com           (optional)
   ```
   On success the client gets `{ request_uri, expires_in: 60 }`.

5. **Redirect** the user's browser to
   `/oauth/authorize?request_uri=<urn>`. The PDS looks up the PAR row,
   renders a login + consent screen pre-filled with the `login_hint`,
   sets a CSRF cookie, and waits for the form POST.

6. **Sign in.** The user types their handle + password, the browser
   POSTs back to `/oauth/authorize?request_uri=<urn>`. The PDS verifies
   the CSRF token, verifies the password via the same `loginWithPassword`
   chapter 13 uses, mints a one-shot authorization `code` bound to the
   PAR row's `dpop_jkt` / PKCE challenge / scope, deletes the PAR row,
   and 302s the browser to
   `<redirect_uri>?code=<code>&state=<state>&iss=<issuer>`.

7. **Token exchange.** The client POSTs `/oauth/token` with:
   ```
   grant_type     authorization_code
   code           <the code>
   redirect_uri   <must match step 4>
   client_id      <must match step 4>
   code_verifier  <the raw PKCE verifier from step 3>
   ```
   Headers include `DPoP: <freshly signed proof>` whose `jkt` matches
   what was pinned at PAR time. The PDS verifies the DPoP proof,
   atomically marks the code used, verifies `sha256(verifier) ===
   challenge`, cross-checks `redirect_uri` and `client_id`, then mints
   an access + refresh JWT pair both bound (`cnf.jkt`) to the DPoP key.

8. **Use the access token** with `Authorization: DPoP <access_jwt>` +
   `DPoP: <fresh proof for this request>` on every call.

9. **Rotate** by POSTing `/oauth/token` with `grant_type=refresh_token`
   when the access expires. The refresh token is single-use — the old
   row gets deleted, a fresh pair gets minted with the same `cnf.jkt`.

### Run it locally

```bash
# 0. Generate signing key + start the dev server.
export PDS_OAUTH_SIGNING_KEY=$(openssl rand -hex 32)
pnpm dev
```

```ts
// dev-oauth-flow.ts — run with `pnpm tsx dev-oauth-flow.ts`.
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  calculateJwkThumbprint,
} from 'jose'
import { createHash, randomBytes } from 'node:crypto'

const PDS = 'http://localhost:3000'
const CLIENT_ID = `${PDS}/dev-client.json` // host the JSON yourself
const REDIRECT_URI = `${PDS}/dev-client/cb`

const { privateKey, publicKey } = await generateKeyPair('ES256', {
  extractable: true,
})
const jwk = await exportJWK(publicKey)
const jkt = await calculateJwkThumbprint(jwk, 'sha256')

const verifier = randomBytes(32).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const state = randomBytes(16).toString('base64url')

const par = await fetch(`${PDS}/oauth/par`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'atproto transition:generic',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    dpop_jkt: jkt,
    login_hint: 'alice.test',
  }),
}).then((r) => r.json())

console.log(`open in your browser:
  ${PDS}/oauth/authorize?request_uri=${encodeURIComponent(par.request_uri)}`)

// After sign-in, the redirect URL will contain ?code=<...> — paste it:
const code = process.argv[2]
if (!code) {
  console.error('run again with the code from the redirect:')
  console.error('  pnpm tsx dev-oauth-flow.ts <code>')
  process.exit(1)
}

const proof = await new SignJWT({
  htm: 'POST',
  htu: `${PDS}/oauth/token`,
  jti: randomBytes(8).toString('base64url'),
})
  .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk })
  .setIssuedAt()
  .sign(privateKey)

const tokens = await fetch(`${PDS}/oauth/token`, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    DPoP: proof,
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  }),
}).then((r) => r.json())

console.log(tokens)
// → { access_token, refresh_token, token_type: 'DPoP', expires_in, scope, sub }
```

The `sub` claim is the user's DID; the access token's `cnf.jkt` matches
the thumbprint of the DPoP key you generated; the refresh token is
already persisted in the `refresh_tokens` table with `kind='oauth'` and
the same `dpop_jkt`.

## Plumbing OAuth tokens into XRPC handlers

The front half mints tokens; the back half lets clients *use* them.
Wave 9B closes the loop in `src/pds/auth/middleware.ts`:

```ts
export async function requireOauthAccess(args: {
  authorization?: string
  dpopProof?: string
  request: Request
  opts?: AuthOptions
}): Promise<AuthenticatedAccount & { scope: string }>

export async function requireEitherAuth(args: {
  authorization?: string
  dpopProof?: string
  request: Request
  opts?: AuthOptions
}): Promise<AuthenticatedAccount & { scope: string }>
```

A client paired with an OAuth token sends:

```
Authorization: DPoP <oauth-access-jwt>
DPoP: <proof-jwt>
```

The dispatcher in `src/pds/xrpc/server.ts` carries the paired `DPoP:`
header alongside the existing `Authorization` header in `HandlerCtx.dpopProof`
— literally just `request.headers.get('dpop')`. Handlers that opt in call
`requireEitherAuth({ authorization, dpopProof, request })`, which:

1. **Inspects the scheme.** `Bearer …` delegates to the chapter-13
   `requireAccessAuth` and tags the result with `scope: 'session'`.
   `DPoP …` delegates to `requireOauthAccess` and tags the result with
   the scope claim from the OAuth token. Anything else is an
   `Unauthorized` `InvalidToken`.
2. **For DPoP:** strip the prefix, verify the access JWT against our
   OAuth public key, then verify the proof JWT with `expectedJkt` set to
   the token's `cnf.jkt`. The proof's `htm` / `htu` must match the live
   request — that's the proof-of-possession binding. Missing `DPoP:` is
   `AuthMissing`; jkt mismatch / replay / signature failure is
   `InvalidToken`.
3. **Loads the account** by the token's `sub` and applies the same
   active / deactivated gate the legacy flow uses.

We *don't* migrate every handler. The two schemes are equivalent on
endpoints that just need "the caller is this DID" — the legacy
session JWT is still the first-party PDS flow for the official client,
and migrating fifty handlers wholesale would be a lot of mechanical
diff for no behaviour change. Instead, handlers opt in case-by-case.
`com.atproto.server.getSession` is the first to do so: it's the most
natural OAuth resource (an `at://me` lookup) and a good template for
the rest. Every other handler still calls `requireAccessAuth` and
accepts only the legacy scheme — including `com.atproto.repo.createRecord`,
`updateHandle`, and the admin surface — until they too get migrated.

When you migrate a handler, the change is two lines:

```diff
- import { requireAccessAuth } from '~/pds/auth/middleware'
+ import { requireEitherAuth } from '~/pds/auth/middleware'

- const handler: Handler = async ({ authorization }) => {
-   const me = await requireAccessAuth(authorization)
+ const handler: Handler = async ({ authorization, dpopProof, request }) => {
+   const me = await requireEitherAuth({ authorization, dpopProof, request })
```

The returned `me` carries an additional `scope` field — `'session'` if
the caller used the legacy flow, or the OAuth token's `scope` claim if
they used DPoP. Future scope-aware enforcement (rejecting a narrow
`atproto` token from a `com.atproto.repo.applyWrites` call, say) lives
in the handler that knows what scope it requires.

## What's still missing

🚧 **Production DPoP replay cache.** The in-process cache in
`src/pds/oauth/dpop.ts` works for a single PDS process. Multi-process
deploys need a shared cache (Redis) or accept the small replay window
across processes as a manageable risk.

## Try it

The end-to-end flow — DPoP keypair, PAR push, consent-page sign-in, token
redemption — is in the "Run it locally" section above. The shorter
"poke the discovery surface" variant:

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
```

The refresh-only path (assuming you already have a refresh token from
the authorization-code flow) looks like:

```ts
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
the `cnf.jkt` claim — that's the thumbprint of the DPoP key you
generated up front.

Finally, use the access token to call a real XRPC endpoint —
`getSession` is the first one to accept the DPoP scheme:

```ts
const getSessionUrl = 'http://localhost:3000/xrpc/com.atproto.server.getSession'
const getSessionProof = await dpopProof('GET', getSessionUrl)
const me = await fetch(getSessionUrl, {
  method: 'GET',
  headers: {
    authorization: `DPoP ${access_token}`,
    dpop: getSessionProof,
  },
}).then((r) => r.json())
console.log(me)
// → { did, handle, email, emailConfirmed: true, didDoc, active: true }
```

The proof must be fresh — try the same fetch twice and the second one
fails with `InvalidToken` because the `jti` is now in the replay cache.

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

3. Read `requireOauthAccess` in `src/pds/auth/middleware.ts`. It composes
   `verifyOauthAccessToken` (signature + claims) and `verifyDpopProof`
   (proof-of-possession on this request). What error names does it
   raise, and which one fires when (a) the `DPoP:` header is missing,
   (b) the proof's key thumbprint doesn't match the token's `cnf.jkt`,
   (c) the proof's `htm` says POST but the request is a GET? Cross-
   reference the chapter-13 `Unauthorized` / `Forbidden` taxonomy.

## Up next

This is the end of the back half of OAuth. The next session takes on the
front half: authorize, PAR, client metadata, PKCE, the consent UI.
Together they'll let real third-party clients onboard a Bluesky user
without ever touching the password.

← [20 — Migration](./20-migration.md) ·
[Table of contents](./README.md)
