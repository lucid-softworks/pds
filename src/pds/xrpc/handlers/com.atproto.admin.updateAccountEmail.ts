// XRPC handler: com.atproto.admin.updateAccountEmail
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/updateAccountEmail.json
//
// Out-of-band email change. The user-side flow goes through a confirmation
// token (chapter 13); the admin-side flow trusts the operator and skips it.
// We clear emailConfirmedAt so the new address still has to be confirmed
// before any email-confirmation-gated endpoint will accept it.
//
// `account` can be a DID or a handle, matching the upstream lexicon.
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
import { findAccountByIdentifier } from '~/pds/auth/session'

const InputSchema = z.object({
  account: z.string().min(1),
  email: z.string().min(3),
})

const handler: Handler = withAdminAudit({
  action: 'updateAccountEmail',
  // `account` may be either a DID or a handle. Only commit it as targetDid
  // when it looks DID-shaped; the resolved DID isn't visible at this layer.
  // The handle case is still captured in the params snapshot.
  targetDidFrom: (input) => {
    const acct = (input as { account?: unknown } | null)?.account
    if (typeof acct !== 'string') return undefined
    return acct.startsWith('did:') ? acct : undefined
  },
}, async ({ input, authorization }) => {
  await requireAdmin(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const target = await findAccountByIdentifier(parsed.data.account)
  if (!target) {
    throw NotFound(`account not found: ${parsed.data.account}`, 'AccountNotFound')
  }
  try {
    await db
      .update(accounts)
      .set({ email: parsed.data.email, emailConfirmedAt: null })
      .where(eq(accounts.did, target.did))
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw Conflict(
        `email already in use: ${parsed.data.email}`,
        'EmailNotAvailable',
      )
    }
    throw err
  }
  return undefined
})

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === '23505'
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.admin.updateAccountEmail'
