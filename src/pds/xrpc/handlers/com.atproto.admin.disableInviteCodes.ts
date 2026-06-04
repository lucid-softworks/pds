// XRPC handler: com.atproto.admin.disableInviteCodes
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/disableInviteCodes.json
//
// Operator burns a specific list of invite codes — once disabled they
// fail at signup time. Accepts two parallel arrays:
//
//   - codes:    [string]  exact code values
//   - accounts: [DID]     wildcard: every code minted by these DIDs
//
// At least one must be non-empty. Both are unioned: pass both to disable
// "this list + everything from these DIDs."
//
// See chapter 19 — Moderation (invite governance).

import { z } from 'zod'
import { inArray, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { inviteCodes } from '~/lib/db/schema'
import { requireAdmin } from '~/pds/auth/middleware'
import { withAdminAudit } from '~/pds/admin/audit'

const InputSchema = z.object({
  codes: z.array(z.string().min(1)).optional(),
  accounts: z.array(z.string().min(1)).optional(),
})

const handler: Handler = withAdminAudit(
  {
    action: 'disableInviteCodes',
    // No single target DID — this can affect many accounts at once.
    targetDidFrom: () => undefined,
  },
  async ({ input, authorization }) => {
    await requireAdmin(authorization)
    const parsed = InputSchema.safeParse(input)
    if (!parsed.success) {
      throw BadRequest(
        'invalid input: ' +
          parsed.error.issues.map((i) => i.message).join('; '),
      )
    }
    const codes = parsed.data.codes ?? []
    const acctList = parsed.data.accounts ?? []
    if (codes.length === 0 && acctList.length === 0) {
      throw BadRequest(
        'at least one of `codes` or `accounts` must be non-empty',
        'InvalidRequest',
      )
    }
    if (acctList.includes('admin')) {
      throw BadRequest(
        'cannot disable admin-issued invite codes via this endpoint',
        'InvalidRequest',
      )
    }

    // Two-clause UPDATE. We don't dedupe — disabling the same code twice
    // is a no-op and the audit row already captures the request shape.
    if (codes.length > 0) {
      await db
        .update(inviteCodes)
        .set({ disabled: true, disabledAt: sql`now()` })
        .where(inArray(inviteCodes.code, codes))
    }
    if (acctList.length > 0) {
      await db
        .update(inviteCodes)
        .set({ disabled: true, disabledAt: sql`now()` })
        .where(inArray(inviteCodes.createdBy, acctList))
    }
    return undefined
  },
)

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.admin.disableInviteCodes'
