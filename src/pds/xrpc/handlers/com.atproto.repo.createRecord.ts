// XRPC handler: com.atproto.repo.createRecord
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/createRecord.json
//
// Write a new record at a generated rkey (or a caller-supplied one). Refuses
// to overwrite — that's putRecord's job.

import { z } from 'zod'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Forbidden } from '../errors'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { applyWrites } from '~/pds/repo/writes'
import { resolveRepoIdent } from './_lib/resolveRepo'

const InputSchema = z.object({
  repo: z.string().min(1),
  collection: z.string().min(1),
  rkey: z.string().min(1).optional(),
  validate: z.boolean().optional(),
  record: z.unknown(),
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

  const result = await applyWrites({
    did,
    swapCommit: parsed.data.swapCommit,
    writes: [
      {
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
export const nsid = 'com.atproto.repo.createRecord'
