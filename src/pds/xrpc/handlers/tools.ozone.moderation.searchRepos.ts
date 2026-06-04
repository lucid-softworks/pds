// XRPC handler: tools.ozone.moderation.searchRepos
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/searchRepos.json
//
// Substring search across our accounts table. Matches against handle
// or email; if the query parses as a DID, exact-match by DID. Returns
// a slim repo view per match — the moderator UI fans out for full
// detail with getRepo.

import { asc, ilike, or, eq, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { accounts } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)

  const q = params.q?.trim()
  if (!q || q.length < 2) {
    throw BadRequest('q parameter required (min 2 chars)', 'InvalidRequest')
  }
  const limit = parseLimit(params.limit)
  const cursor = params.cursor?.trim()
  const pattern = `%${q}%`

  const rows = await db
    .select({
      did: accounts.did,
      handle: accounts.handle,
      email: accounts.email,
      status: accounts.status,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .where(
      sql`(
        ${eq(accounts.did, q)}
        OR ${ilike(accounts.handle, pattern)}
        OR ${ilike(accounts.email, pattern)}
      )
      ${cursor ? sql`AND ${accounts.did} > ${cursor}` : sql``}`,
    )
    .orderBy(asc(accounts.did))
    .limit(limit + 1)
  void or // satisfy import linter

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? page[page.length - 1]!.did
      : undefined

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    repos: page.map((r) => ({
      did: r.did,
      handle: r.handle,
      email: r.email,
      indexedAt: r.createdAt.toISOString(),
      relatedRecords: [],
    })),
  }
}

function parseLimit(raw: string | undefined): number {
  const def = 50
  const max = 100
  if (raw === undefined) return def
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1 || n > max) {
    throw BadRequest(`limit must be 1..${max}`, 'InvalidRequest')
  }
  return n
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.moderation.searchRepos'
