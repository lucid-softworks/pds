// TanStack Start API route: /oauth/authorize  (NOT YET IMPLEMENTED)
//
// The user-facing OAuth authorization endpoint. A real implementation here
// would:
//
//   1. Look up the PAR-pushed request by `request_uri` (only PAR-mode is
//      supported on atproto OAuth — clients can't pass parameters in the
//      browser URL).
//   2. Resolve the client metadata from the `client_id` URL and validate it
//      against the request (redirect_uri allowlist, scope, dpop_jkt, …).
//   3. Render a consent UI to the logged-in user (or redirect to login).
//   4. On approval, mint an authorization code bound to the DPoP key and
//      PKCE challenge, store it server-side, and redirect to the client's
//      `redirect_uri` with the code.
//
// This session ships the back half of OAuth (token endpoint, JWKS, metadata,
// revoke). The browser-facing pieces are a follow-on session. See
// chapter 21 — OAuth, "What's still missing".

import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/oauth/authorize')({
  server: {
    handlers: {
      GET: async () => notImplemented(),
      POST: async () => notImplemented(),
    },
  },
})

function notImplemented(): Response {
  return new Response(
    JSON.stringify({
      error: 'temporarily_unavailable',
      error_description:
        '/oauth/authorize is not yet implemented in this PDS; see chapter 21 — OAuth.',
    }),
    {
      status: 501,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  )
}
