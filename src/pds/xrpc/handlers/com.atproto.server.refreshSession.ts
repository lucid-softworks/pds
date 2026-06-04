// XRPC handler: com.atproto.server.refreshSession
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/refreshSession.json
//
// Unusually, this endpoint expects the *refresh* JWT in the Authorization
// header (where most endpoints want the access JWT). The middleware checks
// the jti is still in `refresh_tokens`; we then rotate — delete the old jti,
// issue and persist a new pair.

import type { Handler, HandlerDef } from '../server'
import { eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, refreshTokens } from '~/lib/db/schema'
import { requireRefreshAuth } from '~/pds/auth/middleware'
import { createSessionTokens, assertAccountActive } from '~/pds/auth/session'
import { buildDidDocument } from '~/pds/did/document'
import { getConfig } from '~/lib/config'
import { Unauthorized } from '../errors'

const handler: Handler = async ({ authorization }) => {
  // requireRefreshAuth already verified the jti row exists.
  const { did, jti } = await requireRefreshAuth(authorization)

  // Rotate the refresh token: invalidating the old jti before issuing the
  // new pair is the property that makes refresh tokens one-time-use.
  await db.delete(refreshTokens).where(eq(refreshTokens.jti, jti))

  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.did, did))
    .limit(1)
  const acct = rows[0]
  if (!acct) {
    throw Unauthorized('account no longer exists', 'InvalidToken')
  }
  assertAccountActive(acct)

  const tokens = await createSessionTokens(did)
  const didDoc = buildDidDocument({
    did: acct.did,
    handle: acct.handle,
    signingKeyMultibase: acct.signingKeyPub,
    pdsEndpoint: getConfig().publicUrl,
  })

  return {
    did: acct.did,
    handle: acct.handle,
    email: acct.email,
    emailConfirmed: acct.emailConfirmedAt != null,
    accessJwt: tokens.accessJwt,
    refreshJwt: tokens.refreshJwt,
    didDoc,
    active: acct.status === 'active',
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.refreshSession'
