// XRPC handler: com.atproto.repo.deleteRecord
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/deleteRecord.json
//
// Remove a record at a known rkey. Deleting a missing record is a no-op in
// the upstream lexicon's contract; we match that by short-circuiting before
// touching the MST.

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Conflict, Forbidden } from '../errors'
import { db } from '~/lib/db'
import { records, repos } from '~/lib/db/schema'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { applyWrites } from '~/pds/repo/writes'
import { resolveRepoIdent } from './_lib/resolveRepo'

const InputSchema = z.object({
  repo: z.string().min(1),
  collection: z.string().min(1),
  rkey: z.string().min(1),
  swapRecord: z.string().optional(),
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
  const existingCid = existing[0]?.cid

  if (parsed.data.swapRecord !== undefined && parsed.data.swapRecord !== existingCid) {
    throw Conflict(
      `swapRecord mismatch: expected ${parsed.data.swapRecord}, current ${existingCid ?? 'absent'}`,
      'InvalidSwap',
    )
  }

  if (!existingCid) {
    // Idempotent no-op. Return the current commit state so clients can chain
    // calls without inferring "is this a 404 or success?"
    const repoRow = (
      await db
        .select({ rootCid: repos.rootCid, rev: repos.rev })
        .from(repos)
        .where(eq(repos.did, did))
        .limit(1)
    )[0]
    return {
      commit: repoRow
        ? { cid: repoRow.rootCid, rev: repoRow.rev }
        : { cid: '', rev: '' },
    }
  }

  const result = await applyWrites({
    did,
    swapCommit: parsed.data.swapCommit,
    writes: [
      {
        action: 'delete',
        collection: parsed.data.collection,
        rkey: parsed.data.rkey,
      },
    ],
  })

  return {
    commit: {
      cid: result.commit.cid.toString(),
      rev: result.commit.rev,
    },
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.repo.deleteRecord'
