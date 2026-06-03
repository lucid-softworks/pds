// XRPC handler: com.atproto.server.revokeAppPassword
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/revokeAppPassword.json
//
// Delete an app password by name. Idempotent — a name that doesn't exist
// still 200s, so a client retrying doesn't have to special-case "already
// gone." Existing refresh tokens minted under this app password are left
// alone; they'll still verify until they expire or are explicitly logged out.
//
// See chapter 13 — Authentication.

import { z } from 'zod'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { requireAuthWithScope } from '~/pds/auth/middleware'
import { revokeAppPassword } from '~/pds/auth/app_password'

const InputSchema = z.object({
  name: z.string().min(1),
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
  await revokeAppPassword(me.did, parsed.data.name)
  return undefined
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.revokeAppPassword'
