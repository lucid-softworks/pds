// XRPC handler: tools.ozone.report.getAssignments
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/report/getAssignments.json

import { and, asc, gt, inArray, isNotNull, type SQL } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { moderationReports } from '~/lib/db/schema'
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
  const cursorN = cursor ? Number.parseInt(cursor, 10) : NaN
  const onlyActive = params.onlyActive !== 'false'

  const conds: SQL[] = []
  if (onlyActive) conds.push(isNotNull(moderationReports.assignedToDid))
  if (params.reportIds) {
    const ids = (Array.isArray(params.reportIds)
      ? params.reportIds
      : params.reportIds.split(',')
    )
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n))
    if (ids.length > 0) conds.push(inArray(moderationReports.id, ids))
  }
  if (params.dids) {
    const dids = (Array.isArray(params.dids)
      ? params.dids
      : params.dids.split(',')
    )
      .map((s) => s.trim())
      .filter(Boolean)
    if (dids.length > 0) conds.push(inArray(moderationReports.assignedToDid, dids))
  }
  if (Number.isFinite(cursorN)) conds.push(gt(moderationReports.id, cursorN))

  const rows = await db
    .select({
      id: moderationReports.id,
      did: moderationReports.assignedToDid,
      assignedAt: moderationReports.assignedAt,
    })
    .from(moderationReports)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(moderationReports.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? String(page[page.length - 1]!.id)
      : undefined

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    assignments: page
      .filter((r) => r.did !== null)
      .map((r) => ({
        reportId: r.id,
        did: r.did!,
        assignedAt: (r.assignedAt ?? new Date()).toISOString(),
      })),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.report.getAssignments'
