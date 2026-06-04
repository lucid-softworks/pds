// XRPC handler: com.atproto.identity.getRecommendedDidCredentials
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/identity/getRecommendedDidCredentials.json
//
// "If you were going to rotate your DID document to point at this PDS,
// here's what it should say." Returns the verificationMethods (the
// signing key we hold for this account), the rotationKeys we want to
// be authorized to operate the DID with, the canonical
// `at://<handle>` aka, and the service endpoint pointing at us.
//
// Used by the migration flow on the destination PDS — the migrating
// user calls this to learn what their PLC op needs to contain so the
// directory will point at us. They then build + sign the op and
// submit it via `submitPlcOperation` (next handler over).
//
// Auth: any access token. Same rule as the reference PDS — "always
// allow" — but we still require *some* auth so a passer-by can't read
// the account's key shape.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { getConfig } from '~/lib/config'

const handler: Handler = async ({ authorization }) => {
  const me = await requireAccessAuth(authorization)

  const rows = await db
    .select({
      handle: accounts.handle,
      signingKeyPub: accounts.signingKeyPub,
      rotationKeyPub: accounts.rotationKeyPub,
    })
    .from(accounts)
    .where(eq(accounts.did, me.did))
    .limit(1)
  const acct = rows[0]
  if (!acct) throw NotFound(`account not found: ${me.did}`, 'AccountNotFound')

  return {
    alsoKnownAs: [`at://${acct.handle}`],
    verificationMethods: {
      atproto: acct.signingKeyPub,
    },
    rotationKeys: [acct.rotationKeyPub],
    services: {
      atproto_pds: {
        type: 'AtprotoPersonalDataServer',
        endpoint: getConfig().publicUrl,
      },
    },
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.identity.getRecommendedDidCredentials'
