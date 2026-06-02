// XRPC handler: com.atproto.server.resetPassword
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/resetPassword.json
//
// Unauthenticated: caller proves account ownership by holding the token.
// We look the token up directly (no DID in scope), then hash the new
// password and update the row. Active sessions remain valid — clients are
// expected to call deleteSession on the other devices.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { consumeEmailTokenByToken } from '~/pds/auth/email'
import { hashPassword } from '~/pds/auth/password'

const InputSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(1),
})

const handler: Handler = async ({ input }) => {
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
      'InvalidToken',
    )
  }
  if (parsed.data.password.length < 8) {
    throw BadRequest(
      'password must be at least 8 characters',
      'InvalidPassword',
    )
  }
  const row = await consumeEmailTokenByToken(
    'reset-password',
    parsed.data.token,
  )
  const passwordHash = await hashPassword(parsed.data.password)
  await db
    .update(accounts)
    .set({ passwordHash })
    .where(eq(accounts.did, row.did))
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.resetPassword'
