// XRPC handler: com.atproto.server.requestEmailConfirmation
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/requestEmailConfirmation.json
//
// Mint a confirmation token for the authenticated account's current email
// address and "send" it. No-op (still 200) if the address is already
// confirmed — clients hitting this in retry loops shouldn't trip an error.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { issueEmailToken } from '~/pds/auth/email'
import { sendEmail } from '~/pds/auth/email_sender'

const handler: Handler = async ({ authorization }) => {
  const me = await requireAccessAuth(authorization)
  const rows = await db
    .select({
      email: accounts.email,
      emailConfirmedAt: accounts.emailConfirmedAt,
    })
    .from(accounts)
    .where(eq(accounts.did, me.did))
    .limit(1)
  const acct = rows[0]!
  if (acct.emailConfirmedAt) return undefined

  const { token } = await issueEmailToken({
    did: me.did,
    purpose: 'confirm-email',
  })
  await sendEmail({
    to: acct.email,
    subject: 'Confirm your email address',
    body:
      'Use this code to confirm your email address:\n\n' +
      `    ${token}\n\n` +
      'This code expires in 24 hours.',
  })
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.requestEmailConfirmation'
