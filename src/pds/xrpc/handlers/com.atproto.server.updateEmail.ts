// XRPC handler: com.atproto.server.updateEmail
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/updateEmail.json
//
// Submit the token from requestEmailUpdate. We pull `newEmail` off the
// token row, swap the account's address, and clear `email_confirmed_at` —
// the new address has to be confirmed in its own right after the change.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Conflict } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { consumeEmailToken } from '~/pds/auth/email'

const InputSchema = z.object({
  // The upstream lexicon accepts `email` here too; we ignore it in favour of
  // the address stored on the token row, which proves ownership.
  email: z.string().optional(),
  token: z.string().min(1),
})

const handler: Handler = async ({ input, authorization }) => {
  const me = await requireAccessAuth(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const row = await consumeEmailToken({
    did: me.did,
    purpose: 'update-email',
    token: parsed.data.token,
  })
  const newEmail = row.newEmail
  if (!newEmail) {
    // Defensive: a token row without newEmail shouldn't exist for this
    // purpose. Treat as a stale token rather than 500.
    throw BadRequest('token is missing target email', 'InvalidToken')
  }

  try {
    await db
      .update(accounts)
      .set({ email: newEmail, emailConfirmedAt: null })
      .where(eq(accounts.did, me.did))
  } catch (err) {
    // accounts_email_idx is UNIQUE; the swap fails if someone else already
    // owns the new address.
    if (isUniqueViolation(err)) {
      throw Conflict(`email already in use: ${newEmail}`, 'EmailNotAvailable')
    }
    throw err
  }
  return undefined
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  // 23505 is Postgres' unique_violation; pglite surfaces the same code.
  return code === '23505'
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.updateEmail'
