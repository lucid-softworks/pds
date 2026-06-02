// XRPC handler: com.atproto.server.createAccount
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/createAccount.json
//
// Spec input (we currently support the bolded subset):
//   handle         (string, required)  ← supported
//   email          (string, optional)  ← required in our impl
//   password       (string, optional)  ← required in our impl
//   did            (string, optional)  — pre-existing DID for migration
//   inviteCode     (string, optional)  — closed-signup mode
//   recoveryKey    (string, optional)  — caller-controlled rotation key
//   plcOp          (object, optional)  — pre-built genesis op
//
// We'll implement migration / invite codes / recovery keys in follow-on
// chapters. The flow that ships here is the simplest one: a brand new
// self-hosted account.

import { z } from 'zod'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { createAccount } from '~/pds/account/create'

const InputSchema = z.object({
  handle: z.string().min(1),
  email: z.string().min(1),
  password: z.string().min(1),
  inviteCode: z.string().min(1).optional(),
})

const handler: Handler = async ({ input }) => {
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }

  const result = await createAccount(parsed.data)

  return {
    did: result.did,
    handle: result.handle,
    accessJwt: result.accessJwt,
    refreshJwt: result.refreshJwt,
    didDoc: result.didDoc,
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.createAccount'
