// XRPC handler: com.atproto.repo.putRecord
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/putRecord.json
//
// Write a record at a known rkey, creating it if absent and replacing it if
// present. Supports the swapRecord precondition (current CID at rkey must
// match) for optimistic concurrency.

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Conflict, Forbidden } from '../errors'
import { db } from '~/lib/db'
import { records } from '~/lib/db/schema'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { applyWrites } from '~/pds/repo/writes'
import { resolveRepoIdent } from './_lib/resolveRepo'

const InputSchema = z.object({
  repo: z.string().min(1),
  collection: z.string().min(1),
  rkey: z.string().min(1),
  validate: z.boolean().optional(),
  record: z.unknown(),
  swapRecord: z.string().nullable().optional(),
  swapCommit: z.string().optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const me = await requireAccessAuth(authorization)
  const did = await resolveRepoIdent(parsed.data.repo)
  if (did !== me.did) {
    throw Forbidden('cannot write to another account’s repo', 'AuthRequired')
  }

  // Look up the current cid at this key to decide create vs update and to
  // enforce swapRecord. `null` means "expect absent"; a string means "expect
  // exactly this CID."
  const existing = await db
    .select({ cid: records.cid })
    .from(records)
    .where(
      and(
        eq(records.repoDid, did),
        eq(records.collection, parsed.data.collection),
        eq(records.rkey, parsed.data.rkey),
      ),
    )
    .limit(1)
  const existingCid = existing[0]?.cid ?? null

  if (parsed.data.swapRecord !== undefined) {
    if (parsed.data.swapRecord !== existingCid) {
      throw Conflict(
        `swapRecord mismatch: expected ${parsed.data.swapRecord}, current ${existingCid ?? 'absent'}`,
        'InvalidSwap',
      )
    }
  }

  const result = await applyWrites({
    did,
    swapCommit: parsed.data.swapCommit,
    writes: [
      existingCid
        ? {
            action: 'update',
            collection: parsed.data.collection,
            rkey: parsed.data.rkey,
            value: parsed.data.record,
          }
        : {
            action: 'create',
            collection: parsed.data.collection,
            rkey: parsed.data.rkey,
            value: parsed.data.record,
          },
    ],
  })

  const w = result.writes[0]!
  return {
    uri: w.uri,
    cid: w.cid!.toString(),
    commit: {
      cid: result.commit.cid.toString(),
      rev: result.commit.rev,
    },
    validationStatus: 'unknown',
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.repo.putRecord'
