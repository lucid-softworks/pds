// XRPC handler: com.atproto.admin.updateAccountStatus
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/updateAccountStatus.json
//
// Force the account into one of four states. The status state machine:
//
//   active ⇄ takendown
//   active ⇄ deactivated
//   * → deleted   (terminal)
//
// We don't accept transitions *out* of `deleted` — once tombstoned, the DID
// is dead from the firehose's perspective and consumers have dropped its
// state. Reanimating it would emit nonsense events.
//
// See chapter 19 — Moderation.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Forbidden, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAdmin } from '~/pds/auth/middleware'
import { emitAccount, emitTombstone } from '~/pds/sequencer/sequence'

const InputSchema = z.object({
  did: z.string().min(1),
  status: z.enum(['active', 'takendown', 'deactivated', 'deleted']),
})

const handler: Handler = async ({ input, authorization }) => {
  await requireAdmin(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const { did, status } = parsed.data
  const rows = await db
    .select({ status: accounts.status })
    .from(accounts)
    .where(eq(accounts.did, did))
    .limit(1)
  const row = rows[0]
  if (!row) throw NotFound(`account not found: ${did}`, 'AccountNotFound')
  if (row.status === 'deleted') {
    throw Forbidden('account is already deleted', 'InvalidAccountState')
  }
  if (row.status === status) return undefined // already there — no-op

  await db.update(accounts).set({ status }).where(eq(accounts.did, did))

  if (status === 'active') {
    await emitAccount({ did, active: true })
  } else {
    await emitAccount({ did, active: false, status })
  }
  if (status === 'deleted') {
    await emitTombstone({ did })
  }
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.admin.updateAccountStatus'
