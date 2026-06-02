// XRPC handler: com.atproto.admin.sendEmail
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/admin/sendEmail.json
//
// Send a one-off message from the PDS operator to a user. The recipient is
// addressed by DID; we look up the email on file. `comment` is operator-only
// (an audit-trail field in the real surface); we accept it for shape
// compatibility but currently just log it via the email sender's body for
// dev visibility.
//
// See chapter 19 — Moderation.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAdmin } from '~/pds/auth/middleware'
import { sendEmail } from '~/pds/auth/email_sender'

const InputSchema = z.object({
  recipientDid: z.string().min(1),
  subject: z.string().optional(),
  content: z.string().min(1),
  comment: z.string().optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  await requireAdmin(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const rows = await db
    .select({ email: accounts.email })
    .from(accounts)
    .where(eq(accounts.did, parsed.data.recipientDid))
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw NotFound(
      `account not found: ${parsed.data.recipientDid}`,
      'AccountNotFound',
    )
  }
  await sendEmail({
    to: row.email,
    subject: parsed.data.subject ?? 'Message from your PDS operator',
    body: parsed.data.content,
  })
  return { sent: true }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.admin.sendEmail'
