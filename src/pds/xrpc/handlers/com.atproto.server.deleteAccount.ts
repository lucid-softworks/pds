// XRPC handler: com.atproto.server.deleteAccount
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/deleteAccount.json
//
// Step 2 of the destroy flow. Three independent proofs converge here:
//
//   1. A valid access JWT for `input.did` (the middleware checks the JWT;
//      we then re-assert `me.did === input.did` so a leaked token can't
//      destroy someone else's account by lying in the body).
//   2. The current main password — verified directly against the row's hash
//      rather than trusting the JWT alone. Destructive operations earn the
//      extra round trip. App passwords are *not* accepted here.
//   3. A `delete-account` email token issued by requestAccountDelete and
//      consumed atomically.
//
// On success we mark the account `deleted` (rather than hard-deleting the
// row). The DID and handle remain reserved forever, the PLC log survives,
// and we get reversibility if the user yells later. This matches the
// protocol's "account deleted but DID survives" semantic.
//
// We emit two firehose events on success: an `#account` flip and a
// `#tombstone`. Consumers use the tombstone as their signal to drop any
// cached state for the DID.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Forbidden, Unauthorized } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAuthWithScope } from '~/pds/auth/middleware'
import { consumeEmailToken } from '~/pds/auth/email'
import { verifyPassword } from '~/pds/auth/password'
import { emitAccount, emitTombstone } from '~/pds/sequencer/sequence'

const InputSchema = z.object({
  did: z.string().min(1),
  password: z.string().min(1),
  token: z.string().min(1),
})

const handler: Handler = async ({ input, authorization, dpopProof, request }) => {
  const me = await requireAuthWithScope(
    { authorization, dpopProof, request },
    'transition:generic',
  )
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  // Defense in depth: the JWT already binds the caller to a DID; the body's
  // `did` has to match. Without this check an attacker holding any valid
  // access JWT could pass someone else's DID in the body and we'd happily
  // delete the wrong account.
  if (parsed.data.did !== me.did) {
    throw Forbidden('did mismatch', 'InvalidRequest')
  }

  // Re-verify the password against the stored hash. We deliberately don't
  // accept app passwords — destroying the account is a main-credential-only
  // operation, the same way email/password resets are.
  const rows = await db
    .select({ passwordHash: accounts.passwordHash })
    .from(accounts)
    .where(eq(accounts.did, me.did))
    .limit(1)
  const acct = rows[0]
  if (!acct) {
    // Race: account vanished between auth and now. Treat as already gone.
    throw Unauthorized('account no longer exists', 'InvalidToken')
  }
  const passwordOk = await verifyPassword(parsed.data.password, acct.passwordHash)
  if (!passwordOk) {
    throw Unauthorized('invalid password', 'AuthenticationRequired')
  }

  // Consume the token *after* the password check so a stolen access JWT +
  // intercepted email link still can't destroy an account without the
  // password too. Consume deletes the row even on success-but-expired, so
  // a stale token is single-use even if we reject it.
  await consumeEmailToken({
    did: me.did,
    purpose: 'delete-account',
    token: parsed.data.token,
  })

  // Mark, don't hard-delete. The DID stays bound to this PDS forever; the
  // PLC log survives for auditability; the user keeps the option to plead
  // their case with an admin. A hard delete would cascade through every
  // FK in the schema (chapter 12 lists them) and there'd be no path back.
  await db
    .update(accounts)
    .set({ status: 'deleted' })
    .where(eq(accounts.did, me.did))

  await emitAccount({ did: me.did, active: false, status: 'deleted' })
  await emitTombstone({ did: me.did })
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.deleteAccount'
