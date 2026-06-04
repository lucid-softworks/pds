// XRPC handler: com.atproto.identity.submitPlcOperation
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/identity/submitPlcOperation.json
//
// Take a *signed* PLC op the caller built (typically using
// `signPlcOperation` on their *old* PDS while they still control the
// rotation key) and push it to plc.directory. After this lands, the
// DID resolves to the new doc — points at us, lists our signing key,
// authorises our rotation key for the next op.
//
// We are strict about what the op may contain: it has to point at us
// (rotationKey, signingKey, service endpoint, handle). A user who
// posts an op pointing at a *different* PDS could brick their account
// — the directory would accept it, our local DID resolver would still
// say "yes that's us" until cache TTL, and the firehose would emit an
// `#identity` event that contradicts reality. We refuse instead.
//
// See chapter 20 — Migration.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, InternalError } from '../errors'
import { db } from '~/lib/db'
import { accounts, plcOperations } from '~/lib/db/schema'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { encode } from '~/pds/codec'
import { loadLatestPlcOp, type SignedPlcOp } from '~/pds/did/plc'
import { publishPlcOp } from '~/pds/did/plc_client'
import { emitIdentity } from '~/pds/sequencer/sequence'
import { getConfig } from '~/lib/config'

const ServiceEntry = z.object({
  type: z.string().min(1),
  endpoint: z.string().min(1),
})

const SignedOpSchema = z.object({
  type: z.literal('plc_operation'),
  rotationKeys: z.array(z.string().min(1)).min(1),
  verificationMethods: z.record(z.string().min(1)),
  alsoKnownAs: z.array(z.string().min(1)).min(1),
  services: z.record(ServiceEntry),
  prev: z.string().nullable(),
  sig: z.string().min(1),
})

const InputSchema = z.object({
  operation: SignedOpSchema,
})

const handler: Handler = async ({ input, authorization }) => {
  const me = await requireAccessAuth(authorization)

  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const op = parsed.data.operation

  // Pull our account's expected shape: which signing key + rotation key
  // + handle + endpoint should the op say belongs to this DID.
  const acctRows = await db
    .select({
      handle: accounts.handle,
      signingKeyPub: accounts.signingKeyPub,
      rotationKeyPub: accounts.rotationKeyPub,
    })
    .from(accounts)
    .where(eq(accounts.did, me.did))
    .limit(1)
  const acct = acctRows[0]
  if (!acct) throw InternalError('account row vanished mid-flight')

  // Required shape checks. Each phrasing matches the reference PDS's
  // error strings so a Bluesky client gets a familiar message.
  if (!op.rotationKeys.includes(acct.rotationKeyPub)) {
    throw BadRequest(
      "Rotation keys do not include server's rotation key",
      'InvalidRequest',
    )
  }
  if (op.services.atproto_pds?.type !== 'AtprotoPersonalDataServer') {
    throw BadRequest('Incorrect type on atproto_pds service', 'InvalidRequest')
  }
  const publicUrl = getConfig().publicUrl
  if (op.services.atproto_pds?.endpoint !== publicUrl) {
    throw BadRequest(
      'Incorrect endpoint on atproto_pds service',
      'InvalidRequest',
    )
  }
  if (op.verificationMethods.atproto !== acct.signingKeyPub) {
    throw BadRequest('Incorrect signing key', 'InvalidRequest')
  }
  if (op.alsoKnownAs[0] !== `at://${acct.handle}`) {
    throw BadRequest('Incorrect handle in alsoKnownAs', 'InvalidRequest')
  }

  // Persist + publish. We mirror `signPlcOperation`'s ordering: write
  // local first so a later crash doesn't lose the op, then POST to the
  // directory. If the POST fails the caller can retry — the directory
  // is idempotent on duplicate ops (409 is treated as success).
  const latest = await loadLatestPlcOp(me.did)
  const signedBlock = await encode(op as SignedPlcOp)
  const nextSeq = latest.seq + 1

  await db.insert(plcOperations).values({
    did: me.did,
    cid: signedBlock.cid.toString(),
    operation: signedBlock.bytes,
    seq: nextSeq,
  })

  await publishPlcOp({ did: me.did, signedOpBytes: signedBlock.bytes })

  // Tell the firehose the doc changed so downstream re-resolves the DID.
  try {
    await emitIdentity({ did: me.did, handle: acct.handle })
  } catch (err) {
    console.error('[submitPlcOperation] failed to emit #identity', err)
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.identity.submitPlcOperation'
