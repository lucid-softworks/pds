// XRPC handler: com.atproto.server.requestAccountDelete
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/requestAccountDelete.json
//
// Step 1 of the two-step delete: mint a one-hour `delete-account` token and
// email it to the account's address. Step 2 is `deleteAccount`, where the
// caller submits this token alongside a fresh password proof.
//
// Why a confirmation round trip? An access JWT alone isn't enough authority
// for an irreversible destroy — if the user lost their laptop unlocked, an
// attacker could nuke the account before the user noticed. Requiring a
// fresh email round trip *and* a password re-entry makes drive-by deletion
// meaningfully harder.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAuthWithScope } from '~/pds/auth/middleware'
import { issueEmailToken } from '~/pds/auth/email'
import { sendEmail } from '~/pds/auth/email_sender'

const handler: Handler = async ({ authorization, dpopProof, request }) => {
  const me = await requireAuthWithScope(
    { authorization, dpopProof, request },
    'transition:generic',
  )
  const rows = await db
    .select({ email: accounts.email })
    .from(accounts)
    .where(eq(accounts.did, me.did))
    .limit(1)
  const acct = rows[0]!
  const { token } = await issueEmailToken({
    did: me.did,
    purpose: 'delete-account',
  })
  await sendEmail({
    to: acct.email,
    subject: 'Confirm account deletion',
    body:
      'Use this code to permanently delete your account:\n\n' +
      `    ${token}\n\n` +
      'This code expires in 1 hour. If you did not request account ' +
      'deletion, you can ignore this message — your account is safe.',
  })
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.requestAccountDelete'
