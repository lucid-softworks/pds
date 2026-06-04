// XRPC handler: com.atproto.admin.disableAccountInvites
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/disableAccountInvites.json
//
// Operator revokes a user's right to mint new invite codes. Doesn't
// touch existing codes — those keep working until they're individually
// disabled (`admin.disableInviteCodes`) or run out of uses. The flag
// lives on `accounts.invites_disabled` and gates any future user-facing
// invite-minting path (today, all invite minting is operator-only via
// `createInviteCode(s)`, so the flag is decorative; chapter 12's
// user-mints-their-own-invite exercise wires it up).
//
// See chapter 19 — Moderation (invite governance).

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAdmin } from '~/pds/auth/middleware'
import { withAdminAudit } from '~/pds/admin/audit'

const InputSchema = z.object({
  account: z.string().min(1),
  // The lexicon allows a free-text note that operators record for the
  // audit trail. We accept it for shape compatibility but don't surface
  // it beyond the audit row (DAG-CBOR encoded `params`).
  note: z.string().optional(),
})

const handler: Handler = withAdminAudit(
  {
    action: 'disableAccountInvites',
    targetDidFrom: (input) => {
      const acc = (input as { account?: unknown } | null)?.account
      return typeof acc === 'string' ? acc : undefined
    },
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
    const existing = await db
      .select({ did: accounts.did })
      .from(accounts)
      .where(eq(accounts.did, parsed.data.account))
      .limit(1)
    if (existing.length === 0) {
      throw NotFound(
        `account not found: ${parsed.data.account}`,
        'AccountNotFound',
      )
    }
    await db
      .update(accounts)
      .set({ invitesDisabled: true })
      .where(eq(accounts.did, parsed.data.account))
    return undefined
  },
)

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.admin.disableAccountInvites'
