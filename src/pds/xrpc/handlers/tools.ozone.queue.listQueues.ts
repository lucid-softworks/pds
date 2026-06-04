// XRPC handler: tools.ozone.queue.listQueues
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/queue/listQueues.json

import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { modQueues } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { toQueueView } from '~/pds/mod/queue'

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
  const cursorN = cursor ? Number.parseInt(cursor, 10) : NaN

  const conds = [isNull(modQueues.deletedAt)]
  if (params.enabled === 'true') conds.push(eq(modQueues.enabled, true))
  if (params.enabled === 'false') conds.push(eq(modQueues.enabled, false))
  if (params.subjectType) {
    conds.push(sql`${params.subjectType} = any(${modQueues.subjectTypes})`)
  }
  if (params.collection) {
    conds.push(eq(modQueues.collection, params.collection))
  }
  if (params.reportTypes) {
    const types = Array.isArray(params.reportTypes)
      ? params.reportTypes
      : params.reportTypes.split(',').map((s) => s.trim()).filter(Boolean)
    if (types.length > 0) {
      conds.push(sql`${modQueues.reportTypes} && ${types}::text[]`)
    }
  }
  if (Number.isFinite(cursorN)) conds.push(gt(modQueues.id, cursorN))

  const rows = await db
    .select()
    .from(modQueues)
    .where(and(...conds))
    .orderBy(asc(modQueues.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? String(page[page.length - 1]!.id)
      : undefined

  const queues = await Promise.all(page.map((q) => toQueueView(q, true)))
  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    queues,
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.queue.listQueues'
