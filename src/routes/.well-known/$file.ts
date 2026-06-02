// TanStack Start API route: /.well-known/:file
//
// We serve `/.well-known/did.json` from here — the PDS's own DID document for
// did:web identity. A catch-all keeps the file-routing tractable: TanStack
// treats `did.json.ts` as the nested route `/did/json` (the `.` is the
// segment separator), and there's no escape character at the time of writing,
// so a single $file parameter that we switch on internally is the simplest
// shape that works.
//
// See chapter 17 — PDS vs AppView vs Relay.

import { createServerFileRoute } from '@tanstack/react-start/server'
import { getConfig } from '~/lib/config'

export const ServerRoute = createServerFileRoute().methods({
  GET: async ({ params }) => {
    if (params.file !== 'did.json') {
      return new Response('not found', { status: 404 })
    }
    const cfg = getConfig()
    // The service DID document is intentionally minimal. The PDS itself has
    // no signing key (accounts have signing keys, the *service* doesn't sign
    // anything in our model), so verificationMethod stays empty. The single
    // service entry advertises the PDS endpoint that clients and relays
    // should hit for this hostname.
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
})
