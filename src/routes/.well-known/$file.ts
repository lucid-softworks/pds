// TanStack Start API route: /.well-known/:file
//
// We serve `/.well-known/did.json` from here — the PDS's own DID document
// for did:web identity. A catch-all keeps the file-routing tractable: a
// literal-dot route like `did[.]json.ts` exists in newer TanStack Router,
// but a single $file parameter we dispatch on internally is the simplest
// shape that survives framework version churn.
//
// See chapter 17 — PDS vs AppView vs Relay.

import { createFileRoute } from '@tanstack/react-router'
import { getConfig } from '~/lib/config'

export const Route = createFileRoute('/.well-known/$file')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (params.file !== 'did.json') {
          return new Response('not found', { status: 404 })
        }
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
        return new Response(JSON.stringify(doc), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        })
      },
    },
  },
})
