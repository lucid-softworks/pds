// XRPC handler: com.atproto.server.activateAccount
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/activateAccount.json
//
// The other half of the deactivate pair: flip `accounts.status` from
// 'deactivated' back to 'active'. This is one of the two endpoints that
// opts into `allowDeactivated` on the auth middleware — by construction a
// deactivated account is the only kind of account that can call this and
// have it do anything useful.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { Forbidden } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { emitAccount } from '~/pds/sequencer/sequence'

const handler: Handler = async ({ authorization }) => {
  const me = await requireAccessAuth(authorization, { allowDeactivated: true })
  if (me.status === 'active') {
    // Already active — re-activation is a no-op rather than an error so
    // clients can retry safely.
    return undefined
  }
  if (me.status !== 'deactivated') {
    throw Forbidden(
      `cannot activate from status ${me.status}`,
      'InvalidAccountState',
    )
  }
  await db
    .update(accounts)
    .set({ status: 'active' })
    .where(eq(accounts.did, me.did))
  await emitAccount({ did: me.did, active: true })
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.activateAccount'
