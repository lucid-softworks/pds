// XRPC handler: com.atproto.server.createSession
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/createSession.json
//
// Log in with handle / DID / email + password. Returns a fresh access +
// refresh JWT pair plus the freshly-rendered DID document, mirroring the
// shape createAccount returns.

import { z } from 'zod'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { loginWithPassword } from '~/pds/auth/session'
import { buildDidDocument } from '~/pds/did/document'
import { getConfig } from '~/lib/config'

const InputSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
  // 2FA — accepted but unused for now. See chapter 13.
  authFactorToken: z.string().optional(),
})

const handler: Handler = async ({ input }) => {
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }

  const { account, tokens } = await loginWithPassword(
    parsed.data.identifier,
    parsed.data.password,
  )

  const didDoc = buildDidDocument({
    did: account.did,
    handle: account.handle,
    signingKeyMultibase: account.signingKeyPub,
    pdsEndpoint: getConfig().publicUrl,
  })

  return {
    did: account.did,
    handle: account.handle,
    email: account.email,
    emailConfirmed: account.emailConfirmedAt != null,
    accessJwt: tokens.accessJwt,
    refreshJwt: tokens.refreshJwt,
    didDoc,
    active: account.status === 'active',
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.createSession'
