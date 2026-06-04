// XRPC handler: tools.ozone.set.querySets
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/set/querySets.json

import { asc, eq, gt, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { ozoneSetValues, ozoneSets } from '~/lib/db/schema'
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
  const namePrefix = params.namePrefix?.trim()

  const rows = await db
    .select({
      name: ozoneSets.name,
      description: ozoneSets.description,
      createdAt: ozoneSets.createdAt,
      updatedAt: ozoneSets.updatedAt,
      // Lateral count of the set's values via a correlated subquery.
      // PG supports this; the few-bytes-per-row is fine for our scale.
      size: sql<number>`(
        select count(*) from ${ozoneSetValues}
        where ${ozoneSetValues.setName} = ${ozoneSets.name}
      )::int`,
    })
    .from(ozoneSets)
    .where(
      cursor
        ? gt(ozoneSets.name, cursor)
        : namePrefix
          ? sql`${ozoneSets.name} LIKE ${namePrefix + '%'}`
          : undefined,
    )
    .orderBy(asc(ozoneSets.name))
    .limit(limit + 1)
  void eq // satisfy import linter

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? page[page.length - 1]!.name
      : undefined

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    sets: page.map((r) => ({
      name: r.name,
      ...(r.description !== null ? { description: r.description } : {}),
      setSize: Number(r.size),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.set.querySets'
