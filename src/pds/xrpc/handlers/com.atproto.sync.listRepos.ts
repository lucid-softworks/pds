// XRPC handler: com.atproto.sync.listRepos
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/listRepos.json
//
// Paginated list of every repo on this PDS. Relays call this on first
// contact to enumerate accounts they need to backfill. Order is
// lexicographic by DID; cursor is the last DID of the previous page.

import { eq, gt, asc } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { accounts, repos } from '~/lib/db/schema'

const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 500

const handler: Handler = async ({ params }) => {
  const limitRaw = params.limit
  let limit = DEFAULT_LIMIT
  if (limitRaw !== undefined) {
    const parsed = Number.parseInt(limitRaw, 10)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      throw BadRequest(
        `limit must be between 1 and ${MAX_LIMIT}`,
        'InvalidRequest',
      )
    }
    limit = parsed
  }

  const cursor = params.cursor?.trim()

  const rows = await db
    .select({
      did: repos.did,
      head: repos.rootCid,
      rev: repos.rev,
      status: accounts.status,
    })
    .from(repos)
    .innerJoin(accounts, eq(accounts.did, repos.did))
    .where(cursor ? gt(repos.did, cursor) : undefined)
    .orderBy(asc(repos.did))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? page[page.length - 1]!.did
      : undefined

  return {
    repos: page.map((r) => ({
      did: r.did,
      head: r.head,
      rev: r.rev,
      active: r.status === 'active',
      // Only emit `status` when the repo is *not* active — that's what the
      // lexicon prescribes (and saves bytes on the hot path).
      ...(r.status !== 'active' ? { status: r.status } : {}),
    })),
    ...(nextCursor ? { cursor: nextCursor } : {}),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'com.atproto.sync.listRepos'
