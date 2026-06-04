// XRPC handler: tools.ozone.team.listMembers
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/team/listMembers.json
//
// Read-only roster query. Pairs with the /mod/team UI which renders
// the same join (mod_team ⨝ accounts) as HTML.

import { asc, eq, lt } from 'drizzle-orm'
import { db } from '~/lib/db'
import { accounts, modTeam } from '~/lib/db/schema'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { requireModerator } from '~/pds/mod/auth'

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)

  let limit = DEFAULT_LIMIT
  if (params.limit !== undefined) {
    const n = Number.parseInt(params.limit, 10)
    if (!Number.isFinite(n) || n < 1 || n > MAX_LIMIT) {
      throw BadRequest(`limit must be 1..${MAX_LIMIT}`, 'InvalidRequest')
    }
    limit = n
  }
  const cursor = params.cursor?.trim()

  const rows = await db
    .select({
      did: modTeam.did,
      role: modTeam.role,
      addedAt: modTeam.addedAt,
      handle: accounts.handle,
    })
    .from(modTeam)
    .leftJoin(accounts, eq(accounts.did, modTeam.did))
    .where(cursor ? lt(modTeam.addedAt, new Date(cursor)) : undefined)
    .orderBy(asc(modTeam.role), asc(modTeam.addedAt))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? page[page.length - 1]!.addedAt.toISOString()
      : undefined

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    members: page.map((r) => ({
      did: r.did,
      handle: r.handle ?? undefined,
      role:
        r.role === 'lead'
          ? 'tools.ozone.team.defs#roleAdmin'
          : 'tools.ozone.team.defs#roleModerator',
      disabled: false,
      createdAt: r.addedAt.toISOString(),
      lastUpdatedAt: r.addedAt.toISOString(),
    })),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.team.listMembers'
