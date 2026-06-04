// Helpers shared by `tools.ozone.report.*` handlers.
//
// One source of truth for:
//   - the lexicon's `reportView` shape (status, eventId, assignment, queue)
//   - status derivation from `moderation_reports` + `mod_report_resolution`
//     + `mod_subject_status` joins
//   - activity-log writes (createActivity flows through here)
//
// See chapter 24 — Ozone-shaped moderation (Reports).

import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import {
  moderationReports,
  modQueues,
  modReportActivities,
  modReportResolution,
  modSubjectStatus,
  type ModerationReportRow,
  type ModQueue,
  type ModReportActivity,
} from '~/lib/db/schema'
import { toQueueView, type QueueView } from './queue'

export type ReportStatus =
  | 'open'
  | 'closed'
  | 'escalated'
  | 'queued'
  | 'assigned'

export type ReportView = {
  id: number
  eventId: number
  status: ReportStatus
  subject: { type: string; subject: string }
  reportType: string
  reportedBy: string
  reporter: { type: string; subject: string }
  comment?: string
  createdAt: string
  updatedAt?: string
  queuedAt?: string
  actionEventIds?: number[]
  assignment?: { did: string; assignedAt: string }
  queue?: QueueView
}

const ACTIVITY_TYPES = [
  'queue',
  'assignment',
  'escalation',
  'close',
  'reopen',
  'note',
] as const

export type ActivityType = (typeof ACTIVITY_TYPES)[number]

export function isActivityType(s: string): s is ActivityType {
  return (ACTIVITY_TYPES as readonly string[]).includes(s)
}

/** $type discriminator → activity-type bucket (the lexicon nests the
 *  type inside an `activity` union, e.g. `tools.ozone.report.defs#queueActivity`). */
export function activityFromTypeRef(typeRef: string): ActivityType | null {
  const m = typeRef.match(/#(\w+)Activity$/)
  if (!m) return null
  const candidate = m[1]!.toLowerCase()
  if (isActivityType(candidate)) return candidate
  return null
}

export function activityTypeToTypeRef(t: ActivityType): string {
  return `tools.ozone.report.defs#${t}Activity`
}

/** Determine current status for a single report. Cheap when the status
 *  cache columns are loaded; for free we read the resolution + assignee
 *  + subject_status joins. */
export async function deriveStatus(
  report: ModerationReportRow,
): Promise<ReportStatus> {
  if (report.assignedToDid) return 'assigned'
  const resolution = await db
    .select({ eventId: modReportResolution.eventId })
    .from(modReportResolution)
    .where(eq(modReportResolution.reportId, report.id))
    .limit(1)
  if (resolution.length > 0) return 'closed'

  // Escalated when the subject's status is escalated.
  if (report.subjectUri) {
    const status = await db
      .select({ rs: modSubjectStatus.reviewState })
      .from(modSubjectStatus)
      .where(eq(modSubjectStatus.subjectUri, report.subjectUri))
      .limit(1)
    if (
      status[0]?.rs === 'tools.ozone.moderation.defs#reviewEscalated'
    ) return 'escalated'
  } else if (report.subjectDid) {
    const status = await db
      .select({ rs: modSubjectStatus.reviewState })
      .from(modSubjectStatus)
      .where(eq(modSubjectStatus.subjectDid, report.subjectDid))
      .limit(1)
    if (
      status[0]?.rs === 'tools.ozone.moderation.defs#reviewEscalated'
    ) return 'escalated'
  }

  if (report.queueId !== null) return 'queued'
  return 'open'
}

/** Reflect a single report row into the wire view. Optional `queueMap`
 *  short-circuits a per-row queue fetch when iterating. */
export async function toReportView(
  report: ModerationReportRow,
  opts: { queueMap?: Map<number, ModQueue>; includeActions?: boolean } = {},
): Promise<ReportView> {
  const status = await deriveStatus(report)
  const subject = subjectViewOf(report)
  const reporter = {
    type: 'com.atproto.admin.defs#repoRef',
    subject: report.reportedByDid,
  }

  let actionEventIds: number[] = []
  if (opts.includeActions !== false) {
    const rows = await db
      .select({ eventId: modReportResolution.eventId })
      .from(modReportResolution)
      .where(eq(modReportResolution.reportId, report.id))
    actionEventIds = rows.map((r) => r.eventId)
  }
  const eventId = actionEventIds[0] ?? 0

  let queue: QueueView | undefined
  if (report.queueId !== null) {
    const q =
      opts.queueMap?.get(report.queueId) ??
      (await db
        .select()
        .from(modQueues)
        .where(eq(modQueues.id, report.queueId))
        .limit(1)
        .then((rs) => rs[0]))
    if (q) queue = await toQueueView(q, false)
  }

  return {
    id: report.id,
    eventId,
    status,
    subject,
    reportType: report.reasonType,
    reportedBy: report.reportedByDid,
    reporter,
    ...(report.reason ? { comment: report.reason } : {}),
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.createdAt.toISOString(),
    ...(actionEventIds.length > 0
      ? { actionEventIds: [...actionEventIds].reverse() }
      : {}),
    ...(report.assignedToDid
      ? {
          assignment: {
            did: report.assignedToDid,
            assignedAt: (report.assignedAt ?? report.createdAt).toISOString(),
          },
        }
      : {}),
    ...(queue ? { queue, queuedAt: report.createdAt.toISOString() } : {}),
  }
}

function subjectViewOf(report: ModerationReportRow): {
  type: string
  subject: string
} {
  if (report.subjectType === 'com.atproto.admin.defs#repoRef') {
    return {
      type: 'com.atproto.admin.defs#repoRef',
      subject: report.subjectDid ?? '',
    }
  }
  return {
    type: 'com.atproto.repo.strongRef',
    subject: report.subjectUri ?? '',
  }
}

/** Activity-row → wire view shape. */
export function toActivityView(a: ModReportActivity): {
  id: number
  reportId: number
  activity: { $type: string; previousStatus?: string }
  internalNote?: string
  publicNote?: string
  meta?: unknown
  isAutomated: boolean
  createdBy: string
  createdAt: string
} {
  return {
    id: a.id,
    reportId: a.reportId,
    activity: {
      $type: activityTypeToTypeRef(a.activityType as ActivityType),
      ...(a.previousStatus ? { previousStatus: a.previousStatus } : {}),
    },
    ...(a.internalNote ? { internalNote: a.internalNote } : {}),
    ...(a.publicNote ? { publicNote: a.publicNote } : {}),
    ...(a.meta !== null && a.meta !== undefined ? { meta: a.meta } : {}),
    isAutomated: a.isAutomated,
    createdBy: a.createdBy,
    createdAt: a.createdAt.toISOString(),
  }
}

/** Compute live-stats counters for a queue × moderator × reportType slice. */
export async function computeLiveStats(args: {
  queueId?: number
  moderatorDid?: string
  reportTypes?: string[]
}): Promise<{
  openCount: number
  closedCount: number
  escalatedCount: number
  assignedCount: number
}> {
  const conds = [] as ReturnType<typeof eq>[]
  if (args.queueId !== undefined) {
    conds.push(eq(moderationReports.queueId, args.queueId))
  }
  if (args.moderatorDid) {
    conds.push(eq(moderationReports.assignedToDid, args.moderatorDid))
  }
  if (args.reportTypes && args.reportTypes.length > 0) {
    conds.push(inArray(moderationReports.reasonType, args.reportTypes))
  }
  // Closed = has resolution row.
  const closedRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(moderationReports)
    .innerJoin(
      modReportResolution,
      eq(modReportResolution.reportId, moderationReports.id),
    )
    .where(conds.length > 0 ? and(...conds) : undefined)
  const closedCount = closedRow[0]?.n ?? 0

  // Total (everything matching filters).
  const totalRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(moderationReports)
    .where(conds.length > 0 ? and(...conds) : undefined)
  const total = totalRow[0]?.n ?? 0

  // Assigned = has assigned_to_did set, no resolution.
  const assignedRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(moderationReports)
    .leftJoin(
      modReportResolution,
      eq(modReportResolution.reportId, moderationReports.id),
    )
    .where(
      and(
        isNull(modReportResolution.reportId),
        isNotNull(moderationReports.assignedToDid),
        ...(conds.length > 0 ? conds : []),
      ),
    )
  const assignedCount = assignedRow[0]?.n ?? 0

  // Escalated = matching report on subject with subject_status review_escalated.
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
        eq(
          modSubjectStatus.reviewState,
          'tools.ozone.moderation.defs#reviewEscalated',
        ),
        ...(conds.length > 0 ? conds : []),
      ),
    )
  const escalatedCount = escalatedRow[0]?.n ?? 0

  const openCount = total - closedCount - escalatedCount

  return { openCount, closedCount, escalatedCount, assignedCount }
}

/** Helpers exported for handlers that want raw conditions. */
export const reportHelpers = {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
}
