// XRPC handler: com.atproto.label.subscribeLabels (placeholder)
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/label/subscribeLabels.json
//
// `subscribeLabels` is a WebSocket *subscription* like
// `subscribeRepos`. The dispatcher only returns Response objects, so
// the real subscription endpoint is mounted by an HTTP-upgrade hook on
// the underlying Node http.Server — see `firehose-mount.ts` (dev) and
// `server.ts` (prod).
//
// This handler exists so the registry advertises the NSID. Anyone who
// hits it over plain HTTP gets a 400 pointing them at the WS URL.

import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'

const handler: Handler = async ({ request }) => {
  const url = new URL(request.url)
  const wsUrl = `ws://${url.host}/xrpc/com.atproto.label.subscribeLabels`
  throw BadRequest(
    `subscribeLabels is a WebSocket subscription — connect with ${wsUrl}?cursor=N`,
    'InvalidRequest',
  )
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.label.subscribeLabels'
