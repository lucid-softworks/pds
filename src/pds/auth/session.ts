// Session lifecycle.
//
// "Create a session" means: issue an access JWT + refresh JWT, persist the
// refresh token's jti in the database so it can be revoked. The access
// token is stateless — it isn't stored. Verification is purely signature +
// expiry.
//
// See chapter 13 — Authentication.

import { db } from '~/lib/db'
import { refreshTokens } from '~/lib/db/schema'
import { signAccessToken, signRefreshToken } from './jwt'

export type IssuedSession = {
  accessJwt: string
  refreshJwt: string
}

export async function createSessionTokens(did: string): Promise<IssuedSession> {
  const access = await signAccessToken(did)
  const refresh = await signRefreshToken(did)
  await db.insert(refreshTokens).values({
    jti: refresh.jti,
    did,
    expiresAt: new Date(refresh.exp * 1000),
  })
  return { accessJwt: access.jwt, refreshJwt: refresh.jwt }
}
