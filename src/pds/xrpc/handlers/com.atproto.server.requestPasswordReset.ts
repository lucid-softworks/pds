// XRPC handler: com.atproto.server.requestPasswordReset
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/requestPasswordReset.json
//
// Unauthenticated: a forgotten-password flow can't require a token. We look
// the account up by email; if it exists, issue a one-hour reset token and
// send it. If it doesn't, we still return 200 — surfacing "no such email"
// to an unauthenticated caller would leak account membership.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { getConfig } from '~/lib/config'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { issueEmailToken } from '~/pds/auth/email'
import {
  renderTransactionalEmailHtml,
  sendEmail,
} from '~/pds/auth/email_sender'

const InputSchema = z.object({
  email: z.string().min(1),
})

const handler: Handler = async ({ input }) => {
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const email = parsed.data.email.trim().toLowerCase()
  const rows = await db
    .select({ did: accounts.did, email: accounts.email })
    .from(accounts)
    .where(eq(accounts.email, email))
    .limit(1)
  const acct = rows[0]
  if (!acct) {
    // Pretend it worked. See chapter 13 — Password reset.
    return undefined
  }

  const { token } = await issueEmailToken({
    did: acct.did,
    purpose: 'reset-password',
  })
  const brand = getConfig().hostname
  const subject = 'Reset your password'
  const intro =
    'Enter this code to reset the password on your account. It expires in 1 hour.'
  const outro =
    "If you didn't ask for a password reset, you can safely ignore this email."
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
export const nsid = 'com.atproto.server.requestPasswordReset'
