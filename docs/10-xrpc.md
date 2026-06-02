# XRPC: HTTP API conventions

> 🚧 This chapter ships with the `src/pds/xrpc/` session.

[XRPC](https://atproto.com/specs/xrpc) is how AT Protocol servers expose
their lexicon-defined methods over HTTP. The spec is small — most of the
work is the *dispatcher*: route, validate, call handler, validate output,
serialize.

## Outline

1. **Three shapes.**
   - `GET /xrpc/<nsid>?p=v` — query.
   - `POST /xrpc/<nsid>` — procedure (JSON or binary body).
   - `WebSocket /xrpc/<nsid>` — subscription (just the firehose, in
     practice).
2. **Error envelope.** `{ error, message }` for everything; specific NSIDs
   define their own named errors.
3. **The dispatcher.** Generic shell that handles routing + validation +
   error formatting. Handlers stay focused on business logic.
4. **Per-NSID handlers.** One file per endpoint under
   `src/pds/xrpc/handlers/com/atproto/...`. Auth requirements are declared
   per handler.
5. **Mounting in TanStack Start.** API routes under `src/routes/xrpc/`.
6. **Streaming responses.** For `getRepo` (large CAR) and the firehose
   (long-running WebSocket).

## Where the code goes

- `src/pds/xrpc/server.ts` — dispatcher.
- `src/pds/xrpc/errors.ts` — `XrpcError`.
- `src/pds/xrpc/handlers/` — implementations.
- `src/routes/xrpc/` — TanStack Start mounting.

← [09 — Lexicons](./09-lexicons.md) · → [11 — Database schema](./11-database-schema.md)
