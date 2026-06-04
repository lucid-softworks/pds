// XRPC handler: tools.ozone.report.refreshStats
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/report/refreshStats.json
//
// In upstream Ozone this triggers a Redis-backed counter rebuild. Our
// implementation computes stats live from SQL on every read, so this
// endpoint is a no-op that exists for client compatibility. Returns
// `{ refreshed: true }` and the wall-clock time of the call.

import type { Handler, HandlerDef } from '../server'
import { requireModerator } from '~/pds/mod/auth'

const handler: Handler = async ({ authorization }) => {
  await requireModerator(authorization)
  return {
    refreshed: true,
    refreshedAt: new Date().toISOString(),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.report.refreshStats'
