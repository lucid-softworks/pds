// TanStack Start API route: /xrpc/:nsid
//
// One catch-all route that hands off to the XRPC dispatcher. The handler
// registry lives in src/pds/xrpc/handlers/index.ts — adding a new endpoint
// only requires editing that file + dropping a handler module.

import { createServerFileRoute } from '@tanstack/react-start/server'
import { dispatch } from '~/pds/xrpc/server'
import { registry } from '~/pds/xrpc/handlers'

export const ServerRoute = createServerFileRoute().methods({
  GET: async ({ request, params }) => {
    return dispatch(registry, params.nsid, request)
  },
  POST: async ({ request, params }) => {
    return dispatch(registry, params.nsid, request)
  },
})
