// XRPC handler: com.atproto.server.checkSignupQueue
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/checkSignupQueue.json
//
// Upstream Bluesky.app uses this for a soft launch / waiting-list flow. A
// self-hosted PDS has no queue, so we return "you're activated, no wait" for
// every caller. Unauthenticated; clients poll it.

import type { Handler, HandlerDef } from '../server'

const handler: Handler = async () => ({
  activated: true,
  placeInQueue: 0,
  estimatedTimeMs: 0,
})

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.server.checkSignupQueue'
