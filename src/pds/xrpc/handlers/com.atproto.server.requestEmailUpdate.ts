// XRPC handler: com.atproto.server.requestEmailUpdate
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/requestEmailUpdate.json
//
// Start an email change. The lexicon's input is `{ email }`; we validate
// syntax, issue a token bound to the new address, and send the verification
// code to that new address. The actual swap happens in updateEmail.
//
// We don't reject duplicates here against the existing address — that's
// updateEmail's concern, where the uniqueness constraint actually trips.

import { z } from 'zod'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { issueEmailToken } from '~/pds/auth/email'
import { sendEmail } from '~/pds/auth/email_sender'

const InputSchema = z.object({
  email: z.string().min(1),
})

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const handler: Handler = async ({ input, authorization }) => {
  const me = await requireAccessAuth(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const newEmail = parsed.data.email.trim()
  if (!EMAIL_RE.test(newEmail)) {
    throw BadRequest('email is not a valid address', 'InvalidEmail')
  }

  const { token } = await issueEmailToken({
    did: me.did,
    purpose: 'update-email',
    newEmail,
  })
  // Verification goes to the *new* address — proves the user controls it
  // before we move the account over.
  await sendEmail({
    to: newEmail,
    subject: 'Confirm your new email address',
    body:
      'Use this code to switch your account to this email address:\n\n' +
      `    ${token}\n\n` +
      'This code expires in 24 hours. If you did not request this change, ' +
      'you can ignore this message.',
  })
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.requestEmailUpdate'
