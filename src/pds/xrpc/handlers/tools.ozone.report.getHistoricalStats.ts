// XRPC handler: tools.ozone.report.getHistoricalStats
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/report/getHistoricalStats.json
//
// Day-bucketed counts of reports created vs. resolved over a range.
// `mod_report_resolution.resolved_at` is the resolve timestamp; the
// report's `created_at` is the open timestamp. We bucket by date (UTC)
// and return one row per day. Filters on queueId / moderatorDid /
// reportTypes narrow the set.

import { and, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { moderationReports, modReportResolution } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 30

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
  const now = new Date()
  const startDate = params.startDate ? new Date(params.startDate) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const endDate = params.endDate ? new Date(params.endDate) : now
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    throw BadRequest('startDate / endDate must be parseable', 'InvalidRequest')
  }

  const conds: SQL[] = [
    gte(moderationReports.createdAt, startDate),
    lte(moderationReports.createdAt, endDate),
  ]
  if (params.queueId) {
    const n = Number.parseInt(params.queueId, 10)
    if (Number.isFinite(n)) conds.push(eq(moderationReports.queueId, n))
  }
  if (params.moderatorDid) {
    conds.push(eq(moderationReports.assignedToDid, params.moderatorDid))
  }
  if (params.reportTypes) {
    const types = (Array.isArray(params.reportTypes)
      ? params.reportTypes
      : params.reportTypes.split(',')
    )
      .map((s) => s.trim())
      .filter(Boolean)
    if (types.length > 0) conds.push(inArray(moderationReports.reasonType, types))
  }

  // Per-day open + close counts. We `left join` mod_report_resolution
  // so reports without a resolution still contribute to the open count.
  const rows = await db
    .select({
      day: sql<string>`date_trunc('day', ${moderationReports.createdAt})::date::text`,
      opened: sql<number>`count(*)::int`,
      closed: sql<number>`count(${modReportResolution.reportId})::int`,
    })
    .from(moderationReports)
    .leftJoin(
      modReportResolution,
      eq(modReportResolution.reportId, moderationReports.id),
    )
    .where(and(...conds))
    .groupBy(sql`date_trunc('day', ${moderationReports.createdAt})`)
    .orderBy(sql`date_trunc('day', ${moderationReports.createdAt}) desc`)
    .limit(limit)

  return {
    stats: rows.map((r) => ({
      date: r.day,
      openedCount: r.opened,
      closedCount: r.closed,
    })),
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.report.getHistoricalStats'
