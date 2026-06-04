// XRPC handler: tools.ozone.report.queryReports
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/report/queryReports.json

import { and, asc, desc, eq, gte, inArray, lt, lte, type SQL } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest } from '../errors'
import { db } from '~/lib/db'
import { moderationReports, modReportResolution } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { toReportView } from '~/pds/mod/report'

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

  const conds: SQL[] = []
  if (params.queueId) {
    const n = Number.parseInt(params.queueId, 10)
    if (Number.isFinite(n)) conds.push(eq(moderationReports.queueId, n))
  }
  if (params.subject) {
    const s = params.subject
    if (s.startsWith('at://')) {
      conds.push(eq(moderationReports.subjectUri, s))
    } else {
      conds.push(eq(moderationReports.subjectDid, s))
    }
  }
  if (params.did) {
    conds.push(eq(moderationReports.subjectDid, params.did))
  }
  if (params.subjectType === 'account') {
    conds.push(
      eq(moderationReports.subjectType, 'com.atproto.admin.defs#repoRef'),
    )
  } else if (params.subjectType === 'record') {
    conds.push(eq(moderationReports.subjectType, 'com.atproto.repo.strongRef'))
  }
  if (params.assignedTo) {
    conds.push(eq(moderationReports.assignedToDid, params.assignedTo))
  }
  if (params.reportTypes) {
    const types = Array.isArray(params.reportTypes)
      ? params.reportTypes
      : params.reportTypes.split(',').map((s) => s.trim()).filter(Boolean)
    if (types.length > 0) conds.push(inArray(moderationReports.reasonType, types))
  }
  if (params.reportedAfter) {
    const d = new Date(params.reportedAfter)
    if (!isNaN(d.getTime())) conds.push(gte(moderationReports.createdAt, d))
  }
  if (params.reportedBefore) {
    const d = new Date(params.reportedBefore)
    if (!isNaN(d.getTime())) conds.push(lte(moderationReports.createdAt, d))
  }

  const cursor = params.cursor?.trim()
  if (cursor) {
    const d = new Date(cursor)
    if (!isNaN(d.getTime())) conds.push(lt(moderationReports.createdAt, d))
  }

  const sortDir = params.sortDirection === 'asc' ? asc : desc
  const orderCol =
    params.sortField === 'createdAt'
      ? moderationReports.createdAt
      : moderationReports.createdAt

  const rows = await db
    .select()
    .from(moderationReports)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(sortDir(orderCol))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && page.length > 0
      ? page[page.length - 1]!.createdAt.toISOString()
      : undefined

  const reports = await Promise.all(page.map((r) => toReportView(r)))
  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    reports,
  }
}

export const def: HandlerDef = { method: 'GET', handler }
export const nsid = 'tools.ozone.report.queryReports'
