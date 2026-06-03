// XRPC handler: com.atproto.identity.resolveHandle
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/identity/resolveHandle.json
//
// Map a handle → DID. Tries the local accounts table first (cheap), then
// falls back to the cross-PDS resolver in `~/pds/did/handle_resolver`,
// which races DNS TXT (`_atproto.<handle>`) and HTTPS
// (`https://<handle>/.well-known/atproto-did`). The cross-PDS path also
// runs the bidirectional check against the resolved DID's document so a
// domain can't unilaterally claim someone else's DID.
//
// The "not found" error returns HTTP 400 (not 404) because that's what the
// lexicon defines — see the `errors` array in the JSON schema.

import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { isValidHandleSyntax } from '~/pds/did/handle'
import { resolveLocalHandle } from '~/pds/did/resolver'
import { resolveHandleExternal } from '~/pds/did/handle_resolver'

const handler: Handler = async ({ params }) => {
  const handle = params.handle?.trim().toLowerCase()
  if (!handle) {
    throw BadRequest('handle parameter is required', 'InvalidRequest')
  }
  if (!isValidHandleSyntax(handle)) {
    throw BadRequest(`invalid handle: ${handle}`, 'InvalidRequest')
  }
  const local = await resolveLocalHandle(handle)
  if (local) return { did: local }

  const external = await resolveHandleExternal(handle)
  if (external) return { did: external }

  throw BadRequest(`unable to resolve handle: ${handle}`, 'NotFound')
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.identity.resolveHandle'
