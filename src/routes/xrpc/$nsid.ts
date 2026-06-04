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
import { sql } from 'drizzle-orm'
import { dispatch } from '~/pds/xrpc/server'
import { registry } from '~/pds/xrpc/handlers'
import { getVersion } from '~/lib/version'

// `_health` isn't a normal NSID — the reference PDS serves it from an
// express router *outside* the XRPC pipeline (see basic-routes.ts in
// bluesky-social/atproto). We short-circuit here instead of registering
// a handler so it can't be accidentally tagged with the auth / lexicon
// machinery that real NSIDs go through.
async function handleHealth(): Promise<Response> {
  const version = getVersion()
  try {
    const { db } = await import('~/lib/db')
    await db.execute(sql`select 1`)
    return new Response(JSON.stringify({ version }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  } catch {
    return new Response(
      JSON.stringify({ version, error: 'Service Unavailable' }),
      {
        status: 503,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    )
  }
}

export const Route = createFileRoute('/xrpc/$nsid')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (params.nsid === '_health') return handleHealth()
        return dispatch(registry, params.nsid, request)
      },
      POST: async ({ request, params }) =>
        dispatch(registry, params.nsid, request),
    },
  },
})
