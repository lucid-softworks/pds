// XRPC handler: com.atproto.server.reserveSigningKey
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/reserveSigningKey.json
//
// Destination-side: pre-generate a signing keypair for a soon-to-arrive
// migrating account. The private part stays here; we return the multibase
// public key so the user can include it in the PLC rotate op that points
// their DID at this PDS.
//
// Auth is optional. If the caller's already authenticated, link the
// reservation to *their* DID — useful for testing and for the rare case
// where the user's session straddles the migration. If not, accept a `did`
// in the body: the migrating user doesn't have a session on this PDS yet.
//
// See chapter 20 — Migration.

import { z } from 'zod'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { reservedKeys } from '~/lib/db/schema'
import { generateKeypair } from '~/pds/repo/keys'
import { optionalAccessAuth } from '~/pds/auth/middleware'

const InputSchema = z.object({
  did: z.string().min(1).optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  const parsed = InputSchema.safeParse(input ?? {})
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }

  const me = await optionalAccessAuth(authorization)
  const did = (me?.did ?? parsed.data.did)?.trim()
  if (!did) {
    throw BadRequest(
      'did is required when the request is unauthenticated',
      'InvalidRequest',
    )
  }
  if (!did.startsWith('did:')) {
    throw BadRequest('did must be a DID', 'InvalidRequest')
  }

  const key = generateKeypair()
  // Last reservation wins — if the user re-runs the migration dance, the
  // earlier reserved key is forgotten and they put the new one in the rotate
  // op. The orphan private key is harmless (never linked to an account).
  await db
    .insert(reservedKeys)
    .values({
      did,
      signingKeyPriv: key.privateKeyHex,
      signingKeyPub: key.publicKeyMultibase,
    })
    .onConflictDoUpdate({
      target: reservedKeys.did,
      set: {
        signingKeyPriv: key.privateKeyHex,
        signingKeyPub: key.publicKeyMultibase,
        reservedAt: new Date(),
      },
    })

  return { signingKey: key.publicKeyMultibase }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.server.reserveSigningKey'
