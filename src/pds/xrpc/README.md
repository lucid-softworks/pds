# `xrpc/` — The HTTP API layer

[XRPC](https://atproto.com/specs/xrpc) is the convention by which AT Protocol
servers expose lexicon-defined procedures over HTTP. The shape is simple:

- `GET /xrpc/<nsid>?param=value` — a *query*.
- `POST /xrpc/<nsid>` with a JSON or binary body — a *procedure*.

This module contains:

- `server.ts` — the dispatcher: route `/xrpc/:nsid` to a handler, validate the
  input against its lexicon, validate the output before returning, translate
  errors into the canonical `{ error, message }` envelope.
- `handlers/` — one file per NSID, grouped by namespace. Each handler is
  registered with the dispatcher at startup.
- `errors.ts` — the canonical `XrpcError` type.

In TanStack Start, the dispatcher is mounted under `src/routes/xrpc/`.

See **[Chapter 10 — XRPC](../../../docs/10-xrpc.md)**.
