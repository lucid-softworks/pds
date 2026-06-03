// TanStack Start API route: /.well-known/:file
//
// We serve a handful of discovery documents from here:
//
//   - /.well-known/did.json — the PDS's own DID document (chapter 17).
//   - /.well-known/oauth-authorization-server — RFC 8414 metadata for our
//     OAuth role as an authorization server (chapter 21).
//   - /.well-known/oauth-protected-resource — RFC 9728 metadata for our
//     OAuth role as a protected resource (chapter 21).
//
// A catch-all keeps the file-routing tractable: a literal-dot route like
// `did[.]json.ts` exists in newer TanStack Router, but a single $file
// parameter we dispatch on internally is the simplest shape that survives
// framework version churn.

import { createFileRoute } from '@tanstack/react-router'
import { getConfig } from '~/lib/config'
import {
  authServerMetadata,
  protectedResourceMetadata,
} from '~/pds/oauth/metadata'

export const Route = createFileRoute('/.well-known/$file')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (params.file === 'did.json') {
          const cfg = getConfig()
          const doc = {
            '@context': ['https://www.w3.org/ns/did/v1'],
            id: cfg.serviceDid,
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: cfg.publicUrl,
              },
            ],
          }
          return jsonResponse(doc)
        }
        if (params.file === 'oauth-authorization-server') {
          return jsonResponse(authServerMetadata())
        }
        if (params.file === 'oauth-protected-resource') {
          return jsonResponse(protectedResourceMetadata())
        }
        return new Response('not found', { status: 404 })
      },
    },
  },
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
