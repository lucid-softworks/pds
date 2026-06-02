// XRPC handler: com.atproto.server.confirmEmail
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/confirmEmail.json
//
// Submit the token from requestEmailConfirmation. On match, mark the
// account's email as confirmed (now()). The upstream lexicon also accepts
// the user's current email as a sanity check; we accept it but don't
// require it.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { consumeEmailToken } from '~/pds/auth/email'

const InputSchema = z.object({
  token: z.string().min(1),
  email: z.string().optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  const me = await requireAccessAuth(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  await consumeEmailToken({
    did: me.did,
    purpose: 'confirm-email',
    token: parsed.data.token,
  })
  await db
    .update(accounts)
    .set({ emailConfirmedAt: new Date() })
    .where(eq(accounts.did, me.did))
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.confirmEmail'
