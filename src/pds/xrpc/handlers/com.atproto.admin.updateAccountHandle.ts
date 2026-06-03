// XRPC handler: com.atproto.admin.updateAccountHandle
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/updateAccountHandle.json
//
// Force-rename an account. Validates syntax + uniqueness, swaps the row, and
// emits an `#identity` event so the firehose tells the rest of the network.
//
// > ⚠️ DIVERGENCE: the production PDS *also* publishes a PLC rotation op so
// >    the DID document reflects the new handle. We skip rotation here — it
// >    lives in a different agent's task (wave 5A) — and document the gap in
// >    chapter 19. The coordinator can land a follow-up that combines both.
//
// See chapter 19 — Moderation.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Conflict, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAdmin } from '~/pds/auth/middleware'
import { withAdminAudit } from '~/pds/admin/audit'
import { assertValidHandle, InvalidHandleError } from '~/pds/did/handle'
import { emitIdentity } from '~/pds/sequencer/sequence'

const InputSchema = z.object({
  did: z.string().min(1),
  handle: z.string().min(1),
})

const handler: Handler = withAdminAudit({
  action: 'updateAccountHandle',
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
  const handle = parsed.data.handle.toLowerCase()
  try {
    assertValidHandle(handle)
  } catch (err) {
    if (err instanceof InvalidHandleError) {
      throw BadRequest(err.message, 'InvalidHandle')
    }
    throw err
  }

  const existing = await db
    .select({ did: accounts.did })
    .from(accounts)
    .where(eq(accounts.did, did))
    .limit(1)
  if (!existing[0]) {
    throw NotFound(`account not found: ${did}`, 'AccountNotFound')
  }

  try {
    await db.update(accounts).set({ handle }).where(eq(accounts.did, did))
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw Conflict(`handle already in use: ${handle}`, 'HandleNotAvailable')
    }
    throw err
  }

  await emitIdentity({ did, handle })
  return undefined
})

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === '23505'
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.admin.updateAccountHandle'
