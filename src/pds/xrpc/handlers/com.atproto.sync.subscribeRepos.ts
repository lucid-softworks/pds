// XRPC handler: com.atproto.sync.subscribeRepos (placeholder)
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/subscribeRepos.json
//
// subscribeRepos is a WebSocket *subscription*, not a request/response RPC.
// The HTTP dispatcher in `src/pds/xrpc/server.ts` only knows how to return
// `Response` objects, so the real subscription endpoint is mounted upstream
// of the dispatcher by a Vite dev-server plugin (see `vite.config.ts`).
//
// This handler exists so the registry advertises the NSID. Anyone who hits
// it over plain HTTP gets a 400 pointing them at the WebSocket URL.

import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'

const handler: Handler = async ({ request }) => {
  const url = new URL(request.url)
  const wsUrl = `ws://${url.host}/xrpc/com.atproto.sync.subscribeRepos`
  throw BadRequest(
    `subscribeRepos is a WebSocket subscription — connect with ${wsUrl}?cursor=N`,
    'InvalidRequest',
  )
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.sync.subscribeRepos'
