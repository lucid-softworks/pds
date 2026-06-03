// TanStack Start API route: POST /oauth/par  (NOT YET IMPLEMENTED)
//
// Pushed Authorization Requests (RFC 9126) — the client POSTs the full
// authorize-request parameters here over the back channel, gets a
// `request_uri` opaque handle, and redirects the user to /oauth/authorize
// with just that handle. Atproto OAuth requires PAR mode for every flow.
//
// A real implementation here would:
//
//   - Validate the client_id metadata document (fetched from the URL).
//   - Validate redirect_uri, scope, code_challenge/_method (S256), dpop_jkt.
//   - Store the parameters server-side under a freshly-minted opaque
//     `request_uri` with a short TTL (~60s).
//   - Return { request_uri, expires_in } to the client.
//
// Deferred to a later session alongside /oauth/authorize. See chapter 21.

import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/oauth/par')({
  server: {
    handlers: {
      POST: async () => notImplemented(),
    },
  },
})

function notImplemented(): Response {
  return new Response(
    JSON.stringify({
      error: 'temporarily_unavailable',
      error_description:
        '/oauth/par is not yet implemented in this PDS; see chapter 21 — OAuth.',
    }),
    {
      status: 501,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  )
}
