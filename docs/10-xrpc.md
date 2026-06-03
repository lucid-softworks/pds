# XRPC: HTTP API conventions

The AT Protocol's RPC layer is called **XRPC**. The name promises something
heavyweight; the reality is a small set of conventions over plain HTTP that
make a method's URL, body shape, error envelope, and authentication
behavior derivable from its lexicon name.

This chapter walks the conventions and the dispatcher that implements them
(`src/pds/xrpc/server.ts`).

## The shape

Every XRPC method has an NSID and is one of three shapes:

| Shape | HTTP | URL |
| --- | --- | --- |
| **Query** | GET | `/xrpc/<nsid>?p=v&q=w` |
| **Procedure** | POST | `/xrpc/<nsid>` with a JSON or binary body |
| **Subscription** | WebSocket upgrade | `/xrpc/<nsid>?cursor=N` |

There's no third URL pattern, no path templating, no nested resources. The
NSID *is* the route. `com.atproto.server.createSession` lives at
`/xrpc/com.atproto.server.createSession` and nowhere else.

That makes the dispatcher's job almost embarrassingly simple — split the
path on `/xrpc/`, look up the NSID in a map, call the handler.

## The dispatcher

`src/pds/xrpc/server.ts` is about 100 lines and does five things:

1. **Route** by NSID. The registry is a `Map<string, HandlerDef>`.
2. **Method-check.** Reject if the HTTP method doesn't match the lexicon's
   declared method (`GET` for queries, `POST` for procedures).
3. **Read input.** Procedures with `application/json` bodies get parsed;
   procedures with binary bodies (`uploadBlob`) get the raw request handed
   in.
4. **Call the handler** with a context that includes the parsed input,
   query parameters, the Authorization header, and the raw `Request`.
5. **Format the response.** The handler's return value becomes the JSON
   body — *unless* the handler returns a `Response` instance, in which
   case it's passed through unchanged. That's how binary endpoints
   (`getBlob`, `getRepo`) stream bytes back.

The whole thing:

```ts
const def = registry.get(nsid)
if (!def) return jsonResponse(NotFound(`unknown XRPC method: ${nsid}`, 'MethodNotImplemented'))
if (request.method !== def.method) return jsonResponse(BadRequest(...))

try {
  const input = await readJsonBody(request)
  const params = Object.fromEntries(new URL(request.url).searchParams)
  const output = await def.handler({ input, params, authorization, request })
  if (output instanceof Response) return output
  return new Response(JSON.stringify(output), { status: 200, headers: { ... } })
} catch (err) {
  if (err instanceof XrpcError) return jsonResponse(err)
  return jsonResponse(InternalError())
}
```

Everything past "route by NSID" is plumbing. The interesting work is in
the per-NSID handler files.

## Per-NSID handlers

Handlers live under `src/pds/xrpc/handlers/`, one file per endpoint, named
after the NSID:

```
src/pds/xrpc/handlers/
├── com.atproto.server.createAccount.ts
├── com.atproto.server.createSession.ts
├── com.atproto.server.refreshSession.ts
├── com.atproto.repo.createRecord.ts
├── com.atproto.repo.uploadBlob.ts
├── com.atproto.sync.getRepo.ts
├── ...
└── index.ts                                    ← the registry
```

Every handler module exports two symbols:

```ts
export const nsid = 'com.atproto.server.createAccount'
export const def: HandlerDef = { method: 'POST', handler }
```

…and the registry (`handlers/index.ts`) imports them all and wires up:

```ts
export const registry = new HandlerRegistry()
  .register(createAccount.nsid, createAccount.def)
  .register(createSession.nsid, createSession.def)
  // ...
```

Adding a new endpoint is two files: the handler module and one line in
the registry.

## Mounting in TanStack Start

The HTTP layer is just a single catch-all route:

```ts
// src/routes/xrpc/$nsid.ts
import { createServerFileRoute } from '@tanstack/react-start/server'
import { dispatch } from '~/pds/xrpc/server'
import { registry } from '~/pds/xrpc/handlers'

export const ServerRoute = createServerFileRoute().methods({
  GET:  async ({ request, params }) => dispatch(registry, params.nsid, request),
  POST: async ({ request, params }) => dispatch(registry, params.nsid, request),
})
```

TanStack Start owns the HTTP plumbing — request parsing, body size limits,
error fall-throughs, etc. The XRPC dispatcher owns the protocol-specific
parts. Two small layers, clearly separated.

## The error envelope

Every error response is JSON of the same shape:

```json
{
  "error": "RecordNotFound",
  "message": "no record at at://did:plc:.../app.bsky.feed.post/3lhq..."
}
```

The `error` field is a machine-readable tag drawn from the lexicon's
`errors` declaration. The `message` is human-readable and never
machine-parsed. The HTTP status code matches the *category* of error:

| Status | Meaning |
| --- | --- |
| 400 | Client sent malformed or invalid input |
| 401 | No auth, or invalid auth |
| 403 | Auth was valid but the operation isn't allowed |
| 404 | The named resource doesn't exist |
| 409 | Conflict (handle taken, swap-CID mismatch) |
| 413 | Payload too large |
| 500 | Server error — we crashed |

`src/pds/xrpc/errors.ts` exports constructors for each:

```ts
throw BadRequest('email already registered', 'EmailNotAvailable')
throw Unauthorized('token expired', 'ExpiredToken')
throw Conflict('handle taken', 'HandleNotAvailable')
```

Handlers throw `XrpcError`; the dispatcher catches and translates to the
canonical envelope. Anything else thrown becomes a 500. The dispatcher
logs unexpected exceptions with the NSID so they're traceable.

> 📖 **Why a separate `error` tag?** A 404 from `getRecord` and a 404 from
> `getRepo` are both "not found" — but the client needs to know *which*
> thing wasn't found to decide what to do. The tag is the machine-actionable
> part; the HTTP status is the human-glance summary.

## Authentication

Most endpoints fall into one of three auth categories:

- **None.** Public reads: `describeServer`, `resolveHandle`, `getRecord`,
  `getRepo`. Anyone can call.
- **Access token required.** Anything that writes (`createRecord`,
  `uploadBlob`) or reads private data (`getSession`). Bearer token in
  `Authorization`.
- **Refresh token required.** Only `refreshSession` and `deleteSession`.
  Also a bearer token, but verified differently (signature + database
  presence check).

The auth machinery lives in `src/pds/auth/middleware.ts`. Handlers that
need auth call `requireAccessAuth(ctx.authorization)` early — it returns
the authenticated account or throws the right `XrpcError`. Chapter 13
covers the details.

## Input shapes

Three patterns:

### JSON body (most procedures)

```ts
const handler: Handler = async (ctx) => {
  const input = parseInput(ctx.input)  // zod schema, will be lexicon-driven later
  const account = await requireAccessAuth(ctx.authorization)
  // ...
}
```

`ctx.input` is the already-parsed JSON, typed `unknown`. The handler
validates it before use. Today the validators are hand-written `zod`
schemas; once the lexicon validator lands they'll be derived from the
lexicon files instead.

### Binary body (`uploadBlob`)

```ts
const handler: Handler = async (ctx) => {
  const bytes = new Uint8Array(await ctx.request.arrayBuffer())
  const mimeType = ctx.request.headers.get('content-type') ?? 'application/octet-stream'
  // ...
}
```

The dispatcher leaves binary bodies alone — they're whatever the client
sent. Handlers read from `ctx.request` directly. Size limits are
enforced per-handler (5 MB for `uploadBlob`).

### Query params (queries)

```ts
const handler: Handler = async (ctx) => {
  const did = ctx.params.did
  if (!did) throw BadRequest('did required')
  // ...
}
```

`ctx.params` is the parsed query string as a flat object. Repeated keys
(e.g. `?cids=A&cids=B`) need a second look — the dispatcher only keeps
the *last* value for each key in the flat object, so handlers that
expect repeated params extract them from `ctx.request.url` directly.

## Streaming responses

The binary-passthrough exists for two endpoints today:

- `com.atproto.sync.getBlob` — streams blob bytes from the configured
  store.
- `com.atproto.sync.getRepo` — streams a CAR of the repo's blocks.

Both build a `ReadableStream<Uint8Array>` and wrap it in a `Response` with
the right `Content-Type`:

```ts
return new Response(stream, {
  headers: {
    'content-type': 'application/vnd.ipld.car',
    'cache-control': 'no-store',
  },
})
```

The dispatcher's `if (output instanceof Response) return output` check is
what makes this work end-to-end. Three lines of code in the dispatcher
unlock arbitrarily large streaming responses without putting bytes in
memory.

> ⚠️ **The firehose is *not* part of XRPC's HTTP dispatcher.**
> `com.atproto.sync.subscribeRepos` is a WebSocket upgrade, handled by a
> separate subsystem (chapter 16). The dispatcher only deals with
> request/response. Upgrades to long-lived streams need their own
> wiring.

## How the lexicon validator hooks in

The dispatcher calls `validateInbound` before the handler and
`validateOutbound` after it — both from
`src/pds/xrpc/lexicon-bridge.ts`. They look the NSID up in the bundled
catalog, compile the schemas once (cached forever), and run them on
each request.

Today the bridge is **observe-only**: a mismatch logs
`[lexicon:input] com.atproto.server.createAccount: handle: missing
required field` and otherwise lets the handler run normally. Handlers
still own validation through `zod` schemas they wrote by hand.

To turn the observer into a hard reject, set `LEXICON_STRICT=true` in
the environment. The validator's `ValidationError` becomes an HTTP 400
`InvalidRequest` response and the handler doesn't run. We don't flip
that by default yet because:

1. ~half the bundled lexicons are still stubs (`"main": {"type":
   "object"}`) and would reject everything. We'd lose endpoints until
   those are transcribed.
2. The query-param coerce step in the bridge is best-effort
   (`true/false/123` get typed; everything else stays a string).
   That's good enough to observe; we want a proper type-aware decoder
   before rejecting on it.

The next two steps — finish transcribing the stubs and replace the
zod schemas with lexicon-driven inputs — are chapter 9's "what's next."
The seam already exists; the migration is mechanical.

## Cross-origin requests

Every real ATproto client — bsky.app, the official mobile apps, every
alternate client — calls XRPC on this PDS from a **different origin**
than the one hosting it. Browsers refuse to read the response unless
the server explicitly opts in with `Access-Control-Allow-*` headers,
so the PDS sets them on every response. The wiring lives at the edge,
not per-route:

- `src/lib/cors.ts` — the canonical header set (`*` origin, the methods
  and headers ATproto clients actually send, the response headers
  worth surfacing).
- `server.ts` — wraps every prod response in `withCors()` and
  short-circuits `OPTIONS` to a 204 preflight before the fetch handler
  even sees it.
- `src/lib/cors-vite-plugin.ts` — mirrors the same behaviour on the
  Vite dev server so dev and prod don't disagree.

Two things to know:

1. **Allow-Origin is `*`, not `Origin` echoed back.** Safe because no
   XRPC route reads cookies: auth is bearer-JWT in the `Authorization`
   header. The combination of `Allow-Origin: *` and any credentialed
   request is rejected by browsers anyway, so even if a future route
   added cookies, this wouldn't accidentally leak them.
2. **DPoP-Nonce and WWW-Authenticate are in `Expose-Headers`.** The
   chapter-21 OAuth flows need clients to read those response headers
   directly; without `Expose-Headers` the browser hides them from
   JavaScript even when the request succeeded.

If you add a new top-level route that isn't expected to be called by
external clients (an admin-only HTML page, say), it still gets CORS for
free — there's no harm, and removing it would be a per-route
exception you'd have to remember.

## Try it

The PDS exposes a tiny number of endpoints today; the full set will grow.
What's there:

```bash
# No auth required:
curl -s http://localhost:3000/xrpc/com.atproto.server.describeServer | jq

# Walk the full flow with the demo script:
scripts/demo.sh
```

The demo registers a fresh account, logs in, posts, reads back, refreshes,
logs out. Reading that script is reading a quarter-tour of the codebase.

## Exercises

1. The dispatcher rejects an XRPC method whose HTTP verb doesn't match
   the registry's declared method. Why is this important? What could go
   wrong if `createRecord` accepted `GET`?
2. The error envelope is always JSON, even when the request asked for
   `application/vnd.ipld.car`. Is this a bug? When would a CAR-shaped
   error response make sense?
3. The dispatcher catches `XrpcError` and any other thrown value. What
   happens if a handler throws a string (`throw 'oops'`) instead of an
   Error? Why is this caught and what's lost?
4. Build a sketch of a `com.acme.notes.create` procedure that lives
   outside the `com.atproto.*` namespace. What changes — if anything —
   in the dispatcher? In the handler registry? In the lexicon needed to
   validate it?

## Up next

[Chapter 11](./11-database-schema.md) walks the Postgres schema every
handler ends up touching. [Chapter 13](./13-authentication.md) digs into
the auth middleware referenced above.

← [09 — Lexicons](./09-lexicons.md) · → [11 — Database schema](./11-database-schema.md)
