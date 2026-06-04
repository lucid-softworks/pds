// XRPC handler: tools.ozone.report.reassignQueue
//
// Lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/report/reassignQueue.json

import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import type { Handler, HandlerDef } from '../server'
import { BadRequest, NotFound } from '../errors'
import { db } from '~/lib/db'
import { modQueues, moderationReports, modReportActivities } from '~/lib/db/schema'
import { requireModerator } from '~/pds/mod/auth'
import { deriveStatus } from '~/pds/mod/report'

const InputSchema = z.object({
  reportId: z.number().int(),
  queueId: z.number().int(),
  comment: z.string().optional(),
})

const handler: Handler = async ({ input, authorization }) => {
  const auth = await requireModerator(authorization)
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    throw BadRequest(
      'invalid input: ' + parsed.error.issues.map((i) => i.message).join('; '),
    )
  }
  const { reportId, queueId, comment } = parsed.data

  const queue = await db
    .select()
    .from(modQueues)
    .where(
      and(
        eq(modQueues.id, queueId),
        eq(modQueues.enabled, true),
        isNull(modQueues.deletedAt),
      ),
    )
    .limit(1)
  if (queue.length === 0) {
    throw BadRequest(
      `queue not found or not enabled: ${queueId}`,
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
  const previousStatus = await deriveStatus(reportRows[0]!)

  await db
    .update(moderationReports)
    .set({ queueId })
    .where(eq(moderationReports.id, reportId))

  await db.insert(modReportActivities).values({
    reportId,
    activityType: 'queue',
    previousStatus,
    internalNote: comment ?? null,
    publicNote: null,
    meta: { queueId },
    isAutomated: false,
    createdBy: auth.kind === 'admin' ? 'admin' : auth.did,
  })

  return {}
}

export const def: HandlerDef = { method: 'POST', handler }
export const nsid = 'tools.ozone.report.reassignQueue'
