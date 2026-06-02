// XRPC handler: com.atproto.repo.applyWrites
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/applyWrites.json
//
// Apply a batch of create / update / delete writes as a single commit. Clients
// use this when one user-facing action produces multiple records (post + the
// embed-blob row) or when they want all-or-nothing semantics.

import { z } from 'zod'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, Forbidden } from '../errors'
import { requireAccessAuth } from '~/pds/auth/middleware'
import { applyWrites, type Write } from '~/pds/repo/writes'
import { resolveRepoIdent } from './_lib/resolveRepo'

const CREATE = 'com.atproto.repo.applyWrites#create'
const UPDATE = 'com.atproto.repo.applyWrites#update'
const DELETE = 'com.atproto.repo.applyWrites#delete'

const WriteSchema = z.object({
  $type: z.enum([CREATE, UPDATE, DELETE]),
  collection: z.string().min(1),
  rkey: z.string().min(1).optional(),
  value: z.unknown().optional(),
})

const InputSchema = z.object({
  repo: z.string().min(1),
  validate: z.boolean().optional(),
  writes: z.array(WriteSchema).min(1),
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

  const writes: Write[] = parsed.data.writes.map((w) => {
    if (w.$type === CREATE) {
      if (w.value === undefined) {
        throw BadRequest('create write missing value', 'InvalidRequest')
      }
      return {
        action: 'create',
        collection: w.collection,
        rkey: w.rkey,
        value: w.value,
      }
    }
    if (w.$type === UPDATE) {
      if (!w.rkey) throw BadRequest('update write missing rkey', 'InvalidRequest')
      if (w.value === undefined) {
        throw BadRequest('update write missing value', 'InvalidRequest')
      }
      return {
        action: 'update',
        collection: w.collection,
        rkey: w.rkey,
        value: w.value,
      }
    }
    if (!w.rkey) throw BadRequest('delete write missing rkey', 'InvalidRequest')
    return {
      action: 'delete',
      collection: w.collection,
      rkey: w.rkey,
    }
  })

  const result = await applyWrites({
    did,
    swapCommit: parsed.data.swapCommit,
    writes,
  })

  return {
    commit: {
      cid: result.commit.cid.toString(),
      rev: result.commit.rev,
    },
    results: result.writes.map((w) => ({
      $type:
        w.action === 'create'
          ? 'com.atproto.repo.applyWrites#createResult'
          : w.action === 'update'
            ? 'com.atproto.repo.applyWrites#updateResult'
            : 'com.atproto.repo.applyWrites#deleteResult',
      uri: w.uri,
      ...(w.cid ? { cid: w.cid.toString() } : {}),
    })),
  }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'com.atproto.repo.applyWrites'
