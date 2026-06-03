// XRPC handler: com.atproto.server.deactivateAccount
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/deactivateAccount.json
//
// Voluntary, reversible self-deactivation. The account row stays in place,
// blobs and records stay on disk; only `accounts.status` flips. Existing
// refresh tokens are left alone too — a user who deactivated still needs to
// be able to come back through `activateAccount`, which means their session
// has to keep working.
//
// The upstream lexicon accepts an optional `deleteAfter` ISO timestamp for a
// "delete me in N days unless I come back" workflow. We accept the field for
// shape compatibility but don't act on it yet — there's no scheduler in the
// teaching surface.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Forbidden } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAuthWithScope } from '~/pds/auth/middleware'
import { emitAccount } from '~/pds/sequencer/sequence'

const InputSchema = z.object({
  deleteAfter: z.string().optional(),
})

const handler: Handler = async ({ input, authorization, dpopProof, request }) => {
  const me = await requireAuthWithScope(
    { authorization, dpopProof, request },
    'transition:generic',
  )
  const parsed = InputSchema.safeParse(input ?? {})
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  // requireAuthWithScope (without allowDeactivated) already rejected anything
  // other than 'active'; this defensive check keeps the state machine
  // honest if the middleware policy ever drifts.
  if (me.status !== 'active') {
    throw Forbidden(
      `cannot deactivate from status ${me.status}`,
      'InvalidAccountState',
    )
  }
  await db
    .update(accounts)
    .set({ status: 'deactivated' })
    .where(eq(accounts.did, me.did))
  await emitAccount({ did: me.did, active: false, status: 'deactivated' })
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.deactivateAccount'
