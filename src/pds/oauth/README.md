# `oauth/` — OAuth 2.1 + DPoP + PAR + PKCE

The PDS doubles as an OAuth 2.1 **authorization server** (issuing access /
refresh tokens to third-party clients on behalf of one of its users) AND
as a **resource server** (accepting those tokens to scope-gate its XRPC
surface). Atproto's OAuth profile mandates PAR (RFC 9126), PKCE (RFC
7636), and DPoP-bound tokens (RFC 9449) for every flow — see
`/.well-known/oauth-authorization-server` for the published metadata.

## Files

- [`metadata.ts`](./metadata.ts) — the RFC 8414 + RFC 9728 discovery
  documents served at `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource`. Single source of truth for
  what endpoints we expose, which DPoP algs we accept, which token
  endpoint auth methods we support.
- [`clients.ts`](./clients.ts) — fetches and validates a client's
  `client_id` URL (the canonical atproto client identity), checks the
  hosted JSON document, normalises the `redirect_uris` list.
- [`keys.ts`](./keys.ts) — the PDS's own ES256K signing keypair. Reads
  the hex private scalar from `PDS_OAUTH_SIGNING_KEY`, derives the
  public JWK we publish at `/oauth/jwks`. Cached after first import.
- [`pkce.ts`](./pkce.ts) — `verifyPkce({ verifier, challenge, method:
  'S256' })`. Only S256 is accepted per the spec.
- [`dpop.ts`](./dpop.ts) — `verifyDpopProof({ dpopHeader, httpMethod,
  httpUri, expectedJkt? })`. Verifies the proof's JWK signature, the
  `htm`/`htu` binding, the `iat` window, and (when given) the
  proof-of-possession against the access token's `cnf.jkt`.
- [`dpop_store.ts`](./dpop_store.ts) — the **DPoP replay store**: the
  spec requires us to remember each proof's `jti` for ~60s so a captured
  proof can't be replayed. Pluggable: an in-memory `Map` is the default
  (`PDS_DPOP_REPLAY_STORE=in-memory`); a Redis backend stub exists for
  multi-replica deploys.
- [`tokens.ts`](./tokens.ts) — `signOauthAccessToken`,
  `signOauthRefreshToken`, `consumeOauthCode`,
  `consumeOauthRefreshToken`, `verifyOauthAccess`. All tokens are
  ES256K JWTs (`typ: at+jwt` / `typ: refresh+jwt`), with the access
  token carrying `cnf.jkt` for the DPoP binding.

## Wire shape

The five HTTP endpoints under `/oauth/*` are TanStack Start file
routes (`src/routes/oauth/*.ts`). They sit on top of this module:

| Endpoint | RFC | What it does |
|----------|-----|--------------|
| `POST /oauth/par` | RFC 9126 | Accept full authorize parameters out-of-band, return a `request_uri`. |
| `GET /oauth/authorize` | RFC 6749 §4.1.1 | Render the login + consent screen. The client points the user here with `?request_uri=urn:…`. |
| `POST /oauth/token` | RFC 6749 §3.2 | `grant_type=authorization_code` (first issuance) and `grant_type=refresh_token` (rotation). DPoP-bound. |
| `POST /oauth/revoke` | RFC 7009 | Drop a refresh token's row. Always 200; never leaks whether the token was valid. |
| `GET /oauth/jwks` | RFC 7517 | Publish the public half of `PDS_OAUTH_SIGNING_KEY` so clients can verify our access tokens. |

Authorization codes are one-shot (deleted on first redeem); refresh
tokens are single-use and rotated on every call. PAR rows live for 60
seconds; codes for 60 seconds; access tokens for 1 hour by default;
refresh tokens for 30 days.

See **[Chapter 21 — OAuth](../../../docs/21-oauth.md)**.
