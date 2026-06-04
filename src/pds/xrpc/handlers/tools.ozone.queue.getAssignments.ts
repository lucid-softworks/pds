// XRPC handler: tools.ozone.queue.getAssignments
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/queue/getAssignments.json

import { and, asc, gt, inArray, isNull, type SQL } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { modQueueAssignments } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { fetchQueues, toAssignmentView } from '~/pds/mod/queue'

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

  const onlyActive = params.onlyActive !== 'false'
  const queueIds = parseIntList(params.queueIds)
  const dids = parseStringList(params.dids)

  const conds: SQL[] = []
  if (onlyActive) conds.push(isNull(modQueueAssignments.endAt))
  if (queueIds.length > 0) {
    conds.push(inArray(modQueueAssignments.queueId, queueIds))
  }
  if (dids.length > 0) {
    conds.push(inArray(modQueueAssignments.did, dids))
  }
  if (Number.isFinite(cursorN)) {
    conds.push(gt(modQueueAssignments.id, cursorN))
  }

  const rows = await db
    .select()
    .from(modQueueAssignments)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(modQueueAssignments.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? String(page[page.length - 1]!.id)
      : undefined

  const queueMap = await fetchQueues(page.map((a) => a.queueId))
  const assignments = await Promise.all(
    page.map((a) => toAssignmentView(a, queueMap.get(a.queueId)!)),
  )

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    assignments,
  }
}

function parseIntList(raw: string | string[] | undefined): number[] {
  if (!raw) return []
  const parts = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return parts
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n))
}

function parseStringList(raw: string | string[] | undefined): string[] {
  if (!raw) return []
  const parts = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim())
  return parts.filter((s) => s.length > 0)
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.queue.getAssignments'
