// XRPC handler: tools.ozone.report.listActivities
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/report/listActivities.json

import { and, asc, eq, gt, type SQL } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { modReportActivities } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { toActivityView } from '~/pds/mod/report'

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

const handler: Handler = async ({ params, authorization }) => {
  await requireModerator(authorization)
  const reportId = Number.parseInt(params.reportId ?? '', 10)
  if (!Number.isFinite(reportId)) {
    throw BadRequest('reportId is required', 'InvalidRequest')
  }
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

  const conds: SQL[] = [eq(modReportActivities.reportId, reportId)]
  if (Number.isFinite(cursorN)) conds.push(gt(modReportActivities.id, cursorN))

  const rows = await db
    .select()
    .from(modReportActivities)
    .where(and(...conds))
    .orderBy(asc(modReportActivities.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? String(page[page.length - 1]!.id)
      : undefined

  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    activities: page.map(toActivityView),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.report.listActivities'
