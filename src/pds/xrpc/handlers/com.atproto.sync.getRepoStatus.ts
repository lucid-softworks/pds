// XRPC handler: com.atproto.sync.getRepoStatus
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/getRepoStatus.json
//
// One-row state report for a single repo. Used by consumers that want to
// check on a takendown/deactivated account without pulling the whole repo.

import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { accounts, repos } from '~/lib/db/schema'

const handler: Handler = async ({ params }) => {
  const did = params.did?.trim()
  if (!did) throw BadRequest('did parameter is required', 'InvalidRequest')

  const rows = await db
    .select({
      did: accounts.did,
      status: accounts.status,
      rev: repos.rev,
    })
    .from(accounts)
    .leftJoin(repos, eq(repos.did, accounts.did))
    .where(eq(accounts.did, did))
    .limit(1)
  const row = rows[0]
  if (!row) throw NotFound(`repo not found: ${did}`, 'RepoNotFound')

  const active = row.status === 'active'
  return {
    did: row.did,
    active,
    ...(active ? {} : { status: row.status }),
    ...(row.rev ? { rev: row.rev } : {}),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.sync.getRepoStatus'
