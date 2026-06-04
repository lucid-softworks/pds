// XRPC handler: tools.ozone.set.getValues
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/set/getValues.json

import { and, asc, eq, gt } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { ozoneSetValues, ozoneSets } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 100

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)
  const name = params.name?.trim()
  if (!name) throw BadRequest('name is required', 'InvalidRequest')
  let limit = DEFAULT_LIMIT
  if (params.limit !== undefined) {
    const n = Number.parseInt(params.limit, 10)
    if (!Number.isFinite(n) || n < 1 || n > MAX_LIMIT) {
      throw BadRequest(`limit must be 1..${MAX_LIMIT}`, 'InvalidRequest')
    }
    limit = n
  }
  const cursor = params.cursor?.trim()

  const setRow = (
    await db
      .select({
        name: ozoneSets.name,
        description: ozoneSets.description,
        createdAt: ozoneSets.createdAt,
        updatedAt: ozoneSets.updatedAt,
      })
      .from(ozoneSets)
      .where(eq(ozoneSets.name, name))
      .limit(1)
  )[0]
  if (!setRow) throw NotFound(`set not found: ${name}`, 'SetNotFound')

  const rows = await db
    .select({ value: ozoneSetValues.value })
    .from(ozoneSetValues)
    .where(
      and(
        eq(ozoneSetValues.setName, name),
        cursor ? gt(ozoneSetValues.value, cursor) : undefined,
      ),
    )
    .orderBy(asc(ozoneSetValues.value))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? page[page.length - 1]!.value
      : undefined

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    set: {
      name: setRow.name,
      ...(setRow.description !== null
        ? { description: setRow.description }
        : {}),
      createdAt: setRow.createdAt.toISOString(),
      updatedAt: setRow.updatedAt.toISOString(),
    },
    values: page.map((r) => r.value),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.set.getValues'
