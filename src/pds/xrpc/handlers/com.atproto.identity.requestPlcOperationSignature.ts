// XRPC handler: com.atproto.identity.requestPlcOperationSignature
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/identity/requestPlcOperationSignature.json
//
// Mint a short-lived token that authorises a *subsequent* `signPlcOperation`
// call. The user already has a valid session — we still require an email
// round-trip because the PLC op the token unlocks rewrites the DID
// document (signing key, service endpoint, rotation keyset). The slow path
// is the point.
//
// Pairs with `com.atproto.identity.signPlcOperation` below. The token is
// stored on `email_tokens` with purpose `'plc-operation-signature'` and a
// 15-minute TTL.
//
// See chapter 20 — Migration.

import type { Handler, HandlerDef } from '../server'
import { eq } from 'drizzle-orm'
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

  const { token } = await issueEmailToken({
    did: me.did,
    purpose: 'plc-operation-signature',
  })

  // We email the address currently on file. If it's been changed since the
  // last confirmation that's fine — the change itself required a token
  // delivered to the new address (chapter 13).
  const rows = await db
    .select({ email: accounts.email })
    .from(accounts)
    .where(eq(accounts.did, me.did))
    .limit(1)
  const acct = rows[0]
  if (!acct) return undefined

  await sendEmail({
    to: acct.email,
    subject: 'PLC operation signature requested',
    body:
      'Use this code to authorise a change to your DID document:\n\n' +
      `    ${token}\n\n` +
      'This code expires in 15 minutes. If you did not initiate this, ' +
      'someone with access to your session is trying to change your ' +
      'identity — log out everywhere and rotate your password.',
  })
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.identity.requestPlcOperationSignature'
