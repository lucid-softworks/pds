// XRPC handler: com.atproto.server.requestEmailConfirmation
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/requestEmailConfirmation.json
//
// Mint a confirmation token for the authenticated account's current email
// address and "send" it. No-op (still 200) if the address is already
// confirmed — clients hitting this in retry loops shouldn't trip an error.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { getConfig } from '~/lib/config'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAuthWithScope } from '~/pds/auth/middleware'
import { issueEmailToken } from '~/pds/auth/email'
import {
  renderTransactionalEmailHtml,
  sendEmail,
} from '~/pds/auth/email_sender'

const handler: Handler = async ({ authorization, dpopProof, request }) => {
  const me = await requireAuthWithScope(
    { authorization, dpopProof, request },
    'transition:generic',
  )
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
  const brand = getConfig().hostname
  const subject = 'Confirm your email address'
  const intro =
    'Enter this code in your Bluesky client to confirm your email address.'
  const outro = 'This code expires in 24 hours.'
  await sendEmail({
    to: acct.email,
    subject,
    body: `${intro}\n\n    ${token}\n\n${outro}`,
    html: renderTransactionalEmailHtml({
      title: subject,
      intro,
      code: token,
      outro,
      brand,
    }),
  })
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.requestEmailConfirmation'
