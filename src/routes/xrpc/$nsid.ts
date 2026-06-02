// TanStack Start API route: /xrpc/:nsid
//
// One catch-all route that hands off to the XRPC dispatcher. The handler
// registry lives in src/pds/xrpc/handlers/index.ts — adding a new endpoint
// only requires editing that file + dropping a handler module.
//
// In TanStack Start ≥ 1.166 server routes live on a regular createFileRoute
// via the `server.handlers` config. (Older `createServerFileRoute` from
// @tanstack/react-start/server is gone.)

import { createFileRoute } from '@tanstack/react-router'
import { dispatch } from '~/pds/xrpc/server'
import { registry } from '~/pds/xrpc/handlers'

export const Route = createFileRoute('/xrpc/$nsid')({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        dispatch(registry, params.nsid, request),
      POST: async ({ request, params }) =>
        dispatch(registry, params.nsid, request),
    },
  },
})
