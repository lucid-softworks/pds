// XRPC handler: com.atproto.admin.enableAccountInvites
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/enableAccountInvites.json
//
// Inverse of `disableAccountInvites` — clears the flag, restoring the
// account's ability to mint new invite codes via any user-facing path.
// Already-disabled-but-not-yet-restored codes are unaffected; revive
// individual codes via direct database update if needed (rare).
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
  note: z.string().optional(),
})

const handler: Handler = withAdminAudit(
  {
    action: 'enableAccountInvites',
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
      .set({ invitesDisabled: false })
      .where(eq(accounts.did, parsed.data.account))
    return undefined
  },
)

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.admin.enableAccountInvites'
