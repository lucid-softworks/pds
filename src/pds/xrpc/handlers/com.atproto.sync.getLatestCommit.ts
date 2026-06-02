// XRPC handler: com.atproto.sync.getLatestCommit
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/getLatestCommit.json
//
// Reports the repo's current head. Cheap; pure database lookup.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { repos } from '~/lib/db/schema'

const handler: Handler = async ({ params }) => {
  const did = params.did?.trim()
  if (!did) throw BadRequest('did parameter is required', 'InvalidRequest')

  const rows = await db
    .select({ rootCid: repos.rootCid, rev: repos.rev })
    .from(repos)
    .where(eq(repos.did, did))
    .limit(1)
  const row = rows[0]
  if (!row) throw NotFound(`repo not found: ${did}`, 'RepoNotFound')

  return { cid: row.rootCid, rev: row.rev }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.sync.getLatestCommit'
