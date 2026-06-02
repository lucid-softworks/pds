// XRPC handler: com.atproto.identity.signPlcOperation
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/identity/signPlcOperation.json
//
// Stub. Pairs with requestPlcOperationSignature: the caller submits the
// unsigned op + the token, we counter-sign with the server-held rotation
// key, and return the signed bytes for them to publish. Tracked for a
// future session.

import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { requireAccessAuth } from '~/pds/auth/middleware'

const handler: Handler = async ({ authorization }) => {
  await requireAccessAuth(authorization)
  throw BadRequest(
    'signPlcOperation is not implemented in this PDS yet',
    'MethodNotImplemented',
  )
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.identity.signPlcOperation'
