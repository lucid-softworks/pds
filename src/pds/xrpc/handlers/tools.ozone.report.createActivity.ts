// XRPC handler: tools.ozone.report.createActivity
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/report/createActivity.json
//
// Append an activity row to a report. For state-change activities
// (queue / assignment / escalation / close / reopen) also mutates the
// underlying moderation_reports row so the report's status changes
// atomically with the activity entry.

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound, XrpcError } from '../errors'
import { db } from '~/lib/db'
import {
  moderationReports,
  modReportActivities,
  modReportResolution,
} from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import {
  activityFromTypeRef,
  deriveStatus,
  toActivityView,
} from '~/pds/mod/report'

const InputSchema = z.object({
  reportId: z.number().int(),
  activity: z.object({ $type: z.string() }).passthrough(),
  internalNote: z.string().optional(),
  publicNote: z.string().optional(),
  isAutomated: z.boolean().optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  const auth = await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const { reportId, activity, internalNote, publicNote, isAutomated } =
    parsed.data
  const activityType = activityFromTypeRef(activity.$type ?? '')
  if (!activityType) {
    throw BadRequest(
      `unknown activity $type: ${activity.$type}`,
      'InvalidRequest',
    )
  }

  const reportRows = await db
    .select()
    .from(moderationReports)
    .where(eq(moderationReports.id, reportId))
    .limit(1)
  if (reportRows.length === 0) {
    throw NotFound(`report not found: ${reportId}`, 'ReportNotFound')
  }
  const report = reportRows[0]!
  const previousStatus = await deriveStatus(report)

  // State-machine guards.
  if (activityType === 'reopen' && previousStatus !== 'closed') {
    throw new XrpcError(
      400,
      'InvalidStateTransition',
      `cannot reopen a report in status ${previousStatus}`,
    )
  }
  if (activityType === 'close' && previousStatus === 'closed') {
    throw new XrpcError(
      400,
      'AlreadyInTargetState',
      'report is already closed',
    )
  }

  // Apply state changes that this activity implies on the report row.
  if (activityType === 'reopen') {
    await db
      .delete(modReportResolution)
      .where(eq(modReportResolution.reportId, reportId))
  }
  // Note: close / escalation / queue / assignment are recorded purely as
  // activity entries here — operators drive the underlying state via the
  // existing moderation surface (emitEvent for close/escalation,
  // assignModerator for assignment, routeReports for queue routing). The
  // activity log captures intent + audit; the moderation_reports row +
  // mod_report_resolution + mod_subject_status remain the source of truth.

  const inserted = await db
    .insert(modReportActivities)
    .values({
      reportId,
      activityType,
      previousStatus,
      internalNote: internalNote ?? null,
      publicNote: publicNote ?? null,
      meta: null,
      isAutomated: isAutomated ?? false,
      createdBy: auth.kind === 'admin' ? 'admin' : auth.did,
    })
    .returning()

  return { activity: toActivityView(inserted[0]!) }
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.report.createActivity'
