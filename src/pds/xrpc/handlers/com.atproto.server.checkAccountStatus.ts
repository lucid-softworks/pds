// XRPC handler: com.atproto.server.checkAccountStatus
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/checkAccountStatus.json
//
// "What's the state of my account?" — returns the caller's account-status
// snapshot. Unlike most authenticated endpoints this one is reachable for
// deactivated accounts too: a user who deactivated themselves still needs a
// way to see (and recover) their own state. Takendown and deleted accounts
// remain server-side disabled.
//
// We deliberately omit the expensive informational counts the upstream
// lexicon allows (expectedRecords, expectedBlocks, …); they'd require a
// per-call scan of the repo and we don't need them for the lifecycle flow.

import type { Handler, HandlerDef } from '../server'
import { eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAccessAuth } from '~/pds/auth/middleware'

const handler: Handler = async ({ authorization }) => {
  const me = await requireAccessAuth(authorization, { allowDeactivated: true })
  const rows = await db
    .select({
      did: accounts.did,
      handle: accounts.handle,
      email: accounts.email,
      status: accounts.status,
      emailConfirmedAt: accounts.emailConfirmedAt,
    })
    .from(accounts)
    .where(eq(accounts.did, me.did))
    .limit(1)
  const acct = rows[0]!
  // 'deleted' is unreachable here — loadAccount would have already thrown —
  // so the visible space is 'active' | 'takendown' | 'deactivated'.
  const status = acct.status as 'active' | 'takendown' | 'deactivated'
  return {
    did: acct.did,
    handle: acct.handle,
    email: acct.email,
    emailConfirmed: acct.emailConfirmedAt !== null,
    status,
    active: status === 'active',
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.server.checkAccountStatus'
