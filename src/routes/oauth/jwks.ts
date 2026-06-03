// TanStack Start API route: /oauth/jwks
//
// Publishes the PDS's OAuth signing key as a JWKS so OAuth clients can
// verify the access + refresh tokens we issue. Only the public half is here;
// the private scalar lives in the PDS_OAUTH_SIGNING_KEY env var.
//
// See chapter 21 — OAuth.

import { createFileRoute } from '@tanstack/react-router'
import { getOauthSigningKey } from '~/pds/oauth/keys'

export const Route = createFileRoute('/oauth/jwks')({
  server: {
    handlers: {
      GET: async () => {
        try {
          const key = await getOauthSigningKey()
          const body = { keys: [key.publicJwk] }
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              // OAuth clients cache JWKS aggressively; 1h is a sensible
              // upper bound when the key rarely (if ever) rotates in dev.
              'cache-control': 'public, max-age=3600',
            },
          })
        } catch (err) {
          return new Response(
            JSON.stringify({
              error: 'server_error',
              error_description: (err as Error).message,
            }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          )
        }
      },
    },
  },
})
