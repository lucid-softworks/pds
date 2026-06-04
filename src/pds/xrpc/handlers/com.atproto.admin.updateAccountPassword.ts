// XRPC handler: com.atproto.admin.updateAccountPassword
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/updateAccountPassword.json
//
// Operator force-set of an account's password. Useful when an
// emergency lockout (compromised credentials, employee-managed
// account) means the user can't run the password-reset flow
// themselves. The new password is scrypted with the same KDF the
// regular reset path uses (`src/pds/auth/password.ts`) so the
// downstream storage is byte-identical to a user-driven reset.
//
// This does NOT invalidate existing sessions on its own. Operators
// who want a full lock-out should also issue an `updateAccountStatus`
// with `takendown` (or invalidate refresh tokens manually). Pairing
// the two is the documented "evict the user" recipe.
//
// See chapter 19 — Moderation.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAdmin } from '~/pds/auth/middleware'
import { withAdminAudit } from '~/pds/admin/audit'
import { hashPassword } from '~/pds/auth/password'

const InputSchema = z.object({
  did: z.string().min(1),
  // Reject obviously-weak operator-typed passwords. The full strength
  // policy lives upstream of this handler (in chapter 12's signup
  // path); here we just protect against the empty-string and short-
  // string footguns operators can hit by accident in a hurry.
  password: z.string().min(8, 'password must be at least 8 characters'),
})

const handler: Handler = withAdminAudit(
  {
    action: 'updateAccountPassword',
    targetDidFrom: (input) => {
      const did = (input as { did?: unknown } | null)?.did
      return typeof did === 'string' ? did : undefined
    },
    // Never persist the plaintext password to the audit log. Redact to
    // `<redacted>` so an operator reading the audit row still sees that
    // a password change happened, just not what to.
    redactSnapshot: (input) => {
      if (typeof input !== 'object' || input === null) return input
      const { password: _omit, ...rest } = input as Record<string, unknown>
      return { ...rest, password: '<redacted>' }
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
    const { did, password } = parsed.data

    const existing = await db
      .select({ did: accounts.did })
      .from(accounts)
      .where(eq(accounts.did, did))
      .limit(1)
    if (existing.length === 0) {
      throw NotFound(`account not found: ${did}`, 'AccountNotFound')
    }

    const passwordHash = await hashPassword(password)
    await db
      .update(accounts)
      .set({ passwordHash })
      .where(eq(accounts.did, did))
    return undefined
  },
)

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.admin.updateAccountPassword'
