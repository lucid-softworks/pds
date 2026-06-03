// XRPC handler: com.atproto.admin.deleteAccount
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/deleteAccount.json
//
// The admin-driven counterpart to com.atproto.server.deleteAccount. The user
// flow demands password + email-token + JWT (chapter 13); the admin flow
// trusts the operator and skips both. Same outcome though: status flips to
// 'deleted' (soft, the row stays so the DID is reserved forever) and the
// firehose gets `#account { status: 'deleted' }` plus `#tombstone`.
//
// See chapter 19 — Moderation.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Forbidden, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAdmin } from '~/pds/auth/middleware'
import { withAdminAudit } from '~/pds/admin/audit'
import { emitAccount, emitTombstone } from '~/pds/sequencer/sequence'

const InputSchema = z.object({
  did: z.string().min(1),
})

const handler: Handler = withAdminAudit({
  action: 'deleteAccount',
  targetDidFrom: (input) => {
    const did = (input as { did?: unknown } | null)?.did
    return typeof did === 'string' ? did : undefined
  },
}, async ({ input, authorization }) => {
  await requireAdmin(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const did = parsed.data.did
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

  await db.update(accounts).set({ status: 'deleted' }).where(eq(accounts.did, did))
  await emitAccount({ did, active: false, status: 'deleted' })
  await emitTombstone({ did })
  return undefined
})

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.admin.deleteAccount'
