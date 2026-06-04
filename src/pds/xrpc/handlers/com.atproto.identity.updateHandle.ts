// XRPC handler: com.atproto.identity.updateHandle
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/identity/updateHandle.json
//
// Change the authenticated account's handle. Under the hood we append a
// "rotate" PLC op chained off the latest one (keys + service endpoint stay
// put — only `alsoKnownAs` changes), then atomically swap accounts.handle
// and emit an `#identity` firehose event so subscribers re-resolve.
//
// See chapter 04 — DIDs, handles, AT-URIs (rotation semantics) and chapter
// 12 — Account creation (the genesis op this builds on).

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Conflict, InternalError } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireAuthWithScope } from '~/pds/auth/middleware'
import { clearModTeamCache } from '~/pds/mod/team'
import {
  InvalidHandleError,
  assertValidHandle,
  isReservedTld,
} from '~/pds/did/handle'
import { resolveLocalHandle } from '~/pds/did/resolver'
import { rotatePlc } from '~/pds/did/plc'
import { getKeyWrapper } from '~/pds/auth/key_wrap'
import { emitIdentity } from '~/pds/sequencer/sequence'

const InputSchema = z.object({
  handle: z.string().min(1),
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
  const newHandle = parsed.data.handle.trim().toLowerCase()

  try {
    assertValidHandle(newHandle)
  } catch (err) {
    if (err instanceof InvalidHandleError) {
      throw BadRequest(err.message, 'InvalidHandle')
    }
    throw err
  }

  // Match createAccount: warn on reserved TLDs but accept them so dev handles
  // like `alice.test` keep working.
  if (isReservedTld(newHandle)) {
    console.warn(`[updateHandle] handle uses reserved TLD: ${newHandle}`)
  }

  // Same-handle path: skip the PLC rotation (nothing to change) but still
  // emit an `#identity` firehose event so AppViews / Relays re-run their
  // handle verification. This is the documented "kick the AppView" knob
  // when a freshly-published TXT / .well-known/atproto-did handshake
  // hasn't propagated through the identity cache yet — bsky.app shows
  // `⚠ Invalid handle` for cached failures and the easiest way out is
  // to nudge.
  if (newHandle === me.handle) {
    await emitIdentity({ did: me.did, handle: newHandle })
    return undefined
  }

  // Availability: any local row with this handle must be ours (which we
  // already ruled out above) or unclaimed.
  const existingDid = await resolveLocalHandle(newHandle)
  if (existingDid && existingDid !== me.did) {
    throw Conflict(`handle already taken: ${newHandle}`, 'HandleNotAvailable')
  }

  // Load rotation key for the signing step.
  const rows = await db
    .select({ rotationKeyPriv: accounts.rotationKeyPriv })
    .from(accounts)
    .where(eq(accounts.did, me.did))
    .limit(1)
  const acct = rows[0]
  if (!acct) {
    // Auth passed but the row vanished — treat as a server-side glitch.
    throw InternalError('account row missing during rotation')
  }

  // Unwrap the at-rest rotation key. Migrating-in accounts store an empty
  // string as a "no rotation key on this side" sentinel — those callers
  // route through `signPlcOperation` and never reach this handler.
  if (acct.rotationKeyPriv.length === 0) {
    throw InternalError('account has no rotation key on this PDS')
  }
  const rotationKeyPrivPlain = await getKeyWrapper().unwrap(
    acct.rotationKeyPriv,
  )

  // Append the rotate op + swap the handle column. In a single transaction
  // when the driver supports it; otherwise sequentially — the worst-case
  // failure mode is a PLC op without a matching handle update, which a
  // retry of updateHandle reconciles (the next rotate chains off the
  // already-appended op).
  let rotated: Awaited<ReturnType<typeof rotatePlc>>
  try {
    rotated = await db.transaction(async (tx) => {
      const r = await rotatePlc({
        did: me.did,
        newHandle,
        rotationKeyPriv: rotationKeyPrivPlain,
      })
      try {
        await tx
          .update(accounts)
          .set({ handle: newHandle })
          .where(eq(accounts.did, me.did))
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw Conflict(
            `handle already taken: ${newHandle}`,
            'HandleNotAvailable',
          )
        }
        throw err
      }
      return r
    })
  } catch (err) {
    if (isMissingTransactionSupport(err)) {
      rotated = await rotatePlc({
        did: me.did,
        newHandle,
        rotationKeyPriv: rotationKeyPrivPlain,
      })
      try {
        await db
          .update(accounts)
          .set({ handle: newHandle })
          .where(eq(accounts.did, me.did))
      } catch (innerErr) {
        if (isUniqueViolation(innerErr)) {
          throw Conflict(
            `handle already taken: ${newHandle}`,
            'HandleNotAvailable',
          )
        }
        throw innerErr
      }
    } else {
      throw err
    }
  }

  // A rename might move this account into or out of the mod-team handle
  // slot; bust the cached lead so subsequent DID-doc renders pick up
  // the labeler-or-not flag correctly.
  clearModTeamCache()

  // Best-effort #identity emission — the rotation is durable; firehose
  // outage shouldn't unwind the rename.
  try {
    await emitIdentity({ did: me.did, handle: newHandle })
  } catch (err) {
    console.error('[updateHandle] failed to emit #identity', err)
  }

  void rotated

  return undefined
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === '23505'
}

function isMissingTransactionSupport(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const msg = (err as { message?: string }).message ?? ''
  return /transaction/i.test(msg) && /not (a function|supported|implemented)/i.test(msg)
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.identity.updateHandle'
