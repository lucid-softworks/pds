// Cross-Origin Resource Sharing for ATproto XRPC + discovery endpoints.
//
// Browsers refuse to read cross-origin fetch responses unless the server
// opts in with `Access-Control-*` headers. ATproto is *fundamentally*
// cross-origin — bsky.app at https://bsky.app calls
// https://your-pds.example/xrpc/* directly; every alternative client does
// the same — so the lack of these headers in the original implementation
// silently broke every external client. Same for did.json and the OAuth
// metadata docs that AppViews / Relays / OAuth clients fetch.
//
// We allow `*` because all XRPC routes either:
//   - take bearer auth in the `Authorization` header (NOT cookies), so
//     `Access-Control-Allow-Credentials` stays unset and `*` is fine; or
//   - are unauthenticated discovery endpoints (.well-known/*).
//
// The headers list mirrors what `@atproto/api`'s default fetch client
// sends: `Content-Type`, `Authorization`, `Atproto-Accept-Labelers`,
// `Atproto-Proxy`, and the DPoP family for chapter-21 OAuth tokens.
//
// See chapter 10 — XRPC.

// `*` works because we never set `Access-Control-Allow-Credentials: true`
// (no cookies — auth is bearer-only). Per the Fetch spec, ACAH=* and
// ACEH=* are the wildcards for non-credentialed requests: they allow ALL
// request headers (including custom ones like `x-bsky-topics`,
// `x-bsky-tier`, etc. that future bsky.app clients keep adding) and
// expose ALL response headers (including ones we haven't anticipated
// like `ratelimit-*`, `dpop-nonce`, etc.) to caller JavaScript.
// Enumerating ATProto's full per-client header set would be a
// never-ending bug magnet — every client release adds another `x-*`.
const ALLOW_HEADERS = '*'
const ALLOW_METHODS = 'GET, POST, OPTIONS'
const EXPOSE_HEADERS = '*'

/** Merge CORS headers onto a Response. Pass any existing Response through
 *  to add the headers without losing the body / status / other headers. */
export function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  setCorsHeaders(headers)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Handle an OPTIONS preflight. Returns 204 with the right headers. */
export function corsPreflight(): Response {
  const headers = new Headers()
  setCorsHeaders(headers)
  // RFC 7231 §6.3.5 — empty body is fine on 204.
  headers.set('content-length', '0')
  return new Response(null, { status: 204, headers })
}

function setCorsHeaders(headers: Headers): void {
  headers.set('access-control-allow-origin', '*')
  headers.set('access-control-allow-methods', ALLOW_METHODS)
  headers.set('access-control-allow-headers', ALLOW_HEADERS)
  headers.set('access-control-expose-headers', EXPOSE_HEADERS)
  // Cache preflights for an hour. The lexicon set + our header list are
  // stable per deploy; longer is fine, shorter would just add load.
  headers.set('access-control-max-age', '3600')
}
