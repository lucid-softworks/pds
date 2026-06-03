// XRPC handler: com.atproto.server.getServiceAuth
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/getServiceAuth.json
//
// Mint a short-lived service token from the user's session. Used for
// every "I'm <user>, please do <thing> on my behalf" cross-service
// hop — the migrating user calls this to get a token authorising the
// destination PDS, bsky.app calls it to get a token to address the
// AppView for non-proxied endpoints (e.g. age assurance), labelers /
// chat services receive these too.
//
// The token's `iss` is the user DID, `aud` is the target service, and
// `lxm` (optional) scopes it to a single lexicon method. Lifetime
// caps at 60s.
//
// Signed ES256K with the user's repo signing key — the same key
// published in the DID document — so the receiver can verify against
// the user's `verificationMethod[#atproto]` without any shared
// secret. See `~/pds/auth/service_auth.ts`.

import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { requireAuthWithScope } from '~/pds/auth/middleware'
import { mintServiceAuth } from '~/pds/auth/service_auth'

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

  const { jwt } = await mintServiceAuth({
    did: me.did,
    audience: aud,
    ...(lxm ? { lxm } : {}),
    expiresInSeconds: ttl,
  })
  return { token: jwt }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.server.getServiceAuth'
