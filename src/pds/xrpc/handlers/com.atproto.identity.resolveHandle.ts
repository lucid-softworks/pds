// XRPC handler: com.atproto.identity.resolveHandle
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/identity/resolveHandle.json
//
// Map a handle → DID by looking it up in the local accounts table. The
// upstream PDS also walks DNS TXT (`_atproto.<handle>`) and HTTPS
// (`.well-known/atproto-did`) to resolve handles whose authoritative PDS
// isn't us; we defer that to a later chapter on cross-PDS identity.
//
// Gap: even with `PDS_LOCAL_PLC=false` and the external DID resolver in
// place, this endpoint still only handles *local* handles. A complete
// implementation would race `_atproto.<handle>` DNS TXT lookups (via
// DNS-over-HTTPS in a Node-friendly way) and a `.well-known/atproto-did`
// HTTPS fetch, then verify the returned DID's doc lists the handle in
// `alsoKnownAs`. Out of scope for this session — see chapter 17.
//
// The "not found" error returns HTTP 400 (not 404) because that's what the
// lexicon defines — see the `errors` array in the JSON schema.

import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { isValidHandleSyntax } from '~/pds/did/handle'
import { resolveLocalHandle } from '~/pds/did/resolver'

const handler: Handler = async ({ params }) => {
  const handle = params.handle?.trim().toLowerCase()
  if (!handle) {
    throw BadRequest('handle parameter is required', 'InvalidRequest')
  }
  if (!isValidHandleSyntax(handle)) {
    throw BadRequest(`invalid handle: ${handle}`, 'InvalidRequest')
  }
  const did = await resolveLocalHandle(handle)
  if (!did) {
    throw BadRequest(`unable to resolve handle: ${handle}`, 'NotFound')
  }
  return { did }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.identity.resolveHandle'
