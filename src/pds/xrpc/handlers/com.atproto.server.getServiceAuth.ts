// XRPC handler: com.atproto.server.getServiceAuth
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/getServiceAuth.json
//
// Mint a short-lived service token from the user's session. The migrating
// user calls this on their old PDS to get a token authorizing the new PDS to
// call `getRepo` on their behalf. Also a future hook for AppView proxy auth.
//
// The token's `iss` is the user DID, `aud` is the target service, and `lxm`
// (optional) scopes it to a single lexicon method. Lifetime caps at 60s.
//
// ⚠️ See chapter 20: real interop wants ES256K signatures the receiver can
// verify against the user's DID document. We sign with HS256 against the
// shared PDS secret — fine when source and destination are the same PDS,
// not useful across the network.

import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { requireAuthWithScope } from '~/pds/auth/middleware'
import { signServiceToken } from '~/pds/auth/jwt'

const MAX_TTL_SECONDS = 60
const NSID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+(\.[a-zA-Z][a-zA-Z0-9]*)$/

const handler: Handler = async ({ params, authorization, dpopProof, request }) => {
  const me = await requireAuthWithScope(
    { authorization, dpopProof, request },
    'atproto',
  )

  const aud = params.aud?.trim()
  if (!aud) throw BadRequest('aud parameter is required', 'InvalidRequest')
  if (!aud.startsWith('did:')) {
    throw BadRequest('aud must be a DID', 'BadIssuer')
  }

  const lxm = params.lxm?.trim()
  if (lxm && !NSID_RE.test(lxm)) {
    throw BadRequest(`lxm is not a valid NSID: ${lxm}`, 'InvalidRequest')
  }

  let ttl = MAX_TTL_SECONDS
  if (params.exp !== undefined) {
    const expSec = Number.parseInt(params.exp, 10)
    if (!Number.isFinite(expSec)) {
      throw BadRequest('exp must be a unix timestamp', 'InvalidRequest')
    }
    const now = Math.floor(Date.now() / 1000)
    const requested = expSec - now
    if (requested <= 0) {
      throw BadRequest('exp must be in the future', 'BadExpiration')
    }
    ttl = Math.min(requested, MAX_TTL_SECONDS)
  }

  const { jwt } = await signServiceToken({
    did: me.did,
    aud,
    ...(lxm ? { lxm } : {}),
    expiresInSeconds: ttl,
  })
  return { token: jwt }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.server.getServiceAuth'
