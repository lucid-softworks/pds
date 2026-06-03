# `xrpc/` — The HTTP API layer

[XRPC](https://atproto.com/specs/xrpc) is the convention by which AT Protocol
servers expose lexicon-defined procedures over HTTP. The shape is simple:

- `GET /xrpc/<nsid>?param=value` — a *query*.
- `POST /xrpc/<nsid>` with a JSON or binary body — a *procedure*.

This module contains:

- `server.ts` — the dispatcher: route `/xrpc/:nsid` to a handler, validate the
  input against its lexicon, validate the output before returning, translate
  errors into the canonical `{ error, message }` envelope. Also: a rate-limit
  gate, per-request structured logging, and the proxy branch (below).
- `handlers/` — one file per NSID, grouped by namespace. Each handler is
  registered with the dispatcher at startup.
- `proxy.ts` — when an inbound request carries `Atproto-Proxy:
  <did>#<service-id>` AND the NSID isn't local (e.g. `app.bsky.actor.getProfile`),
  the dispatcher forwards it to the target service signed with a one-shot
  ES256K JWT minted from the caller's repo key. Local NSIDs are served
  locally regardless of the header. See chapter 17.
- `rate_limit.ts` — pluggable `RateLimitStore` interface plus an in-process
  token-bucket default. Hot paths (createSession, createAccount, password
  reset, putRecord, …) are gated per-IP per-NSID.
- `lexicon-bridge.ts` — wires the standalone lexicon validator (chapter 9)
  to the dispatcher. Validation is observe-only by default; flip
  `LEXICON_STRICT=true` to hard-reject mismatches.
- `errors.ts` — the canonical `XrpcError` type and its named constructors.

In TanStack Start, the dispatcher is mounted under `src/routes/xrpc/`.

See **[Chapter 10 — XRPC](../../../docs/10-xrpc.md)** and
**[Chapter 17 — PDS vs AppView vs Relay](../../../docs/17-pds-appview-relay.md)**
for the proxy side.
