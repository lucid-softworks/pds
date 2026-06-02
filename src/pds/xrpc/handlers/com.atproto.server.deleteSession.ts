// XRPC handler: com.atproto.server.deleteSession
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/deleteSession.json
//
// Logout. The refresh JWT comes in the Authorization header; we delete its
// jti row so it can never be exchanged again. Idempotent — already-revoked
// or expired tokens still return 200.

import type { Handler, HandlerDef } from '../server'
import { revokeRefreshToken } from '~/pds/auth/session'

const handler: Handler = async ({ authorization }) => {
  const token = parseBearer(authorization)
  if (token) await revokeRefreshToken(token)
  return undefined
}

function parseBearer(authorization: string | undefined): string | null {
  if (!authorization) return null
  const match = /^bearer\s+(.+)$/i.exec(authorization.trim())
  return match?.[1]?.trim() ?? null
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.deleteSession'
