// XRPC handler: com.atproto.server.getSession
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/getSession.json
//
// "Who am I?" — returns the caller's account info given an access JWT in the
// Authorization header. Clients call this on app start to confirm the cached
// session is still valid.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { buildDidDocument } from '~/pds/did/document'
import { getConfig } from '~/lib/config'

const handler: Handler = async ({ authorization }) => {
  const me = await requireAccessAuth(authorization)
  // Pull signingKeyPub so we can render the DID document.
  const rows = await db
    .select({
      did: accounts.did,
      handle: accounts.handle,
      email: accounts.email,
      status: accounts.status,
      signingKeyPub: accounts.signingKeyPub,
    })
    .from(accounts)
    .where(eq(accounts.did, me.did))
    .limit(1)
  const acct = rows[0]!
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
    emailConfirmed: true,
    didDoc,
    active: acct.status === 'active',
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.server.getSession'
