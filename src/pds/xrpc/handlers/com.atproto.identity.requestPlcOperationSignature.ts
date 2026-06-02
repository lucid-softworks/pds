// XRPC handler: com.atproto.identity.requestPlcOperationSignature
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/identity/requestPlcOperationSignature.json
//
// Stub. The full flow mints a one-shot token authorising a *caller-supplied*
// PLC op (rotation key change, recovery key add, …). It's the escape hatch
// for users who want to drive their own rotation rather than going through
// updateHandle. Tracked for a future session.

import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { requireAccessAuth } from '~/pds/auth/middleware'

const handler: Handler = async ({ authorization }) => {
  await requireAccessAuth(authorization)
  throw BadRequest(
    'requestPlcOperationSignature is not implemented in this PDS yet',
    'MethodNotImplemented',
  )
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.identity.requestPlcOperationSignature'
