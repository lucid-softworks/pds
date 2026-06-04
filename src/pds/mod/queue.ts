// Helpers shared by the `tools.ozone.queue.*` handlers.
//
// One source of truth for the queueView / queueStats / assignmentView
// shapes the lexicon expects. The handlers (createQueue, listQueues,
// updateQueue, deleteQueue, assignModerator, unassignModerator,
// getAssignments, routeReports) all reflect rows through these
// functions so the wire shape stays consistent.

import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import {
  modQueueAssignments,
  modQueues,
  moderationReports,
  modReportResolution,
  modSubjectStatus,
  type ModQueue,
  type ModQueueAssignment,
} from '~/lib/db/schema'

export type QueueStats = {
  pendingCount?: number
  actionedCount?: number
  escalatedCount?: number
  inboundCount?: number
  actionRate?: number
  avgHandlingTimeSec?: number
  lastUpdated: string
}

export type QueueView = {
  id: number
  name: string
  description?: string
  subjectTypes: string[]
  reportTypes: string[]
  collection?: string
  enabled: boolean
  deletedAt?: string
  createdBy: string
  createdAt: string
  updatedAt: string
  stats: QueueStats
}

export type AssignmentView = {
  id: number
  did: string
  queue: QueueView
  startAt: string
  endAt?: string
}

/** Compute stats for a single queue. Counts are over `moderation_reports`
 *  rows with `queue_id = queue.id`. A report is "actioned" once
 *  `mod_report_resolution` has a row for it; everything else is
 *  pending. `escalatedCount` reads from `mod_subject_status.review_state`
 *  joined by subject identity. */
export async function computeQueueStats(
  queueId: number,
): Promise<QueueStats> {
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  // Pending = report with no resolution row. Actioned = report with resolution.
  const countsRow = await db
    .select({
      total: sql<number>`count(*)::int`,
      actioned: sql<number>`count(${modReportResolution.reportId})::int`,
    })
    .from(moderationReports)
    .leftJoin(
      modReportResolution,
      eq(modReportResolution.reportId, moderationReports.id),
    )
    .where(eq(moderationReports.queueId, queueId))
  const total = countsRow[0]?.total ?? 0
  const actionedCount = countsRow[0]?.actioned ?? 0
  const pendingCount = total - actionedCount

  // Inbound in last 24h.
  const inboundRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(moderationReports)
    .where(
      and(
        eq(moderationReports.queueId, queueId),
        gte(moderationReports.createdAt, dayAgo),
      ),
    )
  const inboundCount = inboundRow[0]?.n ?? 0

  // Escalated count — reports on subjects whose status is escalated.
  const escalatedRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(moderationReports)
    .innerJoin(
      modSubjectStatus,
      sql`(
        (${moderationReports.subjectUri} is not null and ${moderationReports.subjectUri} = ${modSubjectStatus.subjectUri})
        or
        (${moderationReports.subjectUri} is null and ${moderationReports.subjectDid} = ${modSubjectStatus.subjectDid})
      )`,
    )
    .where(
      and(
        eq(moderationReports.queueId, queueId),
        eq(
          modSubjectStatus.reviewState,
          'tools.ozone.moderation.defs#reviewEscalated',
        ),
      ),
    )
  const escalatedCount = escalatedRow[0]?.n ?? 0

  // Avg handling time — for resolved reports, resolved_at - created_at.
  const avgRow = await db
    .select({
      avg: sql<number | null>`avg(extract(epoch from (${modReportResolution.resolvedAt} - ${moderationReports.createdAt})))::int`,
    })
    .from(moderationReports)
    .innerJoin(
      modReportResolution,
      eq(modReportResolution.reportId, moderationReports.id),
    )
    .where(eq(moderationReports.queueId, queueId))
  const avgHandlingTimeSec = avgRow[0]?.avg ?? undefined

  const actionRate =
    inboundCount > 0 ? Math.round((actionedCount / inboundCount) * 100) : undefined

  return {
    pendingCount,
    actionedCount,
    escalatedCount,
    inboundCount,
    ...(actionRate !== undefined ? { actionRate } : {}),
    ...(avgHandlingTimeSec !== undefined && avgHandlingTimeSec !== null
      ? { avgHandlingTimeSec }
      : {}),
    lastUpdated: now.toISOString(),
  }
}

/** Reflect a mod_queues row to the lexicon's queueView shape, including
 *  freshly-computed stats. The stats query runs N+1 times when used in a
 *  listQueues call; the listQueues handler optionally skips it. */
export async function toQueueView(
  q: ModQueue,
  withStats: boolean,
): Promise<QueueView> {
  const stats = withStats
    ? await computeQueueStats(q.id)
    : { lastUpdated: q.updatedAt.toISOString() }
  return {
    id: q.id,
    name: q.name,
    ...(q.description !== null ? { description: q.description } : {}),
    subjectTypes: q.subjectTypes,
    reportTypes: q.reportTypes,
    ...(q.collection !== null ? { collection: q.collection } : {}),
    enabled: q.enabled,
    ...(q.deletedAt !== null ? { deletedAt: q.deletedAt.toISOString() } : {}),
    createdBy: q.createdBy,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
    stats,
  }
}

export async function toAssignmentView(
  a: ModQueueAssignment,
  queue: ModQueue,
): Promise<AssignmentView> {
  return {
    id: a.id,
    did: a.did,
    queue: await toQueueView(queue, false),
    startAt: a.startAt.toISOString(),
    ...(a.endAt !== null ? { endAt: a.endAt.toISOString() } : {}),
  }
}

/** Find the first enabled queue whose subject_types contains `subjectType`
 *  and whose report_types contains `reasonType`. Returns null if none
 *  match. Used by `routeReports` to auto-route incoming reports. */
export async function findMatchingQueue(args: {
  subjectType: 'account' | 'record'
  reasonType: string
  collection?: string | null
}): Promise<ModQueue | null> {
  const rows = await db
    .select()
    .from(modQueues)
    .where(
      and(
        eq(modQueues.enabled, true),
        isNull(modQueues.deletedAt),
        sql`${args.subjectType} = any(${modQueues.subjectTypes})`,
        sql`${args.reasonType} = any(${modQueues.reportTypes})`,
      ),
    )
  // Prefer a queue whose `collection` matches when subject is a record.
  if (args.subjectType === 'record' && args.collection) {
    const collectionMatch = rows.find((r) => r.collection === args.collection)
    if (collectionMatch) return collectionMatch
  }
  return rows[0] ?? null
}

/** Bulk-fetch queues by IDs (for assignment views). */
export async function fetchQueues(
  ids: number[],
): Promise<Map<number, ModQueue>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select()
    .from(modQueues)
    .where(inArray(modQueues.id, ids))
  return new Map(rows.map((r) => [r.id, r]))
}
