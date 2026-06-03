// XRPC handler: com.atproto.identity.signPlcOperation
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/identity/signPlcOperation.json
//
// Append a caller-controlled PLC op to the user's chain. Pairs with
// `requestPlcOperationSignature`: the caller hands in the one-shot token
// that flow minted plus any subset of (rotationKeys, alsoKnownAs,
// verificationMethods, services). Anything omitted is forwarded from the
// most recent op — same merge rules as `rotatePlc`, just with every
// field exposed.
//
// This is what powers self-custody migration: the user calls
// signPlcOperation on their *old* PDS (which still holds the rotation key)
// with the new PDS's reserved signing key in `verificationMethods.atproto`
// and the new PDS's URL in `services.atproto_pds.endpoint`. The op then
// publishes to plc.directory and the world starts resolving the DID to
// the new PDS.
//
// See chapter 20 — Migration.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, InternalError } from '../errors'
import { db } from '~/lib/db'
import { accounts, plcOperations } from '~/lib/db/schema'
import { requireAuthWithScope } from '~/pds/auth/middleware'
import { consumeEmailToken } from '~/pds/auth/email'
import { encode } from '~/pds/codec'
import { getKeyWrapper } from '~/pds/auth/key_wrap'
import { signBytes } from '~/pds/repo/keys'
import {
  loadLatestPlcOp,
  type SignedPlcOp,
  type UnsignedPlcOp,
} from '~/pds/did/plc'
import { publishPlcOp } from '~/pds/did/plc_client'
import { emitIdentity } from '~/pds/sequencer/sequence'

const ServiceEntry = z.object({
  type: z.string().min(1),
  endpoint: z.string().min(1),
})

const InputSchema = z.object({
  token: z.string().min(1),
  rotationKeys: z.array(z.string().min(1)).optional(),
  alsoKnownAs: z.array(z.string().min(1)).optional(),
  verificationMethods: z.record(z.string().min(1)).optional(),
  services: z.record(ServiceEntry).optional(),
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

  // 1. Burn the one-shot token. consumeEmailToken throws Unauthorized
  //    InvalidToken on miss — exactly what the lexicon wants.
  await consumeEmailToken({
    did: me.did,
    purpose: 'plc-operation-signature',
    token: parsed.data.token,
  })

  // 2. Load the latest op so we know what to carry forward and what
  //    `prev` to chain to.
  const latest = await loadLatestPlcOp(me.did)

  // 3. Load the rotation key. Anyone with the email token *and* the
  //    session can drive this — both gates are upstream of here.
  const acctRows = await db
    .select({ rotationKeyPriv: accounts.rotationKeyPriv })
    .from(accounts)
    .where(eq(accounts.did, me.did))
    .limit(1)
  const acct = acctRows[0]
  if (!acct || acct.rotationKeyPriv.length === 0) {
    // The account row vanished, or this account never had a rotation key
    // (e.g. a migrating-in account where the rotation key lives with the
    // user). Either way, this PDS can't sign for them.
    throw InternalError('account has no rotation key on this PDS')
  }

  // 4. Build the unsigned op by overlaying caller fields on the latest op.
  const overlaid: UnsignedPlcOp = {
    type: 'plc_operation',
    rotationKeys: parsed.data.rotationKeys ?? latest.op.rotationKeys,
    verificationMethods:
      parsed.data.verificationMethods ?? latest.op.verificationMethods,
    alsoKnownAs: parsed.data.alsoKnownAs ?? latest.op.alsoKnownAs,
    services: parsed.data.services ?? latest.op.services,
    prev: latest.cid,
  }

  // 4a. Upstream safety check — refuse-if-not-listed. The reference PDS
  //     would reject an op that drops our own rotation key from the
  //     rotationKeys array, because doing so locks us out of authorising
  //     the next rotation. We *log* the case but don't enforce it yet —
  //     migration intentionally walks this edge (the rotation key stays
  //     with the user, not the PDS), so a hard refusal here would block
  //     the very flow the chapter unlocks. See chapter 20.
  const ourRotationKey = latest.op.rotationKeys[0]
  if (
    overlaid.rotationKeys.length > 0 &&
    ourRotationKey !== undefined &&
    !overlaid.rotationKeys.includes(ourRotationKey)
  ) {
    console.warn(
      `[signPlcOperation] ${me.did}: new op drops this PDS's rotation key — ` +
        `we will not be able to authorise further rotations after this one`,
    )
  }

  // 5. Sign + persist. Same shape as rotatePlc; we hand-roll because the
  //    caller's overlay can change every field, not just the handle.
  //    Unwrap the at-rest rotation key right before the signature — the
  //    plaintext scalar lives in a single local for the next two lines
  //    and isn't passed around.
  const rotationKeyPrivPlain = await getKeyWrapper().unwrap(acct.rotationKeyPriv)
  const unsignedBlock = await encode(overlaid)
  const sigBytes = signBytes(rotationKeyPrivPlain, unsignedBlock.bytes)
  const signed: SignedPlcOp = { ...overlaid, sig: base64url(sigBytes) }
  const signedBlock = await encode(signed)
  const nextSeq = latest.seq + 1

  await db.insert(plcOperations).values({
    did: me.did,
    cid: signedBlock.cid.toString(),
    operation: signedBlock.bytes,
    seq: nextSeq,
  })

  // 6. Publish upstream. No-op in local-PLC mode; in production this
  //    POSTs to plc.directory and the world starts seeing the new doc.
  await publishPlcOp({ did: me.did, signedOpBytes: signedBlock.bytes })

  // 7. If the handle changed (alsoKnownAs[0] flipped), update accounts.
  //    Skip silently if the new aka doesn't look like an at:// URI — the
  //    op is durable either way; we just don't know what to put in the
  //    column.
  const oldHandle = handleFromAlsoKnownAs(latest.op.alsoKnownAs)
  const newHandle = handleFromAlsoKnownAs(overlaid.alsoKnownAs)
  if (newHandle && newHandle !== oldHandle) {
    await db
      .update(accounts)
      .set({ handle: newHandle })
      .where(eq(accounts.did, me.did))
  }

  // 8. Firehose. `#identity` is the event downstream consumers re-resolve
  //    on — exactly what we want, since every field of the doc may have
  //    changed.
  try {
    await emitIdentity({
      did: me.did,
      ...(newHandle ? { handle: newHandle } : {}),
    })
  } catch (err) {
    console.error('[signPlcOperation] failed to emit #identity', err)
  }

  // 9. Hand back the signed op so the caller can present it to anyone
  //    that needs proof the rotation happened (e.g. the destination PDS
  //    during migration).
  return { operation: signed }
}

function handleFromAlsoKnownAs(aka: string[]): string | null {
  const first = aka[0]
  if (!first || !first.startsWith('at://')) return null
  return first.slice('at://'.length)
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.identity.signPlcOperation'
